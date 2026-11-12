# ============================================================
# ClassBeat 只读诊断：页面 / 窗口被移动黑板误触关闭
# ------------------------------------------------------------
# 纯只读：不写注册表、不改设置、不装东西、不停服务，只读取并打印。
# 运行方式（二选一）：
#   1) 右键本文件 ->「使用 PowerShell 运行」
#   2) 被执行策略拦住时，在 PowerShell 里执行：
#      powershell -ExecutionPolicy Bypass -File .\detect.ps1
# 输出可以整段复制回给开发者。
# ============================================================

$ErrorActionPreference = 'Continue'
$script:misses = @()
$script:tabletModeValue = $null
$script:edgeSwipeValue = $null
$script:edgeSwipeKeyFound = $false
$script:kioskFound = $false
$script:autoStartFound = $false

function Write-Section([string]$title) {
  Write-Output ""
  Write-Output ("==== " + $title + " ====")
}

function Note-Miss([string]$item, [string]$why) {
  $script:misses += ($item + "：" + $why)
}

Write-Output "ClassBeat 只读诊断（页面被误触关闭）"
Write-Output ("采集时间：" + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
Write-Output ("计算机名：" + $env:COMPUTERNAME)
Write-Output "说明：本脚本只读，不会修改任何设置。"

# ------------------------------------------------------------
Write-Section "1. 系统信息"

try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  Write-Output ("  Windows 版本：" + $os.Caption)
  Write-Output ("  版本号：" + $os.Version)
  Write-Output ("  Build：" + $os.BuildNumber)
} catch {
  Write-Output ("  Windows 版本：读取失败 - " + $_.Exception.Message)
  Note-Miss "系统版本" $_.Exception.Message
}

try {
  Write-Output ("  64 位系统：" + [Environment]::Is64BitOperatingSystem)
} catch {
  Write-Output "  64 位系统：读取失败"
  Note-Miss "64 位系统" $_.Exception.Message
}

try {
  $touchNames = @()
  try {
    $pnpDevices = Get-PnpDevice -ErrorAction Stop | Where-Object {
      $_.FriendlyName -match '触摸|touch' -and $_.Status -eq 'OK'
    }
    foreach ($d in $pnpDevices) {
      if ($touchNames -notcontains $d.FriendlyName) { $touchNames += $d.FriendlyName }
    }
  } catch { }
  try {
    $pnpEntities = Get-CimInstance Win32_PnPEntity -ErrorAction Stop | Where-Object {
      $_.Name -match '触摸|touch'
    }
    foreach ($p in $pnpEntities) {
      if ($touchNames -notcontains $p.Name) { $touchNames += $p.Name }
    }
  } catch { }
  if ($touchNames.Count -gt 0) {
    foreach ($n in $touchNames) { Write-Output ("  触摸设备：" + $n) }
  } else {
    Write-Output "  触摸设备：未检测到"
  }
} catch {
  Write-Output ("  触摸设备：读取失败 - " + $_.Exception.Message)
  Note-Miss "触摸设备" $_.Exception.Message
}

# ------------------------------------------------------------
Write-Section "2. 平板模式（HKCU ImmersiveShell\TabletMode）"

$tabletPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\ImmersiveShell\TabletMode'
if (Test-Path $tabletPath) {
  try {
    $tabletProps = Get-ItemProperty -Path $tabletPath -ErrorAction Stop
    $shown = 0
    foreach ($p in $tabletProps.PSObject.Properties) {
      if ($p.Name -like 'PS*') { continue }
      Write-Output ("  " + $p.Name + " = " + $p.Value)
      $shown = $shown + 1
      if ($p.Name -eq 'TabletMode') { $script:tabletModeValue = $p.Value }
    }
    if ($shown -eq 0) { Write-Output "  键存在，但没有值" }
  } catch {
    Write-Output ("  读取失败 - " + $_.Exception.Message)
    Note-Miss "平板模式键" $_.Exception.Message
  }
} else {
  Write-Output ("  键不存在：" + $tabletPath)
  Note-Miss "平板模式键" "键不存在"
}

$shellPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\ImmersiveShell'
if (Test-Path $shellPath) {
  try {
    $shellProps = Get-ItemProperty -Path $shellPath -ErrorAction Stop
    $signIn = $null
    foreach ($p in $shellProps.PSObject.Properties) {
      if ($p.Name -eq 'SignInMode') { $signIn = $p.Value }
    }
    if ($signIn -ne $null) {
      Write-Output ("  SignInMode（ImmersiveShell 下）= " + $signIn)
    } else {
      Write-Output "  SignInMode：ImmersiveShell 下未找到该值"
    }
  } catch {
    Write-Output ("  SignInMode：读取失败 - " + $_.Exception.Message)
    Note-Miss "SignInMode" $_.Exception.Message
  }
} else {
  Write-Output "  ImmersiveShell 键不存在"
}

# ------------------------------------------------------------
Write-Section "3. 边缘手势 / EdgeUI 策略"

$edgePaths = @(
  'HKCU:\Software\Policies\Microsoft\Windows\EdgeUI',
  'HKLM:\Software\Policies\Microsoft\Windows\EdgeUI',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\EdgeUI'
)
foreach ($path in $edgePaths) {
  if (Test-Path $path) {
    try {
      $edgeProps = Get-ItemProperty -Path $path -ErrorAction Stop
      $shown = 0
      foreach ($p in $edgeProps.PSObject.Properties) {
        if ($p.Name -like 'PS*') { continue }
        Write-Output ("  " + $path + " :: " + $p.Name + " = " + $p.Value)
        $shown = $shown + 1
        if ($p.Name -eq 'AllowEdgeSwipe') {
          $script:edgeSwipeValue = $p.Value
          $script:edgeSwipeKeyFound = $true
        }
      }
      if ($shown -eq 0) { Write-Output ("  " + $path + " :: 键存在，但没有值") }
    } catch {
      Write-Output ("  " + $path + " :: 读取失败 - " + $_.Exception.Message)
      Note-Miss ("边缘手势 " + $path) $_.Exception.Message
    }
  } else {
    Write-Output ("  键不存在：" + $path)
  }
}
if (-not $script:edgeSwipeKeyFound) {
  Write-Output "  AllowEdgeSwipe：未找到该值（系统按默认行为处理，不能据此断定开启或关闭）"
}

# ------------------------------------------------------------
Write-Section "4. 浏览器进程与启动参数"

