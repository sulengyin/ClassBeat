#!/usr/bin/env python3
"""自动更新：检查、下载、备份、替换、健康检查、回滚（ROADMAP 9.5）。

只在完整安装目录（同时有 app/ 和 server/ 的文件夹）里工作：
- 只替换白名单内的程序文件，绝不碰 data/、assets/、server/messages.json；
- 替换前把当前程序文件整份备份到 backups/program/<时间>-v<版本>/；
- 每个文件先写同目录临时文件，再 os.replace 原子落位；Windows 被占用会重试；
- 替换后校验磁盘上的版本号、逐个文件哈希和页面可访问性，不合格自动回滚；
- 备份只留最近两份，更新成功后清掉更早的。

这个模块不依赖 HTTP 服务，安装器、服务端和测试都可以直接用。
"""

from __future__ import annotations

import datetime as dt
import errno
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import update_manifest as um

BEIJING = dt.timezone(dt.timedelta(hours=8))

CHECK_TIMEOUT = 5
DOWNLOAD_TIMEOUT = 30
MAX_PACKAGE_BYTES = 128 * 1024 * 1024
BACKUP_KEEP = 2
RETRY_DELAYS = (0.2, 0.4, 0.8, 1.2, 2.0)

DOWNLOAD_PAGE = "https://github.com/sulengyin/ClassBeat/releases/latest"


class UpdateError(Exception):
    """更新流程失败。str(e) 直接给老师看，不要往上抛栈。"""


def read_version_js(path):
    """从某个 version.js 读 VERSION / BUILD；读不到返回空串。"""
    try:
        src = Path(path).read_text(encoding="utf-8")
    except OSError:
        return "", ""
    def grab(name):
        m = re.search(name + r'\s*=\s*"([^"]{1,40})"', src)
        return m.group(1) if m else ""
    return grab("VERSION"), grab("BUILD")


def self_update_supported(root):
    """有 app/version.js 和 server/ 才是可原位替换的完整安装目录。"""
    root = Path(root)
    return (root / "app" / "version.js").is_file() and (root / "server").is_dir()


def single_file_hint():
    return "这是单文件版，不能自己更新；请到下载页获取新版"


def is_program_path(rel):
    """替换白名单：只认程序文件，不认数据、资源、消息和配置。"""
    rel = rel.replace("\\", "/")
    if rel in um.PROTECTED_FILES or rel.startswith(um.PROTECTED_PREFIXES):
        return False
    if rel.startswith("app/"):
        return True
    if rel == "server/phone.html":
        return True
    if rel.startswith("server/") and rel.endswith(".py") \
            and not rel.startswith("server/python/"):
        return True
    # 启动器脚本也随版本走（2026-11-19）：图标改名这类修复要能
    # 到达已装的机器，否则老师升级后桌面图标还是旧名字。日志文件
    # 不在清单里，天然不会被换。
    if rel.startswith("tools/launcher/") and rel.endswith((".ps1", ".cmd")):
        return True
    return "/" not in rel and rel.endswith(".bat")


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _is_locked_error(e):
    if getattr(e, "winerror", None) in (5, 32, 33):
        return True
    return getattr(e, "errno", None) in (errno.EACCES, errno.EBUSY, errno.EPERM)


def _readable(e):
    if isinstance(e, (UpdateError, um.ManifestError)):
        return str(e)
    return "更新时出了点问题，请稍后再试"


