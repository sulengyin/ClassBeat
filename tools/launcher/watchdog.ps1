# ============================================================
# ClassBeat 大屏看门狗（页面被误关后自动拉起）
# ------------------------------------------------------------
# 判据（重要）：
#   1) 主判据：进程（chrome / msedge 等）的主窗口标题包含「班级节律屏」。
#      kiosk 模式下窗口标题仍然是网页标题，所以用它判断页面在不在。
#   2) 兜底判据：浏览器进程命令行里同时含 --kiosk 和 127.0.0.1:<端口>。
#      （Chrome 已开时新进程可能转发给旧实例后退出，所以命令行只作兜底。）
# 连续 2 次判定缺失才重启，避免瞬时误判。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File watchdog.ps1
#   powershell -ExecutionPolicy Bypass -File watchdog.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File watchdog.ps1 -MaxRounds 1 -IntervalSeconds 1
# ============================================================

param(
  [int]$Port = 8765,
  [int]$IntervalSeconds = 5,
  [int]$MaxRounds = 0,
  [string[]]$BrowserNames = @('chrome', 'msedge'),
  [string]$TitlePattern = '班级节律屏',
  [string]$LauncherPath = '',
  [switch]$DryRun,
  [int]$MaxRestartsPerMinute = 3,
  [int]$CooldownSeconds = 300,
  [int]$MissThreshold = 2
)

$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$logPath = Join-Path $scriptDir 'watchdog.log'
$stopFlag = Join-Path $scriptDir 'stop.flag'
$logMaxBytes = 512 * 1024

if ($LauncherPath -eq '') {
  $LauncherPath = Join-Path $scriptDir 'start-kiosk.ps1'
}

function Write-Log([string]$msg) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $msg
  if ($DryRun) { Write-Output ('[DRYRUN] ' + $line) }
  try {
    if ((Test-Path $logPath) -and ((Get-Item $logPath).Length -gt $logMaxBytes)) {
      Move-Item -Path $logPath -Destination ($logPath + '.old') -Force
    }
    # 不用 Add-Content：PowerShell 5.1 在文件不可写时会抛不可捕获的 CLR 异常并杀掉进程。
    [System.IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($true)))
  } catch { }
}

function Test-AppWindow {
  foreach ($name in $BrowserNames) {
    $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    foreach ($p in $procs) {
      if ($p.MainWindowTitle -and $p.MainWindowTitle -match $TitlePattern) { return $true }
    }
  }
  $needle = '127.0.0.1:' + $Port
  foreach ($name in $BrowserNames) {
    $filter = "Name='" + $name + ".exe'"
    try {
      $procs = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop)
      foreach ($p in $procs) {
        $cmd = [string]$p.CommandLine
        if ($cmd -match '--kiosk' -and $cmd -like ('*' + $needle + '*')) { return $true }
      }
    } catch { }
  }
  return $false
}

function Test-ShutdownOrLogoff {
  # 判据：出现 LogonUI（锁屏 / 登录 / 关机界面），或 explorer 已退出（注销中）。
  # 这里宁可少拉起一次，也不和系统关机抢资源。
  $logon = @(Get-Process -Name 'LogonUI' -ErrorAction SilentlyContinue)
  if ($logon.Count -gt 0) { return $true }
  $explorer = @(Get-Process -Name 'explorer' -ErrorAction SilentlyContinue)
  if ($explorer.Count -eq 0) { return $true }
  return $false
}

$restarts = New-Object System.Collections.ArrayList
$miss = 0
$round = 0
$wasPresent = $null
$lastSkipReason = ''

Write-Log ('看门狗启动：端口 ' + $Port + '，间隔 ' + $IntervalSeconds + 's，判据标题「' + $TitlePattern + '」')
Write-Log ('重启命令：powershell -ExecutionPolicy Bypass -File "' + $LauncherPath + '"')
if ($DryRun) { Write-Log 'DRYRUN 模式：只判定，不启动任何进程。' }

while ($true) {
  $round = $round + 1

  if (Test-Path $stopFlag) {
    try { Remove-Item -Path $stopFlag -Force -ErrorAction Stop } catch { }
    Write-Log '发现 stop.flag，正常退出（已删除标记）。'
    exit 0
  }

  if (Test-ShutdownOrLogoff) {
    if ($lastSkipReason -ne 'shutdown') {
      Write-Log '检测到锁屏 / 注销 / 关机中，暂停拉起。'
      $lastSkipReason = 'shutdown'
    }
    $miss = 0
  } else {
    $lastSkipReason = ''
    $present = Test-AppWindow
    if ($present) {
      if ($wasPresent -ne $true) { Write-Log '页面存在。' }
      $wasPresent = $true
      $miss = 0
    } else {
      $wasPresent = $false
      $miss = $miss + 1
      Write-Log ('未检测到页面（第 ' + $miss + ' 次，阈值 ' + $MissThreshold + '）。')
      if ($miss -ge $MissThreshold) {
        $now = Get-Date
        $recent = @($restarts | Where-Object { ($now - $_).TotalSeconds -lt 60 })
        if ($recent.Count -ge $MaxRestartsPerMinute) {
          Write-Log ('一分钟内已重启 ' + $recent.Count + ' 次，达到上限 ' + $MaxRestartsPerMinute + '，暂停 ' + $CooldownSeconds + ' 秒。')
          Start-Sleep -Seconds $CooldownSeconds
          $restarts.Clear()
          $miss = 0
        } else {
          if ($DryRun) {
            Write-Log ('DRYRUN：如果真跑，这里会执行：powershell -ExecutionPolicy Bypass -File "' + $LauncherPath + '"')
          } else {
            Write-Log ('执行重启：powershell -ExecutionPolicy Bypass -File "' + $LauncherPath + '"')
            try {
              Start-Process -FilePath 'powershell.exe' `
                -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $LauncherPath) `
                -WindowStyle Hidden | Out-Null
            } catch {
              Write-Log ('重启失败：' + $_.Exception.Message)
            }
          }
          [void]$restarts.Add($now)
          $miss = 0
        }
      }
    }
  }

  if ($MaxRounds -gt 0 -and $round -ge $MaxRounds) {
    Write-Log ('达到 -MaxRounds=' + $MaxRounds + '，退出。')
    exit 0
  }
  Start-Sleep -Seconds $IntervalSeconds
}
