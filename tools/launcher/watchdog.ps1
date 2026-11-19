# ============================================================
# ClassBeat 大屏看门狗（节律时刻弹屏版，2026-11-19 真机反馈 ①）
# ------------------------------------------------------------
# 行为模型（与 0.3.8 及之前的「页面没了就重拉」完全不同）：
#   1) 开机第一屏：看门狗刚被自启拉起时，大屏窗口不在就拉一次——
#      「打开电脑」这个动作本身就该见到大屏。
#   2) 之后只在「节律时刻」行动：课间（break）与眼保健操/大课间
#      （ritual）开始那一刻——窗口在就带到前台，不在就拉起。
#   3) 其余时间（上课、午间、放学后）无论大屏开没开、老师用不用
#      浏览器，一律不打扰、不抢屏、不自动拉起。老师关掉的大屏要
#      到下一个节律时刻才会回来；想立刻回来双击「打开大屏.bat」。
#   4) 作息依据来自大屏自己落盘的配置快照（backups/config/rhythm-
#      日期.json，每 10 秒同步一次）。快照读不到/解析不了 → 不弹。
#      周末与节假日（快照里 calendar 标了 holiday）不弹。
#
# 判据（与 0.3.7 相同）：
#   主判据：任意可见顶层窗口的标题包含「班级节律屏」（共享助手
#   win-titles.ps1 枚举，不依赖谁是进程主窗口）；命令行判据兜底。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File watchdog.ps1
#   powershell -ExecutionPolicy Bypass -File watchdog.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File watchdog.ps1 -SelfTest `
#       -BackupDir <临时快照目录> -TodayStr 2026-11-23   # 冒烟自检
# ============================================================

param(
  [int]$Port = 8765,
  [int]$IntervalSeconds = 20,
  [string[]]$BrowserNames = @('chrome', 'msedge'),
  [string]$TitlePattern = '班级节律屏',
  [string]$LauncherPath = '',
  [switch]$DryRun,
  # 哪些时段开始时要弹屏：课间 break、眼保健操/大课间 ritual
  # （真机反馈 2026-11-19：只需要这两个瞬间，其余时间不打扰）
  [string[]]$PopTypes = @('break', 'ritual'),
  # 容错窗口：轮询间隔可能刚好跨过开始那一分钟，给 3 分钟余量，
  # 一个时刻只弹一次（不做迟到补弹——错过 3 分钟就等下一个时刻）
  [int]$PopWindowMinutes = 3,
  [string]$BackupDir = '',
  [switch]$SelfTest,
  [string]$TodayStr = ''
)

$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$logPath = Join-Path $scriptDir 'watchdog.log'
$stopFlag = Join-Path $scriptDir 'stop.flag'
$logMaxBytes = 512 * 1024

if ($LauncherPath -eq '') {
  $LauncherPath = Join-Path $scriptDir 'start-kiosk.ps1'
}

# 项目根（tools\launcher -> 包根），配置快照在 <根>\backups\config
$pkgRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ($BackupDir -eq '') {
  $BackupDir = Join-Path $pkgRoot 'backups\config'
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
  if ($DryRun -or $SelfTest) { Write-Output $line }
}

function Find-AppWindowTitles {
  # 枚举所有可见顶层窗口标题（共享助手 win-titles.ps1）
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
  # 这里宁可少弹一次，也不和系统关机抢资源。
  $logon = @(Get-Process -Name 'LogonUI' -ErrorAction SilentlyContinue)
  if ($logon.Count -gt 0) { return $true }
  $explorer = @(Get-Process -Name 'explorer' -ErrorAction SilentlyContinue)
  if ($explorer.Count -eq 0) { return $true }
  return $false
}