class UpdateManager:
    def __init__(self, root, manifest_url="", current_version="", base_url="",
                 health=None, replace_func=None, retry_delays=RETRY_DELAYS,
                 log=None):
        self.root = Path(root).resolve()
        self.manifest_url = manifest_url or ""
        self.current_version = current_version or ""
        self.base_url = base_url or ""
        self.health = health
        self._replace_func = replace_func or os.replace
        self.retry_delays = tuple(retry_delays)
        self._log = log or (lambda *a: None)

        self.backup_root = self.root / "backups" / "program"
        self.manifest = None
        self.url_rewrite = None   # 可选钩子：下载前改写包地址（加速域名用）
        self._lock = threading.Lock()
        self._busy = False
        self.state = "idle"
        self.progress = 0
        self.message = "还没有检查更新"
        self.error = ""
        self.last = self._read_last()

    # ---------------------------------------------------------------- 状态

    def busy(self):
        with self._lock:
            return self._busy

    def _set(self, state, progress, message=None, error=None):
        with self._lock:
            self.state = state
            self.progress = max(0, min(100, int(progress)))
            if message is not None:
                self.message = message
            if error is not None:
                self.error = error

    def status(self):
        with self._lock:
            m = self.manifest
            state, progress = self.state, self.progress
            message, error = self.message, self.error
            busy = self._busy

        available, blocked = False, ""
        if m:
            available = um.is_newer(m["version"], self.current_version)
            try:
                um.validate_upgrade(m, self.current_version)
            except um.ManifestError as e:
                blocked = str(e)

        supported = self_update_supported(self.root)
        if not supported:
            blocked = blocked or single_file_hint()

        return {
            "state": state,
            "progress": progress,
            "message": message,
            "error": error,
            "busy": busy,
            "currentVersion": self.current_version,
            "latest": m["version"] if m else "",
            "available": available,
            "canApply": available and not blocked and supported and not busy,
            "blockedReason": blocked,
            "notes": m["notes"] if m else "",
            "publishedAt": m["publishedAt"] if m else "",
            "selfUpdate": supported,
            "downloadPage": DOWNLOAD_PAGE,
            "hasBackup": self.has_backup(),
            "last": self.last,
        }

    def _read_last(self):
        try:
            obj = json.loads((self.backup_root / "last.json").read_text(encoding="utf-8"))
            return obj if isinstance(obj, dict) else {}
        except (OSError, ValueError):
            return {}

    def _record(self, action, ok, from_version, to_version, message, backup=""):
        obj = {
            "format": "classbeat-update-record/v1",
            "at": dt.datetime.now(BEIJING).isoformat(timespec="seconds"),
            "action": action,
            "ok": bool(ok),
            "fromVersion": from_version,
            "toVersion": to_version,
            "message": message,
            "backup": backup.name if backup else "",
        }
        try:
            self.backup_root.mkdir(parents=True, exist_ok=True)
            fp = self.backup_root / "last.json"
            tmp = fp.with_name(fp.name + ".tmp")
            tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")
            os.replace(tmp, fp)
        except OSError:
            pass
        self.last = obj

    # ---------------------------------------------------------------- 检查

    def _fetch_manifest(self):
        if not self.manifest_url:
            raise UpdateError("还没有配置更新源，暂时不能在线更新")
        try:
            req = urllib.request.Request(
                self.manifest_url, headers={"User-Agent": "classbeat-updater"})
            with urllib.request.urlopen(req, timeout=CHECK_TIMEOUT) as r:
                size = r.headers.get("Content-Length")
                if size and int(size) > um.MAX_MANIFEST_BYTES:
                    raise UpdateError("更新清单太大，已停止检查")
                raw = r.read(um.MAX_MANIFEST_BYTES + 1)
        except UpdateError:
            raise
        except Exception as e:
            self._log("manifest fetch failed:", e)
            raise UpdateError("连不上更新服务器，请检查网络后再试")
        if len(raw) > um.MAX_MANIFEST_BYTES:
            raise UpdateError("更新清单太大，已停止检查")
        return raw

    def check(self):
        """拉清单并比对版本；网络/格式错误抛 UpdateError，版本问题只在状态里说。"""
        self._set("checking", 0, "正在检查更新…", "")
        try:
            manifest = um.parse_manifest(self._fetch_manifest())
        except (UpdateError, um.ManifestError) as e:
            msg = _readable(e)
            self._set("failed", 0, msg, msg)
            raise UpdateError(msg)

        self.manifest = manifest
        try:
            um.validate_upgrade(manifest, self.current_version)
        except um.ManifestError as e:
            self._set("idle", 0, str(e), "")
            return self.status()

        self._set("idle", 0, "发现新版本 v%s" % manifest["version"], "")
        return self.status()

    def ensure_ready(self):
        """准备执行更新；不能更新时给出可读原因。"""
        if not self_update_supported(self.root):
            raise UpdateError(single_file_hint())
        if self.manifest is None:
            self.check()
        if self.manifest is None:
            raise UpdateError("暂时没有可用的更新")
        try:
            um.validate_upgrade(self.manifest, self.current_version)
        except um.ManifestError as e:
            raise UpdateError(str(e))
        return self.manifest

    # ---------------------------------------------------------------- 下载

    def _download(self, manifest):
        tmpdir = Path(tempfile.mkdtemp(prefix="classbeat-update-"))
        target = tmpdir / "package.zip"
        try:
            try:
                url = manifest["url"]
                if self.url_rewrite:
                    url = self.url_rewrite(url)
                req = urllib.request.Request(
                    url, headers={"User-Agent": "classbeat-updater"})
                with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as r:
                    size = r.headers.get("Content-Length")
                    if size and int(size) > MAX_PACKAGE_BYTES:
                        raise UpdateError("安装包太大，已停止下载")
                    got = 0
                    with open(target, "wb") as f:
                        while True:
                            chunk = r.read(65536)
                            if not chunk:
                                break
                            got += len(chunk)
                            if got > MAX_PACKAGE_BYTES or got > manifest["bytes"]:
                                raise UpdateError("安装包比清单里写的大，已停止下载")
                            f.write(chunk)
                            pct = 5 + int(40 * got / max(1, manifest["bytes"]))
                            self._set("downloading", min(pct, 45),
                                      "正在下载 v%s…" % manifest["version"])
                    if size and got != int(size):
                        raise UpdateError("下载中断，文件不完整，请检查网络后重试")
            except UpdateError:
                raise
            except urllib.error.HTTPError as e:
                raise UpdateError("下载失败（服务器返回 %d），请稍后再试" % e.code)
            except Exception as e:
                self._log("download failed:", e)
                raise UpdateError("下载中断，请检查网络后重试")

            try:
                um.verify_package(str(target), manifest)
            except um.ManifestError as e:
                raise UpdateError(str(e))
            return target, tmpdir
        except Exception:
            shutil.rmtree(tmpdir, ignore_errors=True)
            raise

    # ---------------------------------------------------------------- 解包

    def _extract(self, package, manifest):
        staging = Path(tempfile.mkdtemp(prefix=".update-staging-", dir=str(self.root)))
        try:
            with zipfile.ZipFile(package) as z:
                infos = [i for i in z.infolist() if not i.is_dir()]
                for item in manifest["files"]:
                    rel = item["path"]
                    if not is_program_path(rel):
                        raise UpdateError("安装包里有不该替换的文件：%s" % rel)
                    matches = [i for i in infos
                               if i.filename.replace("\\", "/") == rel
                               or i.filename.replace("\\", "/").endswith("/" + rel)]
                    if len(matches) != 1:
                        raise UpdateError("安装包不完整：缺少 %s" % rel)
                    data = z.read(matches[0])
                    if len(data) != item["bytes"] \
                            or hashlib.sha256(data).hexdigest() != item["sha256"]:
                        raise UpdateError("安装包里的 %s 校验失败" % rel)
                    dst = staging.joinpath(*rel.split("/"))
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    dst.write_bytes(data)
            return staging
        except UpdateError:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        except (zipfile.BadZipFile, OSError) as e:
            self._log("extract failed:", e)
            shutil.rmtree(staging, ignore_errors=True)
            raise UpdateError("安装包解不开，可能没下载完整")

    # ---------------------------------------------------------------- 备份

    def _current_program_files(self):
        app = self.root / "app"
        if app.is_dir():
            for dirpath, dirnames, filenames in os.walk(app):
                dirnames[:] = [d for d in dirnames if d != "__pycache__"]
                for name in filenames:
                    rel = Path(dirpath, name).relative_to(self.root).as_posix()
                    if is_program_path(rel):
                        yield rel
        server = self.root / "server"
        if server.is_dir():
            for path in sorted(server.glob("*.py")):
                yield path.relative_to(self.root).as_posix()
            phone = server / "phone.html"
            if phone.is_file():
                yield phone.relative_to(self.root).as_posix()
        for bat in sorted(self.root.glob("*.bat")):
            yield bat.relative_to(self.root).as_posix()

    def _backup(self, from_version):
        stamp = dt.datetime.now(BEIJING).strftime("%Y%m%d-%H%M%S")
        base = self.backup_root / ("%s-v%s" % (stamp, from_version or "unknown"))
        path, n = base, 1
        while path.exists():
            n += 1
            path = base.with_name(base.name + "-" + str(n))

        meta = {
            "format": "classbeat-program-backup/v1",
            "fromVersion": from_version,
            "at": dt.datetime.now(BEIJING).isoformat(timespec="seconds"),
            "files": [],
            "created": [],
        }
        try:
            for rel in self._current_program_files():
                src = self.root.joinpath(*rel.split("/"))
                dst = path / "files" / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                meta["files"].append({
                    "path": rel,
                    "sha256": _sha256(src),
                    "bytes": src.stat().st_size,
                })
            path.mkdir(parents=True, exist_ok=True)
            (path / "meta.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except OSError as e:
            self._log("backup failed:", e)
            shutil.rmtree(path, ignore_errors=True)
            raise UpdateError("备份失败，已取消更新，原文件没有动")
        return path, meta

    # ---------------------------------------------------------------- 替换

    def _replace_with_retry(self, src, dst):
        last = None
        for i in range(len(self.retry_delays) + 1):
            try:
                self._replace_func(str(src), str(dst))
                return
            except OSError as e:
                if not _is_locked_error(e):
                    raise
                last = e
                try:
                    os.chmod(dst, stat.S_IWRITE)
                except OSError:
                    pass
                if i < len(self.retry_delays):
                    time.sleep(self.retry_delays[i])
        self._log("replace failed:", last)
        raise UpdateError("「%s」被占用，重试后仍然换不了" % Path(dst).name)

    def _copy_atomic(self, src, dst):
        dst = Path(dst)
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(dst.name + ".classbeat-new")
        try:
            shutil.copyfile(src, tmp)
            self._replace_with_retry(tmp, dst)
        finally:
            try:
                tmp.unlink()
            except OSError:
                pass

    def _replace_all(self, staging, manifest, created):
        order = [f for f in manifest["files"] if f["path"] != "app/version.js"]
        order += [f for f in manifest["files"] if f["path"] == "app/version.js"]
        total = max(1, len(order))
        for i, item in enumerate(order):
            rel = item["path"]
            dst = self.root.joinpath(*rel.split("/"))
            if not dst.exists():
                created.append(rel)
            src = staging.joinpath(*rel.split("/"))
            try:
                self._copy_atomic(src, dst)
            except UpdateError:
                raise
            except OSError as e:
                self._log("install failed:", rel, e)
                raise UpdateError("替换 %s 失败（可能是磁盘满或没有权限）" % rel)
            self._set("installing", 65 + int(20 * (i + 1) / total),
                      "正在替换程序文件…")

    def _remove_with_retry(self, path):
        for i in range(len(self.retry_delays) + 1):
            try:
                os.remove(path)
                return
            except FileNotFoundError:
                return
            except OSError as e:
                if not _is_locked_error(e):
                    raise
                if i < len(self.retry_delays):
                    time.sleep(self.retry_delays[i])
        raise UpdateError("「%s」删不掉，可能被占用" % Path(path).name)

    # ---------------------------------------------------------------- 校验与恢复

    def _health_check(self, manifest):
        if self.health:
            return self.health(manifest)

        version, _ = read_version_js(self.root / "app" / "version.js")
        if um.version_key(version) != um.version_key(manifest["version"]):
            return False, "页面上的版本号还是 v%s" % (version or "未知")
        try:
            um.verify_tree(str(self.root), manifest)
        except um.ManifestError as e:
            return False, str(e)
        if self.base_url:
            try:
                req = urllib.request.Request(
                    self.base_url.rstrip("/") + "/app/index.html",
                    headers={"User-Agent": "classbeat-health", "Cache-Control": "no-cache"})
                with urllib.request.urlopen(req, timeout=5) as r:
                    if r.status != 200 or not r.read(1):
                        return False, "更新后页面打不开"
            except Exception as e:
                self._log("health page failed:", e)
                return False, "更新后页面打不开"
        return True, ""

    def _read_meta(self, backup):
        try:
            return json.loads((Path(backup) / "meta.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise UpdateError("备份记录读不出来，没法自动恢复")

    def _restore(self, backup, created=None):
        meta = self._read_meta(backup)
        created = list(created if created is not None else meta.get("created") or [])
        problems = []

        for rel in created:
            dst = self.root.joinpath(*rel.split("/"))
            if dst.exists():
                try:
                    self._remove_with_retry(dst)
                except (OSError, UpdateError):
                    problems.append(rel)

        for item in meta.get("files") or []:
            rel = item.get("path") or ""
            src = Path(backup) / "files" / rel
            dst = self.root.joinpath(*rel.split("/"))
            if not src.is_file():
                problems.append(rel + "（备份里没有）")
                continue
            try:
                self._copy_atomic(src, dst)
            except (OSError, UpdateError):
                problems.append(rel)

        if problems:
            raise UpdateError("自动恢复没完成：%s" % "、".join(problems[:3]))

    def _update_meta_created(self, backup, created):
        try:
            meta = self._read_meta(backup)
            meta["created"] = list(created)
            (Path(backup) / "meta.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except (OSError, UpdateError):
            pass

    # ---------------------------------------------------------------- 备份清理

    def _backups(self):
        try:
            return sorted((p for p in self.backup_root.iterdir()
                           if p.is_dir() and (p / "meta.json").is_file()),
                          reverse=True)
        except OSError:
            return []

    def latest_backup(self):
        dirs = self._backups()
        return dirs[0] if dirs else None

    def has_backup(self):
        return self.latest_backup() is not None

    def _trim_backups(self):
        for old in self._backups()[BACKUP_KEEP:]:
            shutil.rmtree(old, ignore_errors=True)

    # ---------------------------------------------------------------- 执行

    def apply(self):
        with self._lock:
            if self._busy:
                raise UpdateError("正在更新，请稍等")
            self._busy = True

        package_dir = staging = None
        backup = None
        created = []
        old_version = self.current_version
        try:
            manifest = self.ensure_ready()
            self._set("downloading", 5, "正在下载 v%s…" % manifest["version"], "")
            package, package_dir = self._download(manifest)

            self._set("installing", 50, "正在解压…")
            staging = self._extract(package, manifest)

            self._set("installing", 60, "正在备份当前版本…")
            backup, _ = self._backup(old_version)

            self._replace_all(staging, manifest, created)
            self._update_meta_created(backup, created)

            self._set("verifying", 88, "正在检查页面和版本号…")
            ok, why = self._health_check(manifest)
            if not ok:
                raise UpdateError(why)

            self._record("update", True, old_version, manifest["version"],
                         "页面和版本号都正常", backup)
            self.current_version = manifest["version"]
            self._trim_backups()
            self._set("done", 100,
                      "已更新到 v%s，重启后完全生效" % manifest["version"], "")
            return self.status()

        except Exception as e:
            if backup is not None:
                self._set("rolling_back", 92, "更新没完成，正在恢复…")
                try:
                    self._restore(backup, created)
                except (OSError, UpdateError) as re_err:
                    msg = "更新失败，且自动恢复没完成：%s" % re_err
                    self._record("update", False, old_version, "", msg, backup)
                    self._set("failed", 100, msg, msg)
                    raise UpdateError(msg)
                msg = _readable(e)
                self._record("update", False, old_version,
                             manifest["version"] if 'manifest' in locals() else "",
                             msg, backup)
                self._trim_backups()
                self._set("failed", 100,
                          "更新失败，已自动回到原来的文件", msg)
                raise UpdateError("更新失败，已自动回到原来的文件")

            msg = _readable(e)
            self._record("update", False, old_version, "", msg, "")
            self._set("failed", 100, msg, msg)
            raise UpdateError(msg)
        finally:
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)
            if package_dir is not None:
                shutil.rmtree(package_dir, ignore_errors=True)
            with self._lock:
                self._busy = False

    def rollback(self):
        with self._lock:
            if self._busy:
                raise UpdateError("正在更新，请稍等")
            self._busy = True

        try:
            backup = self.latest_backup()
            if backup is None:
                raise UpdateError("没有可回滚的上一版")
            meta = self._read_meta(backup)
            target = meta.get("fromVersion") or ""
            self._set("rolling_back", 20,
                      "正在回到 v%s…" % (target or "上一版"), "")
            self._restore(backup, meta.get("created"))
            self._record("rollback", True, self.current_version, target,
                         "已回到上一版", backup)
            self.current_version = target
            self.manifest = None
            self._trim_backups()
            self._set("done", 100,
                      "已回到 v%s，重启后完全生效" % (target or "上一版"), "")
            return self.status()
        except Exception as e:
            msg = _readable(e)
            self._record("rollback", False, self.current_version, "", msg, "")
            self._set("failed", 100, msg, msg)
            raise UpdateError(msg)
        finally:
            with self._lock:
                self._busy = False
