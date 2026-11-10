#!/usr/bin/env python3
"""把大屏、手机服务、启动脚本和说明打成可以直接发给一体机的 zip。

    python3 tools/package.py
    python3 tools/package.py --name 节律屏-通用版   # 配 sample 数据，打不含真名的通用版

产物：dist/<包名>-YYYYMMDD.zip

只装运行需要的东西：
  · app/      大屏本体（file:// 直接能开，配置已内联在 data.js）
  · server/   手机发消息（可选，需要电脑装 Python）
不带 tools / data / out，老师用不到，反而会误改。
"""

from __future__ import annotations

import datetime as dt
import hashlib
import re
import shutil
import subprocess
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


def cli_value(flag: str) -> str:
    args = sys.argv[1:]
    if flag in args:
        i = args.index(flag)
        if i + 1 < len(args):
            return args[i + 1]
    return ""


def version_stamp() -> tuple[str, str]:
    """版本号只在 app/version.js 里定义；打包时 --version 可覆盖，构建号取 git 短 SHA。"""
    src = (APP / "version.js").read_text(encoding="utf-8")
    m = re.search(r'var VERSION = "([^"]*)"', src)
    ver = cli_value("--version") or (m.group(1) if m else "0.0.0")
    build = "dev"
    try:
        build = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
            stderr=subprocess.DEVNULL).decode().strip() or "dev"
    except Exception:
        pass
    return ver, build


def stamped_version_js(ver: str, build: str) -> str:
    """生成带真实版本/构建号的 version.js；仓库里的源文件保持不动。"""
    src = (APP / "version.js").read_text(encoding="utf-8")
    src = re.sub(r'(var VERSION = ")[^"]*(")', lambda m: m.group(1) + ver + m.group(2), src, count=1)
    src = re.sub(r'(var BUILD = ")[^"]*(")', lambda m: m.group(1) + build + m.group(2), src, count=1)
    return src


PACK_NAME = class_name().replace("（", "").replace("）", "") + "节律屏-测试包"

# 大屏运行需要的文件，逐个列出来——比整目录拷安全，免得把调试残留带进去
APP_FILES = [
    "version.js", "index.html", "preview.html", "edit.css", "setup.css",
    "data.js", "engine/schedule.js", "clock.js", "rhythm.js", "store.js",
    "runtime.js", "screen.js", "remote.js", "edit.js", "update.js", "backup.js",
    "demo.js",
    "config.js", "qr.js", "phoneui.js", "setup.js", "templates.js",
    "vendor/qrcode.min.js",
]
SERVER_FILES = ["rhythm_server.py", "run.py", "phone.html"]

