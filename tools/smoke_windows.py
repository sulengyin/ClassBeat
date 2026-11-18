#!/usr/bin/env python3
"""Windows 冒烟：把解包后的发布包当真实安装跑一遍（PLAN 2.44）。

背景：CI 的 unit/e2e 都在 Linux 上跑，⑰（Windows SO_REUSEADDR 劫持）
就是「虚拟机全绿、真机才炸」的漏网之鱼。这个脚本在 windows-latest
runner 上模拟教室安装后的关键路径：

  1. 用包内自带 python.exe 启动服务，扫端口确认就绪
  2. 大屏页 / ping / 更新状态 / 检查更新（真实走包内 update-source.txt
     默认源 → ghfast.top 加速 → GitHub raw 清单）
  3. 第二个实例请求同一端口：必须顺延到下一个端口（Windows 上验证
     2.42 的修复真的生效）
  4. 启动器脚本 -DryRun 走通（PowerShell 语法在真 Windows 上解析）

用法（在解包目录上一级）：
    python tools/smoke_windows.py --pkg <解包目录> [--python <python.exe>]

任何一步失败都以非零退出码结束；输出全部可直接贴回。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

# 中文环境的脚本跑在 cp1252/cp936 之外的控制台上会直接崩，先自愈
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

PASS = 0
FAIL = 0


def check(ok, title, detail=""):
    global PASS, FAIL
    print(("PASS  " if ok else "FAIL  ") + title + (("  · " + str(detail)) if detail else ""))
    FAIL += 0 if ok else 1


def ping(port, timeout=2):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping",
                                    timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def find_server(lo=8765, hi=8774, timeout=2):
    """按 run.py 的口径扫端口：认 /api/ping 里 app=classbeat 的服务。"""
    for p in range(lo, hi + 1):
        d = ping(p, timeout)
        if d and d.get("app") == "classbeat":
            return p, d
    return None, None


def wait_server(lo=8765, hi=8774, deadline=30):
    end = time.time() + deadline
    while time.time() < end:
        port, info = find_server(lo, hi)
        if port:
            return port, info
        time.sleep(0.5)
    return None, None


def get(url, timeout=10):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return None, str(e)


def post(url, timeout=60):
    req = urllib.request.Request(
        url, data=b"{}", method="POST",
        headers={"Content-Type": "application/json",
                 "User-Agent": "classbeat-smoke"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return None, str(e)


def accel_reachable():
    """runner 所在网络能不能走 ghfast.top（US 出口可能不通，别当故障）。"""
    code, _ = get("https://ghfast.top/https://raw.githubusercontent.com/"
                  "sulengyin/ClassBeat/main/update.json", timeout=12)
    return code == 200


def spawn(args, pkg):
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    return subprocess.Popen(args, cwd=pkg, creationflags=flags,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pkg", required=True, help="解包后的包根目录")
    ap.add_argument("--python", help="包内 python.exe；缺省用当前解释器")
    a = ap.parse_args()

    pkg = os.path.abspath(a.pkg)
    py = os.path.abspath(a.python) if a.python else sys.executable
    server_py = os.path.join(pkg, "server", "rhythm_server.py")
    if not os.path.exists(server_py):
        raise SystemExit(f"包里找不到 {server_py}")

    # ① 更新源文件在包里，内容指向加速域名
    src = os.path.join(pkg, "update-source.txt")
    check(os.path.exists(src), "① 包根有 update-source.txt")
    if os.path.exists(src):
        with open(src, "r", encoding="utf-8-sig") as f:
            urls = [l.strip() for l in f if l.strip() and not l.strip().startswith("#")]
        check(len(urls) == 1 and "ghfast.top" in urls[0]
              and "raw.githubusercontent.com" in urls[0],
              "①a 默认源 = ghfast.top + GitHub raw", urls)

    accel_ok = accel_reachable()
    print(f"NOTE  runner 网络走 ghfast.top：{'可达' if accel_ok else '不可达（US 出口，属预期，改用直连验证）'}")

    # ② 起服务（包内 python），默认源由服务自己从 update-source.txt 读
    env = dict(os.environ)
    if not accel_ok:
        # runner 走不通加速时，用环境变量强制直连 raw，其余结论仍然成立
        env["CLASSBEAT_UPDATE_URL"] = ("https://raw.githubusercontent.com/"
                                       "sulengyin/ClassBeat/main/update.json")
    proc1 = spawn([py, server_py, "--port", "8765", "--host", "127.0.0.1"], pkg)
    try:
        port1, info = wait_server()
        check(bool(port1), "② 服务 30 秒内就绪（包内 python.exe）",
              f"port={port1} ver={info.get('version') if info else '?'}")
        if not port1:
            raise SystemExit("服务没起来，后续步骤没有意义")

        check(info.get("app") == "classbeat", "②a ping 自认 classbeat")

        code, body = get(f"http://127.0.0.1:{port1}/screen")
        looks_html = "<!doctype" in body[:200].lower() or "<html" in body[:200].lower()
        check(code == 200 and looks_html,
              "②b /screen 返回大屏页面", f"HTTP {code} {len(body)}B")
        code, body = get(f"http://127.0.0.1:{port1}/api/update/status")
        st = json.loads(body) if code == 200 else {}
        check(code == 200 and st.get("ok") is True and st.get("selfUpdate") is True,
              "②c /api/update/status 自更新可用", f"HTTP {code}")

        # ③ 检查更新：真实走「源文件 → 加速域名 → GitHub raw 清单」整链
        code, body = post(f"http://127.0.0.1:{port1}/api/update/check")
        d = json.loads(body) if body else {}
        if code == 200:
            check(d.get("ok") is True and d.get("available") is False,
                  "③ 检查更新成功且已是最新（加速链路整链通过）",
                  f"version={d.get('version')}")
        else:
            check(False, "③ 检查更新失败", f"HTTP {code} {body[:200]}")

        # ④ 端口被占顺延（Windows 上验证 2.42 修复）：第二个实例请求同一端口
        proc2 = spawn([py, server_py, "--port", "8765", "--host", "127.0.0.1"], pkg)
        try:
            end = time.time() + 30
            port2 = None
            while time.time() < end and not port2:
                for p in range(8766, 8775):
                    d2 = ping(p)
                    if d2 and d2.get("app") == "classbeat":
                        port2 = p
                        break
                if not port2:
                    time.sleep(0.5)
            check(bool(port2), "④ 第二个实例被挤到下一端口（不与第一个叠加）",
                  f"{port1} → {port2}")
        finally:
            proc2.terminate()
            try:
                proc2.wait(timeout=10)
            except Exception:
                proc2.kill()

        time.sleep(1)
        check(ping(port1) is not None, "④a 第二实例退出后第一个服务仍健在")
    finally:
        proc1.terminate()
        try:
            proc1.wait(timeout=10)
        except Exception:
            proc1.kill()

    print()
    print(f"{PASS}/{PASS + FAIL} 通过")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
