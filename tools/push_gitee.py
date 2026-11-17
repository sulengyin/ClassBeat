#!/usr/bin/env python3
"""把发布包同步到 Gitee，做成国内可直连的更新源（2026-11-17 P2 9.5）。

为什么有这个脚本：程序内更新器要拉 update.json，老师环境直连 GitHub
不方便（2026-11-17 用户确认），所以更新源默认走 Gitee：

    https://gitee.com/<owner>/<repo>/raw/<branch>/update.json

它做的事：
  1. 在 Gitee 仓库按 tag 建 Release（已存在就复用）
  2. 把整包 zip（可选单文件版）作为附件传上去
  3. 用附件的真实下载地址生成 update.json（复用 make_update 的生成与校验）
  4. 把 update.json 提交回仓库默认分支 → 上面那个 raw 地址永远指向最新版

用法（CI 里已经接好，本地手动跑也行）：
    GITEE_REPO=sulengyin/ClassBeat GITEE_TOKEN=xxx \\
        python3 tools/push_gitee.py --zip dist/classbeat-0.3.4.zip --tag v0.3.4

token 是个人访问令牌（私人令牌，勾 projects 和 仓库读写即可），只从
--token 或环境变量 GITEE_TOKEN 取，绝不写进仓库或日志。

本地演练不真发布：--dry-run 只验证 token、仓库、tag 和清单，不传附件不提交。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "server"))

import make_update as mu  # noqa: E402  复用清单生成与校验
import update_manifest as um  # noqa: E402

API = "https://gitee.com/api/v5"


class GiteeError(RuntimeError):
    pass


def api(method, path, token, params=None, body=None, raw=None,
        content_type=None, timeout=60):
    """调一次 Gitee API v5。token 走查询串（Gitee 官方推荐的通用做法）。"""
    qs = []
    if params:
        qs += ["%s=%s" % (k, v) for k, v in params.items()]
    qs.append("access_token=" + token)
    url = "%s%s?%s" % (API, path, "&".join(qs))
    data = None
    headers = {"User-Agent": "classbeat-push-gitee"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif raw is not None:
        data = raw
        headers["Content-Type"] = content_type or "application/octet-stream"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise GiteeError("%s %s -> HTTP %d %s" % (method, path, e.code, detail)) from e


def default_branch(api_, repo, token):
    info = api("GET", "/repos/" + repo, token)
    br = (info or {}).get("default_branch") or "master"
    return br


def find_release(repo, token, tag):
    try:
        return api("GET", "/repos/%s/releases/tags/%s" % (repo, tag), token)
    except GiteeError as e:
        if "404" in str(e):
            return None
        raise


def create_release(repo, token, tag, name, body, branch):
    return api("POST", "/repos/%s/releases" % repo, token, body={
        "tag_name": tag,
        "name": name,
        "body": body,
        "target_commitish": branch,
    })


def upload_attachment(repo, token, release_id, path):
    """multipart 上传附件，返回附件信息。字段名必须是 file。"""
    path = Path(path)
    payload = path.read_bytes()
    boundary = "classbeat7f3d9b2c1e"
    parts = []
    parts.append(("--%s\r\nContent-Disposition: form-data; name=\"file\"; "
                  "filename=\"%s\"\r\nContent-Type: application/octet-stream"
                  "\r\n\r\n" % (boundary, path.name)).encode("utf-8"))
    parts.append(payload)
    parts.append(("\r\n--%s--\r\n" % boundary).encode("utf-8"))
    raw = b"".join(parts)
    return api("POST", "/repos/%s/releases/%s/attach_files" % (repo, release_id),
               token, raw=raw,
               content_type="multipart/form-data; boundary=" + boundary)


def attachment_url(att, repo, tag):
    """从附件信息里抠出可匿名下载的地址，按可靠程度依次试。"""
    cands = []
    for key in ("browser_download_url", "url", "html_url"):
        v = (att or {}).get(key)
        if isinstance(v, str) and v.startswith("http"):
            cands.append(v)
    att_id = (att or {}).get("id")
    if att_id:
        cands.append("https://gitee.com/%s/attach_files/%s/download" % (repo, att_id))
    name = (att or {}).get("name") or ""
    if name:
        cands.append("https://gitee.com/%s/releases/download/%s/%s" % (repo, tag, name))
    for url in cands:
        if url_reachable(url):
            return url
    raise GiteeError("附件传好了，但 %d 个候选下载地址都不可达：%s"
                     % (len(cands), cands))


def url_reachable(url):
    """带 Range 探一下；Gitee 匿名下载 302 到 CDN 也算可达。"""
    try:
        req = urllib.request.Request(url, method="GET",
                                     headers={"Range": "bytes=0-0",
                                              "User-Agent": "classbeat-push-gitee"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status in (200, 206)
    except Exception:
        return False


def commit_file(repo, token, branch, path, text, message):
    """contents API 提交/更新一个文件，返回 commit 地址片段。"""
    body = {
        "content": base64.b64encode(text.encode("utf-8")).decode("ascii"),
        "branch": branch,
        "message": message,
    }
    try:
        old = api("GET", "/repos/%s/contents/%s" % (repo, path), token,
                  params={"ref": branch})
        if isinstance(old, dict) and old.get("sha"):
            body["sha"] = old["sha"]
    except GiteeError as e:
        if "404" not in str(e):
            raise  # 文件不存在才是首次新建，别的错照常抛
    return api("PUT", "/repos/%s/contents/%s" % (repo, path), token, body=body)


def build_gitee_manifest(zip_path, zip_url, notes):
    """和 make_update 同一套口径，只是整包地址换成 Gitee 附件。"""
    manifest = mu.build_manifest(zip_path, url=zip_url, notes=notes)
    parsed = um.parse_manifest(json.dumps(manifest).encode("utf-8"))
    um.verify_package(zip_path, parsed)
    return manifest


def main():
    ap = argparse.ArgumentParser(description="把发布包同步到 Gitee 更新源")
    ap.add_argument("--repo", default=os.environ.get("GITEE_REPO", ""),
                    help="Gitee 仓库，owner/repo；缺省读 GITEE_REPO")
    ap.add_argument("--token", default=os.environ.get("GITEE_TOKEN", ""),
                    help="Gitee 个人访问令牌；缺省读 GITEE_TOKEN")
    ap.add_argument("--zip", help="整包 zip；默认取 dist 下唯一的 classbeat-*.zip")
    ap.add_argument("--tag", help="Release tag（如 v0.3.4）；默认从包内版本号拼")
    ap.add_argument("--single", action="store_true",
                    help="顺带上传同名单文件版（可选）")
    ap.add_argument("--notes", help="更新说明；不给就从 CHANGELOG 取")
    ap.add_argument("--dry-run", action="store_true",
                    help="只验证 token/仓库/tag 和清单，不传附件不提交")
    a = ap.parse_args()

    if not a.repo or not a.token:
        raise SystemExit("需要 --repo/--token 或环境变量 GITEE_REPO/GITEE_TOKEN")
    if "/" not in a.repo:
        raise SystemExit("--repo 要写成 owner/repo 的形式")

    dist = ROOT / "dist"
    zip_path = Path(a.zip) if a.zip else None
    if zip_path is None:
        found = sorted(dist.glob("classbeat-*.zip"))
        found = [p for p in found if "-single" not in p.name]
        if len(found) != 1:
            raise SystemExit("dist 下应正好有一个 classbeat-*.zip，实际 %d 个" % len(found))
        zip_path = found[0]
    if not zip_path.exists():
        raise SystemExit("找不到整包：%s" % zip_path)

    _, entries = mu.read_zip(zip_path)
    version, _ = mu.read_version(entries)
    tag = a.tag or ("v" + version)
    notes = a.notes
    if notes is None:
        notes = mu.changelog_notes(str(ROOT / "CHANGELOG.md"), version) or ""
    print("目标：gitee.com/%s  tag=%s  包=%s（%.1f MB）"
          % (a.repo, tag, zip_path.name, zip_path.stat().st_size / 1048576))

    branch = default_branch(None, a.repo, a.token)
    print("默认分支：%s" % branch)

    rel = find_release(a.repo, a.token, tag)
    if rel is None:
        if a.dry_run:
            print("[dry-run] 会新建 Release %s（说明 %d 字）" % (tag, len(notes)))
            rel = {"id": 0}
        else:
            rel = create_release(a.repo, a.token, tag, "ClassBeat " + tag,
                                 notes or ("ClassBeat " + tag), branch)
            print("已建 Release：%s（id=%s）" % (tag, rel.get("id")))
    else:
        print("Release 已存在（id=%s），直接补附件" % rel.get("id"))

    single_path = zip_path.with_name(zip_path.stem + "-single.html")
    uploads = [zip_path] + ([single_path] if a.single and single_path.exists() else [])

    zip_url = ""
    if not a.dry_run:
        existing = {(x or {}).get("name") for x in (rel.get("assets") or [])}
        for f in uploads:
            if f.name in existing:
                print("附件已存在，跳过：%s" % f.name)
                continue
            att = upload_attachment(a.repo, a.token, rel["id"], f)
            print("附件已传：%s" % f.name)
            if f == zip_path:
                zip_url = attachment_url(att, a.repo, tag)
                print("整包下载地址可达：%s" % zip_url)
        if not zip_url:
            # 附件早就传过（重跑）：按文件名从候选地址里找一个可达的
            zip_url = attachment_url({"name": zip_path.name}, a.repo, tag)
    else:
        print("[dry-run] 会上传附件：%s" % ", ".join(f.name for f in uploads))

    # dry-run 也把清单算出来验一遍，坏清单别等到线上才发现
    pretend_url = zip_url or ("https://gitee.com/%s/releases/download/%s/%s"
                              % (a.repo, tag, zip_path.name))
    manifest = build_gitee_manifest(zip_path, pretend_url, notes)
    print("update.json 校验通过：v%s · %s · %d 个程序文件"
          % (manifest["version"], manifest["build"], len(manifest["files"])))
    if a.dry_run:
        print("[dry-run] 会把 update.json 提交到 %s 分支，稳定源地址："
              "https://gitee.com/%s/raw/%s/update.json" % (branch, a.repo, branch))
        return

    text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    commit_file(a.repo, a.token, branch, "update.json", text,
                "update.json: %s（by push_gitee）" % tag)
    print("已提交 update.json 到 %s 分支" % branch)
    print("更新源（配进包根 update-source.txt 或 --update-url）：")
    print("  https://gitee.com/%s/raw/%s/update.json" % (a.repo, branch))


if __name__ == "__main__":
    main()
