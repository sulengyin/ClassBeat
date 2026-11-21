#!/usr/bin/env python3
"""生成 tauri-plugin-updater 用的 latest.json（见 docs/05 §5.7）。

一个源一份文件：URL 是写死在 JSON 里的，所以"加速域名 + GitHub 双源"就是
同一份签名、两份 JSON（内容只差 url），分别传到两个地方。客户端的
`plugins.updater.endpoints` 按顺序试，谁先返回有效 JSON 就用谁。

用法：
    python desktop/scripts/make_latest.py \
        --bundle desktop/src-tauri/target/release/bundle/nsis \
        --version 0.4.0 \
        --base-url https://github.com/sulengyin/ClassBeat/releases/download/v0.4.0 \
        --notes "修了什么" \
        --out dist/github/latest.json

产物里只放**已签名**的安装包：找不到 .sig 就直接报错退出，
不让"没验签的包"混进更新源（那等于把签名校验关掉）。
"""

import argparse
import datetime as dt
import json
import pathlib
import sys

# 更新器只认这几种平台键；Windows x64 的键名是 windows-x86_64（x64 也写这个）。
PLATFORM = "windows-x86_64"


def pick_artifact(bundle_dir: pathlib.Path, version: str = "") -> pathlib.Path:
    """优先用 .nsis.zip（updater 首选），没有再退到 -setup.exe。

    目录里常常躺着好几个版本（本地联调过、回滚留底过），
    所以先按版本号过滤；过滤不到才退回"整目录挑一个"。
    """
    cands = sorted(bundle_dir.glob("*.nsis.zip")) + sorted(bundle_dir.glob("*-setup.exe"))
    if not cands:
        raise SystemExit(f"在 {bundle_dir} 下没找到 *.nsis.zip 或 *-setup.exe")
    if version:
        hit = [c for c in cands if f"_{version}_" in c.name]
        if hit:
            cands = hit
        else:
            raise SystemExit(
                f"{bundle_dir} 下没有版本 {version} 的安装包（现有：{', '.join(c.name for c in cands)}）"
            )
    return cands[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True, help="bundle/nsis 目录")
    ap.add_argument("--version", required=True, help="版本号，如 0.4.0")
    ap.add_argument("--base-url", required=True, help="安装包所在目录的 URL（末尾不带 /）")
    ap.add_argument("--notes", default="", help="更新说明，一行即可")
    ap.add_argument("--out", required=True, help="latest.json 输出路径")
    ap.add_argument("--pub-date", default="", help="可选，ISO8601；默认取当前 UTC")
    args = ap.parse_args()

    bundle = pathlib.Path(args.bundle)
    artifact = pick_artifact(bundle, args.version)
    sig_path = artifact.with_name(artifact.name + ".sig")
    if not sig_path.is_file():
        raise SystemExit(
            f"缺少签名文件 {sig_path.name}：请带 TAURI_SIGNING_PRIVATE_KEY 重新构建"
            "（bundle.createUpdaterArtifacts 必须为 true）。"
        )
    signature = sig_path.read_text(encoding="utf-8").strip()
    if not signature:
        raise SystemExit(f"{sig_path.name} 是空的")

    pub_date = args.pub_date or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    data = {
        "version": args.version,
        "notes": args.notes,
        "pub_date": pub_date,
        "platforms": {
            PLATFORM: {
                "signature": signature,
                "url": f"{args.base_url.rstrip('/')}/{artifact.name}",
            }
        },
    }

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"安装包  : {artifact.name}  ({artifact.stat().st_size / 1048576:.2f} MB)")
    print(f"签名文件: {sig_path.name}")
    print(f"写入    : {out}")
    print(f"指向    : {data['platforms'][PLATFORM]['url']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
