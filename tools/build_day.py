#!/usr/bin/env python3
"""把「作息 + 课表 + 岗位 + 名单」编译成某一天的时间线。

用法：
    python3 tools/build_day.py 2026-11-05
    python3 tools/build_day.py 2026-11-06 --group A --week even
    python3 tools/build_day.py 2026-11-07          # 周六 → 非在校日

输出：out/day-YYYY-MM-DD.json

设计约束（见 PLAN.md）：
  · 课表不含时间，时间只来自作息
  · 午间是槽位，不是常量；大扫除是午餐与午间之间插入的动作
  · 表上没写的东西输出 unknown / unset，不猜
  · 轮换规则未确认时不编一个人名
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"


def _default_data() -> Path:
    """公开仓库里没有 data/（真实班级数据不入库），所以退到 sample/。"""
    env = os.environ.get("CLASSBEAT_DATA")
    if env:
        return Path(env)
    real = ROOT / "data"
    return real if (real / "students.json").exists() else ROOT / "sample"


DATA = _default_data()


def set_data(path: str | Path) -> None:
    global DATA
    DATA = Path(path)

WEEKDAY_CN = "一二三四五六日"
DUTY_WINDOW = 16  # 触发后显示 16 分钟，过点不追


# ---------- 基础工具 ----------

def load(name: str) -> dict:
    path = DATA / name
    if not path.exists():
        sys.exit(f"缺少数据文件：{path}")
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def t2m(text: str) -> int:
    h, m = text.split(":")
    return int(h) * 60 + int(m)


def m2t(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def overlaps(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return a_start < b_end and b_start < a_end


# ---------- 周次 ----------

def week_info(date: dt.date, term_start: dt.date) -> tuple[int, str]:
    """返回 (第几周, odd|even)。

    term_start 所在周的周一算第 1 周。哪一周算「双周」尚未与老师确认，
    这里用最朴素的奇偶，调用方可用 --week 覆盖。
    """
    monday = term_start - dt.timedelta(days=term_start.weekday())
    week_no = (date - monday).days // 7 + 1
    return week_no, ("odd" if week_no % 2 else "even")


# ---------- 课表 ----------

def lesson_at(schedule: dict, weekday: int, period_no: int, parity: str) -> dict | None:
    """按条目级 weekRule 取当天该节的课；没有 weekRule 的直接命中。"""
    hits = [
        e for e in schedule["entries"]
        if e["weekday"] == weekday and e["periodNo"] == period_no
        and e.get("weekRule", parity) == parity
    ]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:  # 数据写错时宁可报错，也不随便挑一条
        raise ValueError(f"周{weekday}第{period_no}节匹配到多条：{hits}")
    return None


def content_for(content: dict, subject: str | None) -> dict | None:
    if not subject:
        return None
    for s in content["subjects"]:
        if subject in s["labels"]:
            return {
                "key": s["key"],
                "level": s["level"],
                "items": s["items"],
                "place": s.get("place"),
            }
    return None


# ---------- 午间 ----------

def resolve_noon(noon_rule: dict, weekday: int, override: dict | None) -> dict:
    """四级优先级的最后一层在 P1 不实现；这里只做 WeekRule > Default。"""
    preset_key = (override or {}).get("preset") or noon_rule["weekRule"].get(str(weekday)) \
        or noon_rule["defaultPreset"]
    preset = noon_rule["presets"][preset_key]
    return {"preset": preset_key, **preset, "source": "week-rule"}


def build_day_blocks(timetable: dict, noon: dict) -> list[dict]:
    """把 noon 槽位展开成实际块；大扫除日在午餐与午间之间插入 pre 动作。"""
    band = timetable["noonBand"]
    lunch_end = t2m(band["lunchEnd"])
    bell = t2m(band["bell"])
    noon_end = t2m(band["noonEnd"])

    out: list[dict] = []
    for b in timetable["blocks"]:
        seq = b["seq"]

        if seq == 9:  # 午餐：有前置动作时被压缩到 lunchEnd
            end = lunch_end if noon.get("pre") else bell
            out.append({**b, "end": m2t(end)})
            continue

        if seq == "9b":  # 午间占位：整段重排
            if noon.get("pre") and lunch_end < bell:
                out.append({
                    "seq": "9a",
                    "start": m2t(lunch_end),
                    "end": m2t(bell),
                    "type": "action",
                    "name": noon["pre"]["title"],
                    "tip": noon["pre"].get("tip", ""),
                    "items": noon["pre"].get("items", []),
                })
            out.append({
                "seq": "9b",
                "start": m2t(bell),
                "end": m2t(noon_end),
                "type": "noon",
                "name": noon["title"],
                "tip": noon.get("tip", ""),
                "items": noon.get("items", []),
            })
            continue

        out.append(b)

    return out


# ---------- 岗位 ----------

def resolve_people(role: dict, group: str | None,
                   weekday: int) -> tuple[list[str] | None, str | None]:
    """返回 (名单, 无法确定的理由)。宁可 unknown，也不编人名。"""
    if "groups" in role:
        cyc = role.get("cycle", {})
        if cyc.get("status") != "confirmed" and group is None:
            return None, "cycle-group-unconfirmed"
        chosen = group or cyc.get("current")
        if not chosen:
            return None, "cycle-group-unconfirmed"
        return role["groups"].get(chosen, []), None

    rot = role.get("rotation")
    if rot:
        if rot.get("status") != "confirmed":
            return None, "rotation-unconfirmed"
        if rot.get("kind") == "weekday-map":
            person = role.get("peopleMap", {}).get(str(weekday))
            if not person:
                return None, "weekday-not-mapped"
            return [person], None

    return role.get("people", []), None


def role_triggers(role: dict, blocks: list[dict], noon: dict, weekday: int) -> list[dict]:
    """求一个岗位当天在哪些时刻触发。"""
    freq = role["freq"]
    kind = freq["kind"]
    out: list[dict] = []

    if kind == "unset":
        return out

    if kind == "each":
        # 只挂在课间；上课、眼保健操、午间、课后服务都不挂
        for b in blocks:
            if b["type"] == "break":
                out.append({"at": b["start"], "end": b["end"], "block": b["seq"]})
        return out

    if kind == "task":
        # 挂在宿主动作上：只有大扫除日才有这个块
        if noon.get("pre") and noon["pre"]["title"] == freq.get("task"):
            for b in blocks:
                if b["type"] == "action" and b["name"] == freq["task"]:
                    out.append({"at": b["start"], "end": b["end"], "block": b["seq"]})
        return out

    if kind == "weekly":
        if weekday not in freq.get("weekdays", []):
            return out

    for t in freq.get("times", []):
        start = t2m(t)
        out.append({"at": t, "end": m2t(start + DUTY_WINDOW), "block": None})

    return out


def build_duties(roles: dict, blocks: list[dict], noon: dict, weekday: int,
                 group: str | None) -> tuple[list[dict], list[dict], list[str]]:
    duties: list[dict] = []
    unset: list[str] = []
    unknown: list[dict] = []

    for role in roles["roles"]:
        if role["freq"]["kind"] == "unset":
            unset.append(role["id"])
            continue

        people, reason = resolve_people(role, group, weekday)
        triggers = role_triggers(role, blocks, noon, weekday)
        if not triggers:
            continue

        if people is None:
            unknown.append({
                "roleId": role["id"],
                "name": role["name"],
                "reason": reason,
            })

        for t in triggers:
            duties.append({
                "roleId": role["id"],
                "name": role["name"],
                "at": t["at"],
                "end": t["end"],
                "block": t["block"],
                "people": people,
                "substitute": role.get("substitute", []),
                "status": "ok" if people is not None else "unknown",
                "reason": reason,
                "freqKind": role["freq"]["kind"],
                "order": role.get("order", 0),
                "grp": role.get("grp"),
                "assign": role.get("assign", "fixed"),
            })

    duties.sort(key=lambda d: (t2m(d["at"]), d["order"]))
    return duties, unknown, unset


# ---------- 主流程 ----------

def build(date: dt.date, group: str | None = None,
          parity_override: str | None = None) -> dict:
    timetable = load("timetable.json")
    schedule = load("schedule.json")
    content = load("content.json")
    roles = load("roles.json")
    noon_rule = load("noon.json")

    weekday = date.isoweekday()
    week_no, parity = week_info(date, dt.date.fromisoformat(schedule["termStart"]))
    parity = parity_override or parity

    warnings: list[dict] = []

    if weekday > 5:
        return {
            "date": date.isoformat(),
            "weekday": weekday,
            "inSchool": False,
            "reason": "weekend",
            "warnings": [],
        }

    noon = resolve_noon(noon_rule, weekday, None)
    blocks = build_day_blocks(timetable, noon)

    # 时间线补上课表与准备清单
    timeline: list[dict] = []
    for b in blocks:
        item = {k: b[k] for k in ("seq", "start", "end", "type") if k in b}
        item.update({k: v for k, v in b.items() if k in ("name", "tip", "items", "periodNo")})

        if b["type"] == "class":
            lesson = lesson_at(schedule, weekday, b["periodNo"], parity)
            if lesson is None:
                item["subject"] = None
                item["teacher"] = None
                item["status"] = "unknown"
                warnings.append({
                    "code": "LESSON_MISSING",
                    "message": f"周{weekday}第{b['periodNo']}节在课表里找不到",
                })
            else:
                item["subject"] = lesson["subject"]
                item["teacher"] = lesson["teacher"]
                item["place"] = lesson.get("place")
                item["prep"] = content_for(content, lesson["subject"])
                item["weekRule"] = lesson.get("weekRule")

        timeline.append(item)

    duties, unknown, unset = build_duties(roles, blocks, noon, weekday, group)

    # 已知的悬而未决，统一挂到 warnings，别让 UI 自己判断
    for mark in timetable.get("marks", []):
        if mark.get("status") in ("CONFLICT", "ASSUMED"):
            warnings.append({
                "code": f"MARK_{mark['status']}",
                "message": f"{mark['at']} {mark['kind']}：{mark.get('note', '')}",
            })

    if unknown:
        warnings.append({
            "code": "DUTY_PEOPLE_UNKNOWN",
            "message": "以下岗位成员无法确定，未编造人名",
            "roles": unknown,
        })

    assumed = [
        r["id"] for r in roles["roles"]
        if r["freq"].get("timesStatus") == "ASSUMED"
    ]
    if assumed:
        warnings.append({
            "code": "DUTY_TIME_ASSUMED",
            "message": "以下岗位的触发时刻是按常理排的，需老师核对",
            "roles": assumed,
        })

    return {
        "date": date.isoformat(),
        "weekday": weekday,
        "weekdayName": f"周{WEEKDAY_CN[weekday - 1]}",
        "weekNo": week_no,
        "weekRule": parity,
        "inSchool": True,
        "class": schedule["class"],
        "noon": {
            "preset": noon["preset"],
            "label": noon["label"],
            "title": noon["title"],
            "tip": noon.get("tip", ""),
            "items": noon.get("items", []),
            "pre": noon.get("pre"),
            "band": timetable["noonBand"],
        },
        "timeline": timeline,
        "duties": duties,
        "marks": [m for m in timetable.get("marks", [])
                  if m.get("kind") in ("arrive", "dismiss")],
        "unknown": unknown,
        "unset": unset,
        "warnings": warnings,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="把一天编译成时间线 JSON")
    ap.add_argument("date", help="YYYY-MM-DD")
    ap.add_argument("--group", choices=["A", "B"], help="A/B 组；不传则视轮换规则为未确认")
    ap.add_argument("--week", choices=["odd", "even"], help="覆盖周次推断")
    ap.add_argument("--stdout", action="store_true", help="只打印，不写文件")
    ap.add_argument("--data", help="数据目录，默认 data/，没有就用 sample/")
    args = ap.parse_args()

    if args.data:
        set_data(ROOT / args.data if not Path(args.data).is_absolute() else args.data)

    try:
        date = dt.date.fromisoformat(args.date)
    except ValueError:
        sys.exit(f"日期格式应为 YYYY-MM-DD：{args.date}")

    day = build(date, args.group, args.week)

    if args.stdout:
        print(json.dumps(day, ensure_ascii=False, indent=2))
        return

    OUT.mkdir(exist_ok=True)
    path = OUT / f"day-{date.isoformat()}.json"
    with path.open("w", encoding="utf-8") as f:
        json.dump(day, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"已生成 {path}")


if __name__ == "__main__":
    main()
