; ============================================================================
; ClassBeat 安装器钩子（Tauri NSIS）
;
; 这一份补的正是旧方案缺的三件事：装干净、注册全、卸干净。
; 钩子点由 Tauri 的 NSIS 模板提供，$INSTDIR 已就绪，perUser 安装下
; 上下文是 current（HKCU + 当前用户的开始菜单），不需要管理员权限。
;
; 约定：
;   * 装 = 先停旧版 → 搬数据 → 让 Tauri 铺文件 → 补注册面
;   * 卸 = 先问数据去留 → 停进程 → 删注册面 → 让 Tauri 删文件
;   * 任何一步失败都不阻断安装（老师装不上比装不完美更糟），但一律写日志
; ============================================================================

!define CB_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define CB_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClassBeat"
!define CB_APP_PATHS "Software\Microsoft\Windows\CurrentVersion\App Paths\classbeat.exe"
!define CB_LEGACY "$LOCALAPPDATA\ClassBeat"
!define CB_DATA "$APPDATA\ClassBeat"

; ---------------------------------------------------------------------------
; 清场脚本的定位（实测结论，对应 docs/08 §8.2 最后一行）：
;   · ${__FILEDIR__} 写在 !include 的**顶层**时 = 本文件所在目录（src-tauri\installer）；
;   · 写在**宏里**时 = 插入点（主脚本）所在目录（target\release\nsis\<arch>）。
; 所以必须在 include 时把它固化成 define，再在宏里引用 define ——
; 直接在宏里写 File "${__FILEDIR__}\stop-legacy.ps1" 会去 nsis\x64 下找而失败。
; 找不到就 !error 硬失败：宁可装不上，也不要"旧进程没停干净就覆盖安装"。
; ---------------------------------------------------------------------------
!define CB_STOP_PS1 "${__FILEDIR__}\stop-legacy.ps1"
!if /FILEEXISTS "${CB_STOP_PS1}"
  ; 找到了，继续编译
!else
  !error "找不到 installer\stop-legacy.ps1（期望在 ${CB_STOP_PS1}）。"
!endif

