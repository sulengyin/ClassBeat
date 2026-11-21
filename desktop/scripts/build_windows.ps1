# ClassBeat 桌面版构建（Windows）
#
# 一条命令：装配资源 → cargo tauri build → 打印产物路径。
#
#   powershell -ExecutionPolicy Bypass -File desktop\scripts\build_windows.ps1
#   powershell ... -Data data        # 打包真实班级数据（内部发布用）
#   powershell ... -Check            # 只自检，不构建
#   powershell ... -NoUpdater        # 不带签名更新器（没有 minisign 密钥 / 离线构建时用）
#
# 前置：Rust 1.77+、Node 18+（只用于装 tauri-cli，可选）、WebView2（Win10 1803+ 通常自带）

param(
  [string]$Data = "sample",
  [switch]$Check,
  [switch]$NoPython,
  [switch]$SkipStage,
  [switch]$Clean,
  [switch]$NoUpdater
)

$ErrorActionPreference = 'Stop'
$desktop = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $desktop
$src = Join-Path $desktop 'src-tauri'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

Step "环境"
foreach ($cmd in @('cargo', 'rustc')) {
  $p = Get-Command $cmd -ErrorAction SilentlyContinue
  if (-not $p) { throw "找不到 $cmd。先装 Rust：https://rustup.rs（需要 1.77+）" }
}
Write-Host ("cargo " + (cargo --version))
Write-Host ("repo   " + $repo)

Step "自检"
& python (Join-Path $PSScriptRoot 'verify_package.py')
if ($LASTEXITCODE -ne 0) { throw "自检没通过，先修上面的 FAIL 再构建" }
if ($Check) { Write-Host "`n只自检，退出。"; exit 0 }

if (-not $SkipStage) {
  Step "装配资源（app / server / python 运行时）"
  $stageArgs = @((Join-Path $PSScriptRoot 'stage_resources.py'), '--data', $Data)
  if ($NoPython) { $stageArgs += '--no-python' }
  if ($Clean) { $stageArgs += '--clean' }
  & python @stageArgs
  if ($LASTEXITCODE -ne 0) { throw "资源装配失败" }
} else {
  Write-Host "跳过装配（-SkipStage）"
}

Step "编译与打包"
$tauriCli = Get-Command cargo-tauri -ErrorAction SilentlyContinue
# 更新器依赖 tauri-plugin-updater（内部走 reqwest）。没有签名密钥、或者构建机
# 拉不到 crates 时用 -NoUpdater：托盘「检查更新」会置灰，其余功能不受影响。
$featureArgs = @()
if ($NoUpdater) {
  Write-Host "不带更新器（--no-default-features）：托盘「检查更新」置灰" -ForegroundColor Yellow
  $featureArgs += '--no-default-features'
}
Push-Location $desktop
try {
  if ($tauriCli) {
    cargo tauri build @featureArgs
  } else {
    Write-Host "没有 cargo-tauri，改用 npx @tauri-apps/cli（需要网络装一次）"
    npx --yes @tauri-apps/cli@^2 build @featureArgs
  }
  if ($LASTEXITCODE -ne 0) { throw "构建失败（看上面的 rustc / NSIS 报错）" }
} finally {
  Pop-Location
}

Step "产物"
$bundle = Join-Path $src 'target\release\bundle'
if (Test-Path $bundle) {
  Get-ChildItem $bundle -Recurse -Include *.exe, *.msi |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 6 |
    ForEach-Object { "{0,10:N1} MB  {1}" -f ($_.Length / 1MB), $_.FullName }
} else {
  Write-Host "没找到 bundle 目录，检查 tauri.conf.json 的 bundle.targets"
}

Write-Host @"

下一步：
  1. 双击安装，跑 desktop/docs/06-验收清单.md 的「验收 A（安装）」
  2. 卸载，跑「验收 B（卸载）」
  3. 旧版机器上覆盖安装，跑「验收 C（迁移）」
"@ -ForegroundColor Green
