# ClassBeat 桌面版构建（Windows）
#
# 一条命令：编译工具 → 编译服务 → 自检 → 装配资源 → tauri build → 打印产物。
#
#   powershell -ExecutionPolicy Bypass -File desktop\scripts\build_windows.ps1
#   powershell ... -Data data        # 打包真实班级数据（内部发布用）
#   powershell ... -Check            # 只自检，不构建
#   powershell ... -NoUpdater        # 不带签名更新器（没有 minisign 密钥 / 离线构建时用）
#
# 前置：Rust 1.77+、Node 18+（装 tauri-cli 用）、WebView2（Win10 1803+ 通常自带）
# 说明：0.5.0 起服务与构建工具都是 Rust，构建不再需要 Python。

param(
  [string]$Data = "sample",
  [switch]$Check,
  [switch]$NoPython,   # 兼容旧调用：已无意义，保留只是不让老命令报错
  [switch]$SkipStage,
  [switch]$Clean,
  [switch]$NoUpdater
)

$ErrorActionPreference = 'Stop'
# 工具与服务都是 Rust，往 stdout 写的是 UTF-8；不改成 UTF-8 会在 GBK 控制台里变乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8
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

Step "构建工具"
$tools = Join-Path $desktop 'tools-rs\target\release\classbeat-tools.exe'
cargo build --release --manifest-path (Join-Path $desktop 'tools-rs\Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw "工具编译失败" }

Step "构建服务"
# 装配会把 classbeat-server.exe 拷进 resources，所以必须先编出来。
$serverExe = Join-Path $desktop 'server-rs\target\release\classbeat-server.exe'
cargo build --release --manifest-path (Join-Path $desktop 'server-rs\Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw "服务编译失败" }
if (-not (Test-Path $serverExe)) { throw "没编出 $serverExe" }

Step "自检"
& $tools verify
if ($LASTEXITCODE -ne 0) { throw "自检没通过，先修上面的 FAIL 再构建" }
if ($Check) { Write-Host "`n只自检，退出。"; exit 0 }

if ($NoPython) {
  Write-Host "-NoPython 已废弃：安装包里本来就没有 Python 了" -ForegroundColor Yellow
}

if (-not $SkipStage) {
  Step "装配资源（app / 服务程序 / 出厂数据）"
  $stageArgs = @('stage', '--data', $Data)
  if ($Clean) { $stageArgs += '--clean' }
  & $tools @stageArgs
  if ($LASTEXITCODE -ne 0) { throw "资源装配失败" }

  # 装配后再自检一次：有几条（build-info 的版本号、resources 里有没有 Python）
  # 只有装完才看得到。第一次自检在装配前，查的是仓库侧的完整性。
  Step "装配后复核"
  & $tools verify
  if ($LASTEXITCODE -ne 0) { throw "装配后复核没通过" }
} else {
  Write-Host "跳过装配（-SkipStage）"
}

Step "编译与打包"
$tauriCli = Get-Command cargo-tauri -ErrorAction SilentlyContinue
# 更新器依赖 tauri-plugin-updater。没有签名密钥、或者构建机拉不到 crates 时用
# -NoUpdater：托盘「检查更新」会置灰，其余功能不受影响。
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
  4. classbeat-tools accept   # 运行期 D1–D8 自动验收
"@ -ForegroundColor Green
