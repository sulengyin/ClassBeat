# ============================================================
# ClassBeat 大屏启动器（kiosk）
# ------------------------------------------------------------
# 作用：确保本地服务在跑，然后用 Chrome / Edge 的 kiosk 模式打开大屏页面。
# 用法：
#   powershell -ExecutionPolicy Bypass -File start-kiosk.ps1
#   powershell -ExecutionPolicy Bypass -File start-kiosk.ps1 -DryRun
# 说明：本脚本不写注册表、不安装任何东西；只按需启动服务与浏览器。
# ============================================================

param(
  [switch]$DryRun,
  [int]$Port = 8765,
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$logPath = Join-Path $scriptDir 'launcher.log'
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

function Fail([string]$msg, [int]$code) {
  Write-Log ('[错误] ' + $msg)
  if ($DryRun) { Write-Output ('[DRYRUN] 真跑时会以退出码 ' + $code + ' 结束') }
  exit $code
}

function Clear-EnvCaseConflicts {
  # 某些代理工具会同时写 HTTPS_PROXY 和 https_proxy。Start-Process 在
  # PowerShell 5.1 里把环境块拷进大小写敏感的字典，撞键直接抛异常
  # （真机反馈 2026-11-16：服务起不来，报「已添加项。字典中的关键字」）。
  # 坑比想的深：这种环境下连 Get-ChildItem env: 都枚举不了（同一个撞键）。
  # 所以先探测 env: 能不能用；不能用就走 Win32 API 读原始环境块，
  # 逐个移除大小写重复的项（Win32 SetEnvironmentVariable 大小写不敏感，
  # 每次只移除块里的一条，各留一份）。只影响本进程与子进程，不改系统设置。
  $probeOk = $true
  try { $null = @(Get-ChildItem env: -ErrorAction Stop | Select-Object -First 1) } catch { $probeOk = $false }
  if ($probeOk) { return }
  Write-Log '环境变量里存在大小写不同的重名（env: 枚举失败），走 Win32 API 去重…'
  try {
    try {
      Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class EnvRaw {
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
    foreach ($n in [EnvRaw]::RawNames()) {
      $k = $n.ToUpperInvariant()
      if ($seen.ContainsKey($k)) { $dups += $n } else { $seen[$k] = $true }
    }
    foreach ($n in $dups) { [EnvRaw]::RemoveName($n) }
    Write-Log ('已移除重名环境变量条目：' + ($dups -join '、') + '（各留一份）')
  } catch {
    Write-Log ('环境变量去重失败：' + $_.Exception.Message + '（继续，能起则起）')
  }
}

Clear-EnvCaseConflicts

# 上次「退出大屏」可能留下 stop.flag（看门狗没在跑时没人消费它）。
# 不清掉的话，本次启动的看门狗会以为自己被叫停，直接退出。
if (Test-Path (Join-Path $scriptDir 'stop.flag')) {
  try {
    Remove-Item (Join-Path $scriptDir 'stop.flag') -Force -ErrorAction Stop
    Write-Log '已清除遗留的 stop.flag。'
  } catch { }
}

# ---------- 1. 定位项目根目录 ----------
$root = Split-Path -Parent $scriptDir            # tools\launcher -> tools
$root = Split-Path -Parent $root                 # tools -> 仓库根
if (-not (Test-Path (Join-Path $root 'server\rhythm_server.py'))) {
  if (Test-Path (Join-Path $scriptDir 'server\rhythm_server.py')) {
    $root = $scriptDir
  } elseif (Test-Path (Join-Path (Split-Path -Parent $scriptDir) 'server\rhythm_server.py')) {
    $root = Split-Path -Parent $scriptDir
  }
}
$serverScript = Join-Path $root 'server\rhythm_server.py'
Write-Log ('项目根目录：' + $root)
if (-not (Test-Path $serverScript)) {
  Fail -msg ('找不到服务入口：' + $serverScript) -code 1
}
Write-Log ('服务入口：' + $serverScript)

# ---------- 1.5 桌面图标自愈 ----------
# 真机反馈 2026-11-19：有的机器是解压文件夹装的，桌面上只有文件夹、
# 没有图标。每次打开大屏时顺手补：桌面缺 ClassBeat.lnk 就建一个，
# 指向「大屏全屏.bat」（与 install-autostart.ps1 同款，幂等、可重入）。
if (-not $DryRun) {
  try {
    $kioskBatHere = Join-Path $root '大屏全屏.bat'
    $desktopDir = [Environment]::GetFolderPath('Desktop')
    if ((Test-Path $kioskBatHere) -and $desktopDir) {
      $deskLnk = Join-Path $desktopDir 'ClassBeat.lnk'
      if (-not (Test-Path $deskLnk)) {
        $wshIcon = New-Object -ComObject WScript.Shell
        $dsc = $wshIcon.CreateShortcut($deskLnk)
        $dsc.TargetPath = $kioskBatHere
        $dsc.WorkingDirectory = $root
        $dsc.Description = '打开班级节律屏（全屏）'
        $icoPath = Join-Path $scriptDir 'classbeat.ico'
        if (Test-Path $icoPath) { $dsc.IconLocation = $icoPath }
        $dsc.Save()
        Write-Log ('桌面图标缺失，已补上：' + $deskLnk)
      }
    }
  } catch {
    Write-Log ('桌面图标自愈失败（不影响大屏）：' + $_.Exception.Message)
  }
}

$span = 9
$ports = @()
for ($i = 0; $i -le $span; $i++) { $ports += ($Port + $i) }

# ---------- 2. 判断服务是否已在跑 ----------
function Test-PortOpen([int]$p) {
  # 先做 300ms 的 TCP 探测：端口没开就直接跳过，避免 HTTP 超时把启动拖慢。
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $p, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(300)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Test-AppPage([int]$p) {
  # 大屏入口是服务自带的 /screen（会 302 到 /app/index.html），不要用 /（那是手机页）。
  if (-not (Test-PortOpen $p)) { return $false }
  try {
    $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $p + '/screen') -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ([int]$r.StatusCode -eq 200 -and ($r.Content -match 'heroMain|班级节律屏')) { return $true }
    return $false
  } catch {
    return $false
  }
}

function Test-PortOccupied([int]$p) {
  # 直接尝试以独占方式绑定端口：能绑上说明没人占；绑不上说明被占用。
  # 比解析 netstat / Get-NetTCPConnection 可靠（某些环境下看不到 LISTENING 行）。
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
    $listener.ExclusiveAddressUse = $true
    $listener.Start()
    return $false
  } catch {
    return $true
  } finally {
    if ($listener -ne $null) { try { $listener.Stop() } catch { } }
  }
}

function Get-PortOwner([int]$p) {
  # 仅用于错误提示里的进程名，取不到就返回 $null（不参与占用判定）。
  try {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($conn -ne $null) {
      $procId = [int]$conn.OwningProcess
      $name = ''
      $cmdLine = ''
      try {
        $wp = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $procId) -ErrorAction Stop
        if ($wp) { $name = [string]$wp.Name; $cmdLine = [string]$wp.CommandLine }
      } catch { }
      return (@{ Pid = $procId; Name = $name; Cmd = $cmdLine })
    }
  } catch { }
  try {
    $lines = & netstat -ano 2>$null
    foreach ($line in $lines) {
      if ($line -match ('^\s*TCP\s+\S+:' + $p + '\s+\S+\s+LISTENING\s+(\d+)\s*$')) {
        $procId = [int]$Matches[1]
        $name = ''
        $cmdLine = ''
        try {
          $wp = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $procId) -ErrorAction Stop
          if ($wp) {
            $name = [string]$wp.Name
            $cmdLine = [string]$wp.CommandLine
          }
        } catch { }
        return (@{ Pid = $procId; Name = $name; Cmd = $cmdLine })
      }
    }
  } catch { }
  return $null
}

