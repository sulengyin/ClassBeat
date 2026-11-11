#!/usr/bin/env python3
"""教室局域网消息服务（PLAN 2.22 / P4）。

一体机上跑这个，手机连同一 WiFi 打开 http://<本机IP>:8765 就能发。
大屏是 file:// 打开的静态页，探测到服务后连 SSE，收到消息写回本地覆盖层。

只做一件事：把老师写的一句话送到教室屏上。
学生留言（悄悄话）已推迟，不在这里实现。

启动：
    python3 server/rhythm_server.py
    python3 server/rhythm_server.py --port 8765 --class "五（1）班"

8765 被别的软件占了会自动顺延到 8766、8767…（最多试 10 个），
大屏会自己找过来，不用改地址。无人值守时用 server/run.py：
崩了自动拉起，没有黑窗口。
"""

import argparse
import datetime as dt
import errno
import json
import os
import mimetypes
import re
import socket
import sys
import time
import threading
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
MSG_FILE = os.path.join(BASE, "messages.json")
NET_FILE = os.path.join(BASE, "net.json")
LOG_FILE = os.path.join(BASE, "server.log")
PHONE_FILE = os.path.join(BASE, "phone.html")
APP_DIR = os.path.abspath(os.path.join(BASE, "..", "app"))

DEFAULT_PORT = 8765
PORT_SPAN = 10          # 8765 被别的软件占了就往后找，最多到 8774

CONF = {"port": DEFAULT_PORT, "klass": ""}

# 消息的 at / until 是给教室看的，一律按北京时间算，不跟服务器的本地时区走。
BEIJING = dt.timezone(dt.timedelta(hours=8))

# 版本号的唯一来源是 app/version.js（打包时由 tools/package.py 重写），
# 服务只是读它，不在 Python 里再写一份，免得两处对不上。
VERSION_FILE = os.path.join(APP_DIR, "version.js")
APP_VERSION = {"version": "", "build": "", "startedAt": ""}

# 更新自检：只在配置了更新源时跑，失败一律安静（断网不能影响大屏）。
UPDATE = {"url": "", "interval": 1800, "checkedAt": "", "latest": "", "available": False}
UPDATE_LOCK = threading.Lock()

# 配置自动备份：大屏把整份导出 JSON POST 过来，一天一份落在 backups/config/。
# 只有本机回环能读写；文件里有真实名册，所以这个目录在 .gitignore 里。
BACKUP_DIR = os.path.abspath(os.path.join(BASE, "..", "backups", "config"))
BACKUP_KEEP = 14          # 一天一份，留两周：够覆盖一次长跑和一次误改
BACKUP_MAX_BODY = 512 * 1024
# 回 413 前要把请求体读掉，否则对端还在发、这边就关连接，会变成 RST/断管。
# 最多丢 8 MB、最多读 1 秒：既不把大包整个读进内存，也不让人拿超大体积拖住服务。
BACKUP_DRAIN_MAX = 8 * 1024 * 1024
BACKUP_DRAIN_SEC = 1.0
BACKUP_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _backup_path(day):
    return os.path.join(BACKUP_DIR, "rhythm-%s.json" % day)


def _backup_days():
    try:
        names = os.listdir(BACKUP_DIR)
    except OSError:
        return []
    days = [n[7:-5] for n in names
            if n.startswith("rhythm-") and n.endswith(".json")]
    return sorted(d for d in days if BACKUP_DAY_RE.match(d))


def save_snapshot(payload):
    """一天一份，内容没变就不重写。返回 (saved, day, kept)。

    归一化后再比字节：同一天打开多次屏，不该反复写盘。"""
    day = dt.datetime.now(BEIJING).strftime("%Y-%m-%d")
    body = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")
    os.makedirs(BACKUP_DIR, exist_ok=True)
    fp = _backup_path(day)
    try:
        with open(fp, "rb") as f:
            if f.read() == body:
                return False, day, len(_backup_days())
    except OSError:
        pass
    tmp = fp + ".tmp"
    with open(tmp, "wb") as f:
        f.write(body)
    os.replace(tmp, fp)
    days = _backup_days()
    for old in days[:-BACKUP_KEEP]:
        try:
            os.remove(_backup_path(old))
        except OSError:
            pass
    return True, day, len(_backup_days())


