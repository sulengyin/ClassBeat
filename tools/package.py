#!/usr/bin/env python3
"""把大屏、手机服务、启动脚本和说明打成可以直接发给一体机的 zip。

    python3 tools/package.py

产物：dist/<班名>节律屏-测试包-YYYYMMDD.zip

只装运行需要的东西：
  · app/      大屏本体（file:// 直接能开，配置已内联在 data.js）
  · server/   手机发消息（可选，需要电脑装 Python）
不带 tools / data / out，老师用不到，反而会误改。
"""

from __future__ import annotations

import datetime as dt
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
APP = ROOT / "app"
SERVER = ROOT / "server"

def class_name() -> str:
    """包名跟着数据里的班名走，不写死。"""
    import json
    for folder in ("data", "sample"):
        p = ROOT / folder / "schedule.json"
        if p.exists():
            try:
                name = (json.loads(p.read_text(encoding="utf-8")) or {}).get("class")
                if name:
                    return name
            except Exception:
                pass
    return "班级"


PACK_NAME = class_name().replace("（", "").replace("）", "") + "节律屏-测试包"

# 大屏运行需要的文件，逐个列出来——比整目录拷安全，免得把调试残留带进去
APP_FILES = [
    "index.html", "preview.html", "edit.css",
    "data.js", "engine/schedule.js", "rhythm.js", "store.js",
    "runtime.js", "screen.js", "remote.js", "edit.js", "demo.js", "config.js",
]
SERVER_FILES = ["rhythm_server.py", "phone.html"]

# .bat 内容保持纯 ASCII：cmd 默认 GBK，中文容易花
BAT_SCREEN = "@echo off\r\nstart \"\" \"%~dp0app\\index.html\"\r\n"
BAT_DEMO = "@echo off\r\nstart \"\" \"%~dp0app\\preview.html\"\r\n"
BAT_SERVER = (
    "@echo off\r\n"
    "chcp 65001 >nul\r\n"
    "cd /d \"%~dp0server\"\r\n"
    "python rhythm_server.py\r\n"
    "if errorlevel 1 (\r\n"
    "  echo.\r\n"
    "  echo [!] Python not found. Install Python 3 and tick \"Add to PATH\".\r\n"
    "  echo.\r\n"
    "  pause\r\n"
    ")\r\n"
)

README = """{klass} · 班级节律屏
测试包（{date} 生成）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
一、先做这一步
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
把一体机的系统时间和时区调对。
屏上如果显示「数据不包含今天」，就是时间不对，把电脑时间改回来即可。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
二、打开大屏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
最简单：直接双击「{klass}节律屏-单文件版.html」。
整个屏只有这一个文件，不用解压，Windows / 安卓 / 鸿蒙都能用浏览器打开。

Windows 也可以用文件夹里的：
  双击「打开大屏.bat」，或者直接双击 app\\index.html

打开后按 F11 全屏（安卓点浏览器菜单里的「全屏」）。

大屏不需要联网，也不需要装任何东西。
单文件版没有「手机发消息」，要那个功能用文件夹里的启动脚本。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
三、看它一天怎么变
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
方法一：双击「打开演练版.bat」，一天压缩成几分钟自动播
方法二：点右下角「⋯」→「演练」，拖底部时间条自己找时刻

建议从 07:40 拖到 18:00 看一遍：底色会从清晨的暖色，慢慢变亮到正午，
再转成傍晚的橘色、暮色。这是一天只朝一个方向变的，不跳。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
四、改东西
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
点右下角「⋯」→「编辑」→ 算一道乘法题 → 进入

  今天   发通知（普通 / 紧急红框）、临时改课、切换午间安排
  值日   换掉某一个岗位的人
  文字   改课间那两行、各时段提示语、每科要带什么
  话术   用过的通知，点一下就能再发

改完点「完成」。所有改动只存在这台机器上，关掉浏览器也不会丢。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
五、手机发消息（可选）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
需要一台装了 Python 3 的电脑，和一体机连同一个 WiFi。

1. 电脑上双击「启动手机服务.bat」
2. 窗口里会打印一行「手机打开 http://192.168.x.x:8765」
3. 手机浏览器打开这个地址，写一句话发出去
4. 大屏会自己出现，不用刷新

不装也可以，大屏单独跑完全没问题。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
六、这次重点看什么（都还没在真机上验证过）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
□ 最后一排能不能看清主字（75 寸、8 米）
□ 白天开灯，屏幕反光有没有影响
□ 方格纸背景远看有没有摩尔纹
□ 四个角的星星，投影仪上会不会糊成一团
□ 通知右上角的 ×，按住约 1 秒能关掉；学生乱点关不掉
□ 从早读到放学挂一整天，时钟会不会越走越偏
□ 早上到校和傍晚放学的底色，差别看不看得出来

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
七、出问题怎么办
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
页面卡住：关掉浏览器重开，改动不会丢。
想恢复出厂：编辑 → 文字 → 「全部恢复系统默认」。
想重来一遍今天的改动：编辑 → 「撤销上一步」。

配置包里没有「哪几天」，当天的课表是大屏自己按作息和课表现算的。
所以它不会过期，跨学期换课表时才需要重新运行一次 bundle.py。
"""


