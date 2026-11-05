#!/usr/bin/env python3
"""把「代码 + 私有数据 + 素材 + 安装包」打成一个离线备份包。

用法：
    python3 tools/backup.py                 # 备份到 backups/ClassBeat-备份-YYYYMMDD-HHMM.zip
    python3 tools/backup.py --out /path/to # 指定输出文件

为什么要有这个脚本：仓库是公开的，`data/`、`assets/`、`PLAN.md` 全在 .gitignore 里，
GitHub 上那份只是代码。真正丢了找不回来的，是本机这几样东西：
  · data/*.json          全班姓名、岗位、作息，一学期的劳动
  · assets/source/       两张原始表照片（唯一的纸面来源）
  · PLAN.md 等           含真实姓名的推演文档
所以备份必须三样一起走，只 clone 仓库等于什么都没备。

包里还有一个 git bundle：它是整个仓库的完整历史（含所有分支），
用 `git clone ClassBeat-repo.bundle ClassBeat` 就能还原，不依赖 GitHub。
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import os
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 私有：绝不入库，也不该出现在任何公开位置
PRIVATE_DIRS = ["data", "assets/source"]
PRIVATE_FILES = ["PLAN.md", "PROJECT_BRIEF.md", "WHITEBOARD-VIDEO-PROMPT.md"]
# 构建产物：可重生成，但重生成要现成环境，顺手带上
BUILD_DIRS = ["dist", "out"]
BUILD_FILES = ["server/messages.json"]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", *args], cwd=ROOT, capture_output=True, text=True, check=False
        ).stdout.strip()
    except FileNotFoundError:
        return ""


def collect() -> list[tuple[Path, str]]:
    """返回 [(本地路径, 包内路径)]，保持目录结构。"""
    items: list[tuple[Path, str]] = []
    for d in PRIVATE_DIRS + BUILD_DIRS:
        base = ROOT / d
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*")):
            if p.is_file() and "__pycache__" not in p.parts:
                items.append((p, p.relative_to(ROOT).as_posix()))
    for f in PRIVATE_FILES + BUILD_FILES:
        p = ROOT / f
        if p.is_file():
            items.append((p, f))
    return items


def main() -> None:
    ap = argparse.ArgumentParser(description="打一个离线备份包")
    ap.add_argument("--out", help="输出 zip 路径")
    args = ap.parse_args()

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M")
    out = Path(args.out) if args.out else ROOT / "backups" / f"ClassBeat-备份-{stamp}.zip"
    out.parent.mkdir(parents=True, exist_ok=True)

    bundle = out.parent / f"{out.stem}.bundle"
    head = git("rev-parse", "HEAD") or "unknown"
    branch = git("rev-parse", "--abbrev-ref", "HEAD") or "unknown"
    remote = git("remote", "get-url", "origin")

    if git("rev-parse", "--git-dir"):
        r = subprocess.run(["git", "bundle", "create", str(bundle), "--all"],
                           cwd=ROOT, capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit(f"git bundle 失败：{r.stderr.strip()}")

    items = collect()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for src, arc in items:
            z.write(src, arc)

        manifest = [
            "ClassBeat 离线备份",
            f"时间      {dt.datetime.now().strftime('%Y-%m-%d %H:%M')}",
            f"提交      {head}",
            f"分支      {branch}",
            f"远端      {remote}",
            "",
            "还原代码  git clone ClassBeat-repo.bundle ClassBeat",
            "还原数据  把 data/ assets/ 与 *.md 拷回项目根目录",
            "",
            f"{'大小':>10}  SHA256                                                           文件",
        ]
        for src, arc in items:
            manifest.append(f"{src.stat().st_size:>10}  {sha256(src)}  {arc}")
        z.writestr("MANIFEST.txt", "\n".join(manifest) + "\n")
        if bundle.is_file():
            z.write(bundle, bundle.name)

    bundle_mb = bundle.stat().st_size / 1048576 if bundle.is_file() else 0
    print(f"备份完成：{out}")
    print(f"  文件 {len(items)} 个，压缩后 {out.stat().st_size / 1048576:.1f} MB")
    print(f"  git bundle {bundle_mb:.1f} MB（完整历史，可离线 clone）")
    missing = [f for f in PRIVATE_FILES if not (ROOT / f).is_file()]
    if missing:
        print(f"  注意：缺 {', '.join(missing)}")
    if not git("rev-parse", "--git-dir"):
        print("  注意：当前不是 git 仓库，包里没有代码历史")


if __name__ == "__main__":
    main()
