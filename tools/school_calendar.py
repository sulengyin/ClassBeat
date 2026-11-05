#!/usr/bin/env python3
"""校历：哪些天算上学日，以及 A/B 值日组轮到谁。

为什么单独一个模块：这是全班唯一一处"日期 → 结论"的换算，课表、作息、
岗位都依赖它。放在 build_day.py 里，前端移植时又要抄一遍，抄错没人发现。

三条约定（都不是猜的，是老师给的规则）：

1. **默认周一到周五上学，周六周日放假。** calendar.json 只写例外。
2. **一周只要有半天上课，这一周就算一周。** 周一放假、周二到周五照常，
   值日照样在这一周里做完，下周一换组。
3. **整周放假不消耗轮次。** 国庆整周不上学，下一周还是原来那组——
   没人值日的一周不该算作一次轮换。

由此推出：**轮次按"上学的周"数，不按日历周数**。所以国庆、清明、
台风停课都不会把 A/B 组错开，这是这套算法唯一想要的性质。
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

WEEKDAY_CN = "一二三四五六日"


def load(data_dir: Path) -> dict:
    """calendar.json 可以不存在：没有校历就按纯周一到周五。"""
    path = Path(data_dir) / "calendar.json"
    if not path.exists():
        return {"days": {}}
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _entry(cal: dict, date: dt.date) -> dict | None:
    days = cal.get("days") or {}
    e = days.get(date.isoformat())
    return e if isinstance(e, dict) else None


def _default_kind(date: dt.date) -> str:
    return "school" if date.isoweekday() <= 5 else "holiday"


def resolve_day(cal: dict, date: dt.date) -> dict:
    """当天上不上学。

    返回 {inSchool, reason, label, asWeekday}：
      reason    weekend | holiday | school，供 warning 与调试用
      label     「国庆节」这类说法，没有就是 None
      asWeekday 调休上课的周六按周几的课表上（1–7），没有就是 None
    """
    e = _entry(cal, date)
    kind = (e or {}).get("kind") or _default_kind(date)
    if kind == "school":
        return {
            "inSchool": True,
            "reason": "school" if _default_kind(date) == "school" else "makeup",
            "label": (e or {}).get("name"),
            "asWeekday": (e or {}).get("asWeekday"),
        }
    return {
        "inSchool": False,
        "reason": "holiday" if e else "weekend",
        "label": (e or {}).get("name"),
        "asWeekday": None,
    }


def monday_of(date: dt.date) -> dt.date:
    return date - dt.timedelta(days=date.weekday())


def week_has_school(cal: dict, monday: dt.date) -> bool:
    return any(resolve_day(cal, monday + dt.timedelta(days=i))["inSchool"]
               for i in range(7))


def school_week_index(cal: dict, anchor: dt.date, date: dt.date) -> int | None:
    """anchor 所在周算第 0 周，数到 date 所在周，只数有课的那几周。

    返回 None 表示 date 早于 anchor（那时还没有轮岗，不往回推）。
    """
    start = monday_of(anchor)
    end = monday_of(date)
    if end < start:
        return None
    n = 0
    cur = start
    while cur < end:
        if week_has_school(cal, cur):
            n += 1
        cur += dt.timedelta(days=7)
    return n


def group_for(cal: dict, cycle: dict, date: dt.date) -> tuple[str | None, str | None]:
    """按校历算当天是 A 组还是 B 组。返回 (组, 说不清的理由)。"""
    if cycle.get("status") != "confirmed":
        return None, "cycle-unconfirmed"
    anchor_raw = cycle.get("anchor")
    groups = cycle.get("groups") or []
    anchor_group = cycle.get("anchorGroup")
    if not anchor_raw or not groups or anchor_group not in groups:
        return None, "cycle-anchor-missing"
    idx = school_week_index(cal, dt.date.fromisoformat(anchor_raw), date)
    if idx is None:
        return None, "before-anchor"
    start = groups.index(anchor_group)
    return groups[(start + idx) % len(groups)], None


def describe(data_dir: Path) -> str:
    """给命令行用的一句话摘要。"""
    cal = load(data_dir)
    days = cal.get("days") or {}
    if not days:
        return "无校历（按周一到周五）"
    h = sum(1 for e in days.values() if e.get("kind") == "holiday")
    s = sum(1 for e in days.values() if e.get("kind") == "school")
    return f"校历 {len(days)} 条例外：放假 {h} 天，调休上课 {s} 天"


if __name__ == "__main__":
    import sys
    d = Path(sys.argv[1] if len(sys.argv) > 1 else "data")
    print(describe(d))