def collect() -> list[tuple[Path, str]]:
    """返回 (本地文件, 包内路径) 列表。缺文件直接报错，不生成半个包。"""
    items: list[tuple[Path, str]] = []
    missing = []

    for name in APP_FILES:
        p = APP / name
        if not p.exists():
            missing.append(str(p))
        else:
            items.append((p, f"app/{name}"))

    for name in SERVER_FILES:
        p = SERVER / name
        if not p.exists():
            missing.append(str(p))
        else:
            items.append((p, f"server/{name}"))

    if missing:
        sys.exit("缺少文件：\n  " + "\n  ".join(missing))

    return items


def build_single(out: Path) -> Path:
    """把 css/js 全部内联成一个 html。

    为什么要有这个：安卓一体机、或者老师只想发一个文件过去时，
    多目录的包很容易丢文件。单文件双击就能开，不需要解压，
    也不需要管相对路径。代价是没有手机发消息的服务端。
    """
    html = (APP / "index.html").read_text(encoding="utf-8")

    css = (APP / "edit.css").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="edit.css">',
                        "<style>\n" + css + "\n</style>")

    # 按 APP_FILES 走，别再单独维护一份列表——加了 config.js 容易漏
    for name in [f for f in APP_FILES if f.endswith(".js")]:
        code = (APP / name).read_text(encoding="utf-8")
        # 代码里若出现 </script> 会提前结束标签，转义掉
        code = code.replace("</script>", "<\\/script>")
        html = html.replace(f'<script src="{name}"></script>',
                            "<script>\n" + code + "\n</script>")

    out.write_text(html, encoding="utf-8")
    return out


def main() -> None:
    items = collect()
    DIST.mkdir(exist_ok=True)

    today = dt.date.today()
    zip_path = DIST / f"{PACK_NAME}-{today.strftime('%Y%m%d')}.zip"
    single_path = DIST / f"{PACK_NAME}-单文件版.html"

    readme = README.format(date=today.isoformat(), klass=PACK_NAME.split("节律屏")[0])

    build_single(single_path)

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for src, arc in items:
            z.write(src, f"{PACK_NAME}/{arc}")

        z.write(single_path, f"{PACK_NAME}/{PACK_NAME}-单文件版.html")
        z.writestr(f"{PACK_NAME}/使用说明.txt", readme.encode("utf-8-sig"))
        z.writestr(f"{PACK_NAME}/打开大屏.bat", BAT_SCREEN.encode("ascii"))
        z.writestr(f"{PACK_NAME}/打开演练版.bat", BAT_DEMO.encode("ascii"))
        z.writestr(f"{PACK_NAME}/启动手机服务.bat", BAT_SERVER.encode("ascii"))

    size = zip_path.stat().st_size / 1024
    one = single_path.stat().st_size / 1024
    print(f"已生成 {zip_path}")
    print(f"  {len(items) + 5} 个文件，{size:.0f} KB")
    print(f"已生成 {single_path}")
    print(f"  单文件 {one:.0f} KB，任何系统双击即开（没有手机发消息）")


if __name__ == "__main__":
    main()
