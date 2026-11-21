# 开发模式：把数据目录指到一个临时位置，反复起停不污染真实班级数据。
#
#   powershell -ExecutionPolicy Bypass -File desktop\scripts\dev.ps1
#
# 第一次会装配资源（含 11MB 内置运行时）。之后改 Rust 直接热重启，
# 改前端/服务脚本后重新装配一次即可（-Stage）。

param(
  [switch]$Stage,
  [switch]$NoPython,
  [string]$Data = "sample"
)

$ErrorActionPreference = 'Stop'
$desktop = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $desktop
$devData = Join-Path $env:TEMP 'classbeat-dev-data'

# 开发期数据目录：随时可以整个删掉重来
if (-not (Test-Path $devData)) { New-Item -ItemType Directory -Path $devData | Out-Null }
$env:CLASSBEAT_DATA_DIR = $devData

Write-Host ("开发数据目录：" + $devData) -ForegroundColor Cyan

if ($Stage -or -not (Test-Path (Join-Path $desktop 'src-tauri\resources\app\index.html'))) {
  $args = @((Join-Path $PSScriptRoot 'stage_resources.py'), '--data', $Data)
  if ($NoPython) { $args += '--no-python' }
  & python @args
  if ($LASTEXITCODE -ne 0) { throw "资源装配失败" }
}

# 没装内置运行时时，用系统 pythonw 顶（壳认这个环境变量）
if ($NoPython) {
  $pyw = (Get-Command pythonw -ErrorAction SilentlyContinue)
  if (-not $pyw) { throw "没有 pythonw，去掉 -NoPython 用内置运行时" }
  $env:CLASSBEAT_PYTHONW = $pyw.Source
}

Push-Location $desktop
try {
  cargo tauri dev
} finally {
  Pop-Location
}