def list_snapshots(limit=5):
    """给面板列最近几份。只回日期、大小、班名，不回名册。"""
    out = []
    for day in _backup_days()[-limit:][::-1]:
        fp = _backup_path(day)
        try:
            with open(fp, "r", encoding="utf-8") as f:
                obj = json.load(f)
            st = os.stat(fp)
        except (OSError, ValueError):
            continue
        meta = ((obj.get("config") or {}).get("meta") or {})
        out.append({
            "day": day,
            "savedAt": dt.datetime.fromtimestamp(st.st_mtime, BEIJING)
                          .isoformat(timespec="minutes"),
            "size": st.st_size,
            "klass": str(meta.get("klass") or "")[:40],
        })
    return out


def load_snapshot(day):
    if not BACKUP_DAY_RE.match(day or ""):
        return None
    try:
        with open(_backup_path(day), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def read_app_version():
    """从 app/version.js 里抠出 VERSION / BUILD；读不到就当空，不抛错。"""
    try:
        with open(VERSION_FILE, encoding="utf-8") as f:
            src = f.read()
    except OSError:
        return "", ""
    def grab(name):
        m = re.search(name + r'\s*=\s*"([^"]{1,40})"', src)
        return m.group(1) if m else ""
    return grab("VERSION"), grab("BUILD")


def app_version():
    """惰性读一次并缓存；启动时间也在第一次拿到版本时记下。"""
    if not APP_VERSION["version"]:
        APP_VERSION["version"], APP_VERSION["build"] = read_app_version()
        APP_VERSION["startedAt"] = dt.datetime.now(BEIJING).isoformat(timespec="seconds")
    return APP_VERSION


def version_key(v):
    """0.2.1 / v0.2.1 这类写法变成可比较的三元组；解析不了的段按 0 算。"""
    v = (v or "").strip().lstrip("vV")
    out = []
    for part in v.split(".")[:3]:
        m = re.match(r"\d+", part)
        out.append(int(m.group(0)) if m else 0)
    while len(out) < 3:
        out.append(0)
    return tuple(out)


def check_update_once():
    """问一次更新源（校内共享盘/静态站的 JSON）。任何异常都只表示「没查到」。"""
    url = UPDATE.get("url")
    if not url:
        return
    latest = ""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "classbeat-update-check"})
        with urllib.request.urlopen(req, timeout=5) as r:
            raw = r.read(65536).decode("utf-8", "replace")
        data = json.loads(raw)
        latest = str((data or {}).get("version") or "").strip()
    except Exception:
        latest = ""
    with UPDATE_LOCK:
        UPDATE["checkedAt"] = dt.datetime.now(BEIJING).isoformat(timespec="seconds")
        UPDATE["latest"] = latest
        UPDATE["available"] = bool(latest) and version_key(latest) > version_key(app_version()["version"])


def update_loop():
    while True:
        check_update_once()
        time.sleep(max(60, int(UPDATE.get("interval") or 1800)))


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
    t = dt.datetime.now(BEIJING) + dt.timedelta(minutes=minutes_from_now)
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


# ---------------------------------------------------------------- 地址自检

_addr = {"seen": "", "changed": False, "last": ""}


