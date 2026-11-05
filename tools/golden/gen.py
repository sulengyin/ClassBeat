#!/usr/bin/env python3
"""生成前端引擎的对拍基准。

基准 = 现在这份 Python 编译器的输出。它不参与运行，只用来证明
engine/schedule.js 移植得逐字段一致。改了课程/岗位规则后，要重跑一次，
并在 PR 里说明「基准变了，因为规则本来就该变」。

用法：
    python3 tools/golden/gen.py            # 重新生成
    python3 tools/golden/gen.py --check    # 只校验现有基准是否与当前 Python 一致
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import build_day as bd  # noqa: E402

GOLDEN = Path(__file__).resolve().parent
VARIANTS = GOLDEN / "variants.json"

# 8/27 在起始周之前（测 before-anchor），8/31 开学，9/1 学期起点，
# 10/1–10/7 国庆整周放假，10/10 调休周六。到 10/31 为止共 66 天。
START = dt.date(2026, 8, 27)
END = dt.date(2026, 10, 31)


def dates() -> list[dt.date]:
    n = (END - START).days
    return [START + dt.timedelta(days=i) for i in range(n + 1)]


def apply_patch(data: dict, patch: dict) -> dict:
    out = dict(data)
    for key, value in (patch or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            merged = dict(out[key])
            merged.update(value)
            out[key] = merged
        else:
            out[key] = value
    return out


def build_variant(variant: dict) -> dict:
    """在临时目录里把 sample/ 改成本变体，再逐天编译。"""
    name = variant["name"]
    patch = variant.get("patch") or {}
    tmp = Path(tempfile.mkdtemp(prefix=f"golden-{name}-"))
    try:
        for f in (ROOT / "sample").glob("*.json"):
            shutil.copy(f, tmp / f.name)
        if "roles" in patch:
            roles = json.loads((tmp / "roles.json").read_text(encoding="utf-8"))
            roles.update(patch["roles"])
            (tmp / "roles.json").write_text(
                json.dumps(roles, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
        bd.set_data(tmp)
        days = {}
        for d in dates():
            days[d.isoformat()] = bd.build(d)
        return {"variant": name, "start": START.isoformat(), "end": END.isoformat(), "days": days}
    finally:
        bd.set_data(ROOT / "sample")
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只比对，不写文件")
    args = ap.parse_args()

    variants = json.loads(VARIANTS.read_text(encoding="utf-8"))["variants"]
    bad = 0
    for v in variants:
        payload = build_variant(v)
        path = GOLDEN / f"{v['name']}.json"
        text = json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
        if args.check:
            old = path.read_text(encoding="utf-8") if path.exists() else ""
            if old != text:
                print(f"✗ {path.name} 与当前 Python 输出不一致")
                bad += 1
            else:
                print(f"✓ {path.name}")
        else:
            path.write_text(text, encoding="utf-8")
            print(f"写入 {path.name}（{len(payload['days'])} 天，{len(text) / 1024:.0f} KB）")

    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
