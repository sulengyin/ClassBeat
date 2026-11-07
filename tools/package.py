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
import hashlib
import shutil
import sys
import urllib.request
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
    "index.html", "preview.html", "edit.css", "setup.css",
    "data.js", "engine/schedule.js", "clock.js", "rhythm.js", "store.js",
    "runtime.js", "screen.js", "remote.js", "edit.js", "demo.js", "config.js",
    "qr.js", "phoneui.js", "setup.js", "templates.js", "vendor/qrcode.min.js",
]
SERVER_FILES = ["rhythm_server.py", "phone.html"]

# .bat 内容保持纯 ASCII：cmd 默认 GBK，中文容易花
BAT_SCREEN = "@echo off\r\nstart \"\" \"%~dp0app\\index.html\"\r\n"
BAT_DEMO = "@echo off\r\nstart \"\" \"%~dp0app\\preview.html\"\r\n"
# 编码用 GBK，不用 UTF-8 + chcp 65001。
# 实测（2026-11-06，一体机）：UTF-8 + chcp 65001 下 cmd 逐行解码会在长中文行上错位，
# 把 "安装第一屏...勾上 Add Python to PATH" 那一行拆开，后半截被当成命令执行，
# 屏上直接报 "is not recognized as an internal or external command"。
# 中文 Windows 的 cmd 默认代码页就是 936，按 GBK 存盘最稳，也不需要 chcp。
# 另外：echo 里不要出现英文双引号，少一个让 cmd 误解析的机会。
# Python 探测顺序 py -3 → python → python3：官方安装包的 launcher 最可靠，
# 而 Windows 自带的 python.exe 可能只是个跳应用商店的 stub。
BAT_SERVER = (
    "@echo off\r\n"
    "title 手机消息服务 · 这个窗口不要关\r\n"
    "cd /d \"%~dp0server\"\r\n"
    "\r\n"
    "rem 包里自带一份 Python，不用装、不用配 PATH\r\n"
    "if exist \"python\\python.exe\" goto bundled\r\n"
    "\r\n"
    "rem 没带运行时（--no-python 打的包），退回系统 Python\r\n"
    "set \"PY=\"\r\n"
    "python -c \"import sys\" >nul 2>&1\r\n"
    "if not errorlevel 1 set \"PY=python\"\r\n"
    "if not defined PY (\r\n"
    "  py -3 -c \"import sys\" >nul 2>&1\r\n"
    "  if not errorlevel 1 set \"PY=py -3\"\r\n"
    ")\r\n"
    "if not defined PY goto nopython\r\n"
    "\r\n"
    "echo 正在启动手机消息服务，这个窗口最小化就好，不要关。\r\n"
    "echo.\r\n"
    "%PY% rhythm_server.py\r\n"
    "goto done\r\n"
    "\r\n"
    ":bundled\r\n"
    "echo 正在启动手机消息服务，这个窗口最小化就好，不要关。\r\n"
    "echo.\r\n"
    "python\\python.exe rhythm_server.py\r\n"
    "goto done\r\n"
    "\r\n"
    ":nopython\r\n"
    "echo.\r\n"
    "echo   这台电脑没找到 Python 3，包里也没有自带。\r\n"
    "echo.\r\n"
    "echo   大屏不受影响，双击「打开大屏.bat」照样能用。\r\n"
    "echo   只有「手机发消息」这一个功能需要 Python。\r\n"
    "echo.\r\n"
    "echo   现在可以直接关掉这个窗口，不影响大屏。\r\n"
    "pause\r\n"
    "exit /b 1\r\n"
    "\r\n"
    ":done\r\n"
    "echo.\r\n"
    "echo 服务已停止（上面几行是最后的输出）。\r\n"
    "pause\r\n"
)


# 官方免安装运行时：解压即用，不需要安装、不需要管理员权限、不碰 PATH。
# 一体机通常是学校统一管的，装软件要审批——这 11 MB 换掉一次审批。
PY_EMBED_URL = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip"
PY_EMBED_SHA256 = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3"
PY_EMBED_CACHE = ROOT / "tools" / "vendor" / "python-embed-amd64.zip"


def python_runtime() -> Path | None:
    """取一份免安装 Python，带校验。拿不到就返回 None，不阻塞打包。"""
    if PY_EMBED_CACHE.exists():
        got = hashlib.sha256(PY_EMBED_CACHE.read_bytes()).hexdigest()
        if got == PY_EMBED_SHA256:
            return PY_EMBED_CACHE
        print(f"  缓存的运行时校验不对（{got[:12]}…），重新下载")
        PY_EMBED_CACHE.unlink()

    PY_EMBED_CACHE.parent.mkdir(parents=True, exist_ok=True)
    print("  正在下载免安装 Python（约 11 MB，只需一次）…")
    part = PY_EMBED_CACHE.with_suffix(".part")
    try:
        with urllib.request.urlopen(PY_EMBED_URL, timeout=180) as r, part.open("wb") as f:
            shutil.copyfileobj(r, f)
    except Exception as e:
        part.unlink(missing_ok=True)
        print(f"  下载失败：{e}")
        return None

    got = hashlib.sha256(part.read_bytes()).hexdigest()
    if got != PY_EMBED_SHA256:
        part.unlink(missing_ok=True)
        print(f"  下载到的文件校验不对（{got}），不用它")
        return None
    part.rename(PY_EMBED_CACHE)
    return PY_EMBED_CACHE


