#!/usr/bin/env python3
"""生成大屏桌面图标的 .ico（tools/launcher/classbeat.ico）。

两种来源：
    python3 tools/make_ico.py                     # 程序化贴纸时钟（默认，CI 可跑）
    python3 tools/make_ico.py --png <图片路径>     # 用品牌图生成（2026-11-17 的 CB logo）

--png 模式：PNG 直接解；JPEG 在 Windows 上借系统 gdiplus.dll 转一手
（ctypes 调用，不装任何东西）。白底转透明（从四边泛洪）、按几何面积
平均缩到 7 档，PNG 负载装进 ICO 容器。品牌图换新时：
    python3 tools/make_ico.py --png tools/launcher/logo-source.png
logo 源图与 ico 都入库，CI 打包只读 ico，不重生成。
"""

import ctypes
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_icons import build, png_bytes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tools", "launcher", "classbeat.ico")

SIZES = (16, 24, 32, 48, 64, 128, 256)


# ---------- PNG 解码（8-bit RGB/RGBA，非隔行） ----------

def decode_png(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG"
    pos = 8
    w = h = ctype = None
    idat = b""
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
            assert depth == 8 and interlace == 0 and ctype in (2, 6), \
                f"不支持的 PNG：位深 {depth} 颜色 {ctype}"
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
        pos += 12 + ln
    bpp = 3 if ctype == 2 else 4
    raw = zlib.decompress(idat)
    stride = w * bpp
    px = [[None] * w for _ in range(h)]
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        f = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b_ = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 0:
                v = line[x]
            elif f == 1:
                v = line[x] + a
            elif f == 2:
                v = line[x] + b_
            elif f == 3:
                v = line[x] + (a + b_) // 2
            else:
                p_ = a + b_ - c
                pa, pb, pc = abs(p_ - a), abs(p_ - b_), abs(p_ - c)
                v = line[x] + (a if pa <= pb and pa <= pc else (b_ if pb <= pc else c))
            line[x] = v & 0xFF
        row = px[y]
        for x in range(w):
            if ctype == 2:
                row[x] = (line[x * 3], line[x * 3 + 1], line[x * 3 + 2], 255)
            else:
                row[x] = (line[x * 4], line[x * 4 + 1], line[x * 4 + 2], line[x * 4 + 3])
        prev = line
    return w, h, px


# ---------- JPEG → PNG（Windows 系统自带 GDI+，ctypes 调用） ----------

def jpeg_to_png_bytes(jpeg_path):
    g = ctypes.WinDLL("gdiplus.dll")

    class StartupInput(ctypes.Structure):
        _fields_ = [("ver", ctypes.c_uint32), ("ptr", ctypes.c_void_p),
                    ("noa", ctypes.c_int32), ("noe", ctypes.c_int32)]

    token = ctypes.c_uint32()
    si = StartupInput(1, None, 0, 0)
    assert g.GdiplusStartup(ctypes.byref(token), ctypes.byref(si), None) == 0
    try:
        img = ctypes.c_void_p()
        r = g.GdipLoadImageFromFile(ctypes.c_wchar_p(os.path.abspath(jpeg_path)),
                                    ctypes.byref(img))
        assert r == 0, f"GdipLoadImageFromFile 失败：{r}"
        # PNG 编码器 CLSID（系统固定值 {557CF406-1A04-11D3-9A73-0000F81EF32E}，
        # 按 GUID 小端布局展开成 16 字节）
        clsid = ctypes.create_string_buffer(
            bytes.fromhex("06f47c55041ad3119a730000f81ef32e"), 16)
        tmp = os.path.join(os.environ.get("TEMP", "."), "_ico_tmp.png")
        r = g.GdipSaveImageToFile(img, ctypes.c_wchar_p(tmp),
                                  ctypes.cast(clsid, ctypes.c_void_p), None)
        assert r == 0, f"GdipSaveImageToFile 失败：{r}"
        g.GdipDisposeImage(img)
        with open(tmp, "rb") as f:
            return f.read()
    finally:
        g.GdiplusShutdown(token)


def load_image(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return decode_png(data)
    if data[:3] == b"\xff\xd8\xff":
        return decode_png(jpeg_to_png_bytes(path))
    raise ValueError("只认 PNG / JPEG")


# ---------- 白底转透明：从四边泛洪，只清与边缘连通的近白像素 ----------

def flatten_white(px, w, h, tol=18):
    def near_white(p):
        return p[3] == 0 or (p[0] >= 255 - tol and p[1] >= 255 - tol and p[2] >= 255 - tol)

    seen = [[False] * w for _ in range(h)]
    stack = []
    for x in range(w):
        stack += [(x, 0), (x, h - 1)]
    for y in range(h):
        stack += [(0, y), (w - 1, y)]
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y][x]:
            continue
        seen[y][x] = True
        if not near_white(px[y][x]):
            continue
        px[y][x] = (px[y][x][0], px[y][x][1], px[y][x][2], 0)
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    return px


# ---------- 几何面积平均缩放（预乘 alpha，避免白边） ----------

def resize(px, w, h, size):
    out = [[None] * size for _ in range(size)]
    for Y in range(size):
        sy0, sy1 = Y * h / size, (Y + 1) * h / size
        for X in range(size):
            sx0, sx1 = X * w / size, (X + 1) * w / size
            r = g = b = a = area = 0.0
            for sy in range(max(0, int(sy0)), min(h, int(sy1) + 1)):
                fy = min(sy1, sy + 1) - max(sy0, sy)
                if fy <= 0:
                    continue
                for sx in range(max(0, int(sx0)), min(w, int(sx1) + 1)):
                    fx = min(sx1, sx + 1) - max(sx0, sx)
                    if fx <= 0:
                        continue
                    p = px[sy][sx]
                    f = fx * fy * (p[3] / 255.0)
                    r += p[0] * f
                    g += p[1] * f
                    b += p[2] * f
                    a += f
                    area += fx * fy
            if a > 0.5:
                av = a / area if area else 0
                out[Y][X] = (round(min(255, r / a)), round(min(255, g / a)),
                             round(min(255, b / a)), round(min(255, av * 255)))
            else:
                out[Y][X] = (255, 255, 255, 0)
    return out


# ---------- ICO 打包 ----------

def pack_ico(pngs, out):
    offset = 6 + 16 * len(pngs)
    header = struct.pack("<HHH", 0, 1, len(pngs))
    entries = b""
    body = b""
    for size, png in pngs:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset)
        body += png
        offset += len(png)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as f:
        f.write(header + entries + body)
    print(f"已生成 {out}（{os.path.getsize(out)} 字节，{len(pngs)} 档）")


def main():
    args = sys.argv[1:]
    if args and args[0] == "--png":
        assert len(args) == 2, "用法：make_ico.py --png <图片路径>"
        w, h, px = load_image(args[1])
        px = flatten_white(px, w, h)
        pngs = [(s, png_bytes(s, s, resize(px, w, h, s))) for s in SIZES]
    else:
        pngs = [(s, png_bytes(s, s, build(s))) for s in SIZES]
    pack_ico(pngs, OUT)


if __name__ == "__main__":
    main()