# .bat 内容保持纯 ASCII：cmd 默认 GBK，中文容易花
# 大屏优先走本机服务：同一个来源，端口顺延也能跟上；没有 Python 才退回 file://。
BAT_SCREEN = (
    "@echo off\r\n"
    "cd /d \"%~dp0server\"\r\n"
    "\r\n"
    "if exist \"python\\pythonw.exe\" goto bundled\r\n"
    "\r\n"
    "set \"PYW=\"\r\n"
    "pythonw -c \"import sys\" >nul 2>&1\r\n"
    "if not errorlevel 1 set \"PYW=pythonw\"\r\n"
    "if not defined PYW (\r\n"
    "  pyw -3 -c \"import sys\" >nul 2>&1\r\n"
    "  if not errorlevel 1 set \"PYW=pyw -3\"\r\n"
    ")\r\n"
    "if not defined PYW goto nofile\r\n"
    "start \"\" %PYW% run.py --open\r\n"
    "exit /b 0\r\n"
    "\r\n"
    ":bundled\r\n"
    "start \"\" \"python\\pythonw.exe\" run.py --open\r\n"
    "exit /b 0\r\n"
    "\r\n"
    ":nofile\r\n"
    "rem 没有 Python：退回本地文件方式，大屏照样能看，手机消息用不了\r\n"
    "start \"\" \"%~dp0app\\index.html\"\r\n"
    "exit /b 0\r\n"
)
BAT_DEMO = "@echo off\r\nstart \"\" \"%~dp0app\\preview.html\"\r\n"
# 编码用 GBK，不用 UTF-8 + chcp 65001。
# 实测（2026-11-06，一体机）：UTF-8 + chcp 65001 下 cmd 逐行解码会在长中文行上错位，
# 把 "安装第一屏...勾上 Add Python to PATH" 那一行拆开，后半截被当成命令执行，
# 屏上直接报 "is not recognized as an internal or external command"。
# 中文 Windows 的 cmd 默认代码页就是 936，按 GBK 存盘最稳，也不需要 chcp。
# 另外：echo 里不要出现英文双引号，少一个让 cmd 误解析的机会。
# Python 探测顺序 pythonw → pyw -3：都用 pythonw，起子进程时不弹黑窗。
# 官方安装包的 py launcher 自带 pyw.exe；而 Windows 自带的 python.exe 可能只是
# 个跳应用商店的 stub，所以要先验一句 import sys 再信它。
# 真正把服务跑起来的是 server\run.py（守护进程：崩了自动拉起、已经在跑就不再开）。
BAT_SERVER = (
    "@echo off\r\n"
    "title 启动手机消息服务\r\n"
    "cd /d \"%~dp0server\"\r\n"
    "\r\n"
    "rem 包里自带一份 Python，不用装、不用配 PATH\r\n"
    "if exist \"python\\pythonw.exe\" goto bundled\r\n"
    "\r\n"
    "rem 没带运行时（--no-python 打的包），退回系统 Python\r\n"
    "set \"PYW=\"\r\n"
    "pythonw -c \"import sys\" >nul 2>&1\r\n"
    "if not errorlevel 1 set \"PYW=pythonw\"\r\n"
    "if not defined PYW (\r\n"
    "  pyw -3 -c \"import sys\" >nul 2>&1\r\n"
    "  if not errorlevel 1 set \"PYW=pyw -3\"\r\n"
    ")\r\n"
    "if not defined PYW goto nopython\r\n"
    "start \"\" %PYW% run.py\r\n"
    "goto started\r\n"
    "\r\n"
    ":bundled\r\n"
    "start \"\" \"python\\pythonw.exe\" run.py\r\n"
    "\r\n"
    ":started\r\n"
    "echo.\r\n"
    "echo   服务已经在后台跑起来了，没有窗口，不用管它。\r\n"
    "echo   大屏右下角「手机」里有二维码，手机扫一下就能发消息。\r\n"
    "echo   要停止：双击「停止手机服务.bat」。\r\n"
    "echo.\r\n"
    "echo   （第一次启动 Windows 可能问能不能联网，必须点「允许访问」）\r\n"
    "timeout /t 5 >nul\r\n"
    "exit /b 0\r\n"
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
)

