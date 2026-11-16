#!/usr/bin/env python3
"""update.json 的验收测试（ROADMAP 9.5）。

全部在临时目录里跑：把 tools/make_update.py、server/update_manifest.py
和 CHANGELOG.md 复制过去，自己造一个假安装包，绝不碰真实仓库里的文件。

    python3 tools/test_update_manifest.py
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
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


def make_fake_zip(path):
    """造一个和真实发布包同结构的 zip，只装最小的假文件。"""
    top = "五1班节律屏-测试包"
    files = {
        "app/version.js": b'var VERSION = "0.2.2";\nvar BUILD = "abc1234";\n',
        "app/index.html": b"<html><body>screen</body></html>\n",
        "app/update.js": b"// update ui\n",
        "server/rhythm_server.py": b"# server\n",
        "server/run.py": b"# guard\n",
        "server/phone.html": b"<html>phone</html>\n",
        "server/update_manifest.py": b"# manifest\n",
        "server/python/python.exe": b"MZ fake runtime",
        "server/python/python312.dll": b"fake dll",
        "打开大屏.bat": b"@echo off\r\n",
        "使用说明.txt": b"readme",
        "五1班节律屏-单文件版.html": b"<html>single</html>\n",
        "MANIFEST.txt": b"fake manifest",
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, data in files.items():
            z.writestr(top + "/" + rel, data)
    return top, files


def program_paths(files):
    out = []
    for rel in files:
        if rel in ("MANIFEST.txt", "使用说明.txt"):
            continue
        if rel.endswith("-单文件版.html") or rel.endswith("-single.html"):
            continue
        if rel.startswith("server/python/"):
            continue
        if rel.startswith("app/") or rel.startswith("server/") or rel.endswith(".bat"):
            out.append(rel)
    return sorted(out)


def main():
    tmp = Path(tempfile.mkdtemp(prefix="classbeat-update-"))
    try:
        repo = tmp / "repo"
        (repo / "tools").mkdir(parents=True)
        (repo / "server").mkdir()
        (repo / "dist").mkdir()
        shutil.copy2(ROOT / "tools" / "make_update.py", repo / "tools" / "make_update.py")
        shutil.copy2(ROOT / "server" / "update_manifest.py",
                     repo / "server" / "update_manifest.py")

        changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
        changelog = changelog.replace(
            "## 0.2.1",
            "## 0.2.2 — 2026-11-12\n\n- 测试用更新说明：新增自动更新。\n\n## 0.2.1", 1)
        (repo / "CHANGELOG.md").write_text(changelog, encoding="utf-8")

        top, files = make_fake_zip(repo / "dist" / "classbeat-0.2.2.zip")
        zip_path = repo / "dist" / "classbeat-0.2.2.zip"

        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        run = subprocess.run(
            [sys.executable, str(repo / "tools" / "make_update.py"),
             "--tag", "v0.2.2", "--repo", "test/repo", "--min-version", "0.2.0"],
            cwd=str(repo), capture_output=True, text=True, encoding="utf-8", env=env)

        check(run.returncode == 0, "① 在临时仓库副本里生成 update.json",
              (run.stderr or run.stdout).strip()[:200])
        if run.returncode != 0:
            return

        sys.path.insert(0, str(repo / "server"))
        import update_manifest as um

        raw = (repo / "dist" / "update.json").read_bytes()
        m = um.parse_manifest(raw)

        check(m["version"] == "0.2.2" and m["build"] == "abc1234",
              "② 版本号和构建号取自包内 version.js",
              "%s %s" % (m["version"], m["build"]))
        check("测试用更新说明" in m["notes"], "③ 更新说明取自 CHANGELOG", m["notes"][:30])
        check(m["url"] == "https://github.com/test/repo/releases/download/v0.2.2/classbeat-0.2.2.zip",
              "④ 下载地址按 tag 拼出", m["url"])
        check(m["minVersion"] == "0.2.0", "⑤ 最低可升级版本写入", m["minVersion"])
        check(bool(m["publishedAt"]), "⑥ 发布日期写入", m["publishedAt"])

        expected = program_paths(files)
        got = [f["path"] for f in m["files"]]
        check(got == expected, "⑦ files 只列程序文件", "%d 个" % len(got))

        bad = [f["path"] for f in m["files"]
               if f["sha256"] != sha(files[f["path"]]) or f["bytes"] != len(files[f["path"]])]
        check(not bad, "⑧ 每个文件的 SHA256 与字节数都对", bad[:2])

        check(m["sha256"] == sha(zip_path.read_bytes()) and m["bytes"] == zip_path.stat().st_size,
              "⑨ 整包 SHA256 与字节数对", m["sha256"][:12])

        ok = True
        try:
            um.validate_upgrade(m, "0.2.0")
        except um.ManifestError:
            ok = False
        check(ok, "⑩ 0.2.0 可以升到 0.2.2")

        for title, local, word in (
                ("⑪ 同版本不再升级", "0.2.2", "最新"),
                ("⑫ 版本回退被拒", "0.3.0", "回退")):
            try:
                um.validate_upgrade(m, local)
                check(False, title, "没有报错")
            except um.ManifestError as e:
                check(word in str(e), title, e)

        older = json.loads(json.dumps(m))
        older["minVersion"] = "0.3.0"
        try:
            um.validate_upgrade(older, "0.2.1")
            check(False, "⑬ 低于 minVersion 直接拒绝", "没有报错")
        except um.ManifestError as e:
            check("太旧" in str(e), "⑬ 低于 minVersion 直接拒绝", e)

        def bad_manifest(title, mutate, word):
            obj = json.loads(json.dumps(m))
            mutate(obj)
            try:
                um.parse_manifest(json.dumps(obj, ensure_ascii=False).encode("utf-8"))
                check(False, title, "没有报错")
            except um.ManifestError as e:
                check(word in str(e), title, e)

        try:
            um.parse_manifest(b"{")
            check(False, "⑭ 坏 JSON 有可读错误", "没有报错")
        except um.ManifestError as e:
            check("JSON" in str(e), "⑭ 坏 JSON 有可读错误", e)

        bad_manifest("⑮ 缺字段有可读错误", lambda o: o.pop("version"), "版本号")
        bad_manifest("⑯ 不支持的清单版本", lambda o: o.update({"schema": 99}), "格式版本")
        bad_manifest("⑰ 文件 SHA256 格式错",
                     lambda o: o["files"][0].update({"sha256": "abc"}), "SHA256")
        bad_manifest("⑱ 路径越界被拒",
                     lambda o: o["files"][0].update({"path": "../evil.js"}), "不合法")
        bad_manifest("⑲ 受保护文件被拒",
                     lambda o: o["files"][0].update({"path": "data/schedule.json"}), "受保护")
        bad_manifest("⑳ 绝对路径被拒",
                     lambda o: o["files"][0].update({"path": "/etc/passwd"}), "绝对路径")
        bad_manifest("㉑ 非 http 地址被拒",
                     lambda o: o.update({"url": "ftp://x/y.zip"}), "http")
        bad_manifest("㉒ 坏日期被拒",
                     lambda o: o.update({"publishedAt": "昨天"}), "发布日期")

        try:
            um.verify_package(zip_path, m)
            check(True, "㉓ 完整包校验通过")
        except um.ManifestError as e:
            check(False, "㉓ 完整包校验通过", e)

        short = tmp / "short.zip"
        short.write_bytes(zip_path.read_bytes() + b"x")
        try:
            um.verify_package(short, m)
            check(False, "㉔ 大小不符被拒", "没有报错")
        except um.ManifestError as e:
            check("大小" in str(e), "㉔ 大小不符被拒", e)

        broken = tmp / "broken.zip"
        data = bytearray(zip_path.read_bytes())
        data[len(data) // 2] ^= 0xFF
        broken.write_bytes(data)
        try:
            um.verify_package(broken, m)
            check(False, "㉕ SHA256 不符被拒", "没有报错")
        except um.ManifestError as e:
            check("SHA256" in str(e), "㉕ SHA256 不符被拒", e)

        unpack = tmp / "unpack"
        shutil.unpack_archive(str(zip_path), str(unpack))
        root = unpack / top
        try:
            um.verify_tree(root, m)
            check(True, "㉖ 解压后的程序文件逐个校验通过")
        except um.ManifestError as e:
            check(False, "㉖ 解压后的程序文件逐个校验通过", e)

        target = root / "app" / "index.html"
        target.write_bytes(b"tampered")
        try:
            um.verify_tree(root, m)
            check(False, "㉗ 被改过的文件能指出路径", "没有报错")
        except um.ManifestError as e:
            check("app/index.html" in str(e), "㉗ 被改过的文件能指出路径", e)

        target.write_bytes(files["app/index.html"])
        (root / "app" / "update.js").unlink()
        try:
            um.verify_tree(root, m)
            check(False, "㉘ 缺文件能指出路径", "没有报错")
        except um.ManifestError as e:
            check("app/update.js" in str(e) and "缺失" in str(e),
                  "㉘ 缺文件能指出路径", e)

        again = subprocess.run(
            [sys.executable, str(repo / "tools" / "make_update.py"),
             "--check-only", "--dist", str(repo / "dist")],
            cwd=str(repo), capture_output=True, text=True, encoding="utf-8", env=env)
        check(again.returncode == 0, "㉙ --check-only 能独立复核清单",
              (again.stderr or again.stdout).strip()[:120])

        # 再跑一遍真实打包脚本（临时副本，--no-python 免得下载运行时），
        # 确认新增的 server/update_manifest.py 会进包、也会进清单。
        pkgrepo = tmp / "pkgrepo"
        (pkgrepo / "tools").mkdir(parents=True)
        (pkgrepo / "server").mkdir()
        shutil.copytree(ROOT / "app", pkgrepo / "app")
        shutil.copytree(ROOT / "sample", pkgrepo / "sample")
        for name in ("rhythm_server.py", "run.py", "phone.html",
                     "update_manifest.py", "updater.py"):
            shutil.copy2(ROOT / "server" / name, pkgrepo / "server" / name)
        shutil.copy2(ROOT / "tools" / "package.py", pkgrepo / "tools" / "package.py")
        shutil.copy2(ROOT / "tools" / "make_update.py", pkgrepo / "tools" / "make_update.py")

        packed = subprocess.run(
            [sys.executable, "tools/package.py", "--no-python", "--version", "0.2.2"],
            cwd=str(pkgrepo), capture_output=True, text=True, encoding="utf-8", env=env)
        check(packed.returncode == 0, "㉚ 真实 package.py 能在临时副本里打包",
              (packed.stderr or packed.stdout).strip()[-200:])

        real_zip = pkgrepo / "dist" / "classbeat-0.2.2.zip"
        with zipfile.ZipFile(real_zip) as z:
            names = z.namelist()
        check(any(n.endswith("/server/update_manifest.py") for n in names)
              and any(n.endswith("/server/updater.py") for n in names),
              "㉛ 新模块进了发布包")

        made = subprocess.run(
            [sys.executable, "tools/make_update.py", "--tag", "v0.2.2",
             "--repo", "test/repo", "--notes", "集成测试"],
            cwd=str(pkgrepo), capture_output=True, text=True, encoding="utf-8", env=env)
        check(made.returncode == 0, "㉜ 发布包里能生成 update.json",
              (made.stderr or made.stdout).strip()[-200:])

        packed_manifest = um.parse_manifest((pkgrepo / "dist" / "update.json").read_bytes())
        paths = [f["path"] for f in packed_manifest["files"]]
        check(packed_manifest["version"] == "0.2.2"
              and "server/update_manifest.py" in paths
              and "server/updater.py" in paths
              and "app/index.html" in paths
              and not any(p.startswith("server/python/") for p in paths)
              and "MANIFEST.txt" not in paths,
              "㉝ 真实包的清单版本与文件范围正确",
              "%d 个文件" % len(paths))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n通过 %d 项，失败 %d 项" % (pass_n, fail_n))
    sys.exit(1 if fail_n else 0)


if __name__ == "__main__":
    main()