def note_address(lan):
    """记下这次启动的局域网地址，和上次比一比。

    教室电脑多是 DHCP：重启后地址通常不变，但换网段、跨长假、换网口都会变。
    变了不阻断任何功能，只让大屏提示一句——老师存的钉钉链接要重新复制。
    """
    if not lan or lan == _addr["seen"]:
        return _addr
    _addr["seen"] = lan
    try:
        last = ""
        if os.path.isfile(NET_FILE):
            with open(NET_FILE, encoding="utf-8") as f:
                last = (json.load(f) or {}).get("lan") or ""
        if last and last != lan:
            _addr["changed"] = True
            _addr["last"] = last
        with open(NET_FILE, "w", encoding="utf-8") as f:
            json.dump({"lan": lan, "at": dt.datetime.now(BEIJING).isoformat(timespec="seconds")},
                      f, ensure_ascii=False)
    except Exception as e:
        # 记不住地址不影响发消息，绝不能因此起不来
        print(f"[warn] 写 net.json 失败：{e}")
    return _addr


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
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _err(self, msg, code=400):
        self._json({"ok": False, "error": msg}, code)

    def _loopback(self):
        """配置备份只对本机开放：机房局域网里的手机不该能读别人班的名册。"""
        ip = (self.client_address or ("",))[0]
        return ip in ("127.0.0.1", "::1") or ip.startswith("::ffff:127.")

    def _discard_body(self, n):
        """回 413 前把请求体分块丢掉，最多 8 MB / 1 秒。
        对端提前断开或读超时就安静收手，绝不让异常冒到请求主流程。"""
        left = min(n, BACKUP_DRAIN_MAX)
        try:
            self.connection.settimeout(BACKUP_DRAIN_SEC)
        except OSError:
            pass
        try:
            while left > 0:
                try:
                    chunk = self.rfile.read(min(65536, left))
                except (BrokenPipeError, ConnectionResetError, socket.timeout, OSError):
                    return
                if not chunk:
                    return
                left -= len(chunk)
        finally:
            try:
                self.connection.settimeout(None)
            except OSError:
                pass

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
        if path in ("/version", "/api/version"):
            # 轻量自检：只报版本、构建号、启动时间，不暴露路径和用户名
            ver = app_version()
            return self._json({
                "ok": True,
                "version": ver["version"],
                "build": ver["build"],
                "startedAt": ver["startedAt"],
            })
        if path == "/api/ping":
            # 大屏拿它画二维码：手机要打开的是这个地址，不是 127.0.0.1
            lan = CONF.get("lan") or f"http://127.0.0.1:{CONF['port']}"
            addr = note_address(lan)
            ver = app_version()
            return self._json({
                "ok": True,
                # 大屏扫端口时靠它确认「这是节律屏的服务」，不是别的程序
                "app": "classbeat",
                "class": CONF["klass"],
                "port": CONF["port"],
                "lan": lan,
                # 顺手把版本带上：大屏/老师不用再单独问一次
                "version": ver["version"],
                "build": ver["build"],
                # 这次启动的地址和上次不一样：大屏提示一句，让老师重新复制
                "addrChanged": bool(addr["changed"]),
                "lastLan": addr["last"],
                "now": hhmm(0),
                "time": dt.datetime.now(BEIJING).isoformat(timespec="seconds"),
            })
        if path == "/api/update":
            # 只回答「有没有新版」。更新源地址是校内路径，不发给浏览器。
            ver = app_version()
            with UPDATE_LOCK:
                st = dict(UPDATE)
            return self._json({
                "ok": True,
                "version": ver["version"],
                "build": ver["build"],
                "startedAt": ver["startedAt"],
                "checked": bool(st["checkedAt"]),
                "checkedAt": st["checkedAt"],
                "available": bool(st["available"]),
                "latest": st["latest"] if st["available"] else "",
            })
        # 大屏用它校准设备时钟。给毫秒时间戳，客户端自己换算北京时间。
        if path == "/api/time":
            return self._json({
                "ok": True,
                "now": int(time.time() * 1000),
                "beijing": dt.datetime.now(BEIJING).isoformat(timespec="seconds"),
                "offsetMinutes": 480,
            })
        if path == "/api/messages":
            q = parse_qs(u.query)
            n = int((q.get("n") or ["5"])[0])
            return self._json({"ok": True, "messages": recent(max(1, min(n, 50)))})
        if path == "/api/config/backup":
            # 面板要知道「本机有没有备份、最近几天都有哪些」，只回摘要不回内容
            if not self._loopback():
                return self._err("forbidden", 403)
            return self._json({"ok": True, "keep": BACKUP_KEEP,
                               "dir": "backups/config", "items": list_snapshots(5)})
        if path.startswith("/api/config/backup/"):
            if not self._loopback():
                return self._err("forbidden", 403)
            obj = load_snapshot(path.rsplit("/", 1)[1])
            if obj is None:
                return self._err("没有这份备份", 404)
            return self._json(obj)
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

        if route == "/api/config/snapshot":
            # 大屏自动把整份配置 POST 过来；失败一律安静，由调用方吞掉
            if not self._loopback():
                return self._err("只接受本机写入", 403)
            try:
                n = int(self.headers.get("Content-Length") or "")
            except (TypeError, ValueError):
                n = -1
            if n <= 0 or n > BACKUP_MAX_BODY:
                # 先把对端还在发的包读掉再拒；否则这边一关连接就变 RST，调用方只见断管
                if n > BACKUP_MAX_BODY:
                    self._discard_body(n)
                self.close_connection = True
                return self._err("请求体太大或为空", 413)
            try:
                payload = json.loads(self.rfile.read(n).decode("utf-8"))
                if not isinstance(payload, dict) \
                        or payload.get("format") != "rhythm-config/v1":
                    raise ValueError("不是节律屏的设置文件")
            except Exception as e:
                return self._err("请求体不是合法配置：%s" % e, 400)
            try:
                saved, day, kept = save_snapshot(payload)
            except OSError as e:
                return self._err("写不进备份目录：%s" % e, 500)
            return self._json({"ok": True, "saved": saved, "day": day, "kept": kept})

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


