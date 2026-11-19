# ClassBeat 简易安装器：双击 classbeat-setup-x.y.z.exe（7-Zip SFX 自解压）后
# 跑到这里。SFX 壳已把整个包（含免安装 Python）解到临时目录，本脚本
# 所在目录就是包内容根目录，直接安装即可。
# 行为（2026-11-19 真机反馈「依然是压缩文件格式」→ 9.3 第二档简易安装器；
# 同日真机反馈「看门狗换版要重启太麻烦」→ 安装器自动完成交接）：
#   1. 安装到固定目录 %LOCALAPPDATA%\ClassBeat
#      （用户目录，不需要管理员权限，不受 ProgramFiles 写保护）
#   2. 旧安装的 data/、backups/、update-source.txt 原样保留——老师
#      的班级数据、每日快照和自己换的更新源绝不覆盖
#   3. 跑 install-autostart.ps1：开机自启 + 桌面 ClassBeat 图标
#   4. 自动交接看门狗：旧看门狗进程退出（stop.flag 优雅停 + 强制
#      兑底），新看门狗立即在后台接管——装完即生效，不用重启电脑
#
# 参数（给自动化测试用）：
#   -TargetDir <目录>   覆盖安装目标（默认 %LOCALAPPDATA%\ClassBeat）
#   -NoAutostart        只装文件，不写开机自启和桌面图标
#   -NoPause            结束后不停留（CI/自动化）

