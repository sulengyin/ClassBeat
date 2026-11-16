#!/usr/bin/env python3
"""update.json 的解析、校验与文件比对（ROADMAP 9.5）。

只依赖标准库，不联网、不写盘；发布脚本、安装器和测试都用这一份，
免得三处各写一套规则。

清单字段：
    version      新版本号
    build        构建号（短 SHA）
    publishedAt  发布日期（ISO 8601，北京时间）
    minVersion   最低可升级版本
    notes        更新说明
    url          整包下载地址
    sha256       整包 SHA256
    bytes        整包字节数
    files        待替换程序文件的 [{"path", "sha256", "bytes"}]

files 只列「安装时会替换的程序文件」，不含包里的免安装 Python、
MANIFEST.txt、使用说明和单文件版。data/、assets/、backups/ 以及
server/messages.json 这类运行时文件在解析阶段就会被拒绝。
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re

SCHEMA_VERSION = 1

# 清单本身很小；给足余量，也不让一个坏掉的源把内存吃满。
MAX_MANIFEST_BYTES = 512 * 1024
MAX_FILES = 4000

# 这些位置属于老师自己的数据或运行期状态，任何更新包都不许碰。
PROTECTED_PREFIXES = ("data/", "assets/", "backups/")
PROTECTED_FILES = (
    "server/messages.json",
    "server/net.json",
    "server/server.log",
    "server/service.pid",
)

_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
_VERSION_RE = re.compile(r"^\d+(\.\d+){0,2}$")


class ManifestError(ValueError):
    """清单不可用。str(e) 就是给老师看的一句话，不要往上抛栈。"""


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


def is_newer(remote, local):
    return version_key(remote) > version_key(local)


def sha256_file(path, chunk=1024 * 1024):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def _need_text(obj, key, label, allow_empty=False, limit=8192):
    if key not in obj:
        raise ManifestError("更新清单缺少「%s」" % label)
    val = obj.get(key)
    if not isinstance(val, str):
        raise ManifestError("更新清单的「%s」应该是文字" % label)
    val = val.strip()
    if not val and not allow_empty:
        raise ManifestError("更新清单的「%s」是空的" % label)
    if len(val) > limit:
        raise ManifestError("更新清单的「%s」太长" % label)
    return val


def _need_version(obj, key, label):
    val = _need_text(obj, key, label, limit=40).lstrip("vV")
    if not _VERSION_RE.match(val):
        raise ManifestError("更新清单的「%s」不是版本号：%s" % (label, val))
    return val


def _need_int(obj, key, label):
    if key not in obj:
        raise ManifestError("更新清单缺少「%s」" % label)
    val = obj.get(key)
    if isinstance(val, bool) or not isinstance(val, int) or val < 0:
        raise ManifestError("更新清单的「%s」应该是非负整数" % label)
    return val


def _need_sha(obj, key, label):
    val = _need_text(obj, key, label, limit=64).lower()
    if not _SHA_RE.match(val):
        raise ManifestError("更新清单的「%s」不是有效的 SHA256" % label)
    return val


def check_rel_path(path):
    """只接受包内相对路径；越界、绝对路径和保护文件一律拒绝。"""
    if not isinstance(path, str) or not path.strip():
        raise ManifestError("更新清单里有空的文件路径")
    path = path.strip()
    if "\\" in path:
        raise ManifestError("更新清单里的路径不能用反斜杠：%s" % path)
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        raise ManifestError("更新清单里有绝对路径：%s" % path)
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ManifestError("更新清单里的路径不合法：%s" % path)
    low = path.lower()
    if low in PROTECTED_FILES or any(low.startswith(p) for p in PROTECTED_PREFIXES):
        raise ManifestError("更新清单想改受保护的文件：%s" % path)
    return path


def _parse_files(obj):
    raw = obj.get("files")
    if not isinstance(raw, list) or not raw:
        raise ManifestError("更新清单缺少「files」或文件列表为空")
    if len(raw) > MAX_FILES:
        raise ManifestError("更新清单的文件列表太长（%d 个）" % len(raw))

    files = []
    seen = set()
    for i, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise ManifestError("更新清单第 %d 个文件格式不对" % i)
        path = check_rel_path(item.get("path"))
        if path in seen:
            raise ManifestError("更新清单里文件重复：%s" % path)
        seen.add(path)
        files.append({
            "path": path,
            "sha256": _need_sha(item, "sha256", "文件 SHA256"),
            "bytes": _need_int(item, "bytes", "文件大小"),
        })
    return files


def _parse_published_at(value):
    text = _need_text({"publishedAt": value}, "publishedAt", "发布日期", limit=40)
    try:
        dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ManifestError("更新清单的「发布日期」不是有效时间：%s" % text)
    return text


def parse_manifest(raw):
    """把 update.json 解析并校验成规范 dict；任何问题都抛 ManifestError。"""
    if isinstance(raw, (bytes, bytearray, memoryview)):
        data = bytes(raw)
    elif isinstance(raw, str):
        data = raw.encode("utf-8")
    else:
        raise ManifestError("更新清单格式不对：需要 JSON 文本")

    if len(data) > MAX_MANIFEST_BYTES:
        raise ManifestError("更新清单太大（%d 字节）" % len(data))
    try:
        obj = json.loads(data.decode("utf-8-sig"))
    except UnicodeDecodeError:
        raise ManifestError("更新清单不是 UTF-8 文字")
    except ValueError:
        raise ManifestError("更新清单不是有效的 JSON，可能下载不完整")

    if not isinstance(obj, dict):
        raise ManifestError("更新清单的最外层应该是一个对象")

    schema = obj.get("schema", 0)
    if schema != SCHEMA_VERSION:
        raise ManifestError(
            "更新清单格式版本是 %s，这个版本的程序只认 %d；请先手动更新"
            % (schema, SCHEMA_VERSION))

    version = _need_version(obj, "version", "版本号")
    build = _need_text(obj, "build", "构建号", limit=40)
    min_version = _need_version(obj, "minVersion", "最低可升级版本")
    published_at = _parse_published_at(obj.get("publishedAt"))
    notes = _need_text(obj, "notes", "更新说明", allow_empty=True, limit=8000)

    url = _need_text(obj, "url", "下载地址", limit=2048)
    if not re.match(r"^https?://", url, re.I):
        raise ManifestError("更新清单的「下载地址」只能是 http(s)：%s" % url)

    return {
        "schema": SCHEMA_VERSION,
        "version": version,
        "build": build,
        "publishedAt": published_at,
        "minVersion": min_version,
        "notes": notes,
        "url": url,
        "sha256": _need_sha(obj, "sha256", "整包 SHA256"),
        "bytes": _need_int(obj, "bytes", "整包大小"),
        "files": _parse_files(obj),
    }


def validate_upgrade(manifest, local_version):
    """判断这份清单能不能装到当前版本上；不能就给出可读原因。"""
    local = (local_version or "").strip() or "0.0.0"
    if version_key(local) < version_key(manifest["minVersion"]):
        raise ManifestError(
            "当前版本 v%s 太旧，最低可升级到 v%s；请先下载完整安装包手动更新"
            % (local, manifest["minVersion"]))

    remote = version_key(manifest["version"])
    now = version_key(local)
    if remote == now:
        raise ManifestError("已经是最新版本 v%s" % local)
    if remote < now:
        raise ManifestError(
            "远端版本 v%s 比当前 v%s 旧，已拒绝回退" % (manifest["version"], local))


def verify_package(path, manifest):
    """下载完成后校验整包；不通过就抛 ManifestError（调用方负责删临时文件）。"""
    try:
        size = os.path.getsize(path)
    except OSError:
        raise ManifestError("安装包不存在或读不到：%s" % os.path.basename(str(path)))

    if size != manifest["bytes"]:
        raise ManifestError(
            "安装包大小不对（应为 %d 字节，实际 %d 字节），可能没下载完整"
            % (manifest["bytes"], size))

    got = sha256_file(path)
    if got != manifest["sha256"]:
        raise ManifestError("安装包 SHA256 校验失败，可能没下载完整或被改过")


def verify_tree(root, manifest):
    """逐个比对解压后的程序文件；有问题时一次说清前几个。"""
    problems = []
    for item in manifest["files"]:
        fp = os.path.join(root, *item["path"].split("/"))
        try:
            if os.path.getsize(fp) != item["bytes"]:
                problems.append("%s 大小不对" % item["path"])
            elif sha256_file(fp) != item["sha256"]:
                problems.append("%s SHA256 不一致" % item["path"])
        except OSError:
            problems.append("%s 缺失" % item["path"])

    if problems:
        more = "" if len(problems) <= 3 else " 等 %d 个文件" % len(problems)
        raise ManifestError("程序文件校验失败：" + "；".join(problems[:3]) + more)