function Get-CBScheduleInfo {
  # 找最新一份配置快照（rhythm-<日期>.json，文件名字典序即时间序）。
  # 读不到返回 $null——没有作息依据就绝不弹屏。
  try {
    if (-not (Test-Path $BackupDir)) { return $null }
    $files = @(Get-ChildItem -Path $BackupDir -Filter 'rhythm-*.json' -File `
      -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
    if ($files.Count -lt 1) { return $null }
    $fp = $files[0]
    $raw = [System.IO.File]::ReadAllText($fp.FullName)
    $obj = $raw | ConvertFrom-Json
    return @{ Path = $fp.FullName; Mtime = $fp.LastWriteTime; Obj = $obj }
  } catch {
    return $null
  }
}

function Get-CBPopMoments {
  # 从快照里抽出今天要弹屏的时刻（break/ritual 的开始时间）。
  # 假日不弹；周末默认不弹，除非日历把那天标成了 school。
  # 解析不了返回 $null（区别于"今天没有时刻"的空数组）。
  param($Info, [string]$ForDay)
  if ($Info -eq $null) { return $null }
  try {
    $tt = $Info.Obj.config.timetable
    if ($tt -eq $null -or $tt.blocks -eq $null) { return $null }

    $kind = ''
    try {
      $day = $Info.Obj.config.calendar.days.$ForDay
      if ($day -ne $null) { $kind = [string]$day.kind }
    } catch { }
    $dow = [datetime]::ParseExact($ForDay, 'yyyy-MM-dd', $null).DayOfWeek
    $isWeekend = ($dow -eq [System.DayOfWeek]::Saturday -or $dow -eq [System.DayOfWeek]::Sunday)
    if ($kind -eq 'holiday') { return ,@() }
    if ($isWeekend -and $kind -ne 'school') { return ,@() }

    $out = @()
    foreach ($b in $tt.blocks) {
      if ($b -eq $null) { continue }
      if ($PopTypes -notcontains [string]$b.type) { continue }
      $parts = ([string]$b.start).Split(':')
      if ($parts.Count -lt 2) { continue }
      $h = 0; $m = 0
      if (-not [int]::TryParse($parts[0], [ref]$h)) { continue }
      if (-not [int]::TryParse($parts[1], [ref]$m)) { continue }
      $out += @{
        Key = $ForDay + 'T' + $b.start + '#' + $b.type
        Minutes = $h * 60 + $m
        Start = [string]$b.start
        Name = [string]$b.name
        Type = [string]$b.type
      }
    }
    # 逗号包一层：PS 会把空数组拆成 $null，这里要保住“今天没有时刻”与
    # “解析失败（$null）”的区别
    return ,$out
  } catch {
    return $null
  }
}

function Start-KioskHidden {
  if ($DryRun) {
    Write-Log ('DRYRUN：如果真跑，这里会执行：powershell -ExecutionPolicy Bypass -File "' + $LauncherPath + '"')
    return
  }
  Write-Log ('执行拉起：powershell -ExecutionPolicy Bypass -File "' + $LauncherPath + '"')
  try {
    Start-Process -FilePath 'powershell.exe' `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $LauncherPath) `
      -WindowStyle Hidden | Out-Null
  } catch {
    Write-Log ('拉起失败：' + $_.Exception.Message)
  }
}

# ---------- 自检模式（冒烟工作流用）：只解析作息并打印，不进主循环 ----------
if ($SelfTest) {
  $info = Get-CBScheduleInfo
  if ($info -eq $null) { Write-Output 'SELFTEST no-schedule'; exit 2 }
  $day = if ($TodayStr -ne '') { $TodayStr } else { (Get-Date).ToString('yyyy-MM-dd') }
  $ms = Get-CBPopMoments -Info $info -ForDay $day
  if ($ms -eq $null) { Write-Output ('SELFTEST parse-error day=' + $day); exit 3 }
  Write-Output ('SELFTEST day=' + $day + ' count=' + $ms.Count)
  foreach ($m in $ms) {
    Write-Output ('SELFTEST ' + $m.Key + ' minutes=' + $m.Minutes + ' type=' + $m.Type + ' name=' + $m.Name)
  }
  exit 0
}

# 与 start-kiosk.ps1 同一个坑：代理工具同时写 HTTPS_PROXY 和 https_proxy 时，
# env: 枚举和这里的拉起 Start-Process 都会撞键抛异常。
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
    Write-Log ('环境变量去重失败：' + $_.Exception.Message + '（继续，能弹则弹）')
  }
}

# 上次「退出大屏」可能留下 stop.flag（看门狗当时没在跑，没人消费它）。
# 看门狗刚启动时应清掉它，否则会误以为被叫停而直接退出。
if (Test-Path $stopFlag) {
  try {
    Remove-Item $stopFlag -Force -ErrorAction Stop
    Write-Log '清除遗留的 stop.flag（上次退出大屏时留下）。'
  } catch { }
}

Write-Log ('看门狗启动（节律时刻弹屏模式）：弹屏类型 ' + ($PopTypes -join '/') +
  '，容错 ' + $PopWindowMinutes + ' 分钟，快照目录 ' + $BackupDir)

# 开机第一屏：自启拉起看门狗时，大屏不在就先拉一次。之后进主循环，
# 只在节律时刻行动（上课期间无论用不用浏览器都不抢屏）。
if (-not (Test-ShutdownOrLogoff) -and -not (Test-AppWindow)) {
  Write-Log '看门狗启动时大屏不在：先拉起一次（开机第一屏）。'
  Start-KioskHidden
} else {
  Write-Log '看门狗启动时大屏已在（或正在锁屏/注销），不重复拉。'
}

$fired = @{}
$lastCacheKey = ''
$moments = $null
$lastSkipReason = ''
$round = 0

while ($true) {
  $round = $round + 1

  if (Test-Path $stopFlag) {
    try { Remove-Item -Path $stopFlag -Force -ErrorAction Stop } catch { }
    Write-Log '发现 stop.flag，正常退出（已删除标记）。'
    exit 0
  }

  if (Test-ShutdownOrLogoff) {
    if ($lastSkipReason -ne 'shutdown') {
      Write-Log '检测到锁屏 / 注销 / 关机中，暂停弹屏。'
      $lastSkipReason = 'shutdown'
    }
  } else {
    $lastSkipReason = ''
    $now = Get-Date
    $today = if ($TodayStr -ne '') { $TodayStr } else { $now.ToString('yyyy-MM-dd') }

    # 快照变了（文件更新 / 换了文件 / 换了天）才重新解析作息
    $info = Get-CBScheduleInfo
    $cacheKey = ''
    if ($info -ne $null) { $cacheKey = $info.Path + '|' + $info.Mtime.Ticks + '|' + $today }
    if ($cacheKey -ne '' -and $cacheKey -ne $lastCacheKey) {
      $moments = Get-CBPopMoments -Info $info -ForDay $today
      $lastCacheKey = $cacheKey
      $fired.Clear()
      if ($moments -eq $null) {
        Write-Log '作息快照解析失败（没有 backups/config 或格式不对），今天不自动弹屏。'
      } elseif ($moments.Count -eq 0) {
        Write-Log ('今天（' + $today + '）是假日/周末，不弹屏。')
      } else {
        $names = @($moments | ForEach-Object { $_.Start + ' ' + $_.Name })
        Write-Log ('今天的节律时刻（' + $moments.Count + ' 个）：' + ($names -join '、'))
      }
    } elseif ($info -eq $null -and $moments -ne $null) {
      $moments = $null
      $lastCacheKey = ''
      Write-Log '配置快照目录没了（可能是数据被清），停止自动弹屏。'
    }

    # 到点了吗：开始时刻落在容错窗口内、且这个时刻今天还没弹过
    $nowMin = $now.Hour * 60 + $now.Minute
    $due = $null
    if ($moments) {
      foreach ($mo in $moments) {
        if ($fired.ContainsKey($mo.Key)) { continue }
        $delta = $nowMin - $mo.Minutes
        if ($delta -ge 0 -and $delta -lt $PopWindowMinutes) { $due = $mo; break }
      }
    }
    if ($due -ne $null) {
      $fired[$due.Key] = $true
      if ($fired.Count -gt 120) { $fired.Clear() }   # 换天/异常多的兜底，防内存涨
      $present = Test-AppWindow
      if ($present) {
        $ok = Show-CBWindowByTitle -Pattern $TitlePattern
        if ($ok) {
          Write-Log ('节律时刻 ' + $due.Start + '（' + $due.Name + '）：大屏已在，已带到前台。')
        } else {
          Write-Log ('节律时刻 ' + $due.Start + '（' + $due.Name + '）：大屏已在，置前没成功（前台锁），不影响页面内容。')
        }
      } else {
        Write-Log ('节律时刻 ' + $due.Start + '（' + $due.Name + '）：大屏不在，拉起。')
        Start-KioskHidden
      }
    }
  }

  Start-Sleep -Seconds $IntervalSeconds
}
