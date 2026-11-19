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

function Find-AppWindowTitles {
  # 枚举所有可见顶层窗口标题（共享助手 win-titles.ps1，见其头部说明：
  # 2026-11-19 真机反馈 ① 的「大屏不断跳出来」就是主窗口误判导致的）。
  . (Join-Path $PSScriptRoot 'win-titles.ps1')
  return Get-CBWinTitles
}

function Test-AppWindow {
  # 主判据：任意可见窗口的标题带「班级节律屏」（不依赖谁是主窗口）。
  $titles = Find-AppWindowTitles
  if ($titles -ne $null) {
    foreach ($t in $titles) {
      if ($t -and $t -match $TitlePattern) { return $true }
    }
  } else {
    # 兑底：Add-Type 不可用时退回进程主窗口标题（老行为）
    foreach ($name in $BrowserNames) {
      $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
      foreach ($p in $procs) {
        if ($p.MainWindowTitle -and $p.MainWindowTitle -match $TitlePattern) { return $true }
      }
    }
  }
  # 兑底判据：浏览器进程命令行里同时含 --kiosk 和 127.0.0.1:<端口>。
  # （Chrome 已开时新进程可能转发给旧实例后退出，所以命令行只作兑底。）
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

# 老师主动关窗的退避（真机反馈 2026-11-19 ①：老师要用电脑，大屏不断
# 跳出来）。拉起后 90 秒内窗口又没了，多半是老师自己关的，不是误关：
# 暂停检测一段时间再试，逐次翻倍（上限 30 分钟）；期间老师随时双击
# 「打开大屏.bat」就能回来，窗口一出现就清零。误关（窗口稳定存在过
# 一段时间后没了）不受影响，立即恢复。
$userCloseStreak = 0
$pauseUntil = $null
$lastStartAt = $null

Write-Log ('看门狗启动：端口 ' + $Port + '，间隔 ' + $IntervalSeconds + 's，判据标题「' + $TitlePattern + '」')
Write-Log ('重启命令：powershell -ExecutionPolicy Bypass -File "' + $LauncherPath + '"')
if ($DryRun) { Write-Log 'DRYRUN 模式：只判定，不启动任何进程。' }

# 与 start-kiosk.ps1 同一个坑：代理工具同时写 HTTPS_PROXY 和 https_proxy 时，
# env: 枚举和这里的重启 Start-Process 都会撞键抛异常，页面永远拉不回来。
# 先探测 env: 能不能用；不能用就走 Win32 API 读原始环境块去重（各留一份）。
$probeOk = $true
try { $null = @(Get-ChildItem env: -ErrorAction Stop | Select-Object -First 1) } catch { $probeOk = $false }
if (-not $probeOk) {
  Write-Log '环境变量里存在大小写不同的重名（env: 枚举失败），走 Win32 API 去重…'
  try {
    try {
      Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class EnvRawW {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  private static extern IntPtr GetEnvironmentStrings();
  [DllImport("kernel32.dll")]
  private static extern bool FreeEnvironmentStrings(IntPtr l);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  private static extern bool SetEnvironmentVariable(string name, string value);
  public static string[] RawNames() {
    var list = new System.Collections.Generic.List<string>();
    IntPtr p = GetEnvironmentStrings();
    if (p == IntPtr.Zero) return list.ToArray();
    try {
      IntPtr cur = p;
      while (true) {
        string s = Marshal.PtrToStringUni(cur);
        if (s.Length == 0) break;
        if (s.IndexOf('=') > 0) list.Add(s.Substring(0, s.IndexOf('=')));
        cur = (IntPtr)((long)cur + (s.Length + 1) * 2);
      }
    } finally { FreeEnvironmentStrings(p); }
    return list.ToArray();
  }
  public static void RemoveName(string name) { SetEnvironmentVariable(name, null); }
}
"@ -ErrorAction Stop
    } catch { }   # 类型已加载过就算了
    $seen = @{}
    $dups = @()
    foreach ($n in [EnvRawW]::RawNames()) {
      $k = $n.ToUpperInvariant()
      if ($seen.ContainsKey($k)) { $dups += $n } else { $seen[$k] = $true }
    }
    foreach ($n in $dups) { [EnvRawW]::RemoveName($n) }
    Write-Log ('已移除重名环境变量条目：' + ($dups -join '、') + '（各留一份）')
  } catch {
    Write-Log ('环境变量去重失败：' + $_.Exception.Message + '（继续，能拉则拉）')
  }
}

# 上次「退出大屏」可能留下 stop.flag（看门狗当时没在跑，没人消费它）。
# 看门狗刚启动时应清掉它，否则会误以为被叫停而直接退出。
# 退出大屏的正常流程会等看门狗消费完 flag 再关窗口，所以正常路径不会走到这里。
if (Test-Path $stopFlag) {
  try {
    Remove-Item $stopFlag -Force -ErrorAction Stop
    Write-Log '清除遗留的 stop.flag（上次退出大屏时留下）。'
  } catch { }
}

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
      if ($pauseUntil -ne $null) { Write-Log '窗口回来了，清除主动关窗退避。' }
      $pauseUntil = $null
      $userCloseStreak = 0
      $lastStartAt = $null
    } else {
      $wasPresent = $false
      if ($pauseUntil -ne $null -and (Get-Date) -lt $pauseUntil) {
        # 退避中：不检测不拉起，让老师安心用电脑
        $miss = 0
      } else {
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
          } elseif ($lastStartAt -ne $null -and ($now - $lastStartAt).TotalSeconds -lt 90) {
            $userCloseStreak = $userCloseStreak + 1
            $pauseSec = [Math]::Min(1800, 600 * [Math]::Pow(2, $userCloseStreak - 1))
            $pauseUntil = $now.AddSeconds($pauseSec)
            $miss = 0
            Write-Log ('拉起后 90 秒内窗口又没了，疑似老师主动关闭要用电脑：暂停 ' + $pauseSec + ' 秒再试。要用电脑请双击「退出大屏.bat」，恢复大屏双击「打开大屏.bat」。')
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
            $lastStartAt = $now
            $miss = 0
          }
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
