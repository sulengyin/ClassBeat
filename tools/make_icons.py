#!/usr/bin/env python3
"""生成 ClassBeat 图标：只从唯一源图缩放，不再在本文件里绘制形状。

图标固定为 tools/brand/icon-source.png（深色圆角底 + 奶油屏 + CB 时钟）。
要换图标，替换这张源图，再跑：

    python3 tools/make_icons.py            # 生成
    python3 tools/make_icons.py --verify   # 只检查（CI 用，不改文件）

输出：
  server/icons/icon-192.png、icon-512.png   PWA / 手机页
  tools/launcher/classbeat.ico              0.3.x 桌面快捷方式
  desktop/src-tauri/icons/classbeat.ico     0.5.x 安装包（目录不存在则跳过）

透明通道是必然要求，不是可选项：图标是圆角方块，四角必须透出桌面背景。
2026-11-24 之前这里是错的——源图画在白纸上（RGB，没有 alpha），本脚本也只写
RGB，结果 Windows 上桌面图标顶着四个白三角。现在两处都改对了：

  · 源图没有 alpha 时，从四角泛洪把「与角落连通的白」抠掉（图标内部的奶油色
    字样被深色包着，泛洪到不了，不会误伤），抗锯齿过渡带按「白底混色」反解；
  · 源图本来就带 alpha 就原样使用，不再二次抠图。

只用标准库：PNG 读写、双线性缩放、ICO 打包都在本文件里。
"""

import os
import struct
import sys
import zlib
from collections import deque

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
    """读 8-bit、非隔行 PNG，返回 (w, h, ch, bytearray)。ch 为 3(RGB) 或 4(RGBA)。"""
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
        return w, h, 3, rows
    if ch == 4:
        return w, h, 4, rows
    # 灰度 / 灰度+alpha 统一摊成 RGB(A)
    out = bytearray(w * h * (4 if ch == 2 else 3))
    o = 4 if ch == 2 else 3
    for i in range(w * h):
        if ch == 2:
            v = rows[2 * i]
            out[4 * i:4 * i + 3] = bytes((v, v, v))
            out[4 * i + 3] = rows[2 * i + 1]
        else:
            v = rows[i]
            out[3 * i:3 * i + 3] = bytes((v, v, v))
    return w, h, o, out


def png_write(path, w, h, ch, buf):
    """写 8-bit PNG。ch=3 写 RGB，ch=4 写 RGBA（ctype 6）。"""
    ctype = 6 if ch == 4 else 2
    stride = w * ch
    rows = b"".join(b"\x00" + bytes(buf[y * stride:(y + 1) * stride]) for y in range(h))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, ctype, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
                + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


# ---------------------------------------------------------------- 白底 → 透明

WHITE = 254.0          # 实测源图背景是 (254,254,254)，不是纯 255
BG_MIN = 236           # 三通道都不低于它，才算「白纸」
BG_SPREAD = 14         # 三个通道的差不超过它，排除淡黄/淡蓝之类的浅色内容


def _lum(buf, o):
    return 0.299 * buf[o] + 0.587 * buf[o + 1] + 0.114 * buf[o + 2]


def strip_white_corners(w, h, rgb):
    """把「与四角连通的白色背景」抠成透明，返回 (w, h, 4, rgba)。

    为什么只在「连通」范围内动刀：图标中央的奶油色字母、屏幕描边也是浅色，
    但它们四周被深色包着，从角落泛洪过不去，所以不会被削成半透明。

    泛洪会停在抗锯齿的过渡像素上，这些像素是 c = a*图标色 + (1-a)*白。
    如果只把 alpha 设成 a、颜色留着混过的浅色，边缘会留一圈灰白描边；
    所以按亮度估出 a，再把图标色反解回来。
    """
    n = w * h
    is_bg = bytearray(n)
    q = deque()
    for i in (0, w - 1, (h - 1) * w, n - 1):
        q.append(i)
    while q:
        i = q.popleft()
        if is_bg[i]:
            continue
        o = i * 3
        r, g, b = rgb[o], rgb[o + 1], rgb[o + 2]
        if min(r, g, b) < BG_MIN or max(r, g, b) - min(r, g, b) > BG_SPREAD:
            continue
        is_bg[i] = 1
        x = i % w
        if x > 0:
            q.append(i - 1)
        if x < w - 1:
            q.append(i + 1)
        if i >= w:
            q.append(i - w)
        if i < n - w:
            q.append(i + w)

    # 过渡带：贴着背景、但自己不算纯背景的那一圈
    ring = []
    for i in range(n):
        if is_bg[i]:
            continue
        x = i % w
        y = i // w
        touch = False
        for dy in (-1, 0, 1):
            yy = y + dy
            if yy < 0 or yy >= h:
                continue
            for dx in (-1, 0, 1):
                xx = x + dx
                if xx < 0 or xx >= w:
                    continue
                if is_bg[yy * w + xx]:
                    touch = True
                    break
            if touch:
                break
        if touch:
            ring.append(i)

    out = bytearray(n * 4)
    for i in range(n):
        o = i * 3
        d = i * 4
        out[d] = rgb[o]
        out[d + 1] = rgb[o + 1]
        out[d + 2] = rgb[o + 2]
        out[d + 3] = 0 if is_bg[i] else 255

    ring_set = set(ring)
    for i in ring:
        x = i % w
        y = i // w
        ref = []
        for dy in (-1, 0, 1):
            yy = y + dy
            if yy < 0 or yy >= h:
                continue
            for dx in (-1, 0, 1):
                xx = x + dx
                if xx < 0 or xx >= w:
                    continue
                j = yy * w + xx
                if not is_bg[j] and j not in ring_set:
                    ref.append(_lum(rgb, j * 3))
        lref = sum(ref) / len(ref) if ref else 30.0
        if lref >= 250:                     # 旁边也全是白的，说明这里压根不是边界
            continue
        o = i * 3
        a = (WHITE - _lum(rgb, o)) / (WHITE - lref)
        if a <= 0.03:
            d = i * 4
            out[d + 3] = 0
            continue
        if a >= 0.97:
            continue
        d = i * 4
        out[d + 3] = int(round(a * 255))
        for c in range(3):
            v = (rgb[o + c] - (1.0 - a) * WHITE) / a
            out[d + c] = 0 if v < 0 else (255 if v > 255 else int(round(v)))
    return w, h, 4, out


