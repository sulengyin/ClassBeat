# ============================================================
# ClassBeat 开机自启安装 / 卸载
# ------------------------------------------------------------
# 只在当前用户启动文件夹里放一个快捷方式，不动注册表、不需要管理员权限。
# 自启的是看门狗（watchdog.ps1）：它常驻并负责「服务在不在 + 页面在不在」，
# 页面被关掉时再由它调用 start-kiosk.ps1 拉起来。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1            # 安装（会先确认）
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove    # 卸载
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -DryRun    # 只看会写到哪里
# ============================================================

param(
  [switch]$Remove,
  [switch]$DryRun,
  [switch]$Yes,
  [string]$TargetScript = ''
)

$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
if ($TargetScript -eq '') {
  $TargetScript = Join-Path $scriptDir 'watchdog.ps1'
}

$startupDir = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startupDir 'ClassBeat 大屏自动恢复.lnk'

# 桌面图标：老师眼里「桌面上一个图标，双击就开」。包根下有
# 「大屏全屏.bat」才建（仓库源码里没有，安静跳过不影响自启）。
$pkgRoot = Split-Path -Parent $scriptDir
$kioskBat = Join-Path $pkgRoot '大屏全屏.bat'
$icoPath = Join-Path $scriptDir 'classbeat.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$deskLnk = Join-Path $desktop '班级节律屏.lnk'

Write-Output '本次要操作的路径：'
Write-Output ('  启动文件夹：' + $startupDir)
Write-Output ('  快捷方式：  ' + $lnkPath)
Write-Output ('  桌面图标：  ' + $deskLnk)

if (-not $Remove) {
  Write-Output ('  目标程序：  powershell.exe')
  Write-Output ('  目标脚本：  ' + $TargetScript)
  Write-Output ('  参数：      -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $TargetScript + '"')
}

if ($DryRun) {
  if ($Remove) {
    Write-Output '[DRYRUN] 会删除上面的快捷方式与桌面图标（如果存在）。'
  } else {
    Write-Output '[DRYRUN] 会写入上面的快捷方式与桌面图标，内容就是上面打印的目标程序与参数。'
  }
  exit 0
}

if ($Remove) {
  if (Test-Path $lnkPath) {
    try {
      Remove-Item -Path $lnkPath -Force -ErrorAction Stop
      Write-Output '已删除开机自启快捷方式。'
    } catch {
      Write-Output ('删除失败：' + $_.Exception.Message)
      exit 1
    }
  } else {
    Write-Output '没有找到该快捷方式，可能从未安装。'
  }
  if (Test-Path $deskLnk) {
    Remove-Item -Path $deskLnk -Force -ErrorAction SilentlyContinue
    Write-Output '已删除桌面图标。'
  }
  exit 0
}

if (-not $Yes) {
  $answer = Read-Host '确认写入上面的快捷方式吗？输入 y 继续'
  if ($answer -ne 'y' -and $answer -ne 'Y') {
    Write-Output '已取消，没有写入任何文件。'
    exit 0
  }
}

if (-not (Test-Path $TargetScript)) {
  Write-Output ('找不到目标脚本：' + $TargetScript)
  exit 1
}
if (-not (Test-Path $startupDir)) {
  Write-Output ('启动文件夹不存在：' + $startupDir)
  exit 1
}

try {
  $wsh = New-Object -ComObject WScript.Shell
  $sc = $wsh.CreateShortcut($lnkPath)
  $sc.TargetPath = 'powershell.exe'
  $sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $TargetScript + '"'
  $sc.WorkingDirectory = $scriptDir
  $sc.Description = 'ClassBeat 大屏自动恢复'
  $sc.Save()
  Write-Output '已写入开机自启快捷方式。'
  Write-Output '下次登录 Windows 时会自动启动看门狗；要撤销请执行：'
  Write-Output ('  powershell -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Remove')
} catch {
  Write-Output ('写入失败：' + $_.Exception.Message)
  exit 1
}

# 桌面图标：双击直接全屏大屏；缺文件就跳过，不影响自启
try {
  if (Test-Path $kioskBat) {
    $dsc = $wsh.CreateShortcut($deskLnk)
    $dsc.TargetPath = $kioskBat
    $dsc.WorkingDirectory = $pkgRoot
    $dsc.Description = '打开班级节律屏（全屏）'
    if (Test-Path $icoPath) { $dsc.IconLocation = $icoPath }
    $dsc.Save()
    Write-Output ('已写入桌面图标：' + $deskLnk)
  } else {
    Write-Output '没有找到「大屏全屏.bat」，跳过桌面图标（不影响开机自启）。'
  }
} catch {
  Write-Output ('桌面图标写入失败（不影响开机自启）：' + $_.Exception.Message)
}
