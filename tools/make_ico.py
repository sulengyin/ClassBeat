#!/usr/bin/env python3
"""生成大屏桌面图标的 .ico（tools/launcher/classbeat.ico）。

复用 make_icons.py 的贴纸时钟画法，各档尺寸按几何比例重绘（不是拿
512 缩小——小尺寸下线条比例保持一致，缩水不糊）。PNG 负载装进 ICO
容器，Vista 起的 Windows 都认这种格式，不需要引入 Pillow。
    python3 tools/make_ico.py
改了配色或形状，重跑 make_icons.py 与本脚本各一次。
"""

import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_icons import build, png_bytes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tools", "launcher", "classbeat.ico")

# Windows 常用的图标档位；256 用 0 表示（ICO 格式约定）
SIZES = (16, 24, 32, 48, 64, 128, 256)


def main():
    pngs = []
    for size in SIZES:
        px = build(size)
        pngs.append((size, png_bytes(size, size, px)))

    offset = 6 + 16 * len(pngs)
    header = struct.pack("<HHH", 0, 1, len(pngs))
    entries = b""
    body = b""
    for size, png in pngs:
        dim = 0 if size >= 256 else size        # 256 在 ICO 里记作 0
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset)
        body += png
        offset += len(png)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(header + entries + body)
    print(f"已生成 {OUT}（{os.path.getsize(OUT)} 字节，{len(pngs)} 档）")


if __name__ == "__main__":
    main()
