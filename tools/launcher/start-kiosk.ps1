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