def bat_bytes(text):
    """bat 用 GBK 写盘：中文 Windows 的 cmd 默认代码页是 936。

    GBK 编不了的字符（emoji 之类）直接报错，别让它悄悄变成问号。
    """
    try:
        return text.encode("gbk")
    except UnicodeEncodeError as e:
        raise SystemExit(f"bat 里有 GBK 编不了的字符：{e}\n{text!r}")

README = """{klass} · 班级节律屏
测试包（{date} 生成）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
一、先做这一步
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
把一体机的系统时间调对。时区设错了没关系——屏上一律按北京时间显示，
但系统时钟本身差太多的话，还是要先改回来。

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
  作息   改每一段开始/结束、加一段课间、把某段改成早读或课后服务
  文字   改早读建议、提醒事项、课间那两行、各时段提示语、每科要带什么
  话术   用过的通知，点一下就能再发

改完点「完成」。所有改动只存在这台机器上，关掉浏览器也不会丢。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
五、手机发消息（可选）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
不用装任何东西，包里自带运行环境。手机和电脑连同一个 WiFi 就行。

1. 电脑上双击「启动手机服务.bat」
   ——双击就行，不用"选择用什么程序打开"。会弹出一个黑色窗口，
   里面出现地址之后把它最小化，不要关：关了手机就连不上。
   （第一次启动可能慢几秒，Windows 在检查这个新程序，属于正常）
2. 大屏上点右下角「⋯」→「手机」，屏幕上会出一个二维码
3. 手机连同一个 WiFi，扫码（或直接输入屏上那行地址）
4. 写一句话点发送，大屏立刻就出现，不用刷新

大屏要用「从服务打开」的地址，手机消息才收得到：
  · 服务就跑在一体机上：大屏开  http://127.0.0.1:8765/screen
  · 服务在另一台电脑上：  大屏开  http://那台电脑的IP:8765/screen
    （服务窗口里「大屏同源」那行会告诉你是哪个）
打开后按 F11 全屏。这种开法比双击 html 更稳，不会有本地文件的跨域限制。

手机打不开？按顺序查：
  · 手机和电脑是不是同一个 WiFi（不要一个连 WiFi、一个连热点）
  · 电脑第一次启动时，Windows 防火墙会弹窗，必须点「允许访问」
  · 地址里的数字要照着屏上抄，0 和 O、1 和 l 别抄错
  · 学校里如果开了「访客网络隔离」，两台设备互相看不见，得找网管

不装也可以，大屏单独跑完全没问题。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
六、这次重点看什么（都还没在真机上验证过）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
□ 最后一排能不能看清主字（75 寸、8 米）
□ 白天开灯，屏幕反光有没有影响
□ 方格纸背景远看有没有摩尔纹
□ 四个角的星星，投影仪上会不会糊成一团
□ 通知右上角的 ×，按住约 1 秒能关掉；学生乱点关不掉
□ 8:10 早读一下课，屏上是不是立刻换成第一节课的用品清单
□ 早读的黄色「提醒事项」贴纸，最后一排看不看得清
□ 从早读到放学挂一整天，时钟会不会越走越偏
□ 早上到校和傍晚放学的底色，差别看不看得出来
□ 换一台时区设错的电脑打开，右上角时钟是不是仍然是北京时间

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

    # 样式可能不止一份：主样式写在 index.html 里，编辑面板和向导各有一份
    for css_name in ["edit.css", "setup.css"]:
        css = (APP / css_name).read_text(encoding="utf-8")
        html = html.replace(f'<link rel="stylesheet" href="{css_name}">',
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

    pyzip = None if "--no-python" in sys.argv else python_runtime()

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for src, arc in items:
            z.write(src, f"{PACK_NAME}/{arc}")

        if pyzip:
            with zipfile.ZipFile(pyzip) as pz:
                for info in pz.infolist():
                    if info.is_dir():
                        continue
                    z.writestr(f"{PACK_NAME}/server/python/{info.filename}", pz.read(info))

        z.write(single_path, f"{PACK_NAME}/{PACK_NAME}-单文件版.html")
        z.writestr(f"{PACK_NAME}/使用说明.txt", readme.encode("utf-8-sig"))
        z.writestr(f"{PACK_NAME}/打开大屏.bat", bat_bytes(BAT_SCREEN))
        z.writestr(f"{PACK_NAME}/打开演练版.bat", bat_bytes(BAT_DEMO))
        z.writestr(f"{PACK_NAME}/启动手机服务.bat", bat_bytes(BAT_SERVER))

    size = zip_path.stat().st_size / 1024
    one = single_path.stat().st_size / 1024
    with zipfile.ZipFile(zip_path) as z:
        count = len(z.namelist())
    pretty = f"{size / 1024:.1f} MB" if size >= 1024 else f"{size:.0f} KB"
    print(f"已生成 {zip_path}")
    print(f"  {count} 个文件，{pretty}"
          + ("（含免安装 Python，一体机不用装东西）" if pyzip
             else "（没带 Python，一体机要自己装才能用手机发消息）"))
    print(f"已生成 {single_path}")
    print(f"  单文件 {one:.0f} KB，任何系统双击即开（没有手机发消息）")


if __name__ == "__main__":
    main()