# 停止靠 pid 文件：无窗之后没有窗口可关，这是唯一的入口。
BAT_STOP = (
    "@echo off\r\n"
    "title 停止手机消息服务\r\n"
    "cd /d \"%~dp0server\"\r\n"
    "if not exist \"service.pid\" goto none\r\n"
    "set \"PID=\"\r\n"
    "set /p PID=<\"service.pid\"\r\n"
    "if not defined PID goto none\r\n"
    "taskkill /PID %PID% /T /F >nul 2>&1\r\n"
    "del \"service.pid\" >nul 2>&1\r\n"
    "echo.\r\n"
    "echo   手机消息服务已停止。大屏不受影响，照常显示。\r\n"
    "timeout /t 4 >nul\r\n"
    "exit /b 0\r\n"
    "\r\n"
    ":none\r\n"
    "echo.\r\n"
    "echo   没有找到正在运行的服务（可能已经停了）。\r\n"
    "timeout /t 4 >nul\r\n"
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


def write_manifest(zip_path: Path, name: str) -> int:
    """在包根目录补 MANIFEST.txt：大小 + SHA256 + 相对路径。

    先写完包，再读回包里的字节来算，清单与真实内容一一对应；
    清单自己不进清单，免得自指。返回条目数。
    """
    rows = []
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            rel = info.filename[len(name) + 1:]
            if rel == "MANIFEST.txt":
                continue
            data = z.read(info)
            rows.append(f"{len(data):>10}  {hashlib.sha256(data).hexdigest()}  {rel}")

    head = (
        f"{name}\n"
        "完整性清单：文件大小（字节）  SHA256  包内相对路径\n"
        "核对方法：解压后逐行比对；哈希对不上说明文件被改过或没下完整。\n"
        f"共 {len(rows)} 个文件（MANIFEST.txt 自身不计）\n"
        "----\n"
    )
    with zipfile.ZipFile(zip_path, "a", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{name}/MANIFEST.txt",
                   (head + "\n".join(rows) + "\n").encode("utf-8-sig"))
    return len(rows)


README = """{klass} · 班级节律屏
测试包（{date} 生成）
本包内是示例班级（化名），不是真实学生。改成自己班级后，请看「八、隐私」。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
一、先做这一步
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
把一体机的系统时间调对。时区设错了没关系——屏上一律按北京时间显示，
但系统时钟本身差太多的话，还是要先改回来。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
二、打开大屏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
最简单：直接双击「{single}」。
整个屏只有这一个文件，不用解压，Windows / 安卓 / 鸿蒙都能用浏览器打开。

Windows 也可以用文件夹里的：
  双击「打开大屏.bat」——它会顺带启动本机服务，并打开
  http://127.0.0.1:8765/screen（端口被占会自动顺延，脚本跟着实际端口走）
  电脑上没有 Python 时，它会退回直接双击 app\\index.html。

┌─ 以前是「双击 html」用的，现在第一次这样打开 ─┐
浏览器会把「双击文件」和「从本机地址打开」当成两个不同的地方，
原来的修改不会自动带过来，看起来像全空。搬一次就好：

  1. 先用旧方式打开一次：双击 app\\index.html
  2. ⋯ →「编辑」→「文字」→ 页面最下面的「带走这些修改」→ 导出设置
  3. 关掉，双击「打开大屏.bat」按新地址打开
  4. ⋯ →「编辑」→「导入设置」，选刚导出的那个文件

以后一直用「打开大屏.bat」，就不会再变。屏幕底部出现提示条时，
点「知道了」当天不再弹。

配置还会自动留底：用「打开大屏.bat」打开时，改完一分钟内会把整份配置
写到文件夹里的 backups\\config\\，一天一份，留最近 14 天，不用点任何按钮。
以后再换地址或浏览器被清过，进「编辑」→「带走这些修改」→「本机自动备份」，
按日期点「恢复」就行。双击 app\\index.html 时没有本机服务，
只能退回浏览器里存一份副本，恢复入口在同一处。

打开后按 F11 全屏（安卓点浏览器菜单里的「全屏」）。

版本号在右下角「⋯」展开后能看到（如 v0.1.0 · a1b2c3d），
报问题时把这串发给管理员，能直接对上是哪一版。

大屏日常不需要联网，也不需要装任何东西；只有「有没有新版本」的检查
需要网络，连不上就安静跳过，不影响显示。
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
点右下角「⋯」→「编辑」→ 算一道小数除法 → 进入

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

1. 双击「启动手机服务.bat」
   窗口闪一下就没了，这是对的——服务在后台跑，不需要留着窗口。
   （第一次启动可能慢几秒，Windows 在检查这个新程序，属于正常）
   重复双击也不会开第二个；服务万一崩了会自己起来。
2. 大屏上点右下角「⋯」→「手机」，屏幕上会出一个二维码
3. 手机连同一个 WiFi，扫码（或直接输入屏上那行地址）
4. 写一句话点发送，大屏立刻就出现，不用刷新

要停止服务：双击「停止手机服务.bat」。不停止也没关系，重启电脑后
再双击一次「启动手机服务.bat」就行。

大屏要用「从服务打开」的地址，手机消息才收得到：
  · 服务就跑在一体机上：大屏开  http://127.0.0.1:8765/screen
  · 服务在另一台电脑上：  大屏开  http://那台电脑的IP:8765/screen
如果 8765 被别的软件占了，服务会自动换到 8766、8767…，
大屏会自己找到它，不用改地址。

手机打不开？按顺序查：
  · 手机和电脑是不是同一个 WiFi（不要一个连 WiFi、一个连热点）
  · 电脑第一次启动时，Windows 防火墙会弹窗，必须点「允许访问」
  · 地址里的数字要照着屏上抄，0 和 O、1 和 l 别抄错
  · 学校里如果开了「访客网络隔离」，两台设备互相看不见，得找网管
  · 还不行就看 server\\server.log，最后几行会写清楚卡在哪

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

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
八、隐私：别把改过的文件夹发给别人
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 这个包里是示例班级（化名），不是真实学生，可以随便试。
2. 你改成本班之后，学生姓名、老师姓名就存在这个文件夹里。
   把整个文件夹发出去，等于把全班名册一起给了别人。
3. 别人也想用，请把原始安装包转发给他，别发你改过的那份。
4. backups\\config\\ 里是自动备份，内容和导出设置一样，含真实姓名；
   别把这个文件夹单独发出去，要分享请发原始安装包。

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


def build_single(out: Path, ver: str, build: str) -> Path:
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
        code = stamped_version_js(ver, build) if name == "version.js" \
            else (APP / name).read_text(encoding="utf-8")
        # 代码里若出现 </script> 会提前结束标签，转义掉
        code = code.replace("</script>", "<\\/script>")
        html = html.replace(f'<script src="{name}"></script>',
                            "<script>\n" + code + "\n</script>")

    out.write_text(html, encoding="utf-8")
    return out


def pack_name() -> str:
    """--name 可以覆盖包名：打通用版时用示例数据，但 data/ 里是本班的真名，
    不能让「五（5）班」跟着包名跑出去。"""
    args = sys.argv[1:]
    if "--name" in args:
        i = args.index("--name")
        if i + 1 < len(args):
            return args[i + 1]
    return PACK_NAME


def main() -> None:
    items = collect()
    DIST.mkdir(exist_ok=True)
    name = pack_name()

    today = dt.date.today()
    ver, build = version_stamp()

    # 外层文件名只用 ASCII：GitHub Release 会把中文附件名净化成「1.-.-.zip」，
    # 老师看不出这是什么。包内目录名照旧用中文，解压后的一切名字都不变。
    slug = f"classbeat-{ver}"
    zip_path = DIST / f"{slug}.zip"
    single_path = DIST / f"{slug}-single.html"

    readme = README.format(date=today.isoformat(), klass=name.split("节律屏")[0],
                           single=f"{name}-单文件版.html")

    build_single(single_path, ver, build)

    pyzip = None if "--no-python" in sys.argv else python_runtime()

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for src, arc in items:
            if arc == "app/version.js":
                z.writestr(f"{name}/{arc}", stamped_version_js(ver, build).encode("utf-8"))
            else:
                z.write(src, f"{name}/{arc}")

        if pyzip:
            with zipfile.ZipFile(pyzip) as pz:
                for info in pz.infolist():
                    if info.is_dir():
                        continue
                    z.writestr(f"{name}/server/python/{info.filename}", pz.read(info))

        z.write(single_path, f"{name}/{name}-单文件版.html")
        z.writestr(f"{name}/使用说明.txt", readme.encode("utf-8-sig"))
        z.writestr(f"{name}/打开大屏.bat", bat_bytes(BAT_SCREEN))
        z.writestr(f"{name}/打开演练版.bat", bat_bytes(BAT_DEMO))
        z.writestr(f"{name}/启动手机服务.bat", bat_bytes(BAT_SERVER))
        z.writestr(f"{name}/停止手机服务.bat", bat_bytes(BAT_STOP))

    listed = write_manifest(zip_path, name)

    size = zip_path.stat().st_size / 1024
    one = single_path.stat().st_size / 1024
    with zipfile.ZipFile(zip_path) as z:
        count = len(z.namelist())
    pretty = f"{size / 1024:.1f} MB" if size >= 1024 else f"{size:.0f} KB"
    print(f"已生成 {zip_path}")
    print(f"  {count} 个文件，{pretty}"
          + ("（含免安装 Python，一体机不用装东西）" if pyzip
             else "（没带 Python，一体机要自己装才能用手机发消息）"))
    print(f"  MANIFEST.txt：{listed} 个文件的 SHA256")
    print(f"已生成 {single_path}")
    print(f"  单文件 {one:.0f} KB，任何系统双击即开（没有手机发消息）")
    print(f"版本 v{ver} · 构建 {build}")


if __name__ == "__main__":
    main()
