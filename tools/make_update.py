#!/usr/bin/env python3
"""生成 update.json（ROADMAP 9.5）。

    python3 tools/make_update.py --tag v0.2.2 --repo sulengyin/ClassBeat
    python3 tools/make_update.py --zip dist/classbeat-0.2.2.zip \
        --url http://127.0.0.1:9000/classbeat-0.2.2.zip --min-version 0.2.0

版本号和构建号从包内 app/version.js 读，和老师看到的完全一致；
整包 SHA256、每个程序文件的大小与 SHA256 都直接从 zip 读回字节计算。
写完会再用 server/update_manifest.py 校验一遍，避免产出坏清单。
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import update_manifest as um  # noqa: E402

BEIJING = dt.timezone(dt.timedelta(hours=8))

# 低于这个版本的机器不保证更新器认得全部程序文件（0.3.8 起白名单
# 才认 icons/sw.js/launcher），直接提示装完整安装包，不再半路报错。
DEFAULT_MIN_VERSION = "0.3.8"
DEFAULT_REPO = "sulengyin/ClassBeat"


def read_version(entries):
    """从包内 app/version.js 抠版本和构建号（打包时已写死成发布值）。"""
    for rel, data in entries.items():
        if rel.endswith("/app/version.js") or rel == "app/version.js":
            src = data.decode("utf-8", "replace")
            ver = re.search(r'var VERSION = "([^"]*)"', src)
            build = re.search(r'var BUILD = "([^"]*)"', src)
            return (ver.group(1) if ver else ""), (build.group(1) if build else "")
    raise SystemExit("包里找不到 app/version.js，不能生成更新清单")


def is_program_file(rel):
    """只列会被替换的程序文件；运行时、说明和单文件版不进清单。

    0.3.8 曾临时把 server/icons/、server/sw.js、tools/launcher/ 摘出
    清单（当时老机器的替换白名单窄，进清单就被拒换，卡死升级）。
    0.3.10 起现役机器都过了宽白名单，且用 minVersion=0.3.8 做闸门：
    白名单不够宽的老更新器会在「检查更新」阶段就得到"请装完整安装
    包"的清晰提示，不会再中途报"不该替换的文件"。清单重新全量发布，
    启动器/图标/PWA 壳随版本走。受保护文件（data/、assets/、
    server/messages.json 等）就算误进了包也不发清单。"""
    if rel in ("MANIFEST.txt", "使用说明.txt", "update-source.txt"):
        return False
    if rel in um.PROTECTED_FILES or rel.startswith(um.PROTECTED_PREFIXES):
        return False
    if rel.endswith("-单文件版.html") or rel.endswith("-single.html"):
        return False
    if rel.startswith("server/python/"):
        return False
    # 启动器只有脚本随版本走（.ps1/.cmd，与替换白名单同口径）；
    # classbeat.ico 这类静态图标不进清单
    if rel.startswith("tools/launcher/") and not rel.endswith((".ps1", ".cmd")):
        return False
    return rel.startswith("app/") or rel.startswith("server/") \
        or rel.startswith("tools/launcher/") or rel.endswith(".bat")


def read_zip(zip_path):
    """返回 (包内顶层目录, {包内相对路径: 字节})。"""
    with zipfile.ZipFile(zip_path) as z:
        infos = [i for i in z.infolist() if not i.is_dir()]
        if not infos:
            raise SystemExit("包是空的：%s" % zip_path)
        top = infos[0].filename.split("/", 1)[0]
        entries = {}
        for info in infos:
            name = info.filename
            if name == top or not name.startswith(top + "/"):
                continue
            entries[name[len(top) + 1:]] = z.read(info)
    return top + "/", entries


def changelog_notes(path, version):
    """从 CHANGELOG 里取这个版本的一节；找不到就返回空。"""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return ""
    head = re.search(r"^##\s+v?" + re.escape(version) + r"(?![0-9.]).*$",
                     text, re.M)
    if not head:
        return ""
    body = text[head.end():]
    nxt = re.search(r"^##\s", body, re.M)
    return body[:nxt.start() if nxt else len(body)].strip()


def build_manifest(zip_path, tag="", repo=DEFAULT_REPO, url="",
                   min_version=DEFAULT_MIN_VERSION, notes="",
                   published_at=""):
    zip_path = Path(zip_path)
    top, entries = read_zip(zip_path)
    version, build = read_version(entries)
    if not version:
        raise SystemExit("app/version.js 里没有版本号")

    files = []
    for rel in sorted(entries):
        if not is_program_file(rel):
            continue
        data = entries[rel]
        files.append({
            "path": rel,
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
        })

    if not url:
        if not tag:
            raise SystemExit("要么给 --tag，要么直接给 --url")
        url = "https://github.com/%s/releases/download/%s/%s" % (
            repo, tag, zip_path.name)

    raw = zip_path.read_bytes()
    return {
        "schema": um.SCHEMA_VERSION,
        "version": version,
        "build": build,
        "publishedAt": published_at or dt.datetime.now(BEIJING).isoformat(timespec="seconds"),
        "minVersion": min_version,
        "notes": notes,
        "url": url,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes": len(raw),
        "files": files,
    }


def main():
    ap = argparse.ArgumentParser(description="生成 update.json")
    ap.add_argument("--dist", default=str(ROOT / "dist"), help="打包产物目录")
    ap.add_argument("--zip", help="指定 zip；默认取 dist 下唯一的 classbeat-*.zip")
    ap.add_argument("--out", help="输出路径，默认 <dist>/update.json")
    ap.add_argument("--tag", help="Release tag，用来拼下载地址")
    ap.add_argument("--repo", default=DEFAULT_REPO, help="owner/repo")
    ap.add_argument("--url", help="直接指定整包地址（本地测试用）")
    ap.add_argument("--min-version", default=DEFAULT_MIN_VERSION,
                    help="最低可升级版本，默认 %s" % DEFAULT_MIN_VERSION)
    ap.add_argument("--notes", help="更新说明；不给就从 CHANGELOG 取")
    ap.add_argument("--notes-file", default=str(ROOT / "CHANGELOG.md"),
                    help="CHANGELOG 路径")
    ap.add_argument("--published-at", help="固定发布日期（测试用）")
    ap.add_argument("--check-only", action="store_true",
                    help="只校验已有的 update.json，不生成")
    args = ap.parse_args()

    if args.check_only:
        target = Path(args.out) if args.out else Path(args.dist) / "update.json"
        parsed = um.parse_manifest(target.read_bytes())
        print("清单可用：v%s · %s，%d 个程序文件"
              % (parsed["version"], parsed["build"], len(parsed["files"])))
        return

    dist = Path(args.dist)
    zip_path = Path(args.zip) if args.zip else None
    if zip_path is None:
        found = sorted(dist.glob("classbeat-*.zip"))
        if len(found) != 1:
            raise SystemExit("dist 下应该正好有一个 classbeat-*.zip，实际 %d 个" % len(found))
        zip_path = found[0]
    if not zip_path.exists():
        raise SystemExit("找不到安装包：%s" % zip_path)

    _, entries = read_zip(zip_path)
    version, _ = read_version(entries)
    notes = args.notes
    if notes is None:
        notes = changelog_notes(args.notes_file, version)
        if not notes:
            print("提醒：CHANGELOG 里没有 %s 这一节，更新说明留空" % version)

    manifest = build_manifest(
        zip_path, tag=args.tag or "", repo=args.repo, url=args.url or "",
        min_version=args.min_version, notes=notes,
        published_at=args.published_at or "")

    out = Path(args.out) if args.out else dist / "update.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")

    # 写完立刻按安装器的口径再验一遍，坏清单不要流到 Release。
    parsed = um.parse_manifest(out.read_bytes())
    um.verify_package(zip_path, parsed)

    size_mb = parsed["bytes"] / 1024 / 1024
    print("已生成 %s" % out)
    print("  v%s · 构建 %s · 发布日期 %s"
          % (parsed["version"], parsed["build"], parsed["publishedAt"]))
    print("  包 %s（%.1f MB，SHA256 %s…）"
          % (zip_path.name, size_mb, parsed["sha256"][:12]))
    print("  程序文件 %d 个，最低可升级 v%s"
          % (len(parsed["files"]), parsed["minVersion"]))


if __name__ == "__main__":
    main()