function Test-KioskWindow([int]$p) {
  # 与 watchdog.ps1 同一套判据：任意可见窗口的标题带「班级节律屏」，
  # 或命令行同时含 --kiosk 与 127.0.0.1:<端口>。
  # 用途：单实例——窗口已经在了就不开第二个（重复双击、看门狗误拉都到此为止）。
  # 标题判据用共享助手 win-titles.ps1 枚举全部窗口（真机反馈 2026-11-19 ①）：
  # 老师用同一个浏览器开别的网页时，进程的「主窗口」往往不是 kiosk，
  # 只看 MainWindowTitle 会漏判，看门狗就会反复拉起第二个窗口抢屏。
  . (Join-Path $PSScriptRoot 'win-titles.ps1')
  $byTitle = Test-CBWindowTitle '班级节律屏'
  if ($byTitle -ne $null) {
    if ($byTitle) { return $true }
  } else {
    # 兑底：枚举不可用时退回进程主窗口标题（老行为）
    foreach ($name in @('chrome', 'msedge')) {
      foreach ($proc in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
        if ($proc.MainWindowTitle -and $proc.MainWindowTitle -match '班级节律屏') { return $true }
      }
    }
  }
  $needle = '127.0.0.1:' + $p
  foreach ($name in @('chrome', 'msedge')) {
    try {
      $filter = "Name='" + $name + ".exe'"
      foreach ($proc in @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop)) {
        $cmd = [string]$proc.CommandLine
        if ($cmd -match '--kiosk' -and $cmd -like ('*' + $needle + '*')) { return $true }
      }
    } catch { }
  }
  return $false
}