def ensure_stdio():
    """pythonw.exe 启动时没有控制台，sys.stdout / stderr 是 None。

    不管的话，第一句 print 就会 AttributeError，服务干脆起不来。
    这里把输出接到 server.log；连日志都写不了就给个哑写入器，
    绝不让「打日志」成为起不来的理由。
    """
    if sys.stdout is not None and sys.stderr is not None:
        return None
    try:
        f = open(LOG_FILE, "a", encoding="utf-8", buffering=1)
    except OSError:
        f = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = f
    if sys.stderr is None:
        sys.stderr = f
    return f


def _addr_in_use(e):
    # Windows 的 WSAEADDRINUSE 是 10048，Linux/macOS 走 errno.EADDRINUSE
    return getattr(e, "winerror", None) == 10048 or e.errno in (errno.EADDRINUSE, 10048)


def bind_server(host, port, span=PORT_SPAN):
    """从 port 起找一个能绑的端口，返回 (server, 实际端口)。

    教室电脑上「8765 已经被别的软件占了」并不少见（装了各种教学软件）。
    被占就往后挪一个，总比双击后一闪就没强；真的全被占才抛错。
    只吞「地址被占用」，端口越界、没权限这类错误照旧抛出去。
    """
    last = None
    for p in range(port, port + max(1, span)):
        try:
            srv = ThreadingHTTPServer((host, p), Handler)
            srv.daemon_threads = True
            # 传 0 时由系统分配，回报真实端口而不是 0
            return srv, srv.server_address[1]
        except OSError as e:
            if not _addr_in_use(e):
                raise
            last = e
    raise last or OSError(f"{port}–{port + span - 1} 都没有可用端口")


def main():
    ensure_stdio()
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--class", dest="klass", default=None, help="不传就从 data/ 或 sample/ 读")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--update-url", dest="update_url", default=None,
                    help="更新自检的 JSON 地址（校内共享盘/内网静态站）；不填就不查")
    ap.add_argument("--update-interval", dest="update_interval", type=int, default=1800,
                    help="多久查一次更新，秒；默认 30 分钟")
    a = ap.parse_args()

    UPDATE["url"] = a.update_url or os.environ.get("CLASSBEAT_UPDATE_URL", "")
    UPDATE["interval"] = a.update_interval
    if UPDATE["url"]:
        app_version()
        threading.Thread(target=update_loop, daemon=True).start()

    CONF["klass"] = a.klass or detect_class()
    load_messages()

    srv, port = bind_server(a.host, a.port)
    CONF["port"] = port

    ip = lan_ip()
    CONF["lan"] = f"http://{ip}:{port}"
    addr = note_address(CONF["lan"])
    print("教室消息服务已启动")
    if port != a.port:
        print(f"  [!] {a.port} 被别的程序占了，已改用 {port}（大屏会自动找过来）")
    if ip == "127.0.0.1":
        # 没连上局域网时，手机那行地址是打不开的，说清楚比让人瞎试强
        print("  [!] 没找到局域网地址，手机连不上。检查电脑是否连了 WiFi/网线。")
    print(f"  手机打开  http://{ip}:{port}")
    if addr["changed"]:
        print(f"  [!] 地址和上次不同（上次是 {addr['last']}），钉钉里存的链接要重新复制")
    print(f"  大屏同源  http://127.0.0.1:{port}/screen")
    print(f"  本机自测  http://127.0.0.1:{port}/api/ping")
    print(f"  已存消息  {len(_messages)} 条")
    print("  Ctrl+C 停止")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        srv.server_close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # pythonw 下没人看得见异常栈，先落到日志里再退出（run.py 会拉起）
        ensure_stdio()
        traceback.print_exc()
        raise
