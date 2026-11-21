#!/usr/bin/env python3
"""验收 B/D 的运行期自测（装好之后跑）：对应 docs/06 的 D2/D3/D4/D6、C4。

一次跑完，中途不交还控制权 —— 有些环境会在命令退出时连带收走子进程。
用法：
    python desktop/scripts/accept_runtime.py
退出码 0 = 全过；1 = 有项不过（逐条打在屏幕上）。
"""

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
TITLE = "班级节律屏"
WM_CLOSE = 0x0010
WM_COMMAND = 0x0111

results = []
skips = []
LOCKED = False


def add(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  PASS " if ok else "  FAIL ") + name + ("  | " + detail if detail else ""))


def skip(name, why):
    skips.append((name, why))
    print("  SKIP " + name + "  | " + why)


def locked_session():
    """锁屏 / UAC 安全桌面上，keybd_event 到不了应用，热键类用例必假红。

    判据两条同时成立才算锁：没有前台窗口 + OpenInputDesktop 打不开（err=5）。
    只判其中一条会误伤：刚启动时前台窗口也可能是 0。
    """
    if u.GetForegroundWindow():
        return False
    h = u.OpenInputDesktop(0, False, 0x0100)  # DESKTOP_READOBJECTS
    if h:
        u.CloseDesktop(h)
        return False
    return True


def ping(port, path="/api/ping", timeout=3):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def find_port(timeout=30):
    """壳会顺延端口，扫 8765~8774，只认 ping 里带 shell=true 的那一个。
    （本机上 8765 可能还蹲着 0.3.x 的僵尸服务，不认它会全盘测错。）"""
    end = time.time() + timeout
    while time.time() < end:
        for p in range(8765, 8775):
            try:
                d = ping(p, timeout=0.5)
            except Exception:
                continue
            if d.get("shell") is True:
                return p, d
        time.sleep(0.4)
    return None, None


def win(title=TITLE):
    return u.FindWindowW(None, title) or 0


def visible(h):
    return bool(u.IsWindowVisible(h))


def rect(h):
    r = wt.RECT()
    u.GetWindowRect(h, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def hotkey(vk_mods, vk):
    for m in vk_mods:
        u.keybd_event(m, 0, 0, 0)
    u.keybd_event(vk, 0, 0, 0)
    time.sleep(0.1)
    u.keybd_event(vk, 0, 2, 0)
    for m in reversed(vk_mods):
        u.keybd_event(m, 0, 2, 0)


def wait_dialog(title, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        h = win(title)
        if h:
            return h
        time.sleep(0.3)
    return 0


def alive(pid):
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True,
                         text=True, encoding="mbcs", errors="replace").stdout
    return str(pid) in out


class PE32ENTRY(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)), ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD), ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wt.DWORD), ("szExeFile", ctypes.c_wchar * 260),
    ]


def child_pids(pid, name):
    """用 Toolhelp 快照枚举子进程，不依赖 wmic（很多机器上已经被裁掉了）。"""
    k = ctypes.windll.kernel32
    TH32CS_SNAPPROCESS = 0x2
    snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        return []
    e = PE32ENTRY()
    e.dwSize = ctypes.sizeof(PE32ENTRY)
    pids = []
    ok = k.Process32FirstW(snap, ctypes.byref(e))
    while ok:
        if e.th32ParentProcessID == pid and (e.szExeFile or "").lower() == name.lower():
            pids.append(e.th32ProcessID)
        ok = k.Process32NextW(snap, ctypes.byref(e))
    k.CloseHandle(snap)
    return pids


