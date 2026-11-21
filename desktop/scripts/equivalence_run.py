#!/usr/bin/env python3
"""功能等价性对比：把"旧包"和"重构后的包"同时跑起来，逐项对打。

三套实例（互不干扰，端口/目录/数据全隔离）：
  A = 旧包原件（v0.3.24 解压版，自带 python）
  B = 新包代码 + 把三处业务文件回退到 v0.3.24（隔离"重构"这一个变量）
  C = 新包现状（= 0.4.x 里实际装的东西）

对比两对：
  A ↔ B：重构 + 6 处服务端适配补丁，有没有改变老师能感知的行为（这是本次要证的）
  B ↔ C：旧包之后新加的三处业务改动，到底改了什么（这是要如实告知的）

用法：
    python desktop/scripts/equivalence_run.py            # 全量（三侧、每页 25/15 次点击）
    python desktop/scripts/equivalence_run.py --smoke    # 冒烟（只 A/C，各点 3 个）
    python desktop/scripts/equivalence_run.py --keep     # 跑完不关服务，方便手工再看
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from collections import Counter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "desktop", "scripts")
TMP = os.path.join(os.environ["LOCALAPPDATA"], "Temp", "cb-eq")
OUT = os.path.join(ROOT, "desktop", "dist", "equivalence")
LEGACY = r"C:\Users\hello\ClassBeat-backup-20261121-0057\legacy-ClassBeat"
RES = os.path.join(os.environ["LOCALAPPDATA"], "ClassBeat", "resources")

SIDES = {
    "a": {"port": 8785, "desc": "旧包 v0.3.24（解压版原型）"},
    "b": {"port": 8786, "desc": "新包代码 + 业务文件回退到 v0.3.24"},
    "c": {"port": 8787, "desc": "新包现状（0.4.x 实际所装）"},
    "d": {"port": 8788, "desc": "新包 + 壳模式（CLASSBEAT_SHELL=1，老师实际用的形态）"},
}


def prepare():
    """重建三套副本（幂等）。B 侧把 screen.js/edit.js/edit.css 换成 git HEAD 的版本。"""
    if os.path.isdir(TMP):
        shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP)

    shutil.copytree(LEGACY, os.path.join(TMP, "a"))
    # 旧包本身不带 data/，班级名会退化成中性的"班级"；为了只比"功能"不比"数据"，
    # 把同一份示例数据补给 A 侧（只加数据文件，不动一行代码）。
    src_data = os.path.join(RES, "data")
    if os.path.isdir(src_data):
        shutil.copytree(src_data, os.path.join(TMP, "a", "data"))

    def copy_res(dst):
        os.makedirs(dst)
        for name in ("app", "server", "data", "sample", "python", "build-info.json", "icon.ico"):
            s = os.path.join(RES, name)
            if not os.path.exists(s):
                continue
            (shutil.copytree if os.path.isdir(s) else shutil.copy2)(s, os.path.join(dst, name))

    copy_res(os.path.join(TMP, "b"))
    copy_res(os.path.join(TMP, "c"))
    copy_res(os.path.join(TMP, "d"))

    for f in ("screen.js", "edit.js", "edit.css"):
        head = subprocess.run(["git", "show", f"HEAD:app/{f}"], cwd=ROOT, capture_output=True)
        if head.returncode != 0:
            sys.exit(f"取不到 git HEAD:app/{f}，无法构造 B 侧")
        with open(os.path.join(TMP, "b", "app", f), "wb") as fh:
            fh.write(head.stdout)

    shutil.rmtree(os.path.join(TMP, "d-data"), ignore_errors=True)
    for side in ("a", "b", "c"):
        for junk in ("messages.json", "net.json", "server.log"):
            p = os.path.join(TMP, side, "server", junk)
            if os.path.exists(p):
                os.remove(p)
    print(f"三套副本就绪：{TMP}")


def start(side):
    d = os.path.join(TMP, side)
    py = (os.path.join(d, "server", "python", "python.exe") if side == "a"
          else os.path.join(d, "python", "python.exe"))
    srv = os.path.join(d, "server", "rhythm_server.py")
    port = SIDES[side]["port"]
    env = dict(os.environ)
    for k in list(env):
        if k.startswith("CLASSBEAT_"):
            env.pop(k)          # 关键：不设壳相关变量 = 旧行为
    env["TZ"] = "Asia/Shanghai"
    if side == "d":
        # 壳模式：数据改到独立目录、更新交给壳、看门狗交接跳过
        env["CLASSBEAT_SHELL"] = "1"
        env["CLASSBEAT_DATA_DIR"] = os.path.join(TMP, "d-data")
    log = open(os.path.join(OUT, f"server-{side}.log"), "w", encoding="utf-8")
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    p = subprocess.Popen([py, srv, "--port", str(port), "--host", "127.0.0.1"],
                         cwd=os.path.join(d, "server"), env=env,
                         stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
    return p


def wait_ready(side, timeout=45):
    port = SIDES[side]["port"]
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1.5) as r:
                d = json.loads(r.read().decode())
            return d
        except Exception:
            time.sleep(0.5)
    return None


def probe(side, limit=None):
    port = SIDES[side]["port"]
    cmd = ["node", os.path.join(SCRIPTS, "equivalence_probe.cjs"),
           "--base", f"http://127.0.0.1:{port}", "--label", side, "--out", OUT]
    env = dict(os.environ)
    if limit:
        env["CB_EQ_MAX_CLICKS"] = str(limit)
    r = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print((r.stdout or "").strip() or (r.stderr or "").strip()[-800:])
    if r.returncode != 0:
        print(f"[警告] 探针 {side} 退出码 {r.returncode}")


# --------------------------- 对比 ---------------------------

def load(side):
    with open(os.path.join(OUT, f"{side}.json"), encoding="utf-8") as f:
        return json.load(f)


def cmp_elements(x, y, xn, yn):
    """两侧交互要素集合对比：比 (标签|类型|文本|可见性) 多重集，id/class 单独看。"""
    def sig(pages):
        c = Counter()
        for pg in pages:
            for e in pg["elements"]:
                c[(pg["page"], e["tag"], e["type"], e["text"], e["vis"])] += 1
        return c

    cx, cy = sig(x["pages"]), sig(y["pages"])
    only_x = (cx - cy)
    only_y = (cy - cx)
    print(f"\n-- 交互要素（{xn} vs {yn}）--")
    print(f"   {xn} {sum(cx.values())} 个 / {yn} {sum(cy.values())} 个")
    if not only_x and not only_y:
        print("   集合完全一致（标签/类型/文本/可见性逐项对应）")
    for k, n in list(only_x.items())[:20]:
        print(f"   只在 {xn}: {k} ×{n}")
    for k, n in list(only_y.items())[:20]:
        print(f"   只在 {yn}: {k} ×{n}")
    return sum(only_x.values()) + sum(only_y.values())


def cmp_clicks(x, y, xn, yn):
    """同 key 的点击后果逐项比：弹窗、body class、可见元素增减、跳转、报错、接口。"""
    def index(pages):
        d = {}
        for pg in pages:
            for c in pg["clicks"]:
                d[(pg["page"], c["key"])] = c
        return d

    ix, iy = index(x["pages"]), index(y["pages"])
    common = sorted(set(ix) & set(iy))
    diffs = []
    for k in common:
        a, b = ix[k], iy[k]
        fields = ["found", "dialog", "bodyClassChanged", "bodyClassAfter", "dialogsDelta",
                  "urlChanged", "consoleErrors", "pageErrors"]
        for f in fields:
            if a.get(f) != b.get(f):
                diffs.append((k[0], k[1], f, a.get(f), b.get(f)))
        # 文本与元素计数：先抹掉时钟/端口这类噪声再比
        if denoise(a.get("afterText") or "") != denoise(b.get("afterText") or ""):
            diffs.append((k[0], k[1], "点击后文本", "不同", "不同"))
        if sorted(a.get("apiCalls") or []) != sorted(b.get("apiCalls") or []):
            diffs.append((k[0], k[1], "apiCalls", a.get("apiCalls"), b.get("apiCalls")))

    print(f"\n-- 点击后果（{xn} vs {yn}）--")
    print(f"   两边都点过的元素 {len(common)} 个；只在 {xn} {len(set(ix) - set(iy))}、只在 {yn} {len(set(iy) - set(ix))}")
    if not diffs:
        print("   点击后果逐项一致（含弹窗、状态变化、跳转、控制台报错、接口调用）")
    for row in diffs[:25]:
        print(f"   [{row[0]}] {row[1][:44]:44s} {row[2]}: {row[3]} ≠ {row[4]}")
    if len(diffs) > 25:
        print(f"   … 还有 {len(diffs) - 25} 处")
    return len(diffs) + len(set(ix) ^ set(iy))


def cmp_api(x, y, xn, yn):
    print(f"\n-- 接口契约（{xn} vs {yn}）--")
    diffs = 0
    for p in sorted(set(x["api"]) | set(y["api"])):
        a, b = x["api"].get(p, {}), y["api"].get(p, {})
        if a.get("status") != b.get("status"):
            print(f"   {p}: 状态码 {a.get('status')} ≠ {b.get('status')}")
            diffs += 1
            continue
        ka, kb = a.get("keys") or [], b.get("keys") or []
        if ka != kb:
            print(f"   {p}: 键集合不同 → 只在 {xn}: {sorted(set(ka) - set(kb))} / 只在 {yn}: {sorted(set(kb) - set(ka))}")
            diffs += 1
    if not diffs:
        print("   8 个只读接口状态码与键集合完全一致")
    return diffs



def denoise(s):
    """把"必然不同、但与功能无关"的东西抹掉再比：
    时钟/倒计时/日期/端口。不抹掉它们，每一轮都会看到几十处假差异，
    真正的差异反而被埋掉。"""
    import re
    s = re.sub(r"\b\d{1,2}:\d{2}\b", "<T>", s)                    # 14:35、00:14
    s = re.sub(r"(?<!\d):\d{2}\b", ":<SS>", s)                     # 时钟被拆行后的 ":45"
    # 编辑入口的"老师验证"算术题每次随机生成（防学生猜），必须归一化
    s = re.sub(r"\d+(?:\.\d+)?\s*[÷×+\-*]\s*\d+(?:\.\d+)?\s*=\s*\?", "<Q>", s)
    s = re.sub(r"\b\d{1,2}\s*月\s*\d{1,2}\s*日", "<DATE>", s)
    s = re.sub(r"\b20\d{2}-\d{2}-\d{2}\b", "<DATE>", s)
    s = re.sub(r"127\.0\.0\.1:\d{4,5}", "127.0.0.1:<PORT>", s)
    s = re.sub(r"192\.168\.\d{1,3}\.\d{1,3}:\d{4,5}", "<LAN>", s)
    s = re.sub(r"\b\d+\s*秒\b", "<N>秒", s)
    return s

def cmp_text(x, y, xn, yn):
    """逐页面对比整屏可见文本。点击后果能对上、但文本不同，说明是"内容"层面的差异，
    比如版本号写法、人名从 id 解析成人名——这类必须逐字看清，不能只看计数。"""
    import difflib
    print(f"\n-- 页面整屏文本（{xn} vs {yn}）--")
    diffs = 0
    for px in x["pages"]:
        py = next((p for p in y["pages"] if p["page"] == px["page"]), None)
        if not py:
            continue
        a = denoise(px.get("fullText") or "").splitlines()
        b = denoise(py.get("fullText") or "").splitlines()
        if a == b:
            print(f"   [{px['page']}] 一致（{len(''.join(a))} 字）")
            continue
        diffs += 1
        print(f"   [{px['page']}] 不同：")
        for line in list(difflib.unified_diff(a, b, xn, yn, lineterm="", n=0))[:40]:
            print("     " + line[:170])
    return diffs


def shell_audit(data):
    """壳模式（老师实际使用的形态）到底改了哪些"老师能看见/能点"的东西。
    逐条打出来，不做判断，判断留给报告。"""
    print("\n" + "=" * 72)
    print("壳模式审计（A 旧包 vs D 壳模式）")
    print("=" * 72)
    for side, name in (("a", "A 旧包"), ("d", "D 壳模式")):
        d = data.get(side)
        if not d:
            continue
        api = d["api"]
        up = api.get("/api/update", {})
        st = api.get("/api/update/status", {})
        ping = api.get("/api/ping", {})
        print(f"  {name}: ping 键={ping.get('keys')}")
        print(f"          /api/update.status={up.get('status')} keys={up.get('keys')}")
        print(f"          /api/update/status.status={st.get('status')} keys={st.get('keys')}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--skip-prepare", action="store_true")
    ap.add_argument("--shell-audit", action="store_true", help="只审计壳模式引入的接口/文案差异")
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    if not args.skip_prepare:
        prepare()

    if args.shell_audit:
        sides = ["a", "d"]
    elif args.smoke:
        sides = ["a", "c"]
    else:
        sides = ["a", "b", "c"]
    procs, ok = {}, {}
    try:
        for s in sides:
            procs[s] = start(s)
        for s in sides:
            info = wait_ready(s)
            ok[s] = info
            if not info:
                print(f"[错误] {s} 侧没起来，看 {OUT}/server-{s}.log")
                return 2
            print(f"{s} 侧就绪 :{SIDES[s]['port']}  class={info.get('class')}  shell={info.get('shell')}  version={info.get('version')}")

        for s in sides:
            probe(s, limit=3 if args.smoke else None)

        data = {s: load(s) for s in sides}
        if args.shell_audit:
            return shell_audit(data)
        total = 0
        if "a" in data and "b" in data:
            print("\n" + "=" * 72)
            print("A ↔ B ｜ 重构本身是否改变行为（业务代码两侧完全相同）")
            print("=" * 72)
            total += cmp_elements(data["a"], data["b"], "A(旧包)", "B(新包代码)")
            total += cmp_text(data["a"], data["b"], "A(旧包)", "B(新包代码)")
            total += cmp_clicks(data["a"], data["b"], "A(旧包)", "B(新包代码)")
            total += cmp_api(data["a"], data["b"], "A(旧包)", "B(新包代码)")
        if "b" in data and "c" in data:
            print("\n" + "=" * 72)
            print("B ↔ C ｜ 旧包之后新加的业务改动带来了什么")
            print("=" * 72)
            total += cmp_elements(data["b"], data["c"], "B(回退)", "C(现状)")
            total += cmp_text(data["b"], data["c"], "B(回退)", "C(现状)")
            total += cmp_clicks(data["b"], data["c"], "B(回退)", "C(现状)")
            total += cmp_api(data["b"], data["c"], "B(回退)", "C(现状)")

        print(f"\n差异合计 {total} 处；明细 {OUT}")
        return 0
    finally:
        if not args.keep:
            for s, p in procs.items():
                if p.poll() is None:
                    p.terminate()
            time.sleep(1)
            for s, p in procs.items():
                if p.poll() is None:
                    p.kill()


if __name__ == "__main__":
    sys.exit(main())
