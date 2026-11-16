#!/usr/bin/env python3
"""自动更新（下载/备份/替换/回滚）的验收测试（ROADMAP 9.5）。

所有安装目录、假更新源、临时文件都在系统临时目录里，
不碰真实仓库，也不碰 F:\\project\\ClassBeat 里的任何文件。

    python3 tools/test_updater.py
"""

import errno
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
pass_n = fail_n = 0


def check(ok, title, detail=""):
    global pass_n, fail_n
    print(("PASS  " if ok else "FAIL  ") + title + (("  · " + str(detail)) if detail else ""))
    pass_n += 1 if ok else 0
    fail_n += 0 if ok else 1


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load_module(path, name):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, str(path))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class FakeSource:
    """本地假更新源：/update.json、安装包、/app/index.html 都在这里。"""

    def __init__(self):
        self.routes = {}
        src = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                item = src.routes.get(self.path.split("?")[0])
                if item is None:
                    body = b"not found"
                    self.send_response(404)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                body = item.get("body", b"")
                self.send_response(item.get("status", 200))
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if item.get("cut"):
                    self.wfile.write(body[:len(body) // 2])
                    self.wfile.flush()
                    self.close_connection = True
                    return
                self.wfile.write(body)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base(self):
        return "http://127.0.0.1:%d" % self.httpd.server_address[1]

    def serve(self, path, body, **kw):
        self.routes[path] = dict(body=body, **kw)

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def write_install(root, version, build="old"):
    files = {
        "app/version.js": 'var VERSION = "%s";\nvar BUILD = "%s";\n' % (version, build),
        "app/index.html": "<html>old %s</html>\n" % version,
        "app/update.js": "// old updater ui\n",
        "server/rhythm_server.py": "# old server\n",
        "server/run.py": "# old run\n",
        "server/phone.html": "<html>old phone</html>\n",
        "server/update_manifest.py": "# old manifest\n",
        "data/schedule.json": '{"class": "测试班"}\n',
        "assets/logo.txt": "logo\n",
        "server/messages.json": '{"messages": ["老师留下的消息"]}\n',
        "打开大屏.bat": "@echo off\r\n",
    }
    for rel, text in files.items():
        fp = Path(root) / rel
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(text, encoding="utf-8")


def package_files(version):
    return {
        "app/version.js": 'var VERSION = "%s";\nvar BUILD = "sha-%s";\n' % (version, version),
        "app/index.html": "<html>new %s</html>\n" % version,
        "app/update.js": "// new updater ui %s\n" % version,
        "app/new.js": "// added in 0.2.2\n",
        "server/rhythm_server.py": "# new server %s\n" % version,
        "server/run.py": "# new run\n",
        "server/phone.html": "<html>new phone %s</html>\n" % version,
        "server/update_manifest.py": "# new manifest\n",
        "server/updater.py": "# new updater\n",
        "打开大屏.bat": "@echo off\r\n",
        # 下面这些不该进清单，也不该被解出来
        "server/python/python.exe": b"MZ fake",
        "MANIFEST.txt": b"fake",
        "使用说明.txt": b"readme",
        "五1班节律屏-单文件版.html": b"<html>single</html>",
    }


def build_package(work, version, source, mkm):
    top = "五1班节律屏-测试包"
    zip_path = Path(work) / ("classbeat-%s.zip" % version)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, data in package_files(version).items():
            if isinstance(data, str):
                data = data.encode("utf-8")
            z.writestr(top + "/" + rel, data)
    manifest = mkm.build_manifest(
        zip_path,
        url=source.base + "/package-%s.zip" % version,
        min_version="0.2.0",
        notes="更新到 %s：修了几处小问题。" % version,
        published_at="2026-11-12T10:00:00+08:00")
    return zip_path, manifest


def publish(source, manifest, zip_path, name=None):
    source.serve("/update.json", json.dumps(manifest, ensure_ascii=False).encode("utf-8"))
    source.serve("/%s" % (name or ("package-%s.zip" % manifest["version"])),
                 zip_path.read_bytes())
    source.serve("/app/index.html", b"ok")


def version_of(root):
    text = (Path(root) / "app" / "version.js").read_text(encoding="utf-8")
    for line in text.splitlines():
        if "VERSION" in line:
            return line.split('"')[1]
    return ""


def backup_count(root):
    return len(list((Path(root) / "backups" / "program").glob("*/meta.json")))


def main():
    tmp = Path(tempfile.mkdtemp(prefix="classbeat-updater-test-"))
    scratch = tmp / "scratch"
    scratch.mkdir()
    old_tempdir = getattr(tempfile, "tempdir", None)
    tempfile.tempdir = str(scratch)

    # 用仓库副本里的模块，保证测的就是要发布的代码
    repo = tmp / "repo"
    (repo / "tools").mkdir(parents=True)
    (repo / "server").mkdir()
    shutil.copy2(ROOT / "tools" / "make_update.py", repo / "tools" / "make_update.py")
    for name in ("update_manifest.py", "updater.py"):
        shutil.copy2(ROOT / "server" / name, repo / "server" / name)
    sys.path.insert(0, str(repo / "server"))
    U = load_module(repo / "server" / "updater.py", "updater")
    M = load_module(repo / "server" / "update_manifest.py", "update_manifest")
    mkm = load_module(repo / "tools" / "make_update.py", "make_update")

    source = FakeSource()
    try:
        # ① 正常升级
        install = tmp / "normal"
        write_install(install, "0.2.1")
        zip2, man2 = build_package(tmp, "0.2.2", source, mkm)
        publish(source, man2, zip2)

        mgr = U.UpdateManager(str(install), source.base + "/update.json", "0.2.1",
                              base_url=source.base)
        st = mgr.check()
        check(st["available"] and st["latest"] == "0.2.2" and "修了" in st["notes"],
              "① 检查更新：发现 0.2.2 并带说明", "%s %s" % (st["latest"], st["notes"][:12]))

        st = mgr.apply()
        check(st["state"] == "done" and version_of(install) == "0.2.2",
              "② 正常升级到 0.2.2", st.get("message"))
        check((install / "app" / "new.js").is_file()
              and (install / "server" / "updater.py").is_file(),
              "③ 新文件按清单装进来")
        check((install / "data" / "schedule.json").read_text(encoding="utf-8").startswith('{"class"')
              and (install / "assets" / "logo.txt").is_file()
              and "老师留下的消息" in (install / "server" / "messages.json").read_text(encoding="utf-8"),
              "④ data/、assets/、messages.json 没有被碰")
        check(backup_count(install) == 1 and version_of(install) == "0.2.2",
              "⑤ 升级前留下了备份", "备份 %d 份" % backup_count(install))
        last = json.loads((install / "backups" / "program" / "last.json").read_text(encoding="utf-8"))
        check(last.get("ok") is True and last.get("fromVersion") == "0.2.1"
              and last.get("toVersion") == "0.2.2",
              "⑥ 更新结果写进了 last.json", last.get("message"))

        # ② 回滚到上一版
        st = mgr.rollback()
        check(st["state"] == "done" and version_of(install) == "0.2.1",
              "⑦ 一键回滚到 0.2.1", st.get("message"))
        check(not (install / "app" / "new.js").exists()
              and "old 0.2.1" in (install / "app" / "index.html").read_text(encoding="utf-8"),
              "⑧ 回滚会恢复旧文件并删掉新加的文件")
        check("老师留下的消息" in (install / "server" / "messages.json").read_text(encoding="utf-8"),
              "⑨ 回滚也没有碰老师的数据")

        # ③ SHA256 不符
        install2 = tmp / "badhash"
        write_install(install2, "0.2.1")
        zip3, man3 = build_package(tmp, "0.2.3", source, mkm)
        broken = bytearray(zip3.read_bytes())
        broken[len(broken) // 2] ^= 0xFF
        source.serve("/update.json", json.dumps(man3, ensure_ascii=False).encode("utf-8"))
        source.serve("/package-0.2.3.zip", bytes(broken))
        mgr2 = U.UpdateManager(str(install2), source.base + "/update.json", "0.2.1",
                               base_url=source.base)
        ok, err = False, ""
        try:
            mgr2.check()
            mgr2.apply()
        except U.UpdateError as e:
            ok, err = "SHA256" in str(e), str(e)
        check(ok, "⑩ 包 SHA256 不符时丢弃并报错", err)
        check(version_of(install2) == "0.2.1" and backup_count(install2) == 0
              and "old 0.2.1" in (install2 / "app" / "index.html").read_text(encoding="utf-8"),
              "⑪ 哈希不符时原文件一个都没动")
        check(list(scratch.iterdir()) == [], "⑫ 校验失败后临时文件清理干净",
              [p.name for p in scratch.iterdir()][:2])

        # ④ 下载中断
        install3 = tmp / "cut"
        write_install(install3, "0.2.1")
        source.serve("/update.json", json.dumps(man3, ensure_ascii=False).encode("utf-8"))
        source.serve("/package-0.2.3.zip", zip3.read_bytes(), cut=True)
        mgr3 = U.UpdateManager(str(install3), source.base + "/update.json", "0.2.1",
                               base_url=source.base)
        ok, err = False, ""
        try:
            mgr3.check()
            mgr3.apply()
        except U.UpdateError as e:
            ok, err = ("中断" in str(e) or "不完整" in str(e)), str(e)
        check(ok, "⑬ 下载中断给出可读提示", err)
        check(version_of(install3) == "0.2.1" and not (install3 / "app" / "new.js").exists()
              and list(scratch.iterdir()) == [],
              "⑭ 下载中断后没有半截文件")

        # ⑤ 文件被占用（权限/占用失败，重试后回滚）
        install4 = tmp / "locked"
        write_install(install4, "0.2.1")
        zip4, man4 = build_package(tmp, "0.2.4", source, mkm)
        publish(source, man4, zip4)
        calls = {"n": 0}

        def locked_replace(src, dst):
            calls["n"] += 1
            if "app/index.html" in str(dst).replace("\\", "/") and calls["n"] <= 7:
                raise PermissionError(errno.EACCES, "file in use")
            os.replace(src, dst)

        mgr4 = U.UpdateManager(str(install4), source.base + "/update.json", "0.2.1",
                               base_url=source.base, replace_func=locked_replace,
                               retry_delays=(0, 0, 0))
        mgr4.check()
        ok, err = False, ""
        try:
            mgr4.apply()
        except U.UpdateError as e:
            ok, err = "占用" in str(e) or "自动回到" in str(e), str(e)
        check(ok, "⑮ 文件被占用重试后仍失败，给出可读提示", err)
        check(version_of(install4) == "0.2.1"
              and "old 0.2.1" in (install4 / "app" / "index.html").read_text(encoding="utf-8")
              and not (install4 / "app" / "new.js").exists(),
              "⑯ 替换失败能回到原状")

        # ⑥ 磁盘满
        install5 = tmp / "full"
        write_install(install5, "0.2.1")
        state = {"fail": True}

        def full_replace(src, dst):
            if state["fail"] and "app/update.js" in str(dst).replace("\\", "/"):
                state["fail"] = False
                raise OSError(errno.ENOSPC, "No space left")
            os.replace(src, dst)

        mgr5 = U.UpdateManager(str(install5), source.base + "/update.json", "0.2.1",
                               base_url=source.base, replace_func=full_replace,
                               retry_delays=(0, 0, 0))
        mgr5.check()
        ok, err = False, ""
        try:
            mgr5.apply()
        except U.UpdateError as e:
            ok, err = "磁盘满" in str(e) or "自动回到" in str(e), str(e)
        check(ok, "⑰ 磁盘满时给可读提示", err)
        check(version_of(install5) == "0.2.1"
              and "old updater ui" in (install5 / "app" / "update.js").read_text(encoding="utf-8"),
              "⑱ 磁盘失败后回到原状")

        # ⑦ 健康检查失败自动回滚
        install6 = tmp / "unhealthy"
        write_install(install6, "0.2.1")
        mgr6 = U.UpdateManager(str(install6), source.base + "/update.json", "0.2.1",
                               base_url=source.base,
                               health=lambda m: (False, "页面上的版本号还是 0.2.1"))
        mgr6.check()
        ok, err = False, ""
        try:
            mgr6.apply()
        except U.UpdateError as e:
            ok, err = "自动回到" in str(e), str(e)
        check(ok, "⑲ 健康检查不合格自动回滚", err)
        check(version_of(install6) == "0.2.1"
              and "old 0.2.1" in (install6 / "app" / "index.html").read_text(encoding="utf-8")
              and not (install6 / "app" / "new.js").exists(),
              "⑳ 回滚后文件与版本都回到 0.2.1")
        last6 = json.loads((install6 / "backups" / "program" / "last.json").read_text(encoding="utf-8"))
        check(last6.get("ok") is False and "版本号" in last6.get("message", ""),
              "㉑ 健康检查失败的原因写进了记录", last6.get("message"))

        # ⑧ 页面探测失败（默认健康检查）
        install7 = tmp / "nopage"
        write_install(install7, "0.2.1")
        mgr7 = U.UpdateManager(str(install7), source.base + "/update.json", "0.2.1",
                               base_url="http://127.0.0.1:1")
        mgr7.check()
        ok, err = False, ""
        try:
            mgr7.apply()
        except U.UpdateError as e:
            ok, err = "自动回到" in str(e), str(e)
        check(ok and version_of(install7) == "0.2.1",
              "㉒ 更新后页面打不开也会回滚", err)

        # ⑨ 版本回退被拒
        install8 = tmp / "newer"
        write_install(install8, "0.3.0")
        mgr8 = U.UpdateManager(str(install8), source.base + "/update.json", "0.3.0",
                               base_url=source.base)
        st = mgr8.check()
        check(st["available"] is False and "回退" in st["message"],
              "㉓ 远端版本更低时拒绝回退", st["message"])
        ok, err = False, ""
        try:
            mgr8.apply()
        except U.UpdateError as e:
            ok, err = "回退" in str(e), str(e)
        check(ok and backup_count(install8) == 0, "㉔ 回退被拒时不会下载/替换", err)

        # ⑩ 低于 minVersion 被拒
        install9 = tmp / "tooold"
        write_install(install9, "0.1.0")
        mgr9 = U.UpdateManager(str(install9), source.base + "/update.json", "0.1.0",
                               base_url=source.base)
        st = mgr9.check()
        check("太旧" in st["message"], "㉕ 低于 minVersion 直接拒绝", st["message"])

        # ⑪ 单文件版识别
        single = tmp / "single"
        single.mkdir()
        (single / "五1班节律屏-单文件版.html").write_text("<html>single</html>", encoding="utf-8")
        check(U.self_update_supported(str(single)) is False,
              "㉖ 单文件版识别为不能自更新")
        check(not U.is_program_path("data/schedule.json")
              and not U.is_program_path("server/messages.json")
              and U.is_program_path("app/index.html"),
              "㉗ 替换白名单挡住数据和消息")
        mgr10 = U.UpdateManager(str(single), source.base + "/update.json", "0.2.1")
        ok, err = False, ""
        try:
            mgr10.apply()
        except U.UpdateError as e:
            ok, err = "单文件版" in str(e), str(e)
        check(ok, "㉘ 单文件版只提示去下载新版", err)

        # ⑫ 网络失败 / 坏 JSON / 清单过大
        mgr11 = U.UpdateManager(str(tmp / "net"), "http://127.0.0.1:1/update.json", "0.2.1")
        ok, err = False, ""
        try:
            mgr11.check()
        except U.UpdateError as e:
            ok, err = "连不上" in str(e), str(e)
        check(ok, "㉙ 网络失败只有一句可读提示", err)

        source.serve("/update.json", b"not json")
        mgr12 = U.UpdateManager(str(tmp / "net"), source.base + "/update.json", "0.2.1")
        ok, err = False, ""
        try:
            mgr12.check()
        except U.UpdateError as e:
            ok, err = "JSON" in str(e), str(e)
        check(ok, "㉚ 清单不是 JSON 时给可读提示", err)

        source.serve("/update.json", b"x" * (M.MAX_MANIFEST_BYTES + 10))
        mgr13 = U.UpdateManager(str(tmp / "net"), source.base + "/update.json", "0.2.1")
        ok, err = False, ""
        try:
            mgr13.check()
        except U.UpdateError as e:
            ok, err = "太大" in str(e), str(e)
        check(ok, "㉛ 清单过大时停止检查", err)

        # ⑬ 备份只留最近两份
        install14 = tmp / "keep"
        write_install(install14, "0.2.1")
        mgr14 = U.UpdateManager(str(install14), source.base + "/update.json", "0.2.1",
                                base_url=source.base)
        for v in ("0.2.2", "0.2.3", "0.2.4"):
            z, man = build_package(tmp, v, source, mkm)
            publish(source, man, z)
            mgr14.check()
            mgr14.apply()
        check(version_of(install14) == "0.2.4" and backup_count(install14) == 2,
              "㉜ 连续升级后备份只留最近两份",
              "%d 份 / %s" % (backup_count(install14), version_of(install14)))

    finally:
        source.close()
        tempfile.tempdir = old_tempdir
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n通过 %d 项，失败 %d 项" % (pass_n, fail_n))
    sys.exit(1 if fail_n else 0)


if __name__ == "__main__":
    main()
