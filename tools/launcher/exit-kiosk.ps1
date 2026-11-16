# ============================================================
# ClassBeat 逃生门：把大屏从 kiosk 全屏里退出来
# ------------------------------------------------------------
# kiosk 模式没有地址栏、没有标签页、没有关闭按钮——老师必须
# 有一个固定出口。这就是那个出口：不可配置、不依赖任何路径
# （ROADMAP 9.9 的硬边界）。
#
# 顺序很重要：
#   1) 先写 stop.flag 让看门狗停手（它看到 flag 会删掉它并退出）；
#      等 flag 被消费了再关窗口，否则看门狗会把页面又拉回来。
#   2) 看门狗没在跑时没人消费 flag，等不到就超时继续关——
#      遗留的 flag 由 start-kiosk.ps1 下次启动时清掉。
#   3) 关窗口先温和（CloseMainWindow），3 秒没关掉才硬停。
#      只关属于大屏的窗口（判据与 watchdog.ps1 一致），
#      老师自己开的其他浏览器窗口不碰。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File exit-kiosk.ps1
#   powershell -ExecutionPolicy Bypass -File exit-kiosk.ps1 -DryRun
# ============================================================

param(
  [int]$Port = 8765,
  [switch]$DryRun,
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$logPath = Join-Path $scriptDir 'exit-kiosk.log'
$stopFlag = Join-Path $scriptDir 'stop.flag'
$logMaxBytes = 512 * 1024

function Write-Log([string]$msg) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $msg
  if ($DryRun) {
    Write-Output ('[DRYRUN] ' + $line)
    return
  }
  try {
    if ((Test-Path $logPath) -and ((Get-Item $logPath).Length -gt $logMaxBytes)) {
      Move-Item -Path $logPath -Destination ($logPath + '.old') -Force
    }
    # 不用 Add-Content：PowerShell 5.1 在文件不可写时会抛不可捕获的 CLR 异常并杀掉进程。
    [System.IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($true)))
  } catch { }
  if (-not $Quiet) { Write-Output $line }
}

# 与 watchdog.ps1 同一套判据：窗口标题带「班级节律屏」，
# 或命令行同时含 --kiosk 与 127.0.0.1:<端口>。返回命中的进程列表。
function Find-KioskProcess([int]$p) {
  $hits = New-Object System.Collections.ArrayList
  $needle = '127.0.0.1:' + $p
  foreach ($name in @('chrome', 'msedge')) {
    foreach ($proc in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
      $titleHit = ($proc.MainWindowTitle -and $proc.MainWindowTitle -match '班级节律屏')
      if ($titleHit) { [void]$hits.Add(@{ Proc = $proc; ByTitle = $true }) }
    }
    try {
      $filter = "Name='" + $name + ".exe'"
      foreach ($proc in @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop)) {
        $cmd = [string]$proc.CommandLine
        if ($cmd -match '--kiosk' -and $cmd -like ('*' + $needle + '*')) {
          $pid2 = [int]$proc.ProcessId
          $already = $false
          foreach ($h in $hits) { if ([int]$h.Proc.Id -eq $pid2) { $already = $true } }
          if (-not $already) {
            $live = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
            if ($live) { [void]$hits.Add(@{ Proc = $live; ByTitle = $false }) }
          }
        }
      }
    } catch { }
  }
  return $hits
}

# ---------- 1. 先让看门狗停手 ----------
if (-not $DryRun) {
  try {
    [System.IO.File]::WriteAllText($stopFlag, (Get-Date).ToString('s'), (New-Object System.Text.UTF8Encoding($false)))
    Write-Log '已写 stop.flag，等待看门狗退出…'
  } catch {
    Write-Log ('写 stop.flag 失败（看门狗可能不在跑，继续）：' + $_.Exception.Message)
  }
} else {
  Write-Output '[DRYRUN] 将写 stop.flag 并等待看门狗退出。'
}

$watchdogStopped = $false
if (-not $DryRun) {
  # 看门狗默认 5 秒一轮；给 20 秒，足够它看到 flag、写日志、退出。
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path $stopFlag)) { $watchdogStopped = $true; break }
  }
  if ($watchdogStopped) {
    Write-Log '看门狗已退出（flag 被消费）。'
  } else {
    Write-Log '20 秒内没等到看门狗消费 flag（可能没在跑），继续关窗口；遗留 flag 由启动器下次清除。'
  }
}

# ---------- 2. 关掉大屏窗口 ----------
$hits = @(Find-KioskProcess $Port)
if ($hits.Count -eq 0) {
  Write-Log '没找到在跑的大屏 kiosk 窗口。'
  if (-not $DryRun -and -not $Quiet) {
    Write-Output ''
    Write-Output '  没有发现正在运行的大屏全屏窗口。'
    Write-Output '  要回大屏：双击「大屏全屏.bat」或 tools\launcher\start-kiosk.cmd。'
  }
  exit 0
}

foreach ($h in $hits) {
  $proc = $h.Proc
  $how = if ($h.ByTitle) { '按窗口标题' } else { '按命令行' }
  Write-Log ('命中大屏窗口：PID ' + $proc.Id + '（' + $how + '），先尝试温和关闭。')
  if ($DryRun) { continue }
  try {
    [void]$proc.CloseMainWindow()
  } catch { }
}

if (-not $DryRun) {
  Start-Sleep -Seconds 3
  $left = @(Find-KioskProcess $Port)
  foreach ($h in $left) {
    $proc = $h.Proc
    Write-Log ('温和关闭没生效，硬停 PID ' + $proc.Id + '。')
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
  }
  if ($left.Count -gt 0) { Start-Sleep -Seconds 1 }
  $final = @(Find-KioskProcess $Port)
  if ($final.Count -eq 0) {
    Write-Log '大屏窗口已全部关闭，退出 kiosk。'
  } else {
    Write-Log ('仍有 ' + $final.Count + ' 个窗口没关掉，请手动按 Alt+F4 或结束进程。')
  }
} else {
  Write-Output ('[DRYRUN] 命中 ' + $hits.Count + ' 个大屏窗口，真跑时会先温和关闭再兜底硬停。')
}

if (-not $DryRun -and -not $Quiet) {
  Write-Output ''
  Write-Output '  大屏已退出，桌面已回到 Windows。'
  Write-Output '  要回大屏：双击「大屏全屏.bat」或 tools\launcher\start-kiosk.cmd。'
  Write-Output '  想每天开机自动回到大屏：双击「安装开机自启.bat」。'
}
exit 0