!macro CB_LOG msg
  FileWrite $9 "${msg}$\r$\n"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; 安装日志：老师只需要把这一个文件发过来
  StrCpy $9 "$TEMP\classbeat-install.log"
  FileOpen $9 $9 w
  !insertmacro CB_LOG "=== ClassBeat 安装开始 ==="
  !insertmacro CB_LOG "INSTDIR=$INSTDIR"

  ; ---- 1. 停掉正在跑的旧版（0.3.x：隐藏的 powershell 看门狗 + pythonw + 浏览器 kiosk）----
  ; 用随包的小脚本按命令行精确匹配，绝不误杀别人的 python / powershell。
  ; nsExec 不创建窗口：安装全程用户看不到控制台。
  ; 注意 $OUTDIR：本宏跑在 Tauri 的 "SetOutPath $INSTDIR" 之后，
  ; 这里为了把脚本落到 $TEMP 会改 $OUTDIR；**必须**在离开宏前改回 $INSTDIR，
  ; 否则安装段后面那几百条 File 会全部解到 %TEMP%，$INSTDIR 只剩空目录
  ; （本项目实测踩过：装完有卸载项、有注册表，就是没有 classbeat.exe）。
  SetOutPath $TEMP
  File /oname=cb-stop-legacy.ps1 "${CB_STOP_PS1}"
  nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$TEMP\cb-stop-legacy.ps1" -LegacyDir "${CB_LEGACY}" -InstallDir "$INSTDIR"'
  Pop $1
  Pop $2
  !insertmacro CB_LOG "停旧版：退出码=$1 $2"
  Sleep 1500
  Delete "$TEMP\cb-stop-legacy.ps1"
  SetOutPath $INSTDIR

  ; ---- 2. 旧版数据搬过来（只搬缺失的，绝不覆盖新装已有的）----
  ; 0.3.x 把 data/ backups/ update-source.txt 和程序放在一起。
  IfFileExists "${CB_LEGACY}\server\*.*" 0 cb_no_legacy
    !insertmacro CB_LOG "发现旧版安装：${CB_LEGACY}"
    CreateDirectory "${CB_DATA}"
    IfFileExists "${CB_DATA}\data\*.*" cb_skip_data 0
      CopyFiles /SILENT "${CB_LEGACY}\data\*.*" "${CB_DATA}\data"
      !insertmacro CB_LOG "已接管 data/"
    cb_skip_data:
    IfFileExists "${CB_DATA}\backups\*.*" cb_skip_backups 0
      CopyFiles /SILENT "${CB_LEGACY}\backups\*.*" "${CB_DATA}\backups"
      !insertmacro CB_LOG "已接管 backups/"
    cb_skip_backups:
    IfFileExists "${CB_DATA}\update-source.txt" cb_skip_src 0
      IfFileExists "${CB_LEGACY}\update-source.txt" 0 cb_skip_src
        CopyFiles /SILENT "${CB_LEGACY}\update-source.txt" "${CB_DATA}\update-source.txt"
        !insertmacro CB_LOG "已接管 update-source.txt"
      cb_skip_src:
    ; 旧目录整个删掉：程序文件一个都不留，否则两份服务会抢 8765
    RMDir /r "${CB_LEGACY}"
    !insertmacro CB_LOG "已删除旧安装目录"
  cb_no_legacy:

  ; ---- 3. 旧的"启动文件夹"快捷方式（0.3.x 的自启方式）----
  ; 只在"确实是从 0.3.x 升上来"时才删：新版自己的桌面图标也在 $DESKTOP\ClassBeat.lnk，
  ; 无声重装/更新时把它删了，Tauri 那边因为 $UpdateMode=1 又不会重建 → 桌面图标凭空消失。
  ; 0.3.x 的自启 .lnk 名字不是固定的：实测有一份叫「ClassBeat 大屏自动恢复.lnk」，
  ; 指向已删除的 tools\launcher\watchdog.ps1 —— 留着就是每次开机报一次错。
  ; 所以按通配扫一遍，凡是名字里带 ClassBeat / 节律 的都清掉。
  IfFileExists "${CB_LEGACY}\server\*.*" 0 cb_no_shortcuts
    ClearErrors
    FindFirst $0 $1 "$SMSTARTUP\*ClassBeat*.lnk"
    cb_su_loop1:
      StrCmp $1 "" cb_su_done1 0
      Delete "$SMSTARTUP\$1"
      !insertmacro CB_LOG "删旧自启：$1"
      FindNext $0 $1
      Goto cb_su_loop1
    cb_su_done1:
    FindClose $0

    ClearErrors
    FindFirst $0 $1 "$SMSTARTUP\*节律*.lnk"
    cb_su_loop2:
      StrCmp $1 "" cb_su_done2 0
      Delete "$SMSTARTUP\$1"
      !insertmacro CB_LOG "删旧自启：$1"
      FindNext $0 $1
      Goto cb_su_loop2
    cb_su_done2:
    FindClose $0
  cb_no_shortcuts:

  ; 上面 RMDir /r 把 $INSTDIR 整个删了（新装目录和旧装目录是同一个路径），
  ; 所以这里再把输出目录建回来，后面的 File 才有地方落。
  SetOutPath $INSTDIR
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; ---- 4. 系统注册：App Paths + 自启 + 协议 ----
  WriteRegStr HKCU "${CB_APP_PATHS}" "" "$INSTDIR\classbeat.exe"
  WriteRegStr HKCU "${CB_APP_PATHS}" "Path" "$INSTDIR"

  ; 开机自启：注册表项，卸载器能精确删除（旧方案是启动文件夹里的 .lnk）
  WriteRegStr HKCU "${CB_RUN_KEY}" "ClassBeat" '"$INSTDIR\classbeat.exe" --autostart'

  ; classbeat:// 协议：文档、手机页里可以一键"在教室大屏打开"
  WriteRegStr HKCU "Software\Classes\classbeat" "" "URL:ClassBeat Protocol"
  WriteRegStr HKCU "Software\Classes\classbeat" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\classbeat\shell\open\command" "" '"$INSTDIR\classbeat.exe" "%1"'

  ; 桌面图标：老师习惯从桌面起。
  ; 注意不能指望模板里的 CreateOrUpdateDesktopShortcut —— 它遇到"更新模式"
  ; （已经有安装记录）会直接 Return，桌面图标就没了；所以这里自己建，幂等。
  CreateShortCut "$DESKTOP\ClassBeat.lnk" "$INSTDIR\classbeat.exe" "" "$INSTDIR\classbeat.exe" 0
  !insertmacro CB_LOG "已建桌面图标"

  ; ---- 5. 装完自检：主程序必须真的在 $INSTDIR 里 ----
  ; 这条是为了让"装完了却没有 exe"这种失败当场暴露（踩过一次：
  ; PREINSTALL 里 SetOutPath $TEMP 没复位，几百个 File 全解到 %TEMP%）——
  ; 有卸载项、有注册表、就是没主程序，最坏的情况是老师双击没反应。
  IfFileExists "$INSTDIR\classbeat.exe" cb_main_ok 0
    !insertmacro CB_LOG "!!! 严重：$INSTDIR\classbeat.exe 不存在，安装不完整"
    MessageBox MB_ICONSTOP|MB_OK "安装不完整：$\r$\n$INSTDIR\classbeat.exe$\r$\n不存在。$\r$\n$\r$\n请先卸载再重新安装，安装日志在：$\r$\n$TEMP\classbeat-install.log"
    Goto cb_main_done
  cb_main_ok:
    !insertmacro CB_LOG "主程序已就位"
  cb_main_done:

  ; ---- 5.5 旧版进程没停干净（权限不足）时必须提示 ----
  ; 谁写这个标记：stop-legacy.ps1 在 Stop-Process 报"拒绝访问"时写。
  ; 为什么不靠日志：老师不会去看 $TEMP 里的日志，他看到的现象是"装完了却打不开、
  ; 手机连不上、两块屏抢屏"，只会得出"装坏了"的结论（本项目实测踩过：旧版
  ; 0.3.24 的 pythonw 是管理员权限起的，普通权限一律杀不掉，重启才清）。
  IfFileExists "$TEMP\classbeat-need-reboot.flag" 0 cb_inst_reboot_done
    !insertmacro CB_LOG "!!! 有旧版进程权限不足未能结束，已提示老师重启"
    IfSilent cb_inst_reboot_silent
      MessageBox MB_ICONEXCLAMATION|MB_OK "安装已完成，但检测到旧版 ClassBeat 的进程还在运行（权限不足，没能结束）。$\r$\n$\r$\n请重启电脑后再打开 ClassBeat；否则可能出现两块屏同时抢屏、手机连不上。$\r$\n$\r$\n明细：$TEMP\classbeat-stop-legacy.log"
    cb_inst_reboot_silent:
    Delete "$TEMP\classbeat-need-reboot.flag"
  cb_inst_reboot_done:

