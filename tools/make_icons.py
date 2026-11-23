#!/usr/bin/env python3
"""生成 ClassBeat 图标：只从唯一源图缩放，不再在本文件里绘制形状。

图标固定为 tools/brand/icon-source.png（深色圆角底 + 奶油屏 + CB 时钟）。
要换图标，替换这张源图，再跑：

    python3 tools/make_icons.py

输出：
  server/icons/icon-192.png、icon-512.png   PWA / 手机页
  tools/launcher/classbeat.ico              0.3.x 桌面快捷方式
  desktop/src-tauri/icons/classbeat.ico     0.5.x 安装包（目录不存在则跳过）

只用标准库：PNG 读写、双线性缩放、ICO 打包都在本文件里。
"""

import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "brand", "icon-source.png")
PWA_OUT = os.path.join(ROOT, "server", "icons")
ICO_TARGETS = [
    os.path.join(ROOT, "tools", "launcher", "classbeat.ico"),
    os.path.join(ROOT, "desktop", "src-tauri", "icons", "classbeat.ico"),
    os.path.join(ROOT, "tools", "brand", "classbeat.ico"),
]
PWA_SIZES = (192, 512)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


# ---------------------------------------------------------------- PNG 读写

def png_read(path):
    """读 8-bit、非隔行 PNG，返回 (w, h, RGB bytearray)。支持 5 种行过滤。"""
    d = open(path, "rb").read()
    if d[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG：%s" % path)
    pos = 8
    idat = bytearray()
    w = h = depth = ctype = None
    interlace = 0
    while pos < len(d):
        n = struct.unpack(">I", d[pos:pos + 4])[0]
        tag = d[pos + 4:pos + 8]
        body = d[pos + 8:pos + 8 + n]
        pos += 12 + n
        if tag == b"IHDR":
            w, h, depth, ctype, _comp, _filt, interlace = struct.unpack(">IIBBBBB", body)
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
    if depth != 8 or interlace != 0:
        raise ValueError("只支持 8-bit 非隔行 PNG（当前 depth=%s interlace=%s）" % (depth, interlace))
    ch = {0: 1, 2: 3, 4: 2, 6: 4}.get(ctype)
    if ch is None:
        raise ValueError("不支持的 PNG color type：%s" % ctype)
    raw = zlib.decompress(bytes(idat))
    stride = w * ch
    prev = bytearray(stride)
    rows = bytearray()
    p = 0
    for _ in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        rows += line
        prev = line
    if ch == 3:
        rgb = rows
    elif ch == 4:
        rgb = bytearray(w * h * 3)
        for i in range(w * h):
            rgb[3 * i:3 * i + 3] = rows[4 * i:4 * i + 3]
    else:  # 灰度
        rgb = bytearray(w * h * 3)
        for i in range(w * h):
            v = rows[i]
            rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = v
    return w, h, rgb


def png_write_rgb(path, w, h, rgb):
    rows = b"".join(b"\x00" + bytes(rgb[y * w * 3:(y + 1) * w * 3]) for y in range(h))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
                + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def resize(src, sw, sh, dw, dh):
    """双线性缩放，输入输出都是 RGB bytearray。"""
    out = bytearray(dw * dh * 3)
    for y in range(dh):
        fy = (y + 0.5) * sh / dh - 0.5
        y0 = max(0, min(sh - 1, int(fy)))
        y1 = min(sh - 1, y0 + 1)
        ty = max(0.0, fy - y0)
        for x in range(dw):
            fx = (x + 0.5) * sw / dw - 0.5
            x0 = max(0, min(sw - 1, int(fx)))
            x1 = min(sw - 1, x0 + 1)
            tx = max(0.0, fx - x0)
            o = (y * dw + x) * 3
            for c in range(3):
                a = src[(y0 * sw + x0) * 3 + c]
                b = src[(y0 * sw + x1) * 3 + c]
                c0 = src[(y1 * sw + x0) * 3 + c]
                d = src[(y1 * sw + x1) * 3 + c]
                top = a + (b - a) * tx
                bot = c0 + (d - c0) * tx
                out[o + c] = int(top + (bot - top) * ty + 0.5)
    return out


# ---------------------------------------------------------------- ICO 打包

def bmp32(w, h, rgb):
    """ICO 里的 32bpp BMP 条目：BGRA、自下而上、末尾跟全 0 的 AND mask。"""
    hdr = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, w * h * 4, 0, 0, 0, 0)
    body = bytearray()
    for y in range(h - 1, -1, -1):
        base = y * w * 3
        for x in range(w):
            o = base + x * 3
            body += bytes((rgb[o + 2], rgb[o + 1], rgb[o], 255))
    mask_row = ((w + 31) // 32) * 4
    return bytes(hdr) + bytes(body) + bytes(mask_row * h)


def ico_bytes(sw, sh, rgb, sizes=ICO_SIZES):
    imgs = []
    for s in sizes:
        small = rgb if (sw == s and sh == s) else resize(rgb, sw, sh, s, s)
        imgs.append((s, bmp32(s, s, small)))
    head = struct.pack("<HHH", 0, 1, len(imgs))
    offset = 6 + 16 * len(imgs)
    entries = bytearray()
    data = bytearray()
    for s, img in imgs:
        dim = 0 if s == 256 else s
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(img), offset)
        data += img
        offset += len(img)
    return head + bytes(entries) + bytes(data)


def main():
    if not os.path.isfile(SRC):
        raise SystemExit("缺少源图：%s" % SRC)
    w, h, rgb = png_read(SRC)
    if w != h:
        raise SystemExit("源图必须是正方形（当前 %dx%d）" % (w, h))

    os.makedirs(PWA_OUT, exist_ok=True)
    for s in PWA_SIZES:
        p = os.path.join(PWA_OUT, "icon-%d.png" % s)
        png_write_rgb(p, s, s, resize(rgb, w, h, s, s))
        print("已生成 %s（%d 字节）" % (p, os.path.getsize(p)))

    ico = ico_bytes(w, h, rgb)
    for p in ICO_TARGETS:
        if not os.path.isdir(os.path.dirname(p)):
            print("跳过（目录不存在）%s" % p)
            continue
        with open(p, "wb") as f:
            f.write(ico)
        print("已生成 %s（%d 字节）" % (p, len(ico)))


if __name__ == "__main__":
    main()
