#!/usr/bin/env python3
"""教室消息服务的验收测试（PLAN 2.22 / P4）。

跑真 socket，不起浏览器：
    python3 tools/test_server.py
"""

import importlib.util
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "server", "rhythm_server.py")
GUARD_SRC = os.path.join(ROOT, "server", "run.py")

pass_n = fail_n = 0


def check(ok, title, detail=""):
    global pass_n, fail_n
    print(("PASS  " if ok else "FAIL  ") + title + (("  · " + str(detail)) if detail else ""))
    pass_n += 1 if ok else 0
    fail_n += 0 if ok else 1


def load_module():
    spec = importlib.util.spec_from_file_location("hub", SRC)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def load_guard():
    """守护进程只拿它的纯函数来测，不真的去拉服务。"""
    spec = importlib.util.spec_from_file_location("guard", GUARD_SRC)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def req(port, path, method="GET", body=None, timeout=5):
    url = f"http://127.0.0.1:{port}{path}"
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, dict(resp.headers), raw
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def main():
    tmp = tempfile.mkdtemp(prefix="rhythm-hub-")
    hub = load_module()
    hub.MSG_FILE = os.path.join(tmp, "messages.json")
    hub.NET_FILE = os.path.join(tmp, "net.json")
    hub.PHONE_FILE = os.path.join(ROOT, "server", "phone.html")
    hub.CONF["klass"] = "测试班"
    # 大屏拿这个地址画二维码；真机上由启动时探测，这里钉一个固定值
    hub.CONF["lan"] = "http://192.168.1.5:8765"
    hub._addr.update({"seen": "", "changed": False, "last": ""})
    hub._messages = []
    hub._seq = 0

    srv = hub.ThreadingHTTPServer(("127.0.0.1", 0), hub.Handler)
    srv.daemon_threads = True
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    try:
        # ① ping
        code, head, raw = req(port, "/api/ping")
        d = json.loads(raw)
        check(code == 200 and d.get("ok") and d.get("class") == "测试班",
              "① 大屏能探测到服务", f'{code} {d.get("class")}')
        check(d.get("lan") == "http://192.168.1.5:8765",
              "①a ping 报出局域网地址（二维码用）", d.get("lan"))
        check(d.get("addrChanged") is False and d.get("lastLan") == "",
              "①c 第一次启动不报地址变化", f'{d.get("addrChanged")} {d.get("lastLan")}')

        # ①c2 地址自检：第二次启动换了地址才标记，并记住上次的
        hub._addr.update({"seen": "", "changed": False, "last": ""})
        with open(hub.NET_FILE, "w", encoding="utf-8") as f:
            json.dump({"lan": "http://192.168.1.5:8765"}, f)
        st = hub.note_address("http://192.168.1.9:8765")
        check(st["changed"] is True and st["last"] == "http://192.168.1.5:8765",
              "①c2 换了局域网地址会标记并记住上次", f'{st["changed"]} {st["last"]}')
        # 恢复成当前地址，后面的测试不受影响
        hub._addr.update({"seen": "", "changed": False, "last": ""})
        with open(hub.NET_FILE, "w", encoding="utf-8") as f:
            json.dump({"lan": "http://192.168.1.5:8765"}, f)

        # ①b 校时：给毫秒时间戳，并明确按 UTC+8
        code, _, raw = req(port, "/api/time")
        t = json.loads(raw)
        ok_time = (code == 200 and t.get("ok") and t.get("offsetMinutes") == 480
                   and isinstance(t.get("now"), int) and t["now"] > 1_600_000_000_000
                   and "+08:00" in str(t.get("beijing", "")))
        check(ok_time, "①b /api/time 给出北京时间戳", f'{t.get("beijing")} {t.get("now")}')

        # ② CORS：大屏是 file:// 打开的，origin 为 null，必须允许 *
        check(head.get("Access-Control-Allow-Origin") == "*",
              "② 允许 file:// 跨域访问", head.get("Access-Control-Allow-Origin"))

        # ③ 手机发送页
        code, head, raw = req(port, "/")
        html = raw.decode("utf-8")
        check(code == 200 and "发到教室" in html and "紧急" in html,
              "③ 手机发送页能打开", f"{len(raw)} 字节")

        # ④ 发一条
        code, _, raw = req(port, "/api/messages", "POST",
                           {"text": "现在到走廊集合", "level": "urgent", "minutes": 10})
        d = json.loads(raw)
        m = d.get("message") or {}
        check(code == 200 and m.get("seq") == 1 and m.get("level") == "urgent",
              "④ 发一条紧急消息", f'seq={m.get("seq")} {m.get("until")}')
        check(bool(m.get("at")) and bool(m.get("until")),
              "⑤ 服务端补齐 at / until", f'{m.get("at")} → {m.get("until")}')

        # ⑥ 读回
        code, _, raw = req(port, "/api/messages?n=5")
        d = json.loads(raw)
        check(len(d.get("messages", [])) == 1 and d["messages"][0]["text"] == "现在到走廊集合",
              "⑥ 手机能回看刚发的")

        # ⑦ 校验：空、超长、非法枚举
        bad = []
        for body in (
            {"text": "   "},
            {"text": "字" * 61},
            {"text": "ok", "level": "loud"},
            {"text": "ok", "minutes": 999},
            {"text": "ok", "minutes": -3},
            {"text": "ok", "forWhom": "parent"},
        ):
            c, _, _ = req(port, "/api/messages", "POST", body)
            bad.append(c)
        check(bad == [400] * 6, "⑦ 六种非法输入都被挡住", bad)

        # ⑧ 只给自己看的不上屏（大屏侧过滤，服务端照存）
        code, _, raw = req(port, "/api/messages", "POST",
                           {"text": "记得带教研材料", "forWhom": "self"})
        d = json.loads(raw)
        check(code == 200 and d["message"]["forWhom"] == "self",
              "⑧ 私人备忘可存但标记为 self")

        # ⑨ SSE 推送
        stream = urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/stream?since=-1", timeout=5)
        stream.readline()          # retry:
        stream.readline()          # : connected
        stream.readline()          # 空行
        req(port, "/api/messages", "POST", {"text": "马上回教室", "minutes": 10})
        lines = [stream.readline().decode("utf-8") for _ in range(3)]
        stream.close()
        ok = any(l.startswith("data: ") for l in lines) and "马上回教室" in "".join(lines)
        check(ok, "⑨ 新消息走 SSE 推给大屏", lines[1][:40] if len(lines) > 1 else lines)

        # ⑩ since=-1 不回放历史
        stream = urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/stream?since=-1", timeout=5)
        stream.readline(); stream.readline(); stream.readline()
        # 不发新消息：1.2 秒内不该有任何 data 行（服务端心跳是 15 秒一次）
        got = ""
        try:
            stream.fp.raw._sock.settimeout(1.2)
            got = stream.readline().decode("utf-8")
        except Exception:
            got = ""
        stream.close()
        check(got.strip() == "" or got.startswith(":"),
              "⑩ since=-1 不重放历史", repr(got[:30]))

        # ⑬ 手动关：0 分钟 = 今天结束前一直显示
        code, _, raw = req(port, "/api/messages", "POST",
                           {"text": "课堂练习，先别收本子", "minutes": 0})
        d = json.loads(raw)
        check(d["message"]["until"] == "23:59",
              "⑬ 「直到我关」当天有效", d["message"]["until"])

        # ⑭ 撤回：把最新一条撤掉，并广播 clear
        stream = urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/stream?since=-1", timeout=5)
        stream.readline(); stream.readline(); stream.readline()
        code, _, raw = req(port, "/api/retract", "POST")
        d = json.loads(raw)
        check(code == 200 and d.get("cleared") and d["event"]["type"] == "clear",
              "⑭ 撤回成功并发出 clear 事件", f'撤回 seq={d.get("event", {}).get("target")}')

        lines = [stream.readline().decode("utf-8") for _ in range(3)]
        stream.close()
        check(any("clear" in l for l in lines), "⑮ 大屏能收到撤回", lines[1][:36] if len(lines) > 1 else lines)

        # 撤回后最新那条不再出现在「当前」
        _, _, raw = req(port, "/api/messages?n=8")
        msgs = json.loads(raw)["messages"]
        check(bool(msgs[-1].get("retractedAt")), "⑯ 已撤回的消息有标记")

        # ⑪ 落盘与重载
        hub.save_messages()
        saved = json.load(open(hub.MSG_FILE, encoding="utf-8"))
        before_n, before_seq = len(hub._messages), hub._seq
        hub._messages = []
        hub._seq = 0
        hub.load_messages()
        check(len(saved) == before_n and hub._seq == before_seq,
              "⑪ 重启后消息与序号都还在", f"{len(saved)} 条 / seq={hub._seq}")

        # ⑫ 文件损坏不致命
        with open(hub.MSG_FILE, "w", encoding="utf-8") as f:
            f.write("{ 这不是 json ")
        hub._messages = []
        hub._seq = 0
        hub.load_messages()
        check(hub._messages == [] and os.path.exists(hub.MSG_FILE + ".bad"),
              "⑫ 消息文件损坏时备份并从空开始")

        # ⑰ 端口被占自动 +1：教室电脑上 8765 被别的软件占着很常见
        srv_a, port_a = hub.bind_server("127.0.0.1", 0, 1)
        srv_b, port_b = hub.bind_server("127.0.0.1", port_a, 3)
        try:
            check(port_a < port_b <= port_a + 3,
                  "⑰ 端口被占时顺延，不再撞同一个", f"{port_a} → {port_b}")
            check(srv_b.server_address[1] == port_b,
                  "⑰a 回报的是真实端口，不是请求值")
        finally:
            srv_b.server_close()
            srv_a.server_close()

        # ⑱ 守护进程认得出「已经在跑」，也认得出「那是别人的程序」
        guard = load_guard()
        # 测试服务上的 ping 带 app=classbeat，run.py 靠它认亲
        found = guard.find_running(port=port, span=1)
        check(bool(found) and found.get("port") == port and found.get("class") == "测试班",
              "⑱ 守护进程认得出自己的服务", f'{found.get("port") if found else "无"}')
        plain = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        plain.bind(("127.0.0.1", 0))
        plain.listen(1)
        other = plain.getsockname()[1]
        try:
            check(guard.find_running(port=other, span=1) is None,
                  "⑱a 别人占着的端口不算自己的服务")
        finally:
            plain.close()

        # ⑲ pythonw 下 sys.stdout 是 None：print 不能把服务搞崩
        old_out, old_err = sys.stdout, sys.stderr
        old_log = hub.LOG_FILE
        hub.LOG_FILE = os.path.join(tmp, "server.log")
        try:
            sys.stdout = sys.stderr = None
            hub.ensure_stdio()
            ok_stdio = sys.stdout is not None and sys.stderr is not None
            sys.stdout.write("pythonw 下也能写日志\n")
            sys.stdout.flush()
        finally:
            sys.stdout, sys.stderr = old_out, old_err
            hub.LOG_FILE = old_log
        logged = open(os.path.join(tmp, "server.log"), encoding="utf-8").read()
        check(ok_stdio and "能写日志" in logged,
              "⑲ pythonw 无控制台时输出落到日志", logged.strip()[:24])

    finally:
        srv.shutdown()
        srv.server_close()
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    print(f"{pass_n}/{pass_n + fail_n} 通过")
    return 0 if fail_n == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