# ---------------------------------------------------------------- 缩放

def resize(buf, sw, sh, ch, dw, dh):
    """双线性缩放。ch=4 时先乘 alpha 再插值，最后除回来——
    不这么做，全透明像素里的颜色会渗进边缘，缩小后出现一圈黑边。"""
    out = bytearray(dw * dh * ch)
    pre = ch == 4
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
            o = (y * dw + x) * ch
            p00 = (y0 * sw + x0) * ch
            p01 = (y0 * sw + x1) * ch
            p10 = (y1 * sw + x0) * ch
            p11 = (y1 * sw + x1) * ch
            for c in range(ch):
                a = buf[p00 + c]
                b = buf[p01 + c]
                c0 = buf[p10 + c]
                d = buf[p11 + c]
                top = a + (b - a) * tx
                bot = c0 + (d - c0) * tx
                out[o + c] = int(top + (bot - top) * ty + 0.5)
            if pre:
                al = out[o + 3]
                if al == 0:
                    out[o] = out[o + 1] = out[o + 2] = 0
    if pre:
        # 上面是「直接对 alpha 插值」，颜色没做预乘。真要做预乘得在读取时乘、
        # 写入时除；这里源图边缘只有 1~2 像素宽，影响远小于缩到 16px 的误差，
        # 所以只在 alpha 归零处把颜色一并清零，避免黑点。
        pass
    return out


# ---------------------------------------------------------------- ICO 打包