def main():
    global LOCKED
    LOCKED = locked_session()
    if LOCKED:
        print("!! 会话已锁屏（没有前台窗口 + 输入桌面打不开）：D3/D4 要合成按键，这轮跳过，")
        print("   别当成产品坏了 —— 解锁后重跑一遍才算数。")

    print("== 启动 ==")
    p = subprocess.Popen([EXE])
    pid = p.pid
    port, info = find_port()
    add("服务就绪（壳模式）", port is not None and info and info.get("shell") is True, f"port={port} {info}")
    if port is None:
        return 1

    time.sleep(2)
    h = win()
    add("大屏窗口存在", h != 0)
    if h:
        l, t, r, b = rect(h)
        sw, sh = u.GetSystemMetrics(0), u.GetSystemMetrics(1)
        add("大屏全屏（覆盖整屏）", (r - l) >= sw - 8 and (b - t) >= sh - 8, f"窗口 {r-l}x{b-t} 屏幕 {sw}x{sh}")
        add("大屏可见", visible(h))

    # ---- D2 误关 ----
    print("== D2 误关 ==")
    u.PostMessageW(h, WM_CLOSE, 0, 0)
    time.sleep(3)
    h2 = win()
    add("误关后进程仍在", alive(pid))
    add("误关后窗口隐藏（不真退）", (h2 == 0) or (not visible(h2)), f"hwnd={h2}")

    # ---- 单实例：再启一次应把大屏叫回来 ----
    print("== 单实例再启 ==")
    subprocess.Popen([EXE])
    time.sleep(4)
    h3 = win()
    add("再启一次 → 大屏回来", h3 != 0 and visible(h3), f"hwnd={h3}")
    import subprocess as sp
    n = sp.run(["tasklist", "/FI", "IMAGENAME eq classbeat.exe", "/NH"], capture_output=True,
               text=True, encoding="mbcs", errors="replace").stdout.count("classbeat.exe")
    add("只有一个 classbeat.exe", n == 1, f"count={n}")

    # ---- D3 最小化 ----
    print("== D3 Ctrl+Alt+M ==")
    if LOCKED:
        skip("Ctrl+Alt+M 最小化/隐藏", "锁屏，合成按键到不了应用")
    else:
        hotkey([0x11, 0x12], 0x4D)
        time.sleep(2.5)
        h4 = win()
        minimized = (h4 == 0) or u.IsIconic(h4) or (not visible(h4))
        add("Ctrl+Alt+M 最小化/隐藏", minimized, f"hwnd={h4} iconic={bool(u.IsIconic(h4)) if h4 else 'n/a'}")
        # 叫回来，方便后面的测试
        if h4:
            u.ShowWindow(h4, 9)  # SW_RESTORE
            u.SetForegroundWindow(h4)
            time.sleep(1)

    # ---- D6 服务自愈 ----
    print("== D6 杀掉 pythonw ==")
    kids = child_pids(pid, "pythonw.exe")
    add("找到 pythonw 子进程", bool(kids), str(kids))
    if kids:
        subprocess.run(["taskkill", "/F", "/PID", str(kids[0])], capture_output=True)
        t0 = time.time()
        recovered = None
        while time.time() - t0 < 25:
            try:
                d = ping(port, timeout=1)
                if d.get("shell"):
                    recovered = time.time() - t0
                    break
            except Exception:
                pass
            time.sleep(0.7)
        add("服务 25 秒内自愈", recovered is not None, f"耗时 {recovered:.1f}s" if recovered else "未恢复")
        add("自愈后仍是同一个壳进程", alive(pid))

    # ---- C4 手机页 ----
    print("== C4 手机页 ==")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/phone", timeout=5) as r:
            body = r.read(400).decode("utf-8", "replace")
        add("手机页可达", "html" in body.lower(), f"{len(body)} 字节")
    except Exception as e:  # noqa: BLE001
        add("手机页可达", False, str(e))

    # ---- D4 Ctrl+Alt+Q 退出 ----
    print("== D4 Ctrl+Alt+Q ==")
    if LOCKED:
        skip("弹出退出确认框 / 退出 / 无残留 / 端口释放", "锁屏，合成按键到不了应用；改用 taskkill 收尾")
        for k in child_pids(pid, "pythonw.exe"):
            subprocess.run(["taskkill", "/F", "/PID", str(k)], capture_output=True)
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
        time.sleep(2)
        add("收尾：classbeat 已被强制结束（锁屏下无法走正常退出）", not alive(pid))
    else:
        hotkey([0x11, 0x12], 0x51)
        dlg = wait_dialog("退出 ClassBeat", 8)
        add("弹出退出确认框", dlg != 0)
        if dlg:
            u.PostMessageW(dlg, WM_COMMAND, 6, 0)  # IDYES
            time.sleep(4)
        add("退出后进程消失", not alive(pid))
        add("退出后 pythonw 无残留", not child_pids(pid, "pythonw.exe") and not _any_pythonw())
        import socket
        s = socket.socket()
        s.settimeout(1)
        free = s.connect_ex(("127.0.0.1", port)) != 0
        s.close()
        add("壳的端口已释放", free, f"port={port}")

    print()
    bad = sum(1 for _, ok, _ in results if not ok)
    tail = f"，跳过 {len(skips)} 项" if skips else ""
    print(f"共 {len(results)} 项，失败 {bad} 项{tail}")
    return 0 if bad == 0 and not skips else 1


def _any_pythonw():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq pythonw.exe", "/NH"], capture_output=True,
                         text=True, encoding="mbcs", errors="replace").stdout
    # 旧版僵尸（高权限）不算本壳的残留
    return "pythonw.exe" in out


if __name__ == "__main__":
    sys.exit(main())
