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

; LogicLib 提供 ${If}/${ElseIf}。模板虽然经 MUI2 间接引入过，但那属于
; 模板实现细节，不能当契约——自己显式引入，NSIS 的 include guard 保证不会重复。
!include LogicLib.nsh

!define CB_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define CB_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClassBeat"
!define CB_APP_PATHS "Software\Microsoft\Windows\CurrentVersion\App Paths\classbeat.exe"
!define CB_LEGACY "$LOCALAPPDATA\ClassBeat"
!define CB_DATA "$APPDATA\ClassBeat"
; 安装需要的最小磁盘空间（MB）。整包约 30 MB，再给解压与安全软件扫描留一倍余量。
!define CB_NEED_MB 120

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

; 图标文件：编译时从 src-tauri/icons/classbeat.ico 固化路径。
; 桌面快捷方式读这个 .ico 文件，不依赖 exe 内嵌图标的 Windows 缓存
; （覆盖安装后 exe 路径没变，系统按路径缓存旧图标，就是"桌面图标依然是
; 错误的"的根因——0.5.3 真机反馈）。
!define CB_ICON "${__FILEDIR__}\..\icons\classbeat.ico"
!if /FILEEXISTS "${CB_ICON}"
  ; 找到了，继续编译
!else
  !error "找不到 icons\classbeat.ico（期望在 ${CB_ICON}）。"
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

  ; ---- 0. 先照一张环境快照，再决定动不动手 ----
  ; 起因（2026-11-25 真机反馈）：老师只看到「抽取：无法写入文件 classbeat.exe」，
  ; 而这句错可能来自四种完全不同的原因（位数、空间、占用、安全软件）。
  ; 现场只有老师本人，所以把判断依据一次性记进这一个文件：
  ; 系统版本、位数、可用空间、已装版本、每一步的退出码。
  ReadRegStr $3 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "ProductName"
  ReadRegStr $4 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "DisplayVersion"
  ReadRegStr $5 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuild"
  !insertmacro CB_LOG "系统：$3 $4（build $5）"
  ReadRegStr $3 HKCU "${CB_UNINST_KEY}" "DisplayVersion"
  !insertmacro CB_LOG "已装版本：$3"
  ${If} ${RunningX64}
    !insertmacro CB_LOG "系统位数：64 位"
  ${ElseIf} ${IsNativeARM64}
    !insertmacro CB_LOG "系统位数：ARM64"
  ${Else}
    !insertmacro CB_LOG "系统位数：32 位"
  ${EndIf}

  ; ---- 0.1 位数不对就别装了 ----
  ; 主程序是 64 位（PE32+），32 位 Windows 一定打不开，Windows 只会弹
  ; 「此应用无法在你的电脑上运行」。以前一路装到底，装完留一个点不动的图标，
  ; 老师会以为「更新把软件装坏了」。宁可现在说明白。
  ${IfNot} ${RunningX64}
    ${IfNot} ${IsNativeARM64}
      !insertmacro CB_LOG "!!! 32 位 Windows，主程序是 64 位的，停止安装"
      FileClose $9
      IfSilent cb_arch_done
        MessageBox MB_ICONSTOP|MB_OK "这台电脑是 32 位 Windows。$\r$\n$\r$\nClassBeat 需要 64 位 Windows 10 / 11；现在装上也会打不开（Windows 会提示「此应用无法在你的电脑上运行」）。$\r$\n$\r$\n请换一台 64 位电脑安装。安装日志：$\r$\n$TEMP\classbeat-install.log"
      cb_arch_done:
      Quit
    ${EndIf}
  ${EndIf}

  ; ---- 0.2 空间与写权限 ----
  ; NSIS 是自己解压再写盘的，空间不足或目录不可写，报的都是同一句
  ; 「无法写入文件」，跟「被占用」长得一模一样。先分清。
  CreateDirectory "$INSTDIR"
  ClearErrors
  ${DriveSpace} "$INSTDIR" "/D=F /S=M" $3
  IfErrors cb_space_unknown
    !insertmacro CB_LOG "可用空间：$3 MB"
    IntCmp $3 ${CB_NEED_MB} cb_space_ok cb_space_low cb_space_ok
  cb_space_low:
    !insertmacro CB_LOG "!!! 空间不足：只有 $3 MB"
    FileClose $9
    IfSilent cb_space_quit
      MessageBox MB_ICONSTOP|MB_OK "磁盘空间不够，装不下。$\r$\n$\r$\n$INSTDIR 所在磁盘只剩 $3 MB，至少需要 ${CB_NEED_MB} MB。$\r$\n请清理磁盘后再安装。安装日志：$\r$\n$TEMP\classbeat-install.log"
    cb_space_quit:
    Quit
  cb_space_ok:
    Goto cb_space_checked
  cb_space_unknown:
    !insertmacro CB_LOG "可用空间：读不出来，跳过这项检查"
  cb_space_checked:

  ; 往安装目录真写一个空文件试试：目录权限、受控文件夹访问、安全软件
  ; 都会在这一步现形，而不是等解压到一半才失败。
  ClearErrors
  FileOpen $2 "$INSTDIR\.cb-write-probe" w
  IfErrors cb_nowrite
  FileClose $2
  Delete "$INSTDIR\.cb-write-probe"
  !insertmacro CB_LOG "写权限：正常"
  Goto cb_write_ok
  cb_nowrite:
    !insertmacro CB_LOG "!!! 安装目录写不进去"
    FileClose $9
    IfSilent cb_nowrite_quit
      MessageBox MB_ICONSTOP|MB_OK "没法往这个目录写文件：$\r$\n$INSTDIR$\r$\n$\r$\n最常见的原因是安全软件（360、火绒、电脑管家）或学校的管控策略拦下了未签名的程序。$\r$\n$\r$\n请先退出安全软件，把这个目录加入白名单，再重新安装。安装日志：$\r$\n$TEMP\classbeat-install.log"
    cb_nowrite_quit:
    Quit
  cb_write_ok:

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
  ; PowerShell 可能根本起不来：学校组策略、安全软件、以及"禁止脚本宿主"这类
  ; 加固都会让 nsExec 直接回 -1（2026-11-25 本机复现：进程创建就被拦）。
  ; 这时用系统自带的 taskkill 按映像名兜底 —— classbeat.exe 这个名字是本产品
  ; 独有，按名字收不会误伤别的程序；0.3.x 的 pythonw 拿不到命令行，只能靠上面
  ; 那个 ps1，兜底覆盖不到，所以日志里要写清楚。
  StrCmp $1 "0" cb_stop_done 0
    !insertmacro CB_LOG "停旧版没用上 PowerShell，改用 taskkill 兜底"
    nsExec::Exec 'taskkill /F /IM classbeat.exe /T'
    Pop $0
    !insertmacro CB_LOG "taskkill 主程序：退出码=$0（128=没有这个进程，属于正常）"
    ; 0.5.x 的服务是独立进程 classbeat-server.exe，和主程序同名匹配不到，
    ; 必须单独按映像名收 —— 否则它变孤儿进程占着 resources\server 里的文件，
    ; NSIS 覆盖时就会报「无法写入 classbeat-server.exe」（真机实测）。
    nsExec::Exec 'taskkill /F /IM classbeat-server.exe /T'
    Pop $0
    !insertmacro CB_LOG "taskkill 服务：退出码=$0（128=没有这个进程，属于正常）"
  cb_stop_done:
  Sleep 1500
  Delete "$TEMP\cb-stop-legacy.ps1"
  SetOutPath $INSTDIR

  ; ---- 1.1 停完了再看一眼：文件还被占着就到此为止 ----
  ; 这一步是本轮真机反馈的正解。老师双击安装包时，ClassBeat 通常正在跑
  ; （它随开机自启）。旧版必须是「应用内更新」才有机会先退出，手动装包
  ; 只能靠上面那个 ps1 去结束进程；一旦它被组策略或安全软件挡住，
  ; 解压就会在 classbeat.exe 上失败——而 NSIS 只回一句「无法写入文件」，
  ; 更糟的是文件可能已经被截断，老师再点桌面图标就变成
  ; 「此应用无法在你的电脑上运行」，两句话其实是一个原因。
  IfFileExists "$INSTDIR\classbeat.exe" 0 cb_srv_lock_ok
    ClearErrors
    FileOpen $2 "$INSTDIR\classbeat.exe" a
    IfErrors cb_locked
    FileClose $2
    !insertmacro CB_LOG "占用检查：classbeat.exe 没有被占用"
    ; 不跳过服务检查：两个都占着时，主程序检查通过也要继续看服务
  cb_srv_lock_ok:
  ; 0.5.x 的服务也占着 resources\server\classbeat-server.exe，一并检查。
  IfFileExists "$INSTDIR\resources\server\classbeat-server.exe" 0 cb_lock_ok
    ClearErrors
    FileOpen $2 "$INSTDIR\resources\server\classbeat-server.exe" a
    IfErrors cb_locked_srv
    FileClose $2
    !insertmacro CB_LOG "占用检查：classbeat-server.exe 没有被占用"
    Goto cb_lock_ok
  cb_locked_srv:
    !insertmacro CB_LOG "!!! classbeat-server.exe 仍被占用，停止安装"
    FileClose $9
    IfSilent cb_lock_srv_quit
      MessageBox MB_ICONEXCLAMATION|MB_OK "ClassBeat 的后台服务还占着程序文件，装不进去。$\r$\n$\r$\n最常见的原因是 ClassBeat 还在运行（后台服务不会随托盘退出自动停）。$\r$\n$\r$\n请这样处理：$\r$\n1. 重启电脑（最稳妥，会清掉后台服务）；$\r$\n2. 然后重新双击安装包。$\r$\n$\r$\n安装日志：$TEMP\classbeat-install.log"
    cb_lock_srv_quit:
    Quit
  cb_locked:
    !insertmacro CB_LOG "!!! classbeat.exe 仍被占用，停止安装"
    FileClose $9
    IfSilent cb_lock_quit
      MessageBox MB_ICONEXCLAMATION|MB_OK "ClassBeat 的程序文件正被占用，装不进去。$\r$\n$\r$\n最常见的原因是 ClassBeat 还在运行；也可能是安全软件正在扫描这个文件。$\r$\n$\r$\n请这样处理：$\r$\n1. 看屏幕右下角的托盘区，右键 ClassBeat 的小图标 → 退出；$\r$\n2. 如果找不到图标，就重启电脑；$\r$\n3. 然后重新双击安装包。$\r$\n$\r$\n现在就停下，是为了避免把主程序写成半截——那样双击图标只会得到「此应用无法在你的电脑上运行」。$\r$\n$\r$\n安装日志：$TEMP\classbeat-install.log"
    cb_lock_quit:
    Quit
  cb_lock_ok:

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
  ;
  ; 图标用独立的 .ico 文件，不从 exe 取：NSIS 覆盖安装后 exe 路径没变，
  ; Windows 按路径缓存了旧版图标（0.5.1 重绘过 ico，但桌面快捷方式仍显示旧的）。
  ; .ico 文件每次安装都覆盖，再刷一次图标缓存，系统就会重读。
  SetOutPath $INSTDIR
  File /oname=classbeat.ico "${CB_ICON}"
  CreateShortCut "$DESKTOP\ClassBeat.lnk" "$INSTDIR\classbeat.exe" "" "$INSTDIR\classbeat.ico" 0
  !insertmacro CB_LOG "已建桌面图标（读 classbeat.ico，不靠 exe 缓存）"
  ; 刷新 Windows 图标缓存：覆盖安装后系统仍按路径缓存旧图标。
  ; ie4uinit.exe -show 是 Win10/11 的标准刷新命令。
  nsExec::Exec 'ie4uinit.exe -show'

  ; ---- 5. 装完自检：主程序必须真的在 $INSTDIR 里 ----
  ; 这条是为了让"装完了却没有 exe"这种失败当场暴露（踩过一次：
  ; PREINSTALL 里 SetOutPath $TEMP 没复位，几百个 File 全解到 %TEMP%）——
  ; 有卸载项、有注册表、就是没主程序，最坏的情况是老师双击没反应。
  IfFileExists "$INSTDIR\classbeat.exe" cb_main_ok 0
    !insertmacro CB_LOG "!!! 严重：$INSTDIR\classbeat.exe 不存在，安装不完整"
    MessageBox MB_ICONSTOP|MB_OK "安装不完整：$\r$\n$INSTDIR\classbeat.exe$\r$\n不存在。$\r$\n$\r$\n请先卸载再重新安装，安装日志在：$\r$\n$TEMP\classbeat-install.log"
    Goto cb_main_done
  cb_main_ok:
    ; 文件在 ~ 4 MB，明显小于这个数就是「写了一半」——多半是解压时被杀软
    ; 或占用打断。这种 exe 双击只会得到「此应用无法在你的电脑上运行」，
    ; 必须当场说清楚，不能让老师拿着一个残缺程序去猜。
    FileOpen $2 "$INSTDIR\classbeat.exe" r
    IfErrors cb_main_size_ok
    FileSeek $2 0 END $3
    FileClose $2
    !insertmacro CB_LOG "主程序大小：$3 字节"
    IntCmp $3 1000000 cb_main_small cb_main_small cb_main_size_ok
  cb_main_small:
    !insertmacro CB_LOG "!!! 主程序不完整（$3 字节），安装被中断"
    MessageBox MB_ICONSTOP|MB_OK "主程序没写完整（只有 $3 字节），现在打开会提示「此应用无法在你的电脑上运行」。$\r$\n$\r$\n请先退出 ClassBeat，并按日志里的提示排除安全软件拦截，然后重新运行安装包。$\r$\n$\r$\n安装日志：$TEMP\classbeat-install.log"
    Goto cb_main_done
  cb_main_size_ok:
    !insertmacro CB_LOG "主程序已就位"
  cb_main_done:

  ; ---- 5.2 清掉 0.4.x 残留的 Python ----
  ; NSIS 是覆盖安装：新包里没有的文件它**不会删**。0.4.x 的
  ; resources\python 是 22 MB 的捆绑运行时，不清就会一直躺在老师机器上
  ; （本机实测：0.5.0 装完安装目录 29 MB，其中 22 MB 是这个目录）。
  ; 上面 §2 的整目录删除只认 0.3.x 的布局（$INSTDIR\server\），
  ; 0.4.x 起服务在 $INSTDIR\resources\server\，所以那条判断命中不了。
  ; 只删 python 与 .py，不碰 app/、data/、sample/ 与 build-info.json。
  RMDir /r "$INSTDIR\resources\python"
  Delete "$INSTDIR\resources\server\*.py"
  RMDir /r "$INSTDIR\resources\server\__pycache__"
  !insertmacro CB_LOG "已清理 0.4.x 残留的 Python 运行时与脚本"

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