$activePort = 0
foreach ($p in $ports) {
  if (Test-AppPage $p) { $activePort = $p; break }
}

if ($activePort -gt 0) {
  Write-Log ('服务已在运行：http://127.0.0.1:' + $activePort + '/')
} else {
  if (Test-PortOccupied $Port) {
    $owner = Get-PortOwner $Port
    if ($owner -ne $null -and $owner.Cmd -match 'rhythm_server\.py') {
      Fail -msg ('端口 ' + $Port + ' 上已经是本项目的服务（PID ' + $owner.Pid + '，进程 ' + $owner.Name + '），' +
        '但页面探测失败。请查看 server.err.log，或先结束该进程再重试。为了不盲目换端口，这里直接停下。') -code 2
    }
    if ($owner -ne $null) {
      Fail -msg ('端口 ' + $Port + ' 已被其它程序占用（PID ' + $owner.Pid + '，进程 ' + $owner.Name + '）。' +
        '为了不盲目换端口，这里直接停下。请先关掉占用该端口的程序，或手动指定别的 -Port。') -code 2
    }
    Fail -msg ('端口 ' + $Port + ' 已被另一个程序占用（没能取到进程名）。' +
      '为了不盲目换端口，这里直接停下。请先用 netstat -ano 找到占用者并结束它，或手动指定别的 -Port。') -code 2
  }
  Write-Log ('端口 ' + $Port + ' 空闲，需要启动本地服务。')
}

# ---------- 2.5 服务比包旧？程序内更新只换文件不换进程 ----------
# 更新把新版本文件写进磁盘，跑着的服务进程还是旧代码——0.3.17 之前的
# 服务连「重启服务」接口都没有，跨代更新后面板上的按钮亮不起来
# （真机 2026-11-20：更新到 0.3.18 后找不到重启服务）。
# kiosk 启动时对比 /api/version 与包版本：服务旧就换新进程
# （停旧 → 等端口释放 → 掉到下面的正常启动流程）。
# 这样「更新完 → 关掉程序 → 双击桌面图标」就是完整重启，不用碰包内
# 文件；开机自启的机器也会在第二天早上自动完成这次交接。
if ($activePort -gt 0) {
  $pkgVersion = $null
  try {
    $vj = Get-Content (Join-Path $root 'app\version.js') -Raw
    if ($vj -match 'VERSION\s*=\s*"(\d+\.\d+\.\d+)"') { $pkgVersion = $Matches[1] }
  } catch { }
  if ($pkgVersion -ne $null) {
    $srvVersion = $null
    try {
      $v = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $activePort + '/api/version') -TimeoutSec 3
      $srvVersion = [string]$v.version
    } catch { }
    $stale = $true
    if ($srvVersion -match '^\d+\.\d+\.\d+$') {
      try {
        if ([version]$srvVersion -ge [version]$pkgVersion) { $stale = $false }
      } catch { }
    }   # 读不到版本号 / 不是语义版本：按旧处理，宁可多换一次
    if ($stale) {
      Write-Log ('服务版本 ' + $(if ($srvVersion) { $srvVersion } else { '未知' }) + ' 旧于包版本 ' + $pkgVersion + '（更新没换进程），自动重启服务…')
      if ($DryRun) {
        Write-Output ('[DRYRUN] 真跑时会停掉旧服务进程并按新文件重新启动（版本交接）。')
      } else {
        $owner = Get-PortOwner $activePort
        if ($owner -ne $null -and $owner.Cmd -match 'rhythm_server\.py' -and $owner.Cmd -like ('*' + $root + '*')) {
          try {
            Stop-Process -Id $owner.Pid -Force -ErrorAction Stop
            Write-Log ('已停旧服务进程 PID ' + $owner.Pid + '，等端口释放…')
            $freed = $false
            for ($i = 0; $i -lt 20; $i++) {
              Start-Sleep -Milliseconds 500
              if (-not (Test-PortOccupied $activePort)) { $freed = $true; break }
            }
            if ($freed) {
              $activePort = 0   # 掉到下面的正常启动流程：起新服务、等就绪
            } else {
              Write-Log '端口 10 秒没释放，保留旧服务继续（总比没有强）。'
            }
          } catch {
            Write-Log ('停旧服务进程失败：' + $_.Exception.Message + '，保留旧服务继续。')
          }
        } else {
          Write-Log '端口上的服务不是本文件夹的进程，不动它；跳过自动重启。'
        }
      }
    } else {
      Write-Log ('服务版本 ' + $srvVersion + ' 与包一致，不用交接。')
    }
  }
}

