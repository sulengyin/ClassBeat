#!/usr/bin/env python3
"""图标的逻辑测试：白底抠图对不对、产物四角是不是真的透明。

背景（2026-11-24 真机）：桌面快捷方式的图标顶着四个白三角。根因有两层——
源图画在白纸上（没有 alpha），make_icons.py 也只写 RGB。两层都改了，这个文件
就是防止它们再次退化的地方：光看"生成成功"看不出透明度，必须回读像素。

跑：python3 tools/test_icons.py
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_icons as M  # noqa: E402

ok = 0
bad = []


def check(name, cond, detail=""):
    global ok
    if cond:
        ok += 1
        print("PASS  %s%s" % (name, ("  · " + detail) if detail else ""))
    else:
        bad.append(name + ("  · " + detail if detail else ""))
        print("FAIL  %s%s" % (name, ("  · " + detail) if detail else ""))


# ---------------------------------------------------------------- 抠白底

def synth(size=32, radius=10):
    """造一张「深色圆角方块画在白纸上」的 RGB 图，四个角都是圆角。"""
    w = h = size
    rgb = bytearray(w * h * 3)
    for y in range(h):
        for x in range(w):
            # 只有落在某个角的正方形里才需要判圆；四条边的中段一定是方的
            cx = radius - 1 if x < radius else (w - radius if x >= w - radius else -1)
            cy = radius - 1 if y < radius else (h - radius if y >= h - radius else -1)
            outside = False
            if cx >= 0 and cy >= 0:
                outside = ((x - cx) ** 2 + (y - cy) ** 2) > radius * radius
            o = (y * w + x) * 3
            if outside:
                rgb[o] = rgb[o + 1] = rgb[o + 2] = 254
            else:
                rgb[o], rgb[o + 1], rgb[o + 2] = 28, 33, 43
    return w, h, rgb


def alpha_at(buf, w, x, y):
    return buf[(y * w + x) * 4 + 3]


w, h, rgb = synth()
w2, h2, ch2, rgba = M.strip_white_corners(w, h, rgb)
check("抠图后是 RGBA", ch2 == 4 and len(rgba) == w * h * 4)
check("左上角透明", alpha_at(rgba, w, 0, 0) == 0, "alpha=%d" % alpha_at(rgba, w, 0, 0))
check("右上角透明", alpha_at(rgba, w, w - 1, 0) == 0)
check("左下角透明", alpha_at(rgba, w, 0, h - 1) == 0)
check("右下角透明", alpha_at(rgba, w, w - 1, h - 1) == 0)
check("图标中心不透明", alpha_at(rgba, w, w // 2, h // 2) == 255)
check("直边中点仍不透明", alpha_at(rgba, w, w // 2, 0) == 255,
      "上边中点落在方块上，不能被当成背景")

# 圆角内侧一大片必须是纯色、原样保留：抠图只该动背景和边缘
check("圆角内侧颜色没被改动",
      tuple(rgba[(20 * w + 20) * 4:(20 * w + 20) * 4 + 3]) == (28, 33, 43))

# 内部浅色元素不能被误伤：在被深色包围的地方放一块奶油色，它不该变透明
w3, h3, rgb3 = synth(size=40, radius=4)
for y in range(16, 24):
    for x in range(16, 24):
        o = (y * w3 + x) * 3
        rgb3[o], rgb3[o + 1], rgb3[o + 2] = 245, 240, 225
_, _, _, rgba3 = M.strip_white_corners(w3, h3, rgb3)
check("被深色包围的浅色块不被抠掉", alpha_at(rgba3, w3, 20, 20) == 255,
      "α=%d" % alpha_at(rgba3, w3, 20, 20))
check("角落照样透明", alpha_at(rgba3, w3, 0, 39) == 0)


# ---------------------------------------------------------------- 缩放保透明

small = M.resize(rgba, w, h, 4, 8, 8)
# 缩小之后角落不再是「纯背景」：32px 的圆角缩到 8px，一个像素要覆盖小半个圆角，
# 采样到的既不是全白也不是全深色。这里只要求它「没有变成不透明」——
# 全不透明才是 bug（那正是白色方块的来源）。
check("缩小后角落没有变成不透明", alpha_at(small, 8, 0, 0) < 255,
      "α=%d" % alpha_at(small, 8, 0, 0))
check("缩小后中心仍不透明", alpha_at(small, 8, 4, 4) == 255)


# ---------------------------------------------------------------- 产物

for s in M.PWA_SIZES:
    p = os.path.join(M.PWA_OUT, "icon-%d.png" % s)
    if not os.path.isfile(p):
        check("产物存在 %s" % p, False)
        continue
    a = M.corner_alpha(p)
    check("PWA %d 带有透明通道" % s, a is not None)
    if a is not None:
        check("PWA %d 四角透明" % s, max(a) <= 8, "alpha=%s" % a)

for p in M.ICO_TARGETS:
    if not os.path.isfile(p):
        continue
    entries = M.ico_all_entries(p)
    check("ICO %s 有 32bpp 条目" % os.path.basename(p), bool(entries))
    for size, a in entries:
        if size < 128:
            continue
        check("ICO %s %dpx 四角透明" % (os.path.basename(p), size), max(a) <= 8,
              "alpha=%s" % a)

# 尺寸档位齐全，Windows 各场景（列表 / 桌面 / 大图标）才不会临时缩放
sizes = [s for s, _ in M.ico_all_entries(M.ICO_TARGETS[1])] if os.path.isfile(M.ICO_TARGETS[1]) else []
if sizes:
    check("ICO 覆盖 16~256 各档", set(sizes) >= {16, 24, 32, 48, 64, 128, 256}, str(sorted(sizes)))


print()
if bad:
    print("%d 项失败：" % len(bad))
    for b in bad:
        print("  · " + b)
    sys.exit(1)
print("%d/%d 通过" % (ok, ok))
