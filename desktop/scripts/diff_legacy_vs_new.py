#!/usr/bin/env python3
"""旧包（0.3.24 解压版）与新包（0.4.x resources）的业务代码逐文件对比。

目的：给"重构没有改坏功能"提供最硬的一层证据 —— 老师看到的一切都来自
`app/`（页面）与 `server/`（服务），这两棵树如果字节相同，功能就不可能变。

用法：
    python desktop/scripts/diff_legacy_vs_new.py
    python desktop/scripts/diff_legacy_vs_new.py --dump-diff   # 额外打印每处差异的具体改动
"""

import argparse
import difflib
import hashlib
import os
import sys

LEGACY = os.environ.get("CB_LEGACY_DIR",
                        r"C:\Users\hello\ClassBeat-backup-20261121-0057\legacy-ClassBeat")
NEW = os.environ.get("CB_NEW_RES",
                     os.path.join(os.environ["LOCALAPPDATA"], "ClassBeat", "resources"))

SKIP_DIRS = {"__pycache__", "node_modules", ".git"}
# 二进制/运行时：不比内容，只比是否存在
BINARY_EXT = {".exe", ".dll", ".ico", ".png", ".jpg", ".webp", ".pyc", ".zip", ".7z"}


def walk(root, sub):
    base = os.path.join(root, sub)
    out = {}
    if not os.path.isdir(base):
        return out
    for dp, dns, fns in os.walk(base):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for fn in fns:
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, base).replace("\\", "/")
            out[rel] = full
    return out


def sha(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def is_binary(rel):
    return os.path.splitext(rel)[1].lower() in BINARY_EXT


def norm_bytes(path):
    """去掉 BOM、统一行尾后再算哈希。

    为什么必须做这一步：旧包是 Windows 上打出来的（CRLF + 可能带 BOM），
    新包的文件是 stage 脚本按 UTF-8/LF 写的。不归一化会把几百个文件报成"不同"，
    而实际上一行代码都没动 —— 这种噪声会直接把结论带偏。
    """
    with open(path, "rb") as f:
        raw = f.read()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    return raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def compare_tree(sub, dump):
    old, new = walk(LEGACY, sub), walk(NEW, sub)
    only_old = sorted(set(old) - set(new))
    only_new = sorted(set(new) - set(old))
    common = sorted(set(old) & set(new))
    same, cosmetic, changed = [], [], []
    for rel in common:
        if is_binary(rel):
            (same if os.path.getsize(old[rel]) == os.path.getsize(new[rel]) else changed).append(rel)
            continue
        a, b = norm_bytes(old[rel]), norm_bytes(new[rel])
        if a == b:
            (same if sha(old[rel]) == sha(new[rel]) else cosmetic).append(rel)
        else:
            changed.append(rel)

    print(f"\n{'=' * 72}\n[{sub}]  旧 {len(old)} 个文件 / 新 {len(new)} 个文件")
    print(f"  完全一致（含编码/行尾）: {len(same)}")
    print(f"  仅换行或 BOM 不同      : {len(cosmetic)}  {cosmetic if cosmetic else ''}")
    print(f"  实质内容不同          : {len(changed)}")
    print(f"  只在旧包里: {len(only_old)}  {only_old if only_old else ''}")
    print(f"  只在新包里: {len(only_new)}  {only_new if only_new else ''}")
    if changed:
        print("  -- 实质不同的文件 --")
        for rel in changed:
            o, n = old[rel], new[rel]
            print(f"    {rel:38s} {os.path.getsize(o):>8d} → {os.path.getsize(n):>8d} 字节")
            if dump and not is_binary(rel):
                a = norm_bytes(o).decode("utf-8", "replace").splitlines()
                b = norm_bytes(n).decode("utf-8", "replace").splitlines()
                diff = list(difflib.unified_diff(a, b, "旧", "新", lineterm="", n=2))
                for line in diff[:120]:
                    print("      " + line)
                if len(diff) > 120:
                    print(f"      … 还有 {len(diff) - 120} 行差异")
    return same, cosmetic, changed, only_old, only_new


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump-diff", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(LEGACY):
        print(f"找不到旧包目录：{LEGACY}")
        return 2
    if not os.path.isdir(NEW):
        print(f"找不到新包资源：{NEW}")
        return 2
    print(f"旧包 {LEGACY}\n新包 {NEW}")

    total_same = total_cosmetic = total_changed = 0
    for sub in ("app", "server"):
        same, cosmetic, changed, only_old, only_new = compare_tree(sub, args.dump_diff)
        total_same += len(same)
        total_cosmetic += len(cosmetic)
        total_changed += len(changed) + len(only_old) + len(only_new)

    print(f"\n{'=' * 72}")
    print(f"合计：完全一致 {total_same} / 仅编码行尾 {total_cosmetic} / 实质不同 {total_changed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
