#!/usr/bin/env python3
"""把班级配置打包成 app/data.js。

大屏在 file:// 下不能 fetch，所以配置必须内联成脚本。

只装「配置」，不装任何一天的结果：当天的课表由 app/engine/schedule.js
在浏览器里现算。所以改一条作息不用重新打包、不用等下一次构建，
重开页面就是新时间——这也是阶段 1 的验收条件。

    python3 tools/bundle.py                 # 用 data/，没有就用 sample/
    python3 tools/bundle.py --data sample
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from build_day import DATA, set_data  # noqa: E402


def read(data_dir: Path, name: str, default=None):
    p = data_dir / name
    if not p.exists():
        if default is not None:
            return default
        sys.exit(f"缺少 {p}")
    return json.loads(p.read_text(encoding="utf-8"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", help="数据目录，默认 data/，没有就用 sample/")
    args = ap.parse_args()

    data_dir = Path(args.data) if args.data else DATA
    if args.data:
        set_data(data_dir)
    if not (data_dir / "students.json").exists():
        sys.exit(f"数据目录里没有 students.json：{data_dir}")

    students = read(data_dir, "students.json")
    roles = read(data_dir, "roles.json")
    content = read(data_dir, "content.json")
    timetable = read(data_dir, "timetable.json")
    schedule = read(data_dir, "schedule.json")
    noon = read(data_dir, "noon.json")
    # 校历是可选的：没有就当成「周一到周五都上学、不放假」
    calendar = read(data_dir, "calendar.json", default={"days": {}})

    payload = {
        "version": 2,
        "generatedAt": dt.datetime.now().isoformat(timespec="seconds"),
        # 班级信息只从数据来，页面里不写死任何一个具体班名
        "meta": {
            "school": timetable.get("school") or students.get("school") or "",
            "klass": schedule.get("class") or students.get("class") or "",
            "headTeacher": schedule.get("headTeacher") or "",
        },
        "students": students["students"],
        # 整个 roles.json：岗位表 + dutyCycle（轮换锚点）都在里面
        "roles": roles,
        # 编辑页按科目列准备清单，所以这里给数组
        "content": content["subjects"],
        "timetable": timetable,
        "schedule": schedule,
        "noon": noon,
        "calendar": calendar,
    }

    # 老师改好的文字可以烤成这个包的出厂默认：把导出的 texts
    # 存成 data/texts.json，重新打包即可。本机没改过就吃这份。
    baked = data_dir / "texts.json"
    if baked.exists():
        texts = json.loads(baked.read_text(encoding="utf-8"))
        if isinstance(texts, dict) and texts:
            payload["texts"] = texts
            print(f"已并入 {baked.relative_to(ROOT)}：{len(texts)} 组文字")

    out = ROOT / "app" / "data.js"
    with out.open("w", encoding="utf-8") as f:
        f.write("/* 由 tools/bundle.py 生成，不要手改 */\n")
        f.write("window.RHYTHM_DATA=")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    size = out.stat().st_size / 1024
    print(f"已生成 {out}：配置包 {size:.0f} KB（不含任何一天，运行时现算）")


if __name__ == "__main__":
    main()
