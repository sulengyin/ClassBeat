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


AMBER_DEEP = (198, 114, 24, 255)   # 环的下半段，给一点体积感
PAPER_TOP = (255, 250, 239, 255)    # 纸面高光
PAPER_LOW = (246, 229, 198, 255)    # 纸面收暗


def _lerp(a, b, t):
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return (round(a[0] + (b[0] - a[0]) * t),
            round(a[1] + (b[1] - a[1]) * t),
            round(a[2] + (b[2] - a[2]) * t), 255)


def build(size):
    """奶油纸卡 + 琥珀圆弧 + 墨色时针。

    2026-11-22 换掉了原来的"CB 单字 + 屏风"：那套在 16/24px 下笔画糊成一团，
    任务栏和桌面上一眼认不出。现在主体只有一个圆，缩到 16px 仍读得出"钟"，
    正好是这块屏在教室里干的事（看着时间走）。

    小尺寸的两个坑：描边和环宽都按 512 的比例缩，到 16px 只剩零点几像素，
    会被超采样抹成灰边。所以统一走 v(base, min_px)，给每条线一个真实像素下限。
    """
    S = 4 if size <= 128 else 2        # 超采样倍数：小尺寸多采几刀
    W = size * S
    k = size / 512.0                   # 1 个基准单位 = k 个真实像素

    def v(base, min_px=0.0):
        return max(base * k, min_px) * S

    rad = v(108)
    border = v(10, 1.7)
    R = v(170)                         # 环外半径
    ring = v(48, 2.5)                  # 环宽
    hand_w = v(30, 1.9)
    dot = v(18, 1.4)
    cx = cy = W / 2.0
    tipx, tipy = cx - 0.46 * R, cy - 0.37 * R        # 时针指向 10 点
    tick_w = v(10, 1.5)              # 12/3/6/9 的刻度，只有大图才画
    tick_a, tick_b = R - ring - v(3), R - ring - v(3) + v(26)

    px = [[CLEAR] * W for _ in range(W)]
    for y in range(W):
        row = px[y]
        fy = y + 0.5
        for x in range(W):
            if not in_round(x, y, W, W, rad):
                continue
            # 注意是 x - border：判的是"退进内框后"的相对坐标。
            # 写成 x + border 会让右边和下边多出一条厚边（旧版就有这个 bug，
            # 只是底色是深蓝所以看不出来）。
            inner = in_round(x - border, y - border, W - 2 * border,
                             W - 2 * border, max(1.0, rad - border))
            if not inner:
                row[x] = INK
                continue
            # 纸面：上亮下暗
            row[x] = _lerp(PAPER_TOP, PAPER_LOW, fy / W)
            fx = x + 0.5
            d = math.hypot(fx - cx, fy - cy)
            if R - ring <= d <= R:
                row[x] = _lerp(AMBER, AMBER_DEEP, (fy / W - 0.2) / 0.7)
            elif d < R - ring:
                if d <= dot:
                    row[x] = INK
                elif dist_seg(fx, fy, cx, cy, tipx, tipy) <= hand_w / 2:
                    row[x] = INK
                elif size >= 96 and any(
                        dist_seg(fx, fy, cx + tick_a * math.cos(t), cy + tick_a * math.sin(t),
                                 cx + tick_b * math.cos(t), cy + tick_b * math.sin(t)) <= tick_w / 2
                        for t in (0.0, math.pi / 2, math.pi, 1.5 * math.pi)):
                    row[x] = INK
                else:
                    row[x] = CARD

    # 超采样盒式降采样
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