param(
  [string]$TargetDir = "",
  [switch]$NoAutostart,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------- 黑匣子：全程记录到 %TEMP%\classbeat-install.log ----------
# SFX 壳启动的本脚本有自己的控制台窗口，输出不进调用方的日志；
# 排查安装问题全靠这份 transcript（2026-11-19 冒烟第五轮教训）。
$transcript = Join-Path $env:TEMP 'classbeat-install.log'
try { Start-Transcript -Path $transcript -Force -ErrorAction SilentlyContinue | Out-Null } catch { }

# ---------- 0. 路径 ----------
$src = $PSScriptRoot
if (-not $src) { $src = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $TargetDir) { $TargetDir = Join-Path $env:LOCALAPPDATA 'ClassBeat' }
if (-not (Test-Path (Join-Path $src 'app\index.html'))) {
  Write-Output "安装包不完整：解压内容里没有程序文件。"
  if (-not $NoPause) { Read-Host '按回车退出' | Out-Null }
  exit 1
}

Write-Output '=============================================='
Write-Output ' ClassBeat 安装'
Write-Output (' 安装位置：' + $TargetDir)
Write-Output '=============================================='

# ---------- 0.5 旧看门狗退场 ----------
# 真机反馈 2026-11-19：旧看门狗进程读的是内存里的旧脚本，装完不重启
# 就继续按旧逻辑抢屏。这里自动完成交接：先写 stop.flag 让它优雅停
# （0.3.0 起的看门狗都认这个标记），等几秒，再把没退出的强制结束。
try {
  if (Test-Path $TargetDir) {
    $oldFlagDir = Join-Path $TargetDir 'tools\launcher'
    New-Item -ItemType Directory -Path $oldFlagDir -Force | Out-Null
    Set-Content -Path (Join-Path $oldFlagDir 'stop.flag') -Value 'install-swap' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
  }
  $wdProcs = @(Get-CimInstance Win32_Process -ErrorAction Stop |
    Where-Object { $_.Name -in @('powershell.exe', 'pwsh.exe') -and
                   ([string]$_.CommandLine) -match 'watchdog\.ps1' })
  foreach ($w in $wdProcs) {
    try { Stop-Process -Id $w.ProcessId -Force -ErrorAction Stop } catch { }
  }
  if ($wdProcs.Count -gt 0) {
    Write-Output ('旧看门狗：优雅停指令已发，强制结束 ' + $wdProcs.Count + ' 个残留进程。')
  } else {
    Write-Output '旧看门狗：没有发现正在运行的进程（或已优雅退出）。'
  }
} catch {
  Write-Output ('旧看门狗交接出错（继续安装，下次重启电脑后新看门狗生效）：' + $_.Exception.Message)
}

# ---------- 1. 旧安装的老师数据先搬走 ----------
$keep = @()
if (Test-Path $TargetDir) {
  $tmp = Join-Path $env:TEMP ('classbeat-keep-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  foreach ($name in @('data', 'backups', 'update-source.txt')) {
    $p = Join-Path $TargetDir $name
    if (Test-Path $p) {
      Copy-Item -Path $p -Destination $tmp -Recurse -Force
      $keep += (Join-Path $tmp $name)
    }
  }
  if ($keep.Count -gt 0) {
    Write-Output ('发现旧安装，保留其中的班级数据与设置（' + $keep.Count + ' 项）…')
  }
}

# ---------- 2. 换成新副本 ----------
# 目标目录整个换成新副本（比逐文件覆盖干净：旧版废弃文件不留）。
# 用 robocopy 而不是 Copy-Item：runner 实测 pwsh7 的通配 + 递归
# 组合偶发丢深层文件（server\python\python.exe），robocopy /E 是
# 文件级复制，配合退出码判断（0-7 算成功，>=8 失败）最稳。
if (Test-Path $TargetDir) { Remove-Item -Path $TargetDir -Recurse -Force }
New-Item -ItemType Directory -Path $TargetDir | Out-Null
robocopy $src $TargetDir /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP
Write-Output ('robocopy 退出码 ' + $LASTEXITCODE)
if ($LASTEXITCODE -ge 8) {
  Write-Output ('robocopy 复制失败，退出码 ' + $LASTEXITCODE)
  if (-not $NoPause) { Read-Host '按回车退出' | Out-Null }
  exit 1
}
if (-not (Test-Path (Join-Path $TargetDir 'server\python\python.exe'))) {
  Write-Output '复制后校验失败：server\python\python.exe 不在目标目录。'
  Write-Output ('来源目录 ' + $src + ' 内容：')
  Get-ChildItem $src -Recurse -File | Select-Object -First 10 -ExpandProperty FullName | Write-Output
  if (-not $NoPause) { Read-Host '按回车退出' | Out-Null }
  exit 1
}
Write-Output ('程序文件已就位（' + (Get-ChildItem $TargetDir -Recurse -File).Count + ' 个文件）。')

# ---------- 3. 老师数据放回去 ----------
foreach ($p in $keep) {
  $name = Split-Path -Leaf $p
  Copy-Item -Path $p -Destination (Join-Path $TargetDir $name) -Recurse -Force
}
if ($keep.Count -gt 0) {
  Write-Output '班级数据与设置已恢复。'
}

# ---------- 4. 开机自启 + 桌面图标 ----------
$autostart = Join-Path $TargetDir 'tools\launcher\install-autostart.ps1'
if ((-not $NoAutostart) -and (Test-Path $autostart)) {
  Write-Output '写入开机自启与桌面 ClassBeat 图标…'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $autostart -Yes
  if ($LASTEXITCODE -ne 0) {
    Write-Output '（自启安装没成功，程序本身已装好；稍后可双击「安装开机自启.bat」重试。）'
  }
}

# ---------- 5. 新看门狗立即上岗 ----------
# 与上面的旧看门狗退场配对：装完即生效，不用重启电脑。
# 新看门狗启动时的「开机第一屏」逻辑会把大屏拉起来——装完正好看到效果。
if (-not $NoAutostart) {
  $newWatchdog = Join-Path $TargetDir 'tools\launcher\watchdog.ps1'
  if (Test-Path $newWatchdog) {
    Write-Output '启动新版看门狗（节律时段提醒）…'
    try {
      Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $newWatchdog) `
        -WindowStyle Hidden | Out-Null
      Write-Output '看门狗已在后台接管：只在课间/眼保健操时段提醒一次，其余时间不打扰。'
    } catch {
      Write-Output ('看门狗没启动成功（不影响程序，下次开机会自动运行）：' + $_.Exception.Message)
    }
  }
}

Write-Output ''
Write-Output '=============================================='
Write-Output ('安装完成：' + $TargetDir)
Write-Output '桌面上双击 ClassBeat 图标即可打开大屏。'
Write-Output '=============================================='
try { Stop-Transcript | Out-Null } catch { }
if (-not $NoPause) { Read-Host '按回车退出' | Out-Null }
exit 0
