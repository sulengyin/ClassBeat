#!/usr/bin/env python3
"""构建 ClassBeat 简易安装器（7-Zip SFX 自解压路线）。

    python tools/build_installer.py [--zip dist/classbeat-0.3.6.zip] [--out dist]
        [--install-args "-TargetDir C:\\some\\dir -NoAutostart"]

产物 dist/classbeat-setup-<版本>.exe：单个文件，双击安装到
%LOCALAPPDATA%\\ClassBeat，建桌面 ClassBeat 图标，不再需要解压
（2026-11-19 真机反馈，PLAN 2.45 ③ / ROADMAP 9.3 第二档简易路线）。

路线（IExpress 在静默模式下产物损坏，已弃用）：官方 LZMA SDK 的
7zSD.sfx 安装壳 + py7zr 打的 7z 压缩包，三段拼接：
    7zSD.sfx + SFX 配置 + package.7z  →  classbeat-setup.exe
SFX 解压到临时目录后执行包内的 install.ps1（负责保留老师数据、
装文件、写开机自启和桌面图标）。7zSD.sfx 来自 7-zip.org 的
LZMA SDK（lzma2501.7z → bin/7zSD.sfx），LGPL + unRAR 许可，
允许再分发；本目录留有副本 tools/installer/7zSD.sfx。

--install-args 只为自动化测试准备（指定 -TargetDir 等参数），
路径含空格时不可用（SFX 配置不支持内嵌引号）。
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SFX = ROOT / "tools" / "installer" / "7zSD.sfx"
INSTALL_PS1 = ROOT / "tools" / "installer" / "install.ps1"

# 7zSD 安装壳配置：解压完直接跑 install.ps1（UTF-8 变体要求本段
# 以 UTF-8 无 BOM 编码、紧跟在 sfx 模块字节之后）。
#
# 为什么用 ExecuteFile/ExecuteParameters 而不是 RunProgram（源码
# CPP/7zip/Bundles/SFXSetup/SfxSetup.cpp 的坑，2026-11-19 三轮冒烟
# 才定位到）：RunProgram 的整条命令行会被加上 ".\" 前缀去
# CreateProcess，"powershell" 变成 ".\powershell"，只查当前目录
# 不走 PATH → 找不到 → 弹错误框（标题 7-Zip）→ 无人点击挂死。
# ExecuteFile 走 ShellExecuteEx，powershell.exe 经 App Paths 注册表
# 解析，无此坑；解压工作目录已被 SetCurrentDir 成临时解压目录，
# install.ps1 相对路径直接可用。Progress=no 让解压同步执行，
# 不弹进度窗；出错时配合启动参数 -y 可拿到退出码而不是挂死。
CONFIG_TMPL = (
    ";!@Install@!UTF-8!\n"
    'Title="ClassBeat"\n'
    'Progress="no"\n'
    'ExecuteFile="powershell.exe"\n'
    'ExecuteParameters="{execparams}"\n'
    ";!@InstallEnd@!\n"
)


def read_version(zip_path: Path) -> str:
    """从包里的 app/version.js 抠版本号，安装器文件名带上。"""
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            if name.endswith("/app/version.js"):
                src = z.read(name).decode("utf-8", "replace")
                m = re.search(r'var VERSION = "([^"]*)"', src)
                return m.group(1) if m else ""
    return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", help="整包 zip；默认取 dist 下唯一的 classbeat-*.zip")
    ap.add_argument("--out", default=str(ROOT / "dist"), help="产物目录")
    ap.add_argument("--version", default="", help="安装器文件名里的版本号")
    ap.add_argument(
        "--install-args", default="",
        help="附加给 install.ps1 的参数（测试用，如 -TargetDir ... -NoAutostart）",
    )
    a = ap.parse_args()

    if not SFX.exists():
        print("缺少 SFX 安装壳：%s" % SFX)
        return 1

    dist = Path(a.out)
    dist.mkdir(parents=True, exist_ok=True)
    zip_path = Path(a.zip) if a.zip else None
    if zip_path is None:
        found = sorted(p for p in dist.glob("classbeat-*.zip")
                       if not p.name.endswith("-single.html"))
        if len(found) != 1:
            print("dist 下应正好有一个 classbeat-*.zip，实际 %d 个" % len(found))
            return 1
        zip_path = found[0]
    if not zip_path.exists():
        print("找不到整包：%s" % zip_path)
        return 1

    ver = a.version or read_version(zip_path)
    setup_name = "classbeat-setup-%s.exe" % (ver or "dev")

    work = Path(tempfile.mkdtemp(prefix="classbeat-setup-"))
    try:
        # 1) zip → 暂存目录，压平顶层文件夹：SFX 压缩包根 = 包内容根，
        #    这样 install.ps1 的 $PSScriptRoot 直接就是程序根目录。
        staging = work / "pkg"
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(staging)
        tops = [p for p in staging.iterdir() if p.is_dir()]
        if len(tops) != 1:
            print("整包顶层应有且只有一个文件夹，实际 %d 个" % len(tops))
            return 1
        body = tops[0]
        shutil.copy2(INSTALL_PS1, body / "install.ps1")

        # 2) py7zr 打 7z 压缩包（writeall 才递归，write 只写单条目）；
        #    显式纯 LZMA2（去掉默认附带的 BCJ 过滤器），最大化 7zSD 兼容
        import py7zr
        archive = work / "package.7z"
        with py7zr.SevenZipFile(
            archive, "w", filters=[{"id": py7zr.FILTER_LZMA2, "preset": 7}]
        ) as z:
            for p in sorted(body.iterdir()):
                z.writeall(p, arcname=p.name)

        # 3) 三段拼接：sfx 模块 + 配置 + 压缩包
        execparams = "-NoProfile -ExecutionPolicy Bypass -File install.ps1 -NoPause"
        if a.install_args:
            execparams += " " + a.install_args.strip()
        config = CONFIG_TMPL.format(execparams=execparams).encode("utf-8")
        exe = dist / setup_name
        with open(exe, "wb") as out:
            out.write(SFX.read_bytes())
            out.write(config)
            out.write(archive.read_bytes())

        # 4) 体积自检：产物至少应包含 sfx 壳 + 压缩包本体
        floor = SFX.stat().st_size + archive.stat().st_size
        size = exe.stat().st_size
        if size < floor:
            print("安装器 %d 字节 < 壳+包 %d 字节，产物不可信" % (size, floor))
            return 1
        print("已生成 %s（%.1f MB，整包 %.1f MB）"
              % (exe, size / 1048576, zip_path.stat().st_size / 1048576))
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
