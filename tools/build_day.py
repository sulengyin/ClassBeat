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
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
sys.path.insert(0, str(ROOT / "tools"))

import school_calendar as sc  # noqa: E402


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
        # 认 type 不认 seq：seq 是这所学校的编号习惯（9 是午餐、9b 是午间占位），
        # 别的学校节次多少、午餐排在第几段都不一样，拿编号当协议会静默串块。
        if b["type"] == "meal":
            end = lunch_end if noon.get("pre") else bell
            out.append({**b, "end": m2t(end)})
            continue

        if b["type"] == "noon":
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
                "seq": b.get("seq", "9b"),
                "start": m2t(bell),
                "end": m2t(noon_end),
                "type": "noon",
                "name": noon["title"],
                "tip": noon.get("tip", ""),
                "items": noon.get("items", []),
            })
            continue

        out.append(dict(b))

    # noonBand 会把 meal/noon 块的起止重写掉；老师配置里三个分界点若
    # 与块表错位（比如午间结束被拖到第一节课结束之后），重写出的午间
    # 就会盖住正课——屏面 12:52 还在「午间休息、剩 48 分」就是这种
    # （真机 2026-11-20）。输出后按开始时间排序，把前块的结束夹到
    # 后块的开始：宁可截短午间，也不能让正课被遮住。与前端引擎
    # （app/engine/schedule.js）逐字段一致。
    out.sort(key=lambda blk: t2m(blk["start"]))
    for i in range(len(out) - 1):
        # 倒挂块（开始晚于结束）本身是非法脏数据，编辑面板/导入都会拦；
        # 这里跳过它，别拿它的边界去截合法块。
        if t2m(out[i]["end"]) <= t2m(out[i]["start"]):
            continue
        if t2m(out[i + 1]["end"]) <= t2m(out[i + 1]["start"]):
            continue
        cur_end = t2m(out[i]["end"])
        next_start = t2m(out[i + 1]["start"])
        if cur_end > next_start:
            out[i] = {**out[i], "end": m2t(next_start)}

    return out


# ---------- 岗位 ----------

def name_of(v) -> str:
    """一个人名的各种历史写法：字符串、{name}、{label}、数组元素。
    取不出来就当空，绝不让 [object Object] 混进屏面。"""
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, dict):
        inner = v.get("name", v.get("label", v.get("student")))
        return name_of(inner)
    return ""


def name_list(v) -> list[str]:
    """名单统一成「去重、去空的姓名数组」。
    顺手按分隔符拆开：配置里常见 people: ["张三、李四"]，以前原样上屏
    碰巧没错，但按 id 核对时就对不上。人名里不会出现这些符号。"""
    if v is None:
        return []
    items = v if isinstance(v, list) else [v]
    out: list[str] = []
    for x in items:
        n = name_of(x)
        if not n or n == "[object Object]":
            continue
        for part in re.split(r"[、/／,，;；|｜]+", n):
            p = part.strip()
            if p and p != "[object Object]" and p not in out:
                out.append(p)
    return out


def resolve_people(role: dict, group: str | None, group_reason: str | None,
                   weekday: int) -> tuple[list[str] | None, str | None, str]:
    """返回 (名单, 无法确定的理由, 名单来源)。

    「这个岗位今天归谁」只有一个入口。旧写法是三段 if：有 groups 就只看组、
    有 rotation 就只看星期表，people 永远排在最后——老师亲手指定了人，
    只要配置里还留着轮换的元数据，屏上照样「待定」；rotation.status 没确认时，
    就算 peopleMap 里写了今天是谁也一律判成未知。现在按「越具体越优先」排：
    老师指定 > 轮换到的那组 > 按星期表；空数组算「没指定」，继续往下找。
    """
    cycle = role.get("cycle") or {}
    chosen = group or cycle.get("current")
    candidates = [
        ("people", role.get("people")),
        ("group", (role.get("groups") or {}).get(chosen) if chosen else None),
        ("weekday", (role.get("peopleMap") or {}).get(str(weekday))),
    ]

    for key, raw in candidates:
        names = name_list(raw)
        if names:
            return names, None, key

    # 一个都没排：原因要分得清，面板才能告诉老师下一步该点哪儿
    if "groups" in role:
        return None, group_reason or ("group-empty" if chosen else "cycle-group-unconfirmed"), "none"
    if "peopleMap" in role or "rotation" in role:
        return None, "weekday-not-mapped", "none"
    return None, "no-people", "none"