# ---------- 3. 找 Python ----------
function Find-Python {
  $cands = @(
    @{ Exe = (Join-Path $root 'server\python\pythonw.exe'); Extra = @() },
    @{ Exe = (Join-Path $root 'python\pythonw.exe'); Extra = @() },
    @{ Exe = (Join-Path $root 'server\python\python.exe'); Extra = @() },
    @{ Exe = (Join-Path $root 'python\python.exe'); Extra = @() }
  )
  foreach ($c in $cands) {
    if (Test-Path $c.Exe) {
      return @{ Exe = $c.Exe; Extra = $c.Extra; Source = '项目自带' }
    }
  }
  $onPath = @('python.exe', 'pythonw.exe')
  foreach ($name in $onPath) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -eq $null) { continue }
    $path = [string]$cmd.Source
    if ($path -match 'WindowsApps') { continue }   # 商店占位符，执行会弹商店，跳过
    try {
      # pythonw.exe 是 GUI 子系统：用 & 调用拿不到可靠的 $LASTEXITCODE，
      # 所以用 Start-Process -Wait 读退出码；也不看 stdout（pythonw 没有输出）。
      $probe = Start-Process -FilePath $path `
        -ArgumentList @('-c', '"import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)"') `
        -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop
      if ($probe.ExitCode -eq 0) {
        return @{ Exe = $path; Extra = @(); Source = '系统 PATH' }
      }
    } catch { }
  }
  $py = Get-Command 'py.exe' -ErrorAction SilentlyContinue
  if ($py -ne $null) {
    try {
      $probe = Start-Process -FilePath $py.Source `
        -ArgumentList @('-3', '-c', '"import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)"') `
        -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop
      if ($probe.ExitCode -eq 0) {
        return @{ Exe = $py.Source; Extra = @('-3'); Source = 'py 启动器' }
      }
    } catch { }
  }
  return $null
}

$python = $null
if ($activePort -eq 0) {
  $python = Find-Python
  if ($python -eq $null) {
    Write-Log '[错误] 没有找到可用的 Python 3（项目自带运行时、系统 PATH、py 启动器都没有）。'
    if ($DryRun) {
      Write-Output '[DRYRUN] 真跑时会在此以退出码 1 结束；下面继续打印浏览器侧的计划。'
    } else {
      exit 1
    }
  } else {
    Write-Log ('Python：' + $python.Exe + '（' + $python.Source + '）')
  }
}