try {
  $allProcs = Get-CimInstance Win32_Process -ErrorAction Stop
  $browsers = @($allProcs | Where-Object { $_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe' })
  if ($browsers.Count -eq 0) {
    Write-Output "  未检测到 chrome / msedge 进程（页面可能没开，或用了别的浏览器）"
  } else {
    Write-Output ("  chrome / msedge 进程数：" + $browsers.Count)
    foreach ($b in $browsers) {
      $cmd = ''
      if ($b.CommandLine) { $cmd = [string]$b.CommandLine }
      $hasKiosk = $false
      $hasApp = $false
      if ($cmd -match '--kiosk') { $hasKiosk = $true }
      if ($cmd -match '--app=') { $hasApp = $true }
      if ($hasKiosk -or $hasApp) { $script:kioskFound = $true }
      $url = ''
      if ($cmd -match '(https?://[^\s"'']+)') { $url = $Matches[1] }
      $title = ''
      try {
        $gp = Get-Process -Id $b.ProcessId -ErrorAction Stop
        if ($gp.MainWindowTitle) { $title = $gp.MainWindowTitle }
      } catch { }
      Write-Output ("  --- PID " + $b.ProcessId + " · " + $b.Name + " ---")
      Write-Output ("      --kiosk：" + $hasKiosk + "；--app：" + $hasApp)
      if ($url -ne '') { Write-Output ("      目标 URL：" + $url) } else { Write-Output "      目标 URL：命令行里没解析到" }
      if ($title -ne '') { Write-Output ("      窗口标题：" + $title) } else { Write-Output "      窗口标题：无（可能是后台进程）" }
      if (($hasKiosk -or $hasApp) -and $cmd -ne '') {
        Write-Output ("      完整命令行：" + $cmd)
      }
    }
  }
} catch {
  Write-Output ("  读取失败 - " + $_.Exception.Message)
  Note-Miss "浏览器进程" $_.Exception.Message
}

# ------------------------------------------------------------
Write-Section "5. 启动文件夹快捷方式"

$startupFolders = @()
try { $startupFolders += [Environment]::GetFolderPath('Startup') } catch { }
try { $startupFolders += [Environment]::GetFolderPath('CommonStartup') } catch { }

$wsh = $null
try { $wsh = New-Object -ComObject WScript.Shell } catch {
  Write-Output ("  WScript.Shell 不可用 - " + $_.Exception.Message)
  Note-Miss "快捷方式解析" $_.Exception.Message
}

$lnkCount = 0
foreach ($folder in $startupFolders) {
  if (-not $folder) { continue }
  if (Test-Path $folder) {
    Write-Output ("  文件夹：" + $folder)
    $lnks = @(Get-ChildItem -Path $folder -Filter '*.lnk' -ErrorAction SilentlyContinue)
    if ($lnks.Count -eq 0) {
      Write-Output "    没有 .lnk 快捷方式"
    } else {
      foreach ($lnk in $lnks) {
        $lnkCount = $lnkCount + 1
        Write-Output ("    --- " + $lnk.Name + " ---")
        Write-Output ("        目标：" + $lnk.FullName)
        if ($wsh -ne $null) {
          try {
            $sc = $wsh.CreateShortcut($lnk.FullName)
            Write-Output ("        TargetPath：" + $sc.TargetPath)
            Write-Output ("        Arguments：" + $sc.Arguments)
            $all = [string]$sc.TargetPath + ' ' + [string]$sc.Arguments
            if ($all -match '8765|127\.0\.0\.1|localhost|classbeat') {
              $script:autoStartFound = $true
              Write-Output "        判断：指向本地页面 / 服务"
            }
          } catch {
            Write-Output ("        解析失败 - " + $_.Exception.Message)
            Note-Miss ("快捷方式 " + $lnk.Name) $_.Exception.Message
          }
        }
      }
    }
  } else {
    Write-Output ("  文件夹不存在：" + $folder)
  }
}
if ($lnkCount -eq 0) {
  Write-Output "  启动文件夹里没有快捷方式（开机不会自动拉起页面）"
}

# ------------------------------------------------------------
Write-Section "6. 服务与端口"

$wantedPorts = @(8805) + (8765..8774)
$listen = @()
try {
  $netstatLines = & netstat -ano 2>$null
  foreach ($line in $netstatLines) {
    if ($line -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
      $port = [int]$Matches[1]
      $procId = [int]$Matches[2]
      if ($wantedPorts -contains $port) {
        $listen += ,@($port, $procId)
      }
    }
  }
} catch {
  Write-Output ("  netstat 读取失败 - " + $_.Exception.Message)
  Note-Miss "端口监听" $_.Exception.Message
}

$seen = @{}
if ($listen.Count -eq 0) {
  Write-Output "  以上端口都没有在监听（8805、8765-8774）"
} else {
  foreach ($entry in $listen) {
    $port = $entry[0]
    $procId = $entry[1]
    $key = [string]$port + ':' + [string]$procId
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = 1
    $procName = ''
    $procPath = ''
    try {
      $wp = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $procId) -ErrorAction Stop
      if ($wp) {
        $procName = [string]$wp.Name
        $procPath = [string]$wp.ExecutablePath
      }
    } catch { }
    Write-Output ("  端口 " + $port + "：LISTENING，PID " + $procId + "，进程 " + $procName)
    if ($procPath -ne '') { Write-Output ("      路径：" + $procPath) }
    try {
      $resp = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $port + "/") -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      Write-Output ("      HTTP 探测：状态码 " + [int]$resp.StatusCode)
    } catch {
      Write-Output ("      HTTP 探测失败：" + $_.Exception.Message)
    }
  }
}