def role_triggers(role: dict, blocks: list[dict], noon: dict, weekday: int,
                  presents: dict | None = None) -> list[dict]:
    """求一个岗位当天在哪些时刻触发。"""
    freq = role["freq"]
    kind = freq["kind"]
    out: list[dict] = []

    # 时段常驻：被选进「晨间自主管理/课间/午间」任一时段后，触发完全
    # 由时段呈现决定（整段都挂），freq 不再另算。与前端引擎保持一致。
    if presents:
        mine = any(role["id"] in (presents.get(k) or [])
                   for k in ("reading", "break", "noon"))
        if mine:
            for b in blocks:
                if b["type"] not in ("reading", "break", "noon"):
                    continue
                if role["id"] not in (presents.get(b["type"]) or []):
                    continue
                out.append({"at": b["start"], "end": b["end"],
                            "block": b["seq"], "freqKind": "present"})
            return out

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
                 group: str | None, group_reason: str | None = None,
                 presents: dict | None = None) -> tuple[list[dict], list[dict], list[str]]:
    duties: list[dict] = []
    unset: list[str] = []
    unknown: list[dict] = []

    for role in roles["roles"]:
        # 时段常驻可以让 unset 的岗位也挂上屏：被选中的 unset 岗位不跳过
        is_present = presents and any(
            role["id"] in (presents.get(k) or [])
            for k in ("reading", "break", "noon"))
        if role["freq"]["kind"] == "unset" and not is_present:
            unset.append(role["id"])
            continue

        people, reason, people_from = resolve_people(role, group, group_reason, weekday)
        triggers = role_triggers(role, blocks, noon, weekday, presents)
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
                # 这次的人从哪儿来（people/group/weekday），面板据此解释「听谁的」
                "peopleFrom": people_from,
                "substitute": role.get("substitute", []),
                "status": "ok" if people is not None else "unknown",
                "reason": reason,
                "freqKind": t.get("freqKind") or role["freq"]["kind"],
                "order": role.get("order", 0),
                "grp": role.get("grp"),
                "assign": role.get("assign", "fixed"),
            })

    duties.sort(key=lambda d: (t2m(d["at"]), d["order"]))
    return duties, unknown, unset


# ---------- 主流程 ----------

def build(date: dt.date, group: str | None = None,
          parity_override: str | None = None, cal: dict | None = None) -> dict:
    timetable = load("timetable.json")
    schedule = load("schedule.json")
    content = load("content.json")
    roles = load("roles.json")
    noon_rule = load("noon.json")

    if cal is None:
        cal = sc.load(DATA)
    info = sc.resolve_day(cal, date)

    # 放假就不排课、不排值日。调休上课的周六用 asWeekday 指向那天的课表。
    if not info["inSchool"]:
        return {
            "date": date.isoformat(),
            "weekday": date.isoweekday(),
            "weekdayName": f"周{WEEKDAY_CN[date.isoweekday() - 1]}",
            "inSchool": False,
            "reason": info["reason"],
            "label": info["label"],
            "warnings": [],
        }

    weekday = info["asWeekday"] or date.isoweekday()
    week_no, parity = week_info(date, dt.date.fromisoformat(schedule["termStart"]))
    parity = parity_override or parity

    warnings: list[dict] = []

    group_reason = None
    if group is None:
        group, group_reason = sc.group_for(cal, roles.get("dutyCycle") or {}, date)

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

    duties, unknown, unset = build_duties(roles, blocks, noon, weekday, group, group_reason)

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
        "calendar": {
            "label": info["label"],
            "makeup": info["reason"] == "makeup",
        },
        "group": group,
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
