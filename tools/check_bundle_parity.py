#!/usr/bin/env python3
"""data.js 双实现比对（desktop/docs/13 §13.3、§13.12 P1-1）。

同一份数据，两套实现各出一份 app/data.js：

    tools/bundle.py             参考实现（Python，只在开发机与 CI 跑）
    classbeat-tools bundle      产品实现（Rust，打包时真正用的那份）

约定是"以 Rust 为准、Python 只当尺子"。但约定不等于校验——以前只有人工核对，
这份脚本把它变成 CI 里的一条硬断言。

三处差异是**允许的**，比对前先抹平：

1. 首行署名（各自写自己的名字，出问题好判断是谁生成的文件）；
2. `generatedAt` 时间戳（两次运行不可能落在同一秒）；
3. 换行符（统一按 LF 比；Windows 上 Python 文本模式曾写 CRLF）。

除此之外任何一个字节不同都算失败，并打印第一处差异的位置与上下文。

用法：
    python3 tools/check_bundle_parity.py
    python3 tools/check_bundle_parity.py --data sample \\
        --bin desktop/tools-rs/target/release/classbeat-tools.exe
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TS_RE = re.compile(r'"generatedAt":"[^"]*"')


def default_bin():
    name = "classbeat-tools.exe" if os.name == "nt" else "classbeat-tools"
    return ROOT / "desktop" / "tools-rs" / "target" / "release" / name


def run(cmd, label):
    p = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if p.returncode != 0:
        print(f"× {label} 失败（退出码 {p.returncode}）", file=sys.stderr)
        for stream, text in (("stdout", p.stdout), ("stderr", p.stderr)):
            text = (text or "").strip()
            if text:
                print(f"  {stream}: {text}", file=sys.stderr)
        sys.exit(2)
    return p


def normalize(text):
    """抹掉署名行、时间戳与换行差异，返回可逐字节比较的正文。"""
    nl = text.find("\n")
    body = text[nl + 1:] if nl >= 0 else ""
    body = body.replace("\r\n", "\n")
    return TS_RE.sub('"generatedAt":"<ts>"', body)


def first_diff(a, b):
    """第一处差异的下标；相同返回 -1。"""
    limit = min(len(a), len(b))
    for i in range(limit):
        if a[i] != b[i]:
            return i
    return -1 if len(a) == len(b) else limit


def show_diff(a, b, at):
    span = 70
    lo = max(0, at - span)
    print(f"  第一处差异在第 {at} 个字符（两边长度 {len(a)} / {len(b)}）")
    print(f"  参考实现 …{a[lo:at]}\033[31m{a[at:at + span]}\033[0m…")
    print(f"  产品实现 …{b[lo:at]}\033[31m{b[at:at + span]}\033[0m…")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="sample", help="数据目录，默认 sample")
    ap.add_argument("--bin", default=str(default_bin()),
                    help="classbeat-tools 可执行文件路径")
    a = ap.parse_args()

    bin_path = Path(a.bin)
    if not bin_path.is_file():
        print(f"× 找不到 {bin_path}\n"
              f"  先编：cargo build --release --manifest-path desktop/tools-rs/Cargo.toml",
              file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory(prefix="cb-parity-") as tmp:
        py_out = Path(tmp) / "py.js"
        rs_out = Path(tmp) / "rs.js"

        run([sys.executable, "tools/bundle.py", "--data", a.data, "--out", str(py_out)],
            "tools/bundle.py")
        run([str(bin_path), "bundle", "--data", a.data, "--out", str(rs_out)],
            "classbeat-tools bundle")

        py_text = py_out.read_text(encoding="utf-8")
        rs_text = rs_out.read_text(encoding="utf-8")

    for name, text in (("工具", rs_text),):
        if "window.RHYTHM_DATA=" not in text:
            print(f"× {name}产物里没有 window.RHYTHM_DATA=", file=sys.stderr)
            return 1

    pa, pb = normalize(py_text), normalize(rs_text)
    at = first_diff(pa, pb)
    if at >= 0:
        print("× 两套实现产出的 data.js 不一致")
        show_diff(pa, pb, at)
        print("  改了其中一边的字段顺序、分隔方式或取值规则就要同步另一边；"
              "\n  确实要分道扬镳，先改 docs/13 的约定，再删这条断言。")
        return 1

    print(f"✓ data.js 双实现一致（{len(pa)} 字符，已抹平署名/时间戳/换行）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
