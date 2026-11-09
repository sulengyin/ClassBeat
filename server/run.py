#!/usr/bin/env python3
"""手机消息服务的守护进程：崩了自己爬起来，不占一个黑窗口。

双击「启动手机服务.bat」实际跑的是这个文件，用 pythonw.exe 起，所以没有窗口。
它只做三件事：

1. 已经在跑就别再开第二个（扫 8765 起的端口，认 /api/ping 的 app 字段）
2. 起 rhythm_server.py，异常退出 3 秒后重来；连续失败就放慢，但绝不放弃
3. 把 pid 写进 service.pid，给「停止手机服务.bat」用

日志都在 server.log，出问题先看它。
"""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(BASE, "rhythm_server.py")
LOG_FILE = os.path.join(BASE, "server.log")
PID_FILE = os.path.join(BASE, "service.pid")

BASE_PORT = 8765
PORT_SPAN = 10
LOG_MAX = 1024 * 1024        # 日志过 1 MB 就轮转一份，别让一体机硬盘被写满

_quiet = False


def say(text):
    """无窗时 print 无处可去；有控制台（排错时手动 python run.py）才说话。"""
    if not _quiet:
        try:
            print(text, flush=True)
        except Exception:
            pass


def windowless(py):
    """Windows 上把 python.exe 换成同目录的 pythonw.exe，子进程就不弹黑窗。"""
    if os.name != "nt":
        return py
    folder, name = os.path.split(py)
    if name.lower() == "python.exe":
        cand = os.path.join(folder, "pythonw.exe")
        if os.path.isfile(cand):
            return cand
    return py


def ping(port, timeout=0.6):
    """问一下这个端口上是不是我们自己的服务。不是就返回 None，绝不抛错。"""
    url = f"http://127.0.0.1:{port}/api/ping"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            d = json.loads(r.read().decode("utf-8"))
        return d if isinstance(d, dict) and d.get("ok") and d.get("app") == "classbeat" else None
    except Exception:
        return None


def find_running(port=BASE_PORT, span=PORT_SPAN):
    """返回已在运行的服务信息（含 port），没有就 None。

    只认 app=classbeat：8765 上要是别的软件，照样算「没在跑」，让服务去占 8766。
    """
    for p in range(port, port + span):
        d = ping(p)
        if d:
            d = dict(d)
            d["port"] = p
            return d
    return None


def trim_log():
    """日志轮转：改名保留一份，新的从空开始。写不了就算了。"""
    try:
        if os.path.isfile(LOG_FILE) and os.path.getsize(LOG_FILE) > LOG_MAX:
            os.replace(LOG_FILE, LOG_FILE + ".1")
    except OSError:
        pass


def write_pid(pid):
    try:
        with open(PID_FILE, "w", encoding="utf-8") as f:
            f.write(str(pid))
    except OSError:
        pass


def clear_pid(pid=None):
    try:
        if pid is not None:
            with open(PID_FILE, encoding="utf-8") as f:
                if f.read().strip() != str(pid):
                    return          # 不是自己写的，别删
        os.remove(PID_FILE)
    except (OSError, ValueError):
        pass


def say_running(info):
    """已经有一个在跑：别让老师以为开了两个。"""
    phone = info.get("lan") or f"http://127.0.0.1:{info['port']}"
    say(f"手机消息服务已经在运行：{phone}（大屏右下角「手机」里也有）")
    if os.name == "nt":
        # 无窗启动时只有弹窗能让老师知道；有控制台就不多此一举
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                None,
                f"手机消息服务已经在运行，不用再开一次。\n\n手机打开：{phone}\n\n"
                "大屏右下角「⋯」→「手机」，那里有二维码。",
                "班级节律屏", 0x40,
            )
        except Exception:
            pass


def main():
    global _quiet
    _quiet = sys.stdout is None or sys.stderr is None

    running = find_running()
    if running:
        say_running(running)
        return 0

    trim_log()
    try:
        log = open(LOG_FILE, "a", encoding="utf-8", buffering=1)
    except OSError:
        log = None

    py = windowless(sys.executable)
    write_pid(os.getpid())
    say(f"守护启动：{py} {SERVER}")

    fails = 0
    proc = None
    try:
        while True:
            started = time.time()
            try:
                proc = subprocess.Popen(
                    [py, SERVER],
                    cwd=BASE,
                    stdout=log or subprocess.DEVNULL,
                    stderr=log or subprocess.DEVNULL,
                )
            except Exception as e:
                # 解释器本身起不来，几乎没有重试的意义，但也不能静默死掉
                if log:
                    log.write(f"\n[guard] 启动失败：{e}\n")
                say(f"启动失败：{e}")
                return 1

            code = proc.wait()
            lived = time.time() - started
            if log:
                log.write(f"\n[guard] 服务退出（code={code}，运行 {lived:.0f} 秒）\n")

            # 正常退出（有人手动停掉）就不再拉起
            if code == 0:
                say("服务已停止")
                return 0

            # 连续崩：慢慢试，别把日志和 CPU 刷爆，但教室的屏还得有人管
            fails = fails + 1 if lived < 10 else 0
            delay = 3 if fails < 5 else 30
            say(f"服务异常退出（{code}），{delay} 秒后重启")
            if log:
                log.write(f"[guard] {delay} 秒后重启（连续失败 {fails} 次）\n")
            time.sleep(delay)
    except KeyboardInterrupt:
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
        return 0
    finally:
        clear_pid(os.getpid())


if __name__ == "__main__":
    sys.exit(main())