# ---------- 4. 启动服务 ----------
$startedService = $false
if ($activePort -eq 0 -and $python -ne $null) {
  $serviceArgs = @()
  foreach ($e in $python.Extra) { $serviceArgs += $e }
  $serviceArgs += @('"' + $serverScript + '"', '--port', [string]$Port, '--host', '0.0.0.0')
  $outLog = Join-Path $scriptDir 'server.out.log'
  $errLog = Join-Path $scriptDir 'server.err.log'
  $pretty = $python.Exe + ' ' + (($serviceArgs | ForEach-Object { $_ }) -join ' ')

  if ($DryRun) {
    Write-Output ('[DRYRUN] 将启动服务：' + $pretty)
    Write-Output ('[DRYRUN] 工作目录：' + $root)
    Write-Output ('[DRYRUN] 标准输出：' + $outLog)
    Write-Output ('[DRYRUN] 标准错误：' + $errLog)
  } else {
    Write-Log ('启动服务：' + $pretty)
    try {
      $proc = Start-Process -FilePath $python.Exe -ArgumentList $serviceArgs -WorkingDirectory $root `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
      Write-Log ('服务进程已拉起，PID ' + $proc.Id + '，等待端口就绪…')
    } catch {
      Fail -msg ('服务启动失败：' + $_.Exception.Message) -code 4
    }

    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-AppPage $Port) { $activePort = $Port; $startedService = $true; break }
    }
    if ($activePort -eq 0) {
      $tail = ''
      if (Test-Path $errLog) {
        $tail = (Get-Content $errLog -Tail 5 -ErrorAction SilentlyContinue) -join ' / '
      }
      Fail -msg ('服务 15 秒内没有就绪（http://127.0.0.1:' + $Port + '/ 访问不通）。错误日志：' + $tail) -code 4
    }
    Write-Log ('服务就绪：http://127.0.0.1:' + $activePort + '/')
  }
}

if ($DryRun -and $activePort -eq 0) {
  $activePort = $Port
  Write-Output ('[DRYRUN] 服务未启动，以下按端口 ' + $Port + ' 推演浏览器命令。')
}

# ---------- 5. 找浏览器 ----------
function Find-Browser {
  $cands = @(
    @{ Name = 'Chrome'; Exe = (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe') },
    @{ Name = 'Chrome'; Exe = (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe') },
    @{ Name = 'Chrome'; Exe = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe') },
    @{ Name = 'Edge'; Exe = (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe') },
    @{ Name = 'Edge'; Exe = (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe') }
  )
  foreach ($c in $cands) {
    if ($c.Exe -and (Test-Path $c.Exe)) { return $c }
  }
  return $null
}

$browser = Find-Browser
if ($browser -eq $null) {
  Fail -msg '没有找到 Chrome 或 Edge，无法打开 kiosk 窗口。请先安装其中一个浏览器。' -code 3
}
Write-Log ('浏览器：' + $browser.Name + '（' + $browser.Exe + '）')

$url = 'http://127.0.0.1:' + $activePort + '/screen'
$browserArgs = @('--kiosk', $url)
$cmdLine = '"' + $browser.Exe + '" --kiosk ' + $url
Write-Log ('浏览器完整命令行：' + $cmdLine)

if ($DryRun) {
  Write-Output ('[DRYRUN] 将启动浏览器：' + $cmdLine)
  Write-Output '[DRYRUN] 未启动任何进程。'
  Write-Output '[DRYRUN] 单实例：真跑时若已有大屏 kiosk 窗口，不会开第二个。'
  exit 0
}

# ---------- 5.5 单实例 ----------
# kiosk 没有关闭按钮，叠两个全屏窗口只能硬关，所以在这里拦住：
# 重复双击、看门狗误拉，都到这一步为止。
# 2026-11-20：窗口已在时不只是退出——先把窗口还原/置前再走。
# 背景：大屏⋯菜单有了「最小化」，最小化后双击桌面图标是最直接的回来方式。
if (Test-KioskWindow $activePort) {
  Write-Log '检测到大屏 kiosk 窗口已在运行，不开第二个（单实例），把它还原置前。'
  try {
    . (Join-Path $PSScriptRoot 'win-titles.ps1')
    $brought = Show-CBWindowByTitle -Pattern '班级节律屏'
    if ($brought) { Write-Log '已把在跑的大屏窗口带到前台。' }
    else { Write-Log '置前没生效（窗口可能在别的虚拟桌面），页面内容不受影响。' }
  } catch {
    Write-Log ('置前失败（不影响大屏本身）：' + $_.Exception.Message)
  }
  exit 0
}

# ---------- 6. 启动 kiosk ----------
try {
  Start-Process -FilePath $browser.Exe -ArgumentList $browserArgs -WorkingDirectory $root | Out-Null
  Write-Log '已发出 kiosk 启动命令。'
} catch {
  Fail -msg ('浏览器启动失败：' + $_.Exception.Message) -code 3
}

if ($startedService) {
  Write-Log ('本次由启动器拉起了服务（PID 见上），关闭页面不会影响服务与手机通知。')
}
exit 0
