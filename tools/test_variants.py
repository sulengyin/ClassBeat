#!/usr/bin/env python3
"""换一所学校、换一套岗位、换一份校历，还排不排得出来？

公开仓库只有一所学校的样板（sample/），最容易被忽略的风险是：
**这份数据长什么样，代码就只认什么样。** 别人学校八点上课、一节课 35 分钟、
没有课后服务、值日按周几固定、国庆放整周——遇到任何一条，编译就崩或排错班。

这个测试不去猜「真实学校应该长什么样」，而是拿四套作息 × 五套岗位 × 四份校历
做笛卡尔积，逐套连续编译 35 天，检查跨学校通用的那几条不变量：

  1. 不崩：任何一套配置都能编译完，不抛异常
  2. 时间线不断：块按时间升序，首尾相接，不重叠
  3. 不编人名：说不清的岗位输出 unknown + 理由，不说的人名一个都不出现
  4. 用到的人名必须在名单里（换班最容易踩的坑：岗位表改了、名单没改）
  5. 值日时刻落在到校与离校之间（换作息最容易踩的坑：17:10 还在屏上）
  6. 校历说的放假必须真的不排课，调休周六必须真的排课
  7. 规模不爆：一学年 200 天编译得完，单日 JSON 不超过 200 KB

跑法：
    python3 tools/test_variants.py
    python3 tools/test_variants.py --days 60 --verbose
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import build_day as B  # noqa: E402

SAMPLE = ROOT / "sample"
SUBJECTS = ["语文", "数学", "英语", "科学", "体育", "音乐", "美术", "道德与法治"]


# ---------------------------------------------------------------- 作息生成

def t2m(text: str) -> int:
    h, m = text.split(":")
    return int(h) * 60 + int(m)


def m2t(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


# 作息用「一段一段」描述：类型:名字:分钟。生成器只认这几种类型，
# 因为 build_day 只认这几种（class / ritual / break / meal / noon / after）。
SCHOOLS = {
    "标准40分": {
        "start": "08:20", "period": 40,
        "plan": [
            "class", "ritual:大课间:30", "class", "ritual:眼保健操:5", "break:10",
            "class", "break:10", "class", "meal:30", "noon:40", "break:10",
            "class", "ritual:眼保健操:5", "break:10", "class", "ritual:大课间:30",
            "class", "break:10", "after:课后服务 · 第一时段:40", "break:10",
            "after:课后服务 · 第二时段:40",
        ],
    },
    "早八45分": {
        "start": "08:00", "period": 45,
        "plan": [
            "class", "ritual:大课间:25", "class", "break:10", "class", "break:10",
            "class", "meal:35", "noon:30", "break:10", "class", "ritual:眼保健操:5",
            "break:10", "class", "break:10", "class",
        ],
    },
    "八点半35分": {
        "start": "08:30", "period": 35,
        "plan": [
            "class", "break:10", "class", "break:10", "class", "ritual:大课间:20",
            "class", "meal:30", "noon:45", "break:10", "class", "break:10", "class",
            "after:课后服务:40",
        ],
    },
    "短课间": {
        "start": "08:10", "period": 40,
        "plan": [
            "class", "break:5", "class", "ritual:眼保健操:5", "class", "break:5",
            "class", "meal:25", "noon:50", "break:5", "class", "break:5", "class",
            "break:5", "class", "after:课后服务:60",
        ],
    },
}

TOKEN = {"class": "class", "ritual": "ritual", "break": "break",
         "meal": "meal", "noon": "noon", "after": "after"}


def make_timetable(school: dict) -> dict:
    t = t2m(school["start"])
    blocks: list[dict] = []
    seq = 0
    period = 0
    noon_band = {"lunchEnd": "", "bell": "", "noonEnd": ""}

    def next_seq() -> int:
        nonlocal seq
        seq += 1
        if seq == 9:      # 9 留给午餐，跟真实表保持一致
            seq = 10
        return seq

    for token in school["plan"]:
        parts = token.split(":")
        kind = TOKEN[parts[0]]
        name = parts[1] if len(parts) > 2 else None
        dur = school["period"] if len(parts) == 1 else int(parts[-1])
        start, end = t, t + dur
        if kind == "class":
            period += 1
            blocks.append({"seq": next_seq(), "start": m2t(start), "end": m2t(end),
                           "type": "class", "periodNo": period})
        elif kind == "meal":
            seq = 9
            blocks.append({"seq": 9, "start": m2t(start), "end": m2t(end),
                           "type": "meal", "name": "午餐"})
            noon_band["lunchEnd"] = m2t(end)
        elif kind == "noon":
            blocks.append({"seq": "9b", "start": m2t(start), "end": m2t(end),
                           "type": "noon", "name": "午间"})
            noon_band["bell"] = m2t(start)
            noon_band["noonEnd"] = m2t(end)
        else:
            blocks.append({"seq": next_seq(), "start": m2t(start), "end": m2t(end),
                           "type": kind, "name": name})
        t = end

    return {
        "id": "tt-variant", "school": "示例小学", "name": "变体作息",
        "effectiveFrom": "2026-09-01", "status": "CONFIRMED",
        "noonBand": noon_band,
        "blocks": blocks,
        "marks": [
            {"at": m2t(t2m(school["start"]) - 40), "kind": "arrive", "status": "ASSUMED"},
            {"at": m2t(t - 10), "kind": "dismiss", "status": "CONFIRMED"},
        ],
    }


def make_schedule(timetable: dict, weekday_count: int = 5) -> dict:
    entries = []
    periods = sorted({b["periodNo"] for b in timetable["blocks"] if b["type"] == "class"})
    for wd in range(1, weekday_count + 1):
        for i, p in enumerate(periods):
            entries.append({
                "weekday": wd, "periodNo": p,
                "subject": SUBJECTS[(wd + i) % len(SUBJECTS)],
                "teacher": "张老师",
            })
    return {
        "id": "sch-variant", "school": "示例小学", "class": "五（1）班",
        "headTeacher": "张老师", "effectiveFrom": "2026-09-01",
        "termStart": "2026-09-01", "status": "CONFIRMED", "entries": entries,
    }


# ---------------------------------------------------------------- 岗位变体

def roles_fixed(base: dict) -> dict:
    r = copy.deepcopy(base)
    for role in r["roles"]:
        role.pop("groups", None)
        role.pop("rotation", None)
        role.pop("peopleMap", None)
        if not role.get("people"):
            role["people"] = ["赵子墨"]
    return r


def roles_none(base: dict) -> dict:
    return {"id": "roles-empty", "roles": [], "dutyCycle": {"status": "unconfirmed"}}


def roles_cycle(base: dict, week_start_group: str = "A") -> dict:
    """只留 A/B 轮换，并把起始组确认掉。"""
    r = copy.deepcopy(base)
    for role in r["roles"]:
        if "groups" not in role:
            role["freq"] = {"kind": "unset", "reason": "本变体只测轮换"}
    r["dutyCycle"] = {
        "kind": "school-week", "groups": ["A", "B"],
        "anchor": "2026-08-31", "anchorGroup": week_start_group, "status": "confirmed",
    }
    return r


def roles_weekday(base: dict) -> dict:
    """周几映射，故意只给周一到周五（调休周六必然说不清）。"""
    r = copy.deepcopy(base)
    for role in r["roles"]:
        role["freq"] = {"kind": "daily", "times": ["08:10"]}
        role["rotation"] = {"kind": "weekday-map", "status": "confirmed"}
        role["peopleMap"] = {str(i): f"学生{i}号" for i in range(1, 6)}
    return r


ROLE_SETS = {
    "原样": lambda base: copy.deepcopy(base),
    "全固定": roles_fixed,
    "无岗位": roles_none,
    "只有轮换": roles_cycle,
    "周几映射": roles_weekday,
}


# ---------------------------------------------------------------- 校历变体

CALENDARS = {
    "无校历": None,
    "国庆整周": {
        "version": "school-calendar/v1",
        "days": {**{f"2026-10-0{i}": {"kind": "holiday", "name": "国庆节"} for i in (1, 2, 5, 6, 7, 8, 9)}},
    },
    "调休周六": {
        "version": "school-calendar/v1",
        "days": {"2026-10-10": {"kind": "school", "name": "调休上课", "asWeekday": 5}},
    },
    "整周停课": {
        "version": "school-calendar/v1",
        "days": {**{f"2026-11-0{i}": {"kind": "holiday", "name": "停课周"} for i in (2, 3, 4, 5, 6)}},
    },
}


# ---------------------------------------------------------------- 断言

class Fail(Exception):
    pass


def check_day(day: dict, names: set[str], cal: dict | None, label: str) -> None:
    if not day.get("inSchool"):
        if day.get("reason") not in ("weekend", "holiday"):
            raise Fail(f"{label}: 不上学但理由不认识 {day.get('reason')}")
        return

    blocks = [b for b in day["timeline"]]
    if not blocks:
        raise Fail(f"{label}: 上学日却没有时间线")

    # 2. 时间线连续、不重叠
    for a, b in zip(blocks, blocks[1:]):
        if t2m(b["start"]) < t2m(a["end"]):
            raise Fail(f"{label}: {a['seq']} 与 {b['seq']} 时间重叠")
        if t2m(b["start"]) != t2m(a["end"]):
            raise Fail(f"{label}: {a['seq']} 结束后到 {b['seq']} 之间有空档")
        if t2m(b["start"]) <= t2m(a["start"]):
            raise Fail(f"{label}: {b['seq']} 没有排在 {a['seq']} 之后")

    # 3. 课必须有科目，或者明确说不知道
    for b in blocks:
        if b["type"] == "class":
            if b.get("subject") is None and b.get("status") != "unknown":
                raise Fail(f"{label}: 第 {b['periodNo']} 节没课也没标 unknown")

    arrival = t2m(day.get("marks", [{}])[0]["at"]) if day.get("marks") else 0
    dismiss = t2m(blocks[-1]["end"])

    seen: set[tuple] = set()
    for d in day["duties"]:
        key = (d["roleId"], d["at"])
        if key in seen:
            raise Fail(f"{label}: {d['name']} 在 {d['at']} 重复触发")
        seen.add(key)

        # 3/4. 人名要么在名单里，要么 unknown
        if d["people"] is None:
            if d["status"] != "unknown" or not d.get("reason"):
                raise Fail(f"{label}: {d['name']} 没给名单，也没说明理由")
        else:
            missing = [p for p in d["people"] if p not in names]
            if missing:
                raise Fail(f"{label}: {d['name']} 用到名单外的人 {missing}")
            if d["status"] != "ok":
                raise Fail(f"{label}: {d['name']} 有人却标 {d['status']}")

        # 5. 时刻落在到校与离校之间
        at = t2m(d["at"])
        if not (arrival <= at <= dismiss):
            raise Fail(f"{label}: {d['name']} 在 {d['at']} 触发，不在 {m2t(arrival)}–{m2t(dismiss)} 之间")

    # 6. 调休上课的周六，要按下发指定的那一天排
    if day.get("calendar", {}).get("makeup"):
        want = ((cal or {}).get("days", {}).get(day["date"]) or {}).get("asWeekday")
        if want and day["weekday"] != want:
            raise Fail(f"{label}: 调休日应按周{want}排，实际排成周{day['weekday']}")

    size = len(json.dumps(day, ensure_ascii=False).encode())
    if size > 200_000:
        raise Fail(f"{label}: 单日 JSON {size // 1024} KB，超过 200 KB")


# ---------------------------------------------------------------- 主流程

def build_variant(root: Path, school: str, roles_name: str, cal_name: str) -> tuple[Path, set[str], dict]:
    d = root / f"{school}-{roles_name}-{cal_name}"
    d.mkdir(parents=True, exist_ok=True)
    for f in ("students.json", "content.json", "noon.json", "texts.json"):
        if (SAMPLE / f).exists():
            shutil.copy(SAMPLE / f, d / f)

    tt = make_timetable(SCHOOLS[school])
    (d / "timetable.json").write_text(json.dumps(tt, ensure_ascii=False), encoding="utf-8")
    (d / "schedule.json").write_text(json.dumps(make_schedule(tt), ensure_ascii=False), encoding="utf-8")

    base_roles = json.loads((SAMPLE / "roles.json").read_text(encoding="utf-8"))
    roles = ROLE_SETS[roles_name](base_roles)
    # 换作息后，岗位时刻要跟着整体平移——这正是老师换到另一所学校时要做的第一件事。
    # 放学那几个时刻（17:10）另算：跟着新学校的离校时间走。
    shift = t2m(SCHOOLS[school]["start"]) - t2m("08:20")
    dismiss = t2m(tt["marks"][1]["at"])
    for role in roles.get("roles", []):
        times = role.get("freq", {}).get("times") or []
        role["freq"]["times"] = [
            m2t(dismiss - 10) if t == "17:10" else m2t(t2m(t) + shift) for t in times
        ]
    (d / "roles.json").write_text(json.dumps(roles, ensure_ascii=False), encoding="utf-8")

    cal = CALENDARS[cal_name]
    if cal:
        (d / "calendar.json").write_text(json.dumps(cal, ensure_ascii=False), encoding="utf-8")

    names = {s["name"] for s in json.loads((SAMPLE / "students.json").read_text(encoding="utf-8"))["students"]}
    names |= {"学生1号", "学生2号", "学生3号", "学生4号", "学生5号", "赵子墨"}
    return d, names, tt


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=70, help="覆盖国庆与 11 月停课两周")
    ap.add_argument("--start", default="2026-09-01")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    start = dt.date.fromisoformat(args.start)
    root = Path(tempfile.mkdtemp(prefix="classbeat-variants-"))
    rows = []
    failures = []
    total = 0

    combos = [(s, r, c) for s in SCHOOLS for r in ROLE_SETS for c in CALENDARS]
    print(f"{len(SCHOOLS)} 套作息 × {len(ROLE_SETS)} 套岗位 × {len(CALENDARS)} 份校历"
          f" = {len(combos)} 套配置，每套 {args.days} 天\n")

    try:
        for school, roles_name, cal_name in combos:
            label = f"{school}/{roles_name}/{cal_name}"
            try:
                data_dir, names, tt = build_variant(root, school, roles_name, cal_name)
                B.set_data(data_dir)
                days = 0
                school_days = 0
                t0 = time.perf_counter()
                for i in range(args.days):
                    date = start + dt.timedelta(days=i)
                    day = B.build(date)
                    check_day(day, names, CALENDARS[cal_name], f"{label} {date}")
                    days += 1
                    school_days += 1 if day.get("inSchool") else 0
                ms = (time.perf_counter() - t0) * 1000
                rows.append((label, days, school_days, ms))
                if args.verbose:
                    print(f"  ✓ {label}  {school_days}/{days} 上学日  {ms:.0f} ms")
                total += days
            except Fail as e:
                failures.append(str(e))
                print(f"  ✗ {label}: {e}")
            except Exception:
                failures.append(f"{label}\n{traceback.format_exc()}")
                print(f"  ✗ {label}: 抛异常")
                traceback.print_exc()

        print(f"{'配置':<28}{'天数':>6}{'上学日':>7}{'耗时':>9}")
        for label, days, sd, ms in rows:
            print(f"{label:<28}{days:>6}{sd:>7}{ms:>8.0f} ms")

        # 7. 一学年的规模
        B.set_data(root / "标准40分-原样-无校历")
        t0 = time.perf_counter()
        for i in range(200):
            B.build(start + dt.timedelta(days=i))
        year_ms = (time.perf_counter() - t0) * 1000
        print(f"\n一学年 200 天编译：{year_ms:.0f} ms")
        if year_ms > 10000:
            failures.append(f"200 天编译 {year_ms:.0f} ms，太慢")

    finally:
        shutil.rmtree(root, ignore_errors=True)

    print(f"\n共编译 {total} 个太阳日，{len(rows)}/{len(combos)} 套配置通过")
    if failures:
        print(f"\n{len(failures)} 项失败：")
        for f in failures:
            print("  · " + f.replace("\n", "\n    "))
        sys.exit(1)


if __name__ == "__main__":
    main()
