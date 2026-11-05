#!/usr/bin/env python3
"""把未来若干天的编译结果打包成 app/data.js。

大屏在 file:// 下不能 fetch，所以数据必须内联成脚本。
一次打包覆盖 5 周，断网、跨天都不用管；过期了页面会提示重新打包。

    python3 tools/bundle.py                 # 从今天起 35 天
    python3 tools/bundle.py --days 60
    python3 tools/bundle.py --start 2026-11-09
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from build_day import build, set_data, DATA  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default=dt.date.today().isoformat())
    ap.add_argument("--days", type=int, default=35)
    ap.add_argument("--group", choices=["A", "B"], default=None)
    ap.add_argument("--data", help="数据目录，默认 data/，没有就用 sample/")
    args = ap.parse_args()

    data_dir = Path(args.data) if args.data else DATA
    if args.data:
        set_data(data_dir)
    if not (data_dir / "students.json").exists():
        sys.exit(f"数据目录里没有 students.json：{data_dir}")

    start = dt.date.fromisoformat(args.start)
    days: dict[str, dict] = {}
    for i in range(args.days):
        date = start + dt.timedelta(days=i)
        days[date.isoformat()] = build(date, args.group)

    # 编辑面板要用：名单（补全 / 换人人员池）与岗位表（换人时按岗位找）
    students = json.loads((data_dir / "students.json").read_text(encoding="utf-8"))
    roles = json.loads((data_dir / "roles.json").read_text(encoding="utf-8"))
    # 文字页要列出每科带什么，不能只列今天有课的科目
    content = json.loads((data_dir / "content.json").read_text(encoding="utf-8"))
    timetable = json.loads((data_dir / "timetable.json").read_text(encoding="utf-8"))
    schedule = json.loads((data_dir / "schedule.json").read_text(encoding="utf-8"))

    payload = {
        "generatedAt": dt.datetime.now().isoformat(timespec="seconds"),
        "start": start.isoformat(),
        "end": (start + dt.timedelta(days=args.days - 1)).isoformat(),
        "group": args.group,
        # 班级信息只从数据来，页面里不再写死「五（5）班」
        "meta": {
            "school": timetable.get("school") or students.get("school") or "",
            "klass": schedule.get("class") or students.get("class") or "",
            "headTeacher": schedule.get("headTeacher") or "",
        },
        "students": students["students"],
        "roles": roles["roles"],
        "content": content["subjects"],
        "days": days,
    }

    # 老师改好的文字可以烤成这个包的出厂默认：把导出的 texts
    # 存成 data/texts.json，重新打包即可。本机没改过就吃这份。
    baked = data_dir / "texts.json"
    if baked.exists():
        texts = json.loads(baked.read_text(encoding="utf-8"))
        if isinstance(texts, dict) and texts:
            payload["texts"] = texts
            print(f"已并入 {baked.relative_to(ROOT)}：{len(texts)} 组文字")

    app = ROOT / "app"
    app.mkdir(exist_ok=True)
    out = app / "data.js"
    with out.open("w", encoding="utf-8") as f:
        f.write("/* 由 tools/bundle.py 生成，不要手改 */\n")
        f.write("window.RHYTHM_DATA=")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    size = out.stat().st_size / 1024
    print(f"已生成 {out}：{len(days)} 天，{size:.0f} KB（{payload['start']} → {payload['end']}）")


if __name__ == "__main__":
    main()
