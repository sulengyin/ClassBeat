#!/usr/bin/env python3
"""把仓库里的前端 / 服务 / 运行时装配进桌面壳的 resources。

桌面壳（src-tauri）不改业务代码，它只是把这三样东西**原样**装进安装包：

    resources/app/      大屏页面（含 bundle 生成的 data.js）
    resources/server/   本地服务（python 脚本 + 手机页 + 图标）
    resources/python/   免安装 Python 运行时（pythonw.exe，不弹窗口）
    resources/data/     出厂班级数据（首启向导用它起步）
    resources/sample/   示例班级（对外分享用）

只有一处"适配"，就是给服务加三个环境变量开关（数据目录 / 壳模式 / 更新归属）。
改动以**定点替换**的形式做在**副本**上，仓库里的 server/ 一个字节都不动；
替换锚点找不到就报错退出，绝不悄悄产出半成品包。

    python tools/.../stage_resources.py                # 用 sample 数据，含 Python 运行时
    python .../stage_resources.py --data data          # 打包真实班级数据（内部发布）
    python .../stage_resources.py --no-python          # 开发期用系统 Python，跳过 11MB 运行时
    python .../stage_resources.py --check-only         # 只校验锚点与依赖，不写任何文件
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
DESKTOP = HERE.parent
REPO = DESKTOP.parent
RESOURCES = DESKTOP / "src-tauri" / "resources"
PY_EMBED_ZIP = REPO / "tools" / "vendor" / "python-embed-amd64.zip"
BEIJING = timezone(timedelta(hours=8))


# --------------------------------------------------------------------------- 适配补丁
# 每一项是 (文件名, 锚点原文, 替换后, 说明, 幂等哨兵)。
# 哨兵只出现在"替换后"的文本里 —— 用它判断是否已经适配过，
# 别再拿锚点首行判断（HOME_ID = home_id() 两边都有，会误判成已适配）。
PATCHES: list[tuple[str, str, str, str, str]] = [
    (
        "rhythm_server.py",
        '''HOME_ID = home_id()
MSG_FILE = os.path.join(BASE, "messages.json")
NET_FILE = os.path.join(BASE, "net.json")
LOG_FILE = os.path.join(BASE, "server.log")
PHONE_FILE = os.path.join(BASE, "phone.html")
APP_DIR = os.path.abspath(os.path.join(BASE, "..", "app"))''',
        '''HOME_ID = home_id()

# ---------- 桌面壳适配（0.4.0）----------
# 传统目录版把可写数据放在包里（server/messages.json、server.log、../backups）。
# 桌面版装进 Program Files 时包内不可写，所以由壳用 CLASSBEAT_DATA_DIR 指到
# %APPDATA%\\ClassBeat。不设这个变量 = 完全等于旧行为（单文件版 / 解压版 / 现有测试）。
DATA_HOME = os.path.abspath(os.environ["CLASSBEAT_DATA_DIR"]) \\
    if os.environ.get("CLASSBEAT_DATA_DIR", "").strip() else ""
# 壳自己负责进程守护与更新；CLASSBEAT_SHELL=1 时不再跑 PowerShell 看门狗交接，
# 也不抢"程序内更新"（更新交给壳的签名更新器）。
SHELL_MODE = os.environ.get("CLASSBEAT_SHELL", "").strip() == "1"


def _data_file(name):
    if DATA_HOME:
        try:
            os.makedirs(DATA_HOME, exist_ok=True)
        except OSError:
            pass
        return os.path.join(DATA_HOME, name)
    return os.path.join(BASE, name)


MSG_FILE = _data_file("messages.json")
NET_FILE = _data_file("net.json")
LOG_FILE = _data_file("server.log")
PHONE_FILE = os.path.join(BASE, "phone.html")
APP_DIR = os.path.abspath(os.path.join(BASE, "..", "app"))''',
        "数据目录可被壳重定向",
        "def _data_file(name):",
    ),
    (
        "rhythm_server.py",
        'BACKUP_DIR = os.path.abspath(os.path.join(BASE, "..", "backups", "config"))',
        '''BACKUP_DIR = os.path.abspath(
    os.path.join(DATA_HOME, "backups", "config") if DATA_HOME
    else os.path.join(BASE, "..", "backups", "config"))''',
        "配置快照跟着数据目录走",
        'os.path.join(DATA_HOME, "backups", "config") if DATA_HOME',
    ),
    (
        "rhythm_server.py",
        '''    # 过期看门狗自动交接（0.3.16）：后台线程做，别拖慢服务启动
    threading.Thread(target=watchdog_handover, daemon=True).start()''',
        '''    # 过期看门狗自动交接（0.3.16）：后台线程做，别拖慢服务启动。
    # 桌面壳模式下没有 PowerShell 看门狗，这一步跳过。
    if not SHELL_MODE:
        threading.Thread(target=watchdog_handover, daemon=True).start()''',
        "壳模式不跑看门狗交接",
        "if not SHELL_MODE:",
    ),
    (
        "rhythm_server.py",
        '''    if os.name != "nt":
        return
    flag_path = os.path.join(LAUNCHER_DIR, "stop.flag")''',
        '''    if os.name != "nt":
        return
    if SHELL_MODE:
        # 壳拥有窗口与进程：留一个退出标记（壳认它才真退出），再发 WM_CLOSE。
        # 不等 stop.flag、不强杀进程——强杀壳会留下孤儿 pythonw。
        try:
            with open(os.path.join(DATA_HOME or BASE, "exit-request.flag"), "w",
                      encoding="utf-8") as f:
                f.write(dt.datetime.now().isoformat(timespec="seconds"))
        except OSError:
            pass
        try:
            import ctypes
            for hwnd, _t in find_kiosk_windows():
                ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)
        except Exception:
            pass
        return
    flag_path = os.path.join(LAUNCHER_DIR, "stop.flag")''',
        "退出大屏改为壳内退出",
        "exit-request.flag",
    ),
    (
        "rhythm_server.py",
        '''                "app": "classbeat",''',
        '''                "app": "classbeat",
                # true = 由桌面壳托管（壳模式）。冒烟测试与诊断用它区分形态。
                "shell": SHELL_MODE,''',
        "ping 里暴露壳模式",
        '"shell": SHELL_MODE,',
    ),
    (
        "updater.py",
        '''def self_update_supported(root):
    """有 app/version.js 和 server/ 才是可原位替换的完整安装目录。"""
    root = Path(root)
    return (root / "app" / "version.js").is_file() and (root / "server").is_dir()


def single_file_hint():
    return "这是单文件版，不能自己更新；请到下载页获取新版"''',
        '''def _shell_mode():
    """桌面壳托管时为 True：更新由壳（签名更新器）负责，本模块不参与。"""
    return os.environ.get("CLASSBEAT_SHELL", "").strip() == "1"


def self_update_supported(root):
    """有 app/version.js 和 server/ 才是可原位替换的完整安装目录。
    壳模式下恒为 False：程序文件由安装器维护，这里覆盖会造出版本错位。"""
    if _shell_mode():
        return False
    root = Path(root)
    return (root / "app" / "version.js").is_file() and (root / "server").is_dir()


def single_file_hint():
    if _shell_mode():
        return "桌面版由 ClassBeat 应用统一更新：点托盘图标 → 检查更新（或按 Ctrl+Alt+U）"
    return "这是单文件版，不能自己更新；请到下载页获取新版"''',
        "更新归属交给壳",
        "def _shell_mode():",
    ),
]


def apply_patches(server_dir: Path, check_only: bool) -> None:
    per_file: dict[str, str] = {}
    for name, anchor, replacement, note, sentinel in PATCHES:
        src = server_dir / name
        if name not in per_file:
            per_file[name] = src.read_text(encoding="utf-8")
        text = per_file[name]
        if sentinel in text:
            print(f"  · 跳过（已适配）：{name} — {note}")
            continue
        if anchor not in text:
            sys.exit(
                f"[失败] 在 {name} 里找不到锚点：{note}\n"
                f"        锚点开头：{anchor.splitlines()[0]}\n"
                "        上游代码改过 → 先更新 scripts/stage_resources.py 里的 PATCHES 再打包。"
            )
        if text.count(anchor) != 1:
            sys.exit(f"[失败] {name} 里锚点出现 {text.count(anchor)} 次（预期 1 次）：{note}")
        per_file[name] = text.replace(anchor, replacement)
        print(f"  · 已适配：{name} — {note}")

    if check_only:
        return
    for name, text in per_file.items():
        (server_dir / name).write_text(text, encoding="utf-8")


# --------------------------------------------------------------------------- 小工具

def read_version() -> tuple[str, str]:
    js = (REPO / "app" / "version.js").read_text(encoding="utf-8")
    ver = re.search(r'var VERSION = "([^"]*)"', js)
    build = re.search(r'var BUILD = "([^"]*)"', js)
    return (ver.group(1) if ver else "0.0.0", build.group(1) if build else "dev")


def git_sha() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=REPO, capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except Exception:
        return ""


def fresh_dir(p: Path) -> None:
    if p.exists():
        shutil.rmtree(p)
    p.mkdir(parents=True, exist_ok=True)


def copy_dir(src: Path, dst: Path, skip_names: set[str] | None = None) -> None:
    skip = skip_names or set()
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.name in skip or item.name == "__pycache__":
            continue
        target = dst / item.name
        if item.is_dir():
            copy_dir(item, target, skip)
        else:
            shutil.copy2(item, target)


# --------------------------------------------------------------------------- 主流程

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="sample",
                    help="出厂数据目录：sample（默认）/ data / 绝对路径")
    ap.add_argument("--no-python", action="store_true",
                    help="不装内置 Python 运行时（开发期用系统 Python）")
    ap.add_argument("--check-only", action="store_true",
                    help="只校验锚点与依赖，不写文件")
    ap.add_argument("--clean", action="store_true", help="先清空 resources")
    args = ap.parse_args()

    print("== ClassBeat 资源装配 ==")
    print(f"仓库：{REPO}")
    print(f"目标：{RESOURCES}")

    data_dir = Path(args.data)
    if not data_dir.is_absolute():
        data_dir = REPO / args.data
    if not data_dir.is_dir():
        sys.exit(f"[失败] 数据目录不存在：{data_dir}")

    if args.check_only:
        print("\n[1/4] 校验适配锚点")
        apply_patches(REPO / "server", check_only=True)
        print("\n[2/4] 校验内置 Python")
        print(f"  · {PY_EMBED_ZIP} 存在" if PY_EMBED_ZIP.is_file()
              else f"  ! 缺少 {PY_EMBED_ZIP}（--no-python 可跳过）")
        print("\n[3/4] 校验前端")
        for f in ("index.html", "screen.js", "version.js"):
            p = REPO / "app" / f
            print(f"  · {f} {'ok' if p.is_file() else '缺失'}")
        print("\n[4/4] 校验服务")
        for f in ("rhythm_server.py", "updater.py", "phone.html", "sw.js"):
            p = REPO / "server" / f
            print(f"  · {f} {'ok' if p.is_file() else '缺失'}")
        print("\n仅校验，未写入任何文件。")
        return 0

    if args.clean and RESOURCES.exists():
        shutil.rmtree(RESOURCES)

    print("\n[1/5] 复制前端与服务")
    fresh_dir(RESOURCES / "app")
    copy_dir(REPO / "app", RESOURCES / "app")
    fresh_dir(RESOURCES / "server")
    copy_dir(REPO / "server", RESOURCES / "server",
             skip_names={"messages.json", "net.json", "server.log", "service.pid"})
    copy_dir(REPO / "sample", RESOURCES / "sample")
    if data_dir.resolve() != (REPO / "sample").resolve():
        copy_dir(data_dir, RESOURCES / "data")
    else:
        copy_dir(data_dir, RESOURCES / "data")

    print("\n[1.5/5] 把 build 号写进 app/version.js")
    # 为什么单独一步：version.js 里 BUILD="dev" 时，页面 AppVersion.text() 会把这半截省略，
    # 老师点「⋯」看到的版本号就少一段；同时 /api/ping 与日志里的 build 也成了 "dev"，
    # 线上出问题没法定位到底是哪次构建。这里是打包脚本的职责——仓库里的 "dev" 不动，
    # 只改构建副本（等价性对比时就发现这一条：旧包显示 v0.3.24 · 5ecb9e9，新包只剩 v0.3.24）。
    _sha = git_sha()
    if _sha:
        _vjs = RESOURCES / "app" / "version.js"
        _txt = _vjs.read_text(encoding="utf-8")
        _new = re.sub(r'(var BUILD = ")([^"]*)(")',
                      lambda m: m.group(1) + (_sha if m.group(2) in ("", "dev") else m.group(2)) + m.group(3),
                      _txt)
        if _new != _txt:
            _vjs.write_text(_new, encoding="utf-8")
            print(f"  · BUILD → {_sha}")
        else:
            print("  · BUILD 已有具体值，保持不变")
    else:
        print("  · 取不到 git 提交号（不是 git 仓库？）跳过")

    print("\n[2/5] 生成 app/data.js")
    out_js = RESOURCES / "app" / "data.js"
    cmd = [sys.executable, str(REPO / "tools" / "bundle.py"),
           "--data", str(data_dir), "--out", str(out_js)]
    print("  $", " ".join(cmd))
    subprocess.run(cmd, cwd=REPO, check=True)

    print("\n[3/5] 应用服务适配补丁")
    apply_patches(RESOURCES / "server", check_only=False)

    print("\n[4/5] 内置 Python 运行时")
    if args.no_python:
        (RESOURCES / "python").mkdir(parents=True, exist_ok=True)
        (RESOURCES / "python" / "README.txt").write_text(
            "开发构建未内置运行时：壳会用 CLASSBEAT_PYTHONW 环境变量指定的解释器。\n",
            encoding="utf-8")
        print("  · 跳过（--no-python）")
    else:
        if not PY_EMBED_ZIP.is_file():
            sys.exit(f"[失败] 找不到 {PY_EMBED_ZIP}；先跑 tools 里的下载步骤，或加 --no-python")
        fresh_dir(RESOURCES / "python")
        with zipfile.ZipFile(PY_EMBED_ZIP) as z:
            z.extractall(RESOURCES / "python")
        exe = RESOURCES / "python" / "pythonw.exe"
        print(f"  · 解压完成，pythonw.exe {'就位' if exe.is_file() else '缺失（检查压缩包）'}")

    print("\n[5/5] 写 build-info.json")
    version, build = read_version()
    info = {
        "product": "ClassBeat",
        "version": version,
        "build": build if build != "dev" else (git_sha() or "dev"),
        "bundledAt": datetime.now(BEIJING).isoformat(timespec="seconds"),
        "dataSource": str(data_dir),
        "python": "none" if args.no_python else "embed-amd64",
    }
    (RESOURCES / "build-info.json").write_text(
        json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False, indent=2))
    print("\n装配完成。下一步：desktop/scripts/build_windows.ps1")
    return 0


if __name__ == "__main__":
    sys.exit(main())
