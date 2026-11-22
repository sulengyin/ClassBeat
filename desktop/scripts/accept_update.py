#!/usr/bin/env python3
"""验收 E 的更新器端到端自测（版本可参数化，能反复对不同更新源跑）。

前置（否则跑不出意义）：
  1. 本机已装**旧版**，且它的 tauri.conf.json 里 endpoints 指向本机静态服务
     （用 `npx tauri build --config ...` 覆盖，别改生产配置）；
     注意：release 构建**硬拒 http 端点**（"must use a secure protocol like https"，
     插件在初始化阶段就 panic，表现是"双击没反应/闪退"），所以本地源必须同时带
     `"dangerousInsecureTransportProtocol": true`。这一项只进测试构建，生产配置不许有。
  2. 在某端口起静态服务，目录里放**新版**安装包 + 它的 .sig + latest.json
     （latest.json 用 desktop/scripts/make_latest.py 生成）；
  3. 新版必须是已签名的 formal 构建。调试构建会被 Defender 按启发式拦掉，
     现象是"装完版本没变"，别拿它验这一条。

用法：
    python -m http.server 8799 --bind 127.0.0.1     # 在放产物的目录里
    python desktop/scripts/accept_update.py --old 0.4.1 --new 0.4.2 --port 8799

本地源测试构建的完整命令（版本、两个端点按需要改，注意是一条命令）：

    npx tauri build --bundles nsis --config '{"plugins":{"updater":{"endpoints":["http://127.0.0.1:8799/latest.json","http://127.0.0.1:8798/latest.json"],"dangerousInsecureTransportProtocol":true}}}'
"""

import argparse
import ctypes
import json
import os
import subprocess
import sys
import time
import urllib.request

u = ctypes.windll.user32
EXE = os.path.join(os.environ["LOCALAPPDATA"], "ClassBeat", "classbeat.exe")
DATA = os.path.join(os.environ["APPDATA"], "ClassBeat")
LOG = os.path.join(DATA, "logs", "app.log")
WM_COMMAND = 0x0111
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
            except Exception:  # noqa: BLE001
                continue
            if d.get("shell") is True:
                return p
        time.sleep(0.4)
    return None


def screen_locked():
    """锁屏 / 安全桌面时合成按键到不了应用，热键类用例必然假红。"""
    if u.GetForegroundWindow() != 0:
        return False
    h = u.OpenInputDesktop(0, False, 0x0100)
    if h:
        u.CloseDesktop(h)
        return False
    return True


def win(title):
    return u.FindWindowW(None, title) or 0


