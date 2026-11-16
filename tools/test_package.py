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

if failures:
    print(f"\n{len(failures)} 项没过：" + "、".join(failures))
    sys.exit(1)
print("\n打包清单检查全部通过。")
