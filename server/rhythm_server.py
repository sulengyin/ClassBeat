#!/usr/bin/env python3
"""教室局域网消息服务（PLAN 2.22 / P4）。

一体机上跑这个，手机连同一 WiFi 打开 http://<本机IP>:8765 就能发。
大屏是 file:// 打开的静态页，探测到服务后连 SSE，收到消息写回本地覆盖层。

只做一件事：把老师写的一句话送到教室屏上。
学生留言（悄悄话）已推迟，不在这里实现。

启动：
    python3 server/rhythm_server.py
    python3 server/rhythm_server.py --port 8765 --class "五（1）班"
"""

import argparse
import datetime as dt
import json
import os
import mimetypes
import socket
import sys
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
MSG_FILE = os.path.join(BASE, "messages.json")
PHONE_FILE = os.path.join(BASE, "phone.html")
APP_DIR = os.path.abspath(os.path.join(BASE, "..", "app"))

CONF = {"port": 8765, "klass": ""}


def detect_class() -> str:
    """班级名从数据里读，不在代码里写死——别人 clone 下来就是别人的班。

    先看 data/（老师自己的），再看 sample/（公开仓库自带的示例）。
    都没有就退到中性值，不因为缺个名字起不来。
    """
    root = os.path.dirname(BASE)
    for folder in ("data", "sample"):
        path = os.path.join(root, folder, "schedule.json")
        try:
            with open(path, encoding="utf-8") as f:
                name = (json.load(f) or {}).get("class")
            if name:
                return name
        except Exception:
            continue
    return "班级"

_lock = threading.Condition()
_messages = []          # 每条含 seq，seq 单调递增，SSE 靠它断点续传
_seq = 0

MAX_TEXT = 60
LEVELS = ("normal", "urgent")
MAX_MINUTES = 180      # 0 表示"不自动关"，由老师手动撤
MAX_KEEP = 300


# ---------------------------------------------------------------- 存取

def load_messages():
    """文件坏了就备份再重来，绝不让服务起不来。"""
    global _messages, _seq
    if not os.path.exists(MSG_FILE):
        return
    try:
        with open(MSG_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            _messages = [m for m in data
                         if isinstance(m, dict) and ("text" in m or m.get("type") == "clear")]
            _seq = max([m.get("seq", 0) for m in _messages] or [0])
    except Exception as e:
        bad = MSG_FILE + ".bad"
        try:
            os.replace(MSG_FILE, bad)
        except OSError:
            pass
        print(f"[warn] messages.json 损坏（{e}），已备份到 {bad}，从空开始")


def save_messages():
    """先写临时文件再改名，避免断电写半截。"""
    tmp = MSG_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_messages[-MAX_KEEP:], f, ensure_ascii=False, indent=1)
        os.replace(tmp, MSG_FILE)
    except OSError as e:
        print(f"[warn] 写 messages.json 失败：{e}")


# ---------------------------------------------------------------- 业务

def hhmm(minutes_from_now=0):
    t = dt.datetime.now() + dt.timedelta(minutes=minutes_from_now)
    return t.strftime("%H:%M")


def add_message(text, level="normal", minutes=10, for_whom="class"):
    global _seq
    text = (text or "").strip()
    if not text:
        raise ValueError("内容不能为空")
    if len(text) > MAX_TEXT:
        raise ValueError(f"最多 {MAX_TEXT} 字")
    if level not in LEVELS:
        raise ValueError("level 只能是 normal 或 urgent")
    try:
        minutes = int(minutes)
    except (TypeError, ValueError):
        raise ValueError("时长必须是数字")
    if minutes < 0 or minutes > MAX_MINUTES:
        raise ValueError(f"时长要在 0–{MAX_MINUTES} 分钟之间（0 = 手动关）")
    if for_whom not in ("class", "self"):
        raise ValueError("forWhom 只能是 class 或 self")

    with _lock:
        _seq += 1
        msg = {
            "seq": _seq,
            "text": text,
            "level": level,
            "forWhom": for_whom,
            "at": hhmm(0),
            # 0 分钟 = 不自动关，但仍然当天有效（23:59 收），不会留到第二天
            "until": hhmm(minutes) if minutes > 0 else "23:59",
            "createdAt": int(dt.datetime.now().timestamp() * 1000),
        }
        _messages.append(msg)
        _lock.notify_all()
    save_messages()
    return msg


def recent(n=5):
    """手机端历史只给真消息，撤回事件不占位置。"""
    with _lock:
        msgs = [m for m in _messages if m.get("type") != "clear"]
        return msgs[-n:]


def retract_latest():
    """撤回最近一条还没撤回的班级消息，并广播一个 clear 事件。"""
    global _seq
    ev = None
    with _lock:
        for m in reversed(_messages):
            if m.get("type") == "clear" or m.get("forWhom") != "class":
                continue
            if m.get("retractedAt"):
                continue
            if _expired(m):
                continue
            m["retractedAt"] = int(time.time() * 1000)
            _seq += 1
            ev = {"seq": _seq, "type": "clear", "target": m["seq"]}
            _messages.append(ev)
            _lock.notify_all()
            break
    if ev:
        save_messages()
    return ev