; 日志先落盘再干下面那件"可能被拦"的事：
  ; FileWrite 是有缓冲的（这版 NSIS 也没有 FileFlush），进程若在防火墙那步被打断，
  ; 日志会缺一大截 —— 排障时最需要的恰好是"卡在哪一步"。所以先关文件，后面再追加。
  !insertmacro CB_LOG "=== 主要步骤完成 ==="
  FileClose $9

  ; ---- 6. 防火墙入站规则（手机连得上）----
  ; 只给"提权安装"编进去：perUser 装根本不提权，netsh 必定失败，
  ; 却要为此起两个外部进程（net / netsh）——实测在有软件启动管控的机器上
  ; 会直接被拦、连带把安装进程一起带走（装到一半什么都没了）。
  ; 少这两个进程，perUser 路径就完全不依赖外部 exe。
  ; 非提权安装时，首次点"手机控制"系统会弹一次防火墙询问，效果一样。
!if "${INSTALLMODE}" != "currentUser"
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ClassBeat"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="ClassBeat" dir=in action=allow program="$INSTDIR\classbeat.exe" protocol=tcp localport=8765 profile=private enable=yes'
  FileOpen $9 "$TEMP\classbeat-install.log" a
  !insertmacro CB_LOG "已写入防火墙规则"
  FileClose $9
