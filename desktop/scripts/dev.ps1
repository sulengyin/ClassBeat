# 开发模式：把数据目录指到一个临时位置，反复起停不污染真实班级数据。
#
#   powershell -ExecutionPolicy Bypass -File desktop\scripts\dev.ps1
#
# 第一次会装配资源。之后改 Rust 直接热重启；改前端或服务后加 -Stage 重新装配。

param(
  [switch]$Stage,
  [string]$Data = "sample"
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8
$desktop = Split-Path -Parent $PSScriptRoot
$devData = Join-Path $env:TEMP 'classbeat-dev-data'

# 开发期数据目录：随时可以整个删掉重来
if (-not (Test-Path $devData)) { New-Item -ItemType Directory -Path $devData | Out-Null }
$env:CLASSBEAT_DATA_DIR = $devData

Write-Host ("开发数据目录：" + $devData) -ForegroundColor Cyan

$tools = Join-Path $desktop 'tools-rs\target\release\classbeat-tools.exe'
cargo build --release --manifest-path (Join-Path $desktop 'tools-rs\Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw "工具编译失败" }

if ($Stage -or -not (Test-Path (Join-Path $desktop 'src-tauri\resources\app\index.html'))) {
  # 服务是 Rust：改过 server-rs 后要重新编译再装配，否则壳跑的还是旧二进制。
  cargo build --release --manifest-path (Join-Path $desktop 'server-rs\Cargo.toml')
  if ($LASTEXITCODE -ne 0) { throw "服务编译失败" }
  & $tools stage --data $Data
  if ($LASTEXITCODE -ne 0) { throw "资源装配失败" }
}

Push-Location $desktop
try {
  cargo tauri dev
} finally {
  Pop-Location
}