def _expired(m, now=None):
    until = m.get("until") or ""
    if not until:
        return False
    now = now or hhmm(0)
    if "00:00" <= until < "06:00":
        return False
    return now >= until


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "RhythmHub/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # 只记错误，正常请求不刷屏
        pass

    # ---- 公共

    def _common(self, code=200, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._common(code)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, msg, code=400):
        self._json({"ok": False, "error": msg}, code)

    def do_OPTIONS(self):
        self._common(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- GET

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"

        if path in ("/", "/index.html", "/phone"):
            return self._phone()
        if path == "/api/ping":
            return self._json({
                "ok": True,
                "class": CONF["klass"],
                "port": CONF["port"],
                "now": hhmm(0),
            })
        if path == "/api/messages":
            q = parse_qs(u.query)
            n = int((q.get("n") or ["5"])[0])
            return self._json({"ok": True, "messages": recent(max(1, min(n, 50)))})
        if path == "/api/stream":
            return self._stream()

        # 大屏的另一种打开方式：同源，不受 file:// 跨域限制。
        # 教室一体机上直接开 http://127.0.0.1:8765/screen 更稳。
        if path == "/screen":
            self.send_response(302)
            self.send_header("Location", "/app/index.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path.startswith("/app/"):
            return self._static(u.path[5:])

        self._err("not found", 404)

    def _static(self, rel):
        rel = rel.lstrip("/")
        fp = os.path.abspath(os.path.join(APP_DIR, rel))
        if not fp.startswith(APP_DIR + os.sep) and fp != APP_DIR:
            return self._err("forbidden", 403)
        if not os.path.isfile(fp):
            return self._err("not found", 404)
        ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(fp, "rb") as f:
            body = f.read()
        self._common(200, ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _phone(self):
        try:
            with open(PHONE_FILE, "rb") as f:
                body = f.read()
        except OSError:
            return self._err("phone.html 缺失", 500)
        self._common(200, "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _stream(self):
        """SSE。客户端断线写失败会抛异常，靠它清理线程。"""
        self._common(200, "text/event-stream; charset=utf-8")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        q = parse_qs(urlparse(self.path).query)
        try:
            last = int((q.get("since") or ["0"])[0])
        except ValueError:
            last = 0
        if last < 0:
            # since=-1：只收从现在开始的新消息，不回放历史。
            # 大屏拿不到基线时用这个，避免一开机把上午的通知全弹一遍。
            with _lock:
                last = _seq

        try:
            self.wfile.write(b"retry: 2000\n: connected\n\n")
            self.wfile.flush()
            while True:
                with _lock:
                    pending = [m for m in _messages if m["seq"] > last]
                    if not pending:
                        _lock.wait(timeout=15)
                        pending = [m for m in _messages if m["seq"] > last]
                if pending:
                    for m in pending:
                        last = m["seq"]
                        data = json.dumps(m, ensure_ascii=False)
                        self.wfile.write(f"id: {m['seq']}\ndata: {data}\n\n".encode("utf-8"))
                else:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    # ---- POST

    def do_POST(self):
        u = urlparse(self.path)
        route = u.path.rstrip("/")

        if route == "/api/retract":
            ev = retract_latest()
            return self._json({"ok": True, "cleared": bool(ev), "event": ev})

        if route != "/api/messages":
            return self._err("not found", 404)

        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 4096:
                return self._err("请求体太大或为空", 413)
            raw = self.rfile.read(n).decode("utf-8")
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("要 JSON 对象")
        except Exception as e:
            return self._err(f"请求体不是合法 JSON：{e}", 400)

        try:
            msg = add_message(
                payload.get("text"),
                payload.get("level", "normal"),
                payload.get("minutes", 10),
                payload.get("forWhom", "class"),
            )
        except ValueError as e:
            return self._err(str(e), 400)

        self._json({"ok": True, "message": msg})


# ---------------------------------------------------------------- 启动

def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--class", dest="klass", default=None, help="不传就从 data/ 或 sample/ 读")
    ap.add_argument("--host", default="0.0.0.0")
    a = ap.parse_args()

    CONF["port"] = a.port
    CONF["klass"] = a.klass or detect_class()
    load_messages()

    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True

    ip = lan_ip()
    print("教室消息服务已启动")
    print(f"  手机打开  http://{ip}:{a.port}")
    print(f"  大屏同源  http://127.0.0.1:{a.port}/screen")
    print(f"  本机自测  http://127.0.0.1:{a.port}/api/ping")
    print(f"  已存消息  {len(_messages)} 条")
    print("  Ctrl+C 停止")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