def wait_window(title, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        h = win(title)
        if h:
            return h
        time.sleep(0.3)
    return 0


def hotkey(vk):
    for m in (0x11, 0x12):
        u.keybd_event(m, 0, 0, 0)
    u.keybd_event(vk, 0, 0, 0)
    time.sleep(0.1)
    u.keybd_event(vk, 0, 2, 0)
    for m in (0x12, 0x11):
        u.keybd_event(m, 0, 2, 0)


def reg_version():
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Uninstall") as k:
            i = 0
            while True:
                try:
                    name = winreg.EnumKey(k, i)
                except OSError:
                    break
                i += 1
                try:
                    with winreg.OpenKey(
                        winreg.HKEY_CURRENT_USER,
                        r"Software\Microsoft\Windows\CurrentVersion\Uninstall\\" + name,
                    ) as s:
                        dn = winreg.QueryValueEx(s, "DisplayName")[0]
                        if "classbeat" in str(dn).lower():
                            return winreg.QueryValueEx(s, "DisplayVersion")[0]
                except OSError:
                    continue
    except OSError:
        pass
    return None


def log_tail(n=4000):
    try:
        with open(LOG, encoding="utf-8", errors="replace") as f:
            return f.read()[-n:]
    except OSError:
        return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", default="0.4.1", help="更新前应装的版本")
    ap.add_argument("--new", default="0.4.2", help="更新后应变的版本")
    ap.add_argument("--port", type=int, default=8799, help="本地静态源端口（只用于提示文案）")
    ap.add_argument("--keep-running", action="store_true", help="结束时不要退出应用")
    args = ap.parse_args()

    if screen_locked():
        print("检测到屏幕已锁定：合成按键到不了应用，热键类用例会假红。")
        print("请解锁屏幕后重跑（本脚本不动任何东西，可以放心重来）。")
        return 2

    print(f"== 更新前状态（源端口 {args.port}）==")
    v0 = reg_version()
    add(f"更新前是 {args.old}", v0 == args.old, f"registry={v0}")
    b0 = None
    p0 = find_port(3)
    if p0:
        try:
            b0 = ping(p0).get("build")
        except Exception:  # noqa: BLE001
            pass

    print("== 启动 + 触发检查更新 ==")
    p = subprocess.Popen([EXE])
    port = find_port()
    add("服务就绪", port is not None, f"port={port}")
    if port is None:
        return 1
    time.sleep(2)
    hotkey(0x55)  # Ctrl+Alt+U

    dlg = wait_window("发现新版本", 40)
    add("E1 弹出中文确认框（有新版）", dlg != 0, "标题「发现新版本」" if dlg else "没等到")
    if not dlg:
        print(log_tail(1500))
        return 1

    print("== 确认安装 ==")
    u.PostMessageW(dlg, WM_COMMAND, 6, 0)  # IDYES

    passed = False
    deadline = time.time() + 180
    while time.time() < deadline:
        tail = log_tail(3000)
        if "已留底" in tail:
            passed = True
        try:
            alive = str(p.pid) in subprocess.run(
                ["tasklist", "/FI", f"PID eq {p.pid}", "/NH"], capture_output=True,
                text=True, encoding="mbcs", errors="replace").stdout
        except Exception:  # noqa: BLE001
            alive = None
        if not alive and passed:
            break
        time.sleep(2)

    tail = log_tail(4000)
    add("E2 下载并验签成功、安装包已留底", "已留底" in tail,
        [l for l in tail.splitlines() if "留底" in l][-1][:120] if "留底" in tail else "")
    add("E2 安装前停掉了本地服务", "更新安装前先停掉本地服务" in tail)
    add("E2 壳把安装交给安装器后退出", "更新已交给安装器" in tail)

    print("== 等自动重启 ==")
    newv = None
    deadline = time.time() + 240
    while time.time() < deadline:
        nv = reg_version()
        if nv == args.new:
            newv = nv
            if find_port(20):
                break
        time.sleep(3)
    add(f"E2 装完版本变成 {args.new}", newv == args.new, f"registry={newv}")
    add("E2 装完自动回到大屏（服务在听）", find_port(30) is not None)

    tail = log_tail(6000)
    add(f"重启后是 {args.new} 的壳", f"壳 {args.new} 启动" in tail,
        [l for l in tail.splitlines() if f"壳 {args.new}" in l][-1][:80]
        if f"壳 {args.new}" in tail else "")

    p1 = find_port(5)
    if p1:
        try:
            d = ping(p1)
            add("业务包与构建号跟着更新", d.get("build") not in (None, "", "dev", b0),
                f"build {b0} → {d.get('build')}；class={d.get('class')}")
        except Exception as e:  # noqa: BLE001
            add("业务包与构建号跟着更新", False, str(e))

    print("== E3 数据与回滚素材 ==")
    snaps = []
    cfg = os.path.join(DATA, "backups", "config")
    if os.path.isdir(cfg):
        snaps = [f for f in os.listdir(cfg) if f.startswith("rhythm-")]
    add("E3 班级数据还在", bool(snaps), ",".join(sorted(snaps)[-2:]))
    inst = os.path.join(DATA, "backups", "installers")
    kept = os.listdir(inst) if os.path.isdir(inst) else []
    add("E3 backups/installers 留着安装包", any(args.new in f for f in kept), str(kept))

    if not args.keep_running:
        print("== 收尾：Ctrl+Alt+Q 退出 ==")
        hotkey(0x51)
        d = wait_window("退出 ClassBeat", 10)
        if d:
            u.PostMessageW(d, WM_COMMAND, 6, 0)
            time.sleep(4)
        add("退出正常", not find_port(8))

    print()
    bad = sum(1 for _, ok, _ in results if ok is False)
    print(f"共 {len(results)} 项，失败 {bad} 项")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
