#!/usr/bin/env python3
"""生成手机端 PWA 图标（server/icons/）。

只用标准库：手账贴纸风——奶油方格纸底、蜡笔琥珀时钟、深棕描边。
    python3 tools/make_icons.py
输出 192 与 512 两档；改了配色或形状，重跑一次即可。
"""

import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "server", "icons")

BG = (251, 243, 223, 255)      # 奶油纸 #FBF3DF
GRID = (226, 209, 176, 255)    # 格线（同色系加深一点）
CARD = (255, 248, 231, 255)    # 表盘 #FFF8E7
INK = (58, 42, 30, 255)        # 深棕描边 #3A2A1E
AMBER = (239, 159, 39, 255)    # 蜡笔琥珀 #EF9F27
TEAL = (29, 158, 117, 255)     # 分针 #1D9E75
CLEAR = (0, 0, 0, 0)


def png_write(path, w, h, px):
    rows = b"".join(b"\x00" + bytes(v for p in px[y] for v in p) for y in range(h))

    def chunk(t, data):
        c = t + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(data)
    return data          # make_ico.py 直接拿字节装进 ICO 容器，不再读盘


def png_bytes(w, h, px):
    """与 png_write 相同的编码，只返回字节不落盘（桌面图标用）。"""
    rows = b"".join(b"\x00" + bytes(v for p in px[y] for v in p) for y in range(h))

    def chunk(t, data):
        c = t + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def in_round(x, y, w, h, r):
    """圆角矩形内部判断（0<=x<w, 0<=y<h）。"""
    if x < 0 or y < 0 or x >= w or y >= h:
        return False
    if x < r and y < r:
        return (x - r) ** 2 + (y - r) ** 2 <= r * r
    if x >= w - r and y < r:
        return (x - (w - 1 - r)) ** 2 + (y - r) ** 2 <= r * r
    if x < r and y >= h - r:
        return (x - r) ** 2 + (y - (h - 1 - r)) ** 2 <= r * r
    if x >= w - r and y >= h - r:
        return (x - (w - 1 - r)) ** 2 + (y - (h - 1 - r)) ** 2 <= r * r
    return True


def dist_seg(px, py, ax, ay, bx, by):
    """点到线段的距离。"""
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L = vx * vx + vy * vy
    t = 0.0 if L == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def build(size):
    S = 2                       # 2x 超采样换边缘平滑
    W = size * S
    u = W / 512.0               # 以下几何尺寸都以 512 为基准
    rad = 56 * u                # 圆角
    margin = 14 * u             # 描边到边缘
    border = 9 * u              # 描边宽
    cx, cy = 256 * u, 262 * u
    R = 148 * u                 # 表盘外半径
    ring = 30 * u               # 琥珀环宽
    hand_w = 13 * u
    # 时针指向 10 点，分针指向 2 点
    hx, hy = cx - 74 * u, cy - 90 * u
    mx, my = cx + 96 * u, cy - 66 * u

    px = [[CLEAR] * W for _ in range(W)]
    for y in range(W):
        row = px[y]
        for x in range(W):
            # 纸底 + 格线（只在圆角矩形内画）
            if not in_round(x, y, W, W, rad):
                continue
            inner = in_round(x + margin, y + margin, W - 2 * margin, W - 2 * margin, max(1.0, rad - margin))
            if not inner:
                row[x] = INK
                continue
            g = 26 * u
            if (x % g) < 1.6 * u or (y % g) < 1.6 * u:
                row[x] = GRID
                continue
            d = math.hypot(x - cx, y - cy)
            if abs(d - R) <= ring / 2:
                row[x] = AMBER
            elif d < R - ring / 2:
                if dist_seg(x, y, cx, cy, hx, hy) <= hand_w / 2:
                    row[x] = INK
                elif dist_seg(x, y, cx, cy, mx, my) <= hand_w / 2:
                    row[x] = TEAL
                elif d <= 16 * u:
                    row[x] = INK
                else:
                    row[x] = CARD
            else:
                row[x] = BG

    # 2x 超采样盒式降采样
    out = [[None] * size for _ in range(size)]
    for Y in range(size):
        for X in range(size):
            r = g = b = a = 0
            for dy in range(S):
                for dx in range(S):
                    p = px[Y * S + dy][X * S + dx]
                    r += p[0]; g += p[1]; b += p[2]; a += p[3]
            n = S * S
            out[Y][X] = (round(r / n), round(g / n), round(b / n), round(a / n))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (192, 512):
        px = build(size)
        p = os.path.join(OUT, f"icon-{size}.png")
        png_write(p, size, size, px)
        print(f"已生成 {p}（{os.path.getsize(p)} 字节）")


if __name__ == "__main__":
    main()
