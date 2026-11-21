#!/usr/bin/env python3
"""开发包自检：不联网、不编译，只查"这份包是不是自洽"。

能查出来的错，都是最难在真机上定位的那类：
  · 少了某个源文件 / 图标 / 钩子，构建到一半才炸；
  · tauri.conf 指向一个不存在的钩子或资源目录；
  · lib.rs 里 mod 了不存在的模块；
  · 服务适配锚点跟上游代码已经对不上（打包出半成品）。

查不出来的：Rust 类型错误、Tauri API 版本差异、NSIS 语法细节。
那些必须靠一次 `cargo tauri build`（需要联网拉 crates）。

    python desktop/scripts/verify_package.py
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DESKTOP = HERE.parent
SRC = DESKTOP / "src-tauri"
REPO = DESKTOP.parent

errors: list[str] = []
warnings: list[str] = []
notes: list[str] = []


def need(cond: bool, msg: str) -> None:
    if not cond:
        errors.append(msg)


def warn(cond: bool, msg: str) -> None:
    if not cond:
        warnings.append(msg)


def check_files() -> None:
    required = [
        "Cargo.toml", "build.rs", "tauri.conf.json",
        "capabilities/default.json", "icons/classbeat.ico",
        "installer/hooks.nsh", "installer/stop-legacy.ps1",
        "src/main.rs", "src/lib.rs", "src/config.rs", "src/logging.rs",
        "src/server.rs", "src/window.rs", "src/tray.rs", "src/power.rs",
        "src/hotkey.rs", "src/autostart.rs", "src/migrate.rs",
        "src/commands.rs", "src/update.rs", "src/ui.rs",
    ]
    for rel in required:
        need((SRC / rel).is_file(), f"缺少文件：src-tauri/{rel}")
    need((DESKTOP / "web" / "index.html").is_file(), "缺少 web/index.html（错误页）")
    need((HERE / "stage_resources.py").is_file(), "缺少 scripts/stage_resources.py")


def check_modules() -> None:
    lib = (SRC / "src" / "lib.rs").read_text(encoding="utf-8")
    mods = re.findall(r"^mod (\w+);", lib, re.M)
    for m in mods:
        need((SRC / "src" / f"{m}.rs").is_file(), f"lib.rs 声明了 mod {m}，但没有 src/{m}.rs")
    called = set(re.findall(r"(\w+)::", lib))
    for c in ("config", "logging", "server", "tray", "hotkey", "power", "migrate", "update", "window"):
        need(c in mods, f"lib.rs 没把 {c} 声明成模块（但代码里用到了）")
    if "commands" in called:
        need("commands" in mods, "lib.rs 用了 commands 但没声明模块")


def check_cargo() -> None:
    text = (SRC / "Cargo.toml").read_text(encoding="utf-8")
    for token in ["tauri", "tauri-plugin-single-instance", "serde", "windows"]:
        need(token in text, f"Cargo.toml 缺少依赖：{token}")
    need('crate-type = ["staticlib", "cdylib", "rlib"]' in text,
         "Cargo.toml 的 [lib] crate-type 不标准（Tauri 需要 staticlib/cdylib/rlib）")
    need("features = [\"tray-icon\"" in text, "Cargo.toml 的 tauri 没开 tray-icon（托盘会编译失败）")
    need("image-ico" in text, "Cargo.toml 的 tauri 没开 image-ico（托盘图标读 .ico 会失败）")
    need("updater" in text, "Cargo.toml 没有 updater feature")


def check_conf() -> None:
    conf_path = SRC / "tauri.conf.json"
    try:
        conf = json.loads(conf_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        errors.append(f"tauri.conf.json 不是合法 JSON：{e}")
        return

    need(conf.get("identifier") == "cn.classbeat.app", "identifier 不是 cn.classbeat.app")
    need(conf.get("productName") == "ClassBeat", "productName 不是 ClassBeat")

    bundle = conf.get("bundle", {})
    need(bundle.get("active") is True, "bundle.active 不是 true")
    need("nsis" in bundle.get("targets", []), "bundle.targets 里没有 nsis")
    need("msi" in bundle.get("targets", []), "bundle.targets 里没有 msi")

    for icon in bundle.get("icon", []):
        need((SRC / icon).is_file(), f"bundle.icon 指向不存在的文件：{icon}")

    hooks = bundle.get("windows", {}).get("nsis", {}).get("installerHooks")
    need(bool(hooks), "没有配置 nsis.installerHooks（安装/卸载钩子不会生效）")
    if hooks:
        need((SRC / hooks).is_file(), f"installerHooks 指向不存在的文件：{hooks}")

    mode = bundle.get("windows", {}).get("nsis", {}).get("installMode")
    need(mode == "currentUser", f"installMode 应为 currentUser（免管理员），实际 {mode}")

    res = bundle.get("resources")
    need(bool(res), "bundle.resources 为空：壳找不到 app/ 与 server/")
    need(bool(conf.get("app", {}).get("windows") == []),
         "app.windows 应为空数组：窗口由壳在服务就绪后创建")

    pubkey = conf.get("plugins", {}).get("updater", {}).get("pubkey", "")
    if "REPLACE" in pubkey:
        warnings.append("updater.pubkey 还是占位符：正式发布前必须换成 minisign 公钥"
                        "（否则「检查更新」会报错，但大屏不受影响）")


def check_hooks() -> None:
    text = (SRC / "installer" / "hooks.nsh").read_text(encoding="utf-8")
    for macro in ("NSIS_HOOK_PREINSTALL", "NSIS_HOOK_POSTINSTALL",
                  "NSIS_HOOK_PREUNINSTALL", "NSIS_HOOK_POSTUNINSTALL"):
        need(f"!macro {macro}" in text, f"hooks.nsh 缺少 {macro}")
    need("WriteRegStr HKCU" in text, "hooks.nsh 没有写注册表（App Paths / 自启 / 协议）")
    need("netsh advfirewall" in text, "hooks.nsh 没有防火墙规则")
    need("update-source.txt" in text, "hooks.nsh 没有接管旧版的 update-source.txt")
    need("${If}" not in text, "hooks.nsh 用了 LogicLib 的 ${If}，但模板不保证引入 LogicLib")
    stop = (SRC / "installer" / "stop-legacy.ps1").read_text(encoding="utf-8")
    need("Get-CimInstance" in stop and "classbeat.exe" in stop,
         "stop-legacy.ps1 没有按命令行精确清场")
    # 权限不足的提示靠一个标记文件把两处代码串起来：写方漏了 = 永远不提示；
    # 读方漏了 = 老师看到一个杀不掉的旧进程在抢屏，却没有任何解释。
    need("classbeat-need-reboot.flag" in stop,
         "stop-legacy.ps1 没在权限不足时写 classbeat-need-reboot.flag")
    need(text.count("classbeat-need-reboot.flag") >= 2,
         "hooks.nsh 没在装/卸结束时读取 classbeat-need-reboot.flag（权限不足就没提示）")


def check_rust_invariants() -> None:
    win = (SRC / "src" / "window.rs").read_text(encoding="utf-8")
    need("KIOSK_TITLE" in win, "window.rs 没有用 KIOSK_TITLE 设窗口标题（页面「退出大屏」会失效）")
    srv = (SRC / "src" / "server.rs").read_text(encoding="utf-8")
    need("CLASSBEAT_DATA_DIR" in srv, "server.rs 没有把数据目录传给服务")
    need("CLASSBEAT_SHELL" in srv, "server.rs 没有传 CLASSBEAT_SHELL")
    need("CREATE_NO_WINDOW" in srv, "server.rs 没设 CREATE_NO_WINDOW（会闪黑窗）")
    lib = (SRC / "src" / "lib.rs").read_text(encoding="utf-8")
    need("windows_subsystem" in (SRC / "src" / "main.rs").read_text(encoding="utf-8"),
         "main.rs 没声明 windows_subsystem=windows（release 下会带控制台）")
    need("single_instance" in lib, "lib.rs 没挂单实例插件")


def check_stage_anchors() -> None:
    r = subprocess.run(
        [sys.executable, str(HERE / "stage_resources.py"), "--check-only"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        errors.append("资源装配锚点校验失败：\n" + (r.stdout + r.stderr).strip())
    else:
        notes.append("服务适配锚点全部命中（上游改了代码也不会悄悄打出坏包）")


def check_staged_build() -> None:
    """构建副本里的 build 号必须是真提交号。

    踩过一次：stage 只把 sha 写进了 build-info.json，忘了写 app/version.js，
    页面 AppVersion.text() 就把那半截省掉了 —— 老师看到的版本号少一段，
    /api/ping 和日志里也是 dev，线上出问题没法定位是哪次构建。
    仓库里的 version.js 保持 dev（本地开发就该是 dev），这里只查构建副本。
    """
    vjs = SRC / "resources" / "app" / "version.js"
    if not vjs.is_file():
        notes.append("resources/ 还没装配，跳过 build 号检查")
        return
    txt = vjs.read_text(encoding="utf-8", errors="replace")
    m = re.search(r'var BUILD = "([^"]*)"', txt)
    build = m.group(1) if m else ""
    need(build not in ("", "dev"),
         f'构建副本 app/version.js 的 BUILD="{build}"，应为 git 提交号（重跑 stage_resources.py）')
    info = SRC / "resources" / "build-info.json"
    if info.is_file():
        try:
            j = json.loads(info.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            errors.append(f"build-info.json 解析失败：{e}")
            return
        need(j.get("build") == build,
             f'build-info.json 的 build={j.get("build")} 与 app/version.js 的 {build} 不一致')


def check_repo_untouched() -> None:
    """打包脚本只能动 desktop/ 与 resources/，不该改仓库里的业务代码。"""
    r = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                       capture_output=True, text=True)
    if r.returncode != 0:
        notes.append("不在 git 仓库里，跳过「业务代码是否被改动」检查")
        return
    changed = [
        line[3:].strip() for line in r.stdout.splitlines()
        if line[3:].strip() and not line[3:].strip().startswith("desktop/")
    ]
    changed = [c for c in changed if not c.startswith("app/data.js")]
    if changed:
        warnings.append(
            "desktop/ 之外存在未提交改动（多半是你在别的分支上的工作，与本包无关）："
            + "、".join(changed)
        )


def main() -> int:
    print("== ClassBeat 开发包自检 ==\n")
    check_files()
    check_modules()
    check_cargo()
    check_conf()
    check_hooks()
    check_rust_invariants()
    check_stage_anchors()
    check_staged_build()
    check_repo_untouched()

    for n in notes:
        print(f"  ok   {n}")
    for w in warnings:
        print(f"  warn {w}")
    for e in errors:
        print(f"  FAIL {e}")

    print("\n未覆盖（需要联网 + Windows 构建机）：")
    print("  · cargo check / tauri build 的编译错误")
    print("  · NSIS 编译与安装/卸载真机行为")
    print("  · WebView2 全屏在触控一体机上的表现")
    print("  → 见 docs/06-验收清单.md 的 P0 探测与验收 A~E")

    if errors:
        print(f"\n结果：{len(errors)} 个错误")
        return 1
    print(f"\n结果：通过（{len(warnings)} 条提醒）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
