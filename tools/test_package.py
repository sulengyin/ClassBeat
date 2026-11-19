#!/usr/bin/env python3
"""打包清单的静态检查：不真打包，只验证「老师拿到的东西是齐的」。

    python3 tools/test_package.py

背景（2026-11-16）：启动器三件套 + 逃生门进了发布包（ROADMAP 9.3 第一档、
9.6、9.9），但打包清单是逐文件手列的——漏一个老师就拿不到，而且没有任何
报错。这里把「清单完整性 + bat 可编码 + 使用说明入口」钉住。
"""

import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import package  # noqa: E402

failures = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("✅ " if ok else "❌ ") + name + (("  —— " + detail) if detail else ""))
    if not ok:
        failures.append(name)


# 一、collect() 必须带上启动器与逃生门（漏一个老师就拿不到）
items = {arc for _, arc in package.collect()}
need = [
    "tools/launcher/start-kiosk.ps1",
    "tools/launcher/start-kiosk.cmd",
    "tools/launcher/exit-kiosk.ps1",
    "tools/launcher/exit-kiosk.cmd",
    "tools/launcher/watchdog.ps1",
    "tools/launcher/install-autostart.ps1",
    "tools/launcher/win-titles.ps1",
    "tools/launcher/classbeat.ico",
]
missing = [n for n in need if n not in items]
check("打包清单包含启动器与逃生门", not missing, "缺：" + ", ".join(missing) if missing else "")

# 二、三个新 bat 必须 GBK 可编码（bat_bytes 编不了会直接 SystemExit）
for attr in ("BAT_KIOSK", "BAT_EXIT", "BAT_AUTOSTART"):
    text = getattr(package, attr, None)
    ok = text is not None
    detail = "" if text is not None else "常量不存在"
    if ok:
        try:
            package.bat_bytes(text)
        except SystemExit as e:
            ok, detail = False, str(e)
    check(f"{attr} 存在且 GBK 可编码", ok, detail)

# 三、使用说明必须提到三个新入口
for needle in ("大屏全屏.bat", "退出大屏.bat", "安装开机自启.bat"):
    check(f"使用说明提到 {needle}", needle in package.README)

# 四、kiosk 没有关闭按钮，使用说明必须写清唯一出口
check("使用说明写明退出大屏的入口", "退出大屏.bat" in package.README and "看门狗" in package.README)

# 四之一、桌面图标叫 ClassBeat，不带班名（2026-11-19 真机反馈）
check("使用说明写明桌面图标名 ClassBeat", "ClassBeat 图标" in package.README)

# 五、程序内更新的更新源文件（2026-11-17 P2 9.5）：必须存在，且
# 默认源必须是「加速前缀 + GitHub raw」——GitHub 裸直连在国内不稳
# 定（2026-11-17 用户确认）；加速域名方案是用户 2026-11-18 选定的
src = getattr(package, "UPDATE_SOURCE", None)
check("UPDATE_SOURCE 模板存在", src is not None)
if src:
    urls = [ln.strip() for ln in src.splitlines()
            if ln.strip() and not ln.strip().startswith("#")]
    check("默认源恰好一行", len(urls) == 1, str(urls))
    u = urls[0] if urls else ""
    check("默认源带加速前缀且指向 GitHub raw 清单",
          u.startswith("https://")
          and u.endswith("/update.json")
          and "raw.githubusercontent.com" in u
          and not u.startswith("https://raw.githubusercontent.com")
          and not u.startswith("https://github.com"),
          u[:80])
    check("模板里写了备用前缀", "gh-proxy.com" in src and "ghproxy.net" in src)
    check("使用说明提到程序内更新", "检查更新" in package.README
          and "update-source.txt" in package.README)

# 六、简易安装器的三件套（2026-11-19 真机反馈「依然是压缩包」，9.3 第二档）：
# SFX 壳 + 安装脚本 + 构建脚本缺一个就出不了安装器
installer = TOOLS / "installer"
check("7zSD.sfx 安装壳在仓库里", (installer / "7zSD.sfx").exists()
      and (installer / "7zSD.sfx").stat().st_size > 100_000)
if (installer / "install.ps1").exists():
    ps1 = (installer / "install.ps1").read_bytes()
    check("install.ps1 带 UTF-8 BOM（GBK 环境直接跑会炸）", ps1[:3] == b"\xef\xbb\xbf")
    check("install.ps1 保留老师数据", all(
        w in ps1.decode("utf-8-sig") for w in ("data", "backups", "update-source.txt")))
else:
    check("install.ps1 存在", False, "tools/installer/install.ps1 不存在")
check("build_installer.py 存在", (TOOLS / "build_installer.py").exists())

if failures:
    print(f"\n{len(failures)} 项没过：" + "、".join(failures))
    sys.exit(1)
print("\n打包清单检查全部通过。")
