#!/usr/bin/env python3
"""验收 E4：更新源不可达时**只告警、不动大屏**。

做的事：
  1. 起当前装好的壳（不预设版本，只要能起）；
  2. 按下 `Ctrl+Alt+U`；
  3. 等一个「检查更新失败」的框（超时上限 120 秒，两个源各给一轮连接时间）；
  4. 在框还开着的时候，核对三件事：大屏窗口还在、服务还在听、`/api/ping` 有回包；
  5. 点掉框，确认服务仍然正常，再 `Ctrl+Alt+Q` 退出。

为什么这样就能复现"源不可达"：`tauri.conf.json` 里两个 endpoint 分别是
  - https://github.com/sulengyin/ClassBeat/releases/latest/download/latest.json
  - https://classbeat.example.com/update/latest.json
两个都取不到（前者仓库没有 release，后者域名保留未注册），
所以不需要断网、不需要改配置，按一次就是"源不可达"这条分支。

用法：
    python desktop/scripts/accept_e4.py
    python desktop/scripts/accept_e4.py --keep-running   # 跑完不退出，留给人工看
"""

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import time
import urllib.request

u = ctypes.windll.user32
EXE = os.path.join(os.environ["LOCALAPPDATA"], "ClassBeat", "classbeat.exe")
LOG = os.path.join(os.environ["APPDATA"], "ClassBeat", "logs", "app.log")
KIOSK_TITLE = "班级节律屏"
WM_COMMAND = 0x0111
IDOK = 1
results = []


def add(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  PASS " if ok else "  FAIL ") + name + ("  | " + detail if detail else ""))


def ping(port, timeout=2):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def find_port(timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        for p in range(8765, 8780):
            try:
                d = ping(p, 0.4)
            except Exception:
                continue
            if d.get("shell") is True:
                return p
        time.sleep(0.4)
    return None


def win(title):
    return u.FindWindowW(None, title) or 0


def wait_window(title, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        h = win(title)
        if h:
            return h
        time.sleep(0.4)
    return 0


def child_texts(hwnd):
    """把框里所有静态文本取出来，做证据用。"""
    out = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(h, _):
        buf = ctypes.create_unicode_buffer(1024)
        u.GetWindowTextW(h, buf, 1024)
        if buf.value.strip():
            out.append(buf.value.strip())
        return True

    u.EnumChildWindows(hwnd, cb, 0)
    return out


def kiosk_alive():
    h = win(KIOSK_TITLE)
    return bool(h) and bool(u.IsWindowVisible(h))


def hotkey(vk):
    for m in (0x11, 0x12):          # Ctrl, Alt
        u.keybd_event(m, 0, 0, 0)
    u.keybd_event(vk, 0, 0, 0)
    time.sleep(0.1)
    u.keybd_event(vk, 0, 2, 0)
    for m in (0x12, 0x11):
        u.keybd_event(m, 0, 2, 0)


def log_tail(n=4000):
    try:
        with open(LOG, encoding="utf-8", errors="replace") as f:
            return f.read()[-n:]
    except OSError:
        return ""


def running_pid():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq classbeat.exe", "/NH"],
                         capture_output=True, text=True, encoding="mbcs", errors="replace").stdout
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].lower() == "classbeat.exe":
            return int(parts[1])
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-running", action="store_true")
    args = ap.parse_args()

    if running_pid():
        add("前置：没有别的实例在跑", False, "已经有 classbeat.exe，先退出它")
        return 1
    add("前置：主程序在", os.path.isfile(EXE), EXE)

    print("== 启动 ==")
    before = log_tail()
    subprocess.Popen([EXE])
    port = find_port()
    add("服务就绪", port is not None, f"port={port}")
    if port is None:
        return 1
    time.sleep(2.5)
    add("大屏窗口在", kiosk_alive(), KIOSK_TITLE)

    print("== Ctrl+Alt+U（此时两个更新源都不可达）==")
    t0 = time.time()
    hotkey(0x55)
    dlg = wait_window("检查更新失败", 120)
    cost = round(time.time() - t0, 1)
    add("E4 弹出「检查更新失败」而不是静默失败", dlg != 0, f"{cost}s")
    if not dlg:
        tail = log_tail(1500)
        print(tail)
        return 1

    texts = child_texts(dlg)
    add("E4 框里有具体原因（不是空白框）", bool(texts), " / ".join(texts)[:160])

    print("== 框还开着的时候，大屏必须照常 ==")
    add("E4 大屏窗口没被关", kiosk_alive())
    proxied = ping(port, 3)
    add("E4 服务仍在应答 /api/ping", proxied.get("ok") is True,
        f"class={proxied.get('class')} port={proxied.get('port')}")

    u.PostMessageW(dlg, WM_COMMAND, IDOK, 0)
    time.sleep(1.5)
    add("E4 点掉框后大屏还在", kiosk_alive())
    add("E4 日志记了检查更新失败", "检查更新失败" in log_tail(3000),
        [l for l in log_tail(3000).splitlines() if "检查更新失败" in l][-1][:110]
        if "检查更新失败" in log_tail(3000) else "")
    add("E4 没有误触发下载/安装", "已留底" not in log_tail(3000))

    if args.keep_running:
        print("== 按 --keep-running 留着，不退出 ==")
    else:
        print("== 收尾：Ctrl+Alt+Q ==")
        hotkey(0x51)
        d = wait_window("退出 ClassBeat", 10)
        if d:
            u.PostMessageW(d, WM_COMMAND, 6, 0)   # IDYES
            time.sleep(4)
        add("退出正常", find_port(8) is None)

    print()
    bad = sum(1 for _, ok, _ in results if not ok)
    print(f"共 {len(results)} 项，失败 {bad} 项")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