# ------------------------------------------------------------
Write-Section "7. 近期事件（最近 24 小时，可选）"

try {
  $since = (Get-Date).AddHours(-24)
  $events = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since } -MaxEvents 200 -ErrorAction Stop
  $hits = @($events | Where-Object {
      ($_.Level -eq 2 -or $_.LevelDisplayName -eq '错误') -and
      ($_.Message -match 'explorer\.exe|chrome\.exe|msedge\.exe')
    })
  if ($hits.Count -eq 0) {
    Write-Output "  未发现 explorer / chrome / msedge 相关的错误事件"
  } else {
    $shown = 0
    foreach ($e in $hits) {
      $firstLine = ''
      if ($e.Message) {
        $firstLine = ($e.Message -split "`r?`n")[0]
        if ($firstLine.Length -gt 160) { $firstLine = $firstLine.Substring(0, 160) }
      }
      Write-Output ("  " + $e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss') + " · " + $e.ProviderName + " · " + $firstLine)
      $shown = $shown + 1
      if ($shown -ge 10) { break }
    }
  }
} catch {
  Write-Output ("  读取失败，已跳过：" + $_.Exception.Message)
  Note-Miss "应用事件日志" $_.Exception.Message
}

# ------------------------------------------------------------
Write-Section "未能检测的项"

if ($script:misses.Count -eq 0) {
  Write-Output "  无（所有检测项都读到了）"
} else {
  foreach ($m in $script:misses) { Write-Output ("  - " + $m) }
}

# ------------------------------------------------------------
Write-Section "结论提示（疑似，不是定论）"

if ($script:tabletModeValue -eq 1) {
  Write-Output "  疑似①：平板模式处于开启状态，边缘下滑关闭应用的手势更容易生效，优先排查手势。"
} elseif ($script:tabletModeValue -eq 0) {
  Write-Output "  提示：平板模式当前为关闭（TabletMode=0），手势路径可能性下降，但仍不能完全排除。"
} else {
  Write-Output "  提示：没读到平板模式值，手势路径无法判断。"
}

if ($script:edgeSwipeKeyFound) {
  if ($script:edgeSwipeValue -eq 1) {
    Write-Output "  疑似②：AllowEdgeSwipe=1（允许边缘滑动），优先怀疑边缘手势误关了页面。"
  } elseif ($script:edgeSwipeValue -eq 0) {
    Write-Output "  提示：AllowEdgeSwipe=0（边缘滑动被禁用），手势路径可能性下降。"
  } else {
    Write-Output ("  提示：AllowEdgeSwipe=" + $script:edgeSwipeValue + "，含义不常见，需结合现场现象判断。")
  }
} else {
  Write-Output "  提示：没找到 AllowEdgeSwipe，若 TabletMode 也为空，手势路径暂不能排除。"
}

if ($script:kioskFound) {
  Write-Output "  提示：检测到 --kiosk / --app 启动，窗口控件（关闭按钮、地址栏、标签页）已被隐藏，窗口被误点的可能性下降。"
} else {
  Write-Output "  疑似③：没检测到 --kiosk / --app 启动方式，优先怀疑窗口自身的关闭按钮、地址栏、标签页被蹭到。"
}

if ($script:autoStartFound) {
  Write-Output "  提示：启动文件夹里有指向本地页面的快捷方式，自动拉起已有基础。"
} else {
  Write-Output "  疑似④：启动文件夹里没找到指向本地页面的快捷方式，页面被关后不会自动恢复，自动恢复缺位。"
}

Write-Output ""
Write-Output "以上均为疑似判断，最终以现场复现结果为准。"
Write-Output "本脚本只读，未修改任何设置。"
