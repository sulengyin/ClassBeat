<#
  ClassBeat 安装/卸载期的进程清场脚本。

  为什么存在：旧版 0.3.x 跑着隐藏的 PowerShell 看门狗和 pythonw，
  它们不认识"安装器"，不先停掉就会出现两份服务抢 8765、旧窗口抢屏。
  在 NSIS 里用 nsExec 调这个脚本 => 没有任何窗口弹出（用户看不到控制台）。

  为什么不用 taskkill /IM 一刀切：会误杀老师自己开的 python 或 powershell。
  这里按 **命令行里的路径** 精确匹配，范围只圈 ClassBeat 的安装目录。

  参数：
    -LegacyDir   旧版安装目录（%LOCALAPPDATA%\ClassBeat）
    -InstallDir  本次安装目录
#>
param(
  [string]$LegacyDir = "",
  [string]$InstallDir = ""
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'classbeat-stop-legacy.log'
function Write-Out([string]$m) {
  try { Add-Content -Path $log -Value ((Get-Date).ToString('HH:mm:ss') + '  ' + $m) -Encoding UTF8 } catch { }
}

$targets = @()
foreach ($d in @($LegacyDir, $InstallDir)) {
  if ($d -and $d.Trim()) { $targets += $d.Trim().TrimEnd('\').ToLower() }
}

if ($targets.Count -eq 0) {
  Write-Out '没有给目录，按名字兜底'
}

function Matches([string]$cmdline) {
  if (-not $cmdline) { return $false }
  $c = $cmdline.ToLower()
  foreach ($t in $targets) {
    if ($c.Contains($t)) { return $true }
  }
  # 名字兜底：主进程没有别的同名程序，可以安全按映像名收
  return $c.Contains('classbeat.exe')
}

$killed = 0
$blocked = 0
$blockedList = @()
try {
  $procs = Get-CimInstance Win32_Process -ErrorAction Stop |
    Where-Object {
      $_.Name -in @('classbeat.exe', 'pythonw.exe', 'python.exe', 'powershell.exe', 'pwsh.exe') -and
      (Matches ([string]$_.CommandLine))
    }
  foreach ($p in $procs) {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      $killed++
      Write-Out ("已结束 " + $p.Name + " pid=" + $p.ProcessId)
    } catch {
      $blocked++
      $blockedList += ($p.Name + " pid=" + $p.ProcessId)
      Write-Out ("结束失败 pid=" + $p.ProcessId + "：" + $_.Exception.Message)
    }
  }
} catch {
  # 学校电脑常见：组策略/安全软件把 Get-CimInstance（WMI）挡掉。
  # 这条兜底只按映像名收 classbeat.exe —— 它是唯一的主程序，误杀风险为零；
  # 旧版的 pythonw 靠命令行匹配，WMI 不可用时拿不到命令行，只能放过
  # （那种机器上 0.3.x 本来就装不上，见 docs/跨代升级）。
  Write-Out ("枚举进程失败：" + $_.Exception.Message + "，改用 Get-Process 按映像名兜底")
  try {
    foreach ($p in (Get-Process -Name 'classbeat' -ErrorAction SilentlyContinue)) {
      try {
        Stop-Process -Id $p.Id -Force -ErrorAction Stop
        $killed++
        Write-Out ("已结束 classbeat.exe pid=" + $p.Id)
      } catch {
        $blocked++
        $blockedList += ("classbeat.exe pid=" + $p.Id)
        Write-Out ("结束失败 pid=" + $p.Id + "：" + $_.Exception.Message)
      }
    }
  } catch {
    Write-Out ("Get-Process 兜底也失败：" + $_.Exception.Message)
  }
}

# 旧版看门狗的优雅停标记（0.3.14+ 认这个），先写再杀更保险
if ($LegacyDir) {
  try {
    $flagDir = Join-Path $LegacyDir 'tools\launcher'
    if (Test-Path $flagDir) {
      Set-Content -Path (Join-Path $flagDir 'stop.flag') -Value 'installer' -Encoding UTF8 -ErrorAction SilentlyContinue
    }
  } catch { }
}

Write-Out ("清场完成，共结束 " + $killed + " 个进程")

# 权限不足 = 这一次没清干净。老师看不到这份日志，所以留个标记文件，
# 让安装器收尾时弹一句"重启后再用"；不提示的话表现是"装完了却打不开、
# 手机连不上、两块屏抢屏"，会被当成装坏了（实测踩过：管理员权限跑的
# pythonw，普通权限 Stop-Process 一律"拒绝访问"，卸载重装都清不掉）。
$flag = Join-Path $env:TEMP 'classbeat-need-reboot.flag'
if ($blocked -gt 0) {
  Write-Out ("!!! 有 " + $blocked + " 个 ClassBeat 进程权限不足，结束不掉：" + ($blockedList -join '、'))
  Write-Out '!!! 需要重启电脑后再打开 ClassBeat，否则旧进程会继续占端口、抢屏'
  try {
    Set-Content -Path $flag -Encoding UTF8 `
      -Value ($blocked.ToString() + " 个进程未能结束：`r`n" + ($blockedList -join "`r`n"))
  } catch { Write-Out ("标记文件写入失败：" + $_.Exception.Message) }
} else {
  # 上一次留下的标记不能一直挂着，否则这次装得好好的也会被提示重启
  try { if (Test-Path $flag) { Remove-Item $flag -Force -ErrorAction SilentlyContinue } } catch { }
}

exit 0