def bmp32(w, h, rgba):
    """ICO 里的 32bpp BMP 条目：BGRA、自下而上、末尾跟 AND 掩码。

    Vista 以后的 Windows 认 alpha 通道；AND 掩码是给老外壳看的，
    按 alpha<128 置 1（透明），不然旧接口会把四角画成黑的。
    """
    hdr = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, w * h * 4, 0, 0, 0, 0)
    body = bytearray()
    mask_bits = []
    for y in range(h - 1, -1, -1):
        row = bytearray()
        for x in range(w):
            o = (y * w + x) * 4
            row += bytes((rgba[o + 2], rgba[o + 1], rgba[o], rgba[o + 3]))
        body += row
    for y in range(h - 1, -1, -1):
        bits = []
        for x in range(w):
            a = rgba[(y * w + x) * 4 + 3]
            bits.append(1 if a < 128 else 0)
        mask_bits.append(bits)
    mask_row_bytes = ((w + 31) // 32) * 4
    mask = bytearray()
    for bits in mask_bits:
        by = bytearray(mask_row_bytes)
        for x, bit in enumerate(bits):
            if bit:
                by[x // 8] |= 0x80 >> (x % 8)
        mask += by
    return bytes(hdr) + bytes(body) + bytes(mask)


def ico_bytes(sw, sh, rgba, sizes=ICO_SIZES, extra=()):
    imgs = []
    for s, data in extra:
        imgs.append((s, data))
    for s in sizes:
        small = rgba if (sw == s and sh == s) else resize(rgba, sw, sh, 4, s, s)
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


# ---------------------------------------------------------------- 检查

def corner_alpha(path):
    """返回生成的图标四角 alpha 值；不是 RGBA 就返回 None（说明没透明通道）。"""
    w, h, ch, buf = png_read(path)
    if ch != 4:
        return None
    return [buf[(y * w + x) * 4 + 3] for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]


def ico_all_entries(path):
    """把 ICO 里每个条目的 (边长, 四角 alpha) 列出来。"""
    d = open(path, "rb").read()
    _r, _t, count = struct.unpack("<HHH", d[:6])
    out = []
    for k in range(count):
        ent = d[6 + 16 * k:6 + 16 * (k + 1)]
        dim = ent[0]
        _planes, _bpp, _size, off = struct.unpack("<HHII", ent[4:16])
        hdr = struct.unpack("<IiiHHIIiiII", d[off:off + 40])
        bw, bh = hdr[1], hdr[2]
        if bh != bw * 2:
            continue                       # 不是 32bpp，读不出 alpha
        base = off + 40
        w = bw

        def px(x, y):
            row = (w - 1) - y             # BMP 条目是自下而上存的
            return d[base + (row * w + x) * 4 + 3]

        out.append((dim or 256, [px(0, 0), px(w - 1, 0), px(0, w - 1), px(w - 1, w - 1)]))
    return out


def verify():
    bad = []
    for s in PWA_SIZES:
        p = os.path.join(PWA_OUT, "icon-%d.png" % s)
        a = corner_alpha(p)
        if a is None:
            bad.append("%s 没有透明通道（四角会变白）" % p)
        elif any(v > 8 for v in a):
            bad.append("%s 四角不透明：alpha=%s" % (p, a))
    for p in ICO_TARGETS:
        if not os.path.isfile(p):
            continue
        entries = ico_all_entries(p)
        if not entries:
            bad.append("%s 里没有 32bpp 条目，读不出透明度" % p)
            continue
        # 只查最大那几档：16/24 像素的圆角被抗锯齿抹平，角落本来就会带一点
        # alpha，拿它当判据会天天误报。大图透明了，小图就是同一份数据的缩放。
        for size, a in entries:
            if size < 128:
                continue
            if any(v > 8 for v in a):
                bad.append("%s 的 %dpx 档四角不透明：alpha=%s" % (p, size, a))
    if bad:
        print("图标检查失败：")
        for b in bad:
            print("  · " + b)
        return 1
    print("图标检查通过：四角都是透明的")
    return 0


def load_source():
    w, h, ch, buf = png_read(SRC)
    if w != h:
        raise SystemExit("源图必须是正方形（当前 %dx%d）" % (w, h))
    note = ""
    if ch == 3:
        w, h, ch, buf = strip_white_corners(w, h, buf)
        note = "源图没有透明通道，已把四角的白底抠掉（%dx%d）" % (w, h)
    return w, h, buf, note


def compare():
    """仓库里的图标和源图对不对得上。

    比的是**解码后的像素**，不是文件字节：PNG 是 zlib 压过的，同一份像素在
    不同 zlib 版本下压出来的字节可能不一样，按字节比会在 Linux 的 CI 上
    无缘无故报错。ICO 里装的是没压缩的 BMP，直接比字节最省事。
    """
    w, h, buf, note = load_source()
    if note:
        print(note)
    bad = []
    for s in PWA_SIZES:
        p = os.path.join(PWA_OUT, "icon-%d.png" % s)
        if not os.path.isfile(p):
            bad.append("%s 不存在" % p)
            continue
        ew, eh, ech, ebuf = png_read(p)
        if (ew, eh) != (s, s) or ech != 4:
            bad.append("%s 尺寸/通道不对（%dx%d，%d 通道）" % (p, ew, eh, ech))
            continue
        want = resize(buf, w, h, 4, s, s)
        if bytes(ebuf) != bytes(want):
            bad.append("%s 和源图不一致（改了源图忘了重跑？）" % p)
    want_ico = ico_bytes(w, h, buf)
    for p in ICO_TARGETS:
        if not os.path.isfile(p):
            continue
        if open(p, "rb").read() != want_ico:
            bad.append("%s 和源图不一致（改了源图忘了重跑？）" % p)
    if bad:
        print("图标与源图不一致：")
        for b in bad:
            print("  · " + b)
        print("跑一次 python3 tools/make_icons.py 再提交")
        return 1
    print("图标与源图一致")
    return 0


def main():
    if "--verify" in sys.argv:
        return verify()
    if "--compare" in sys.argv:
        return compare()
    if not os.path.isfile(SRC):
        raise SystemExit("缺少源图：%s" % SRC)
    w, h, buf, note = load_source()
    if note:
        print(note)

    os.makedirs(PWA_OUT, exist_ok=True)
    for s in PWA_SIZES:
        p = os.path.join(PWA_OUT, "icon-%d.png" % s)
        png_write(p, s, s, 4, resize(buf, w, h, 4, s, s))
        print("已生成 %s（%d 字节）" % (p, os.path.getsize(p)))

    # 全部尺寸都塞 32bpp BMP 条目：Windows 从 Vista 起认 alpha 通道，
    # 不再像以前那样把透明区域涂成白/黑。体积大一点（约 370 KB），
    # 但一份图标只随安装包发一次，不值得为它引入 PNG 条目的兼容风险。
    ico = ico_bytes(w, h, buf)
    for p in ICO_TARGETS:
        if not os.path.isdir(os.path.dirname(p)):
            print("跳过（目录不存在）%s" % p)
            continue
        with open(p, "wb") as f:
            f.write(ico)
        print("已生成 %s（%d 字节）" % (p, len(ico)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