!endif
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $9 "$TEMP\classbeat-uninstall.log"
  FileOpen $9 $9 w
  !insertmacro CB_LOG "=== ClassBeat 卸载开始 ==="

  ; ---- 1. 问数据去留（静默卸载默认保留）----
  StrCpy $8 "keep"
  IfSilent cb_data_decided
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "要把这台电脑上的班级数据一起删掉吗？$\r$\n$\r$\n选「否」= 保留（推荐）：班名、课表、岗位、备份都留在$\r$\n${CB_DATA}$\r$\n以后重装会自动恢复。$\r$\n$\r$\n选「是」= 一并删除，无法撤销。" \
      IDNO cb_data_decided
      StrCpy $8 "delete"
  cb_data_decided:

  ; ---- 2. 停进程（不先停会删不动文件）----
  SetOutPath $TEMP
  File /oname=cb-stop-legacy.ps1 "${CB_STOP_PS1}"
  nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$TEMP\cb-stop-legacy.ps1" -LegacyDir "${CB_LEGACY}" -InstallDir "$INSTDIR"'
  Pop $1
  Pop $2
  Sleep 1200
  Delete "$TEMP\cb-stop-legacy.ps1"
  SetOutPath $INSTDIR

    ; 进程没停掉，后面的 RMDir 就删不动 —— 卸载会"看着成功、其实残留"。
  ; 这里当场说清楚，并且提示重启后再卸一次，而不是让老师以为卸干净了。
  IfFileExists "$TEMP\classbeat-need-reboot.flag" 0 cb_un_reboot_done
    !insertmacro CB_LOG "!!! 有进程未能结束，卸载可能不完整，需重启后再卸一次"
    IfSilent cb_un_reboot_silent
      MessageBox MB_ICONEXCLAMATION|MB_OK "有 ClassBeat 的进程权限不足，没能结束。$\r$\n$\r$\n这次卸载可能删不干净。请重启电脑后再运行一次卸载程序。$\r$\n$\r$\n明细：$TEMP\classbeat-stop-legacy.log"
    cb_un_reboot_silent:
    Delete "$TEMP\classbeat-need-reboot.flag"
  cb_un_reboot_done:

; ---- 3. 删系统注册面 ----
  DeleteRegValue HKCU "${CB_RUN_KEY}" "ClassBeat"
  DeleteRegKey HKCU "${CB_APP_PATHS}"
  DeleteRegKey HKCU "Software\Classes\classbeat"
  ; 卸载项由 Tauri 自己删（它的 UninstallString 就在启用中的那个 exe 上）
  ; 防火墙规则：只可能在提权安装时写过，perUser 卸载不必去碰 netsh。
!if "${INSTALLMODE}" != "currentUser"
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ClassBeat"'
!endif
  ; 计划任务：0.3.x 用的是启动文件夹里的 .lnk，没有计划任务；
  ; 这里不再调 schtasks（外部进程，容易被安全软件拦，拦了整个卸载会被打断）。

  ; ---- 4. 快捷方式 ----
  Delete "$DESKTOP\ClassBeat.lnk"
  Delete "$SMSTARTUP\ClassBeat.lnk"
  Delete "$SMSTARTUP\班级节律屏.lnk"

  ; ---- 5. 数据 ----
  StrCmp $8 "delete" 0 cb_keep_data
    RMDir /r "${CB_DATA}"
    !insertmacro CB_LOG "按用户选择删除数据目录"
    Goto cb_data_done
  cb_keep_data:
    !insertmacro CB_LOG "保留数据目录：${CB_DATA}"
  cb_data_done:

  !insertmacro CB_LOG "=== 卸载收尾 ==="
  FileClose $9
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 兜底：万一 Tauri 的删除被占用打断，这里再扫一次残留的注册痕迹
  DeleteRegValue HKCU "${CB_RUN_KEY}" "ClassBeat"
!macroend
