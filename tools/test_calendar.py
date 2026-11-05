#!/usr/bin/env python3
"""校历与轮岗的回归测试：只测「日期 → 上不上学 / 轮到哪组」这一层。

这几条是老师口述过的规则，改坏了不会报错，只会让某个组多值一周班，
所以必须钉住：

  1. 整周放假不消耗轮次（停课一周回来还是原来那组）
  2. 只放周一，这一周照常算一周（周二到周五照做）
  3. 单日放假不影响轮换，只影响那天上不上学
  4. 调休上课的周六算上学日，并按 asWeekday 取课表
  5. 起始日之前不给结论
"""

import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import school_calendar as sc  # noqa: E402

RESULTS: list[tuple[str, str]] = []


def check(cond: bool, label: str, detail: str = "") -> None:
    print(f"  {'✓' if cond else '✗'} {label}" + (f"（{detail}）" if detail else ""))
    RESULTS.append((label, "" if cond else detail or "失败"))


CAL = {
    "days": {
        # 国庆 7 天：10/1–10/7（10/8、10/9 正常上学）
        "2026-10-01": {"kind": "holiday", "name": "国庆节"},
        "2026-10-02": {"kind": "holiday", "name": "国庆节"},
        "2026-10-05": {"kind": "holiday", "name": "国庆节"},
        "2026-10-06": {"kind": "holiday", "name": "国庆节"},
        "2026-10-07": {"kind": "holiday", "name": "国庆节"},
        # 整周停课：11/2–11/6 一天不上，这一周不该消耗轮次
        "2026-11-02": {"kind": "holiday", "name": "停课周"},
        "2026-11-03": {"kind": "holiday", "name": "停课周"},
        "2026-11-04": {"kind": "holiday", "name": "停课周"},
        "2026-11-05": {"kind": "holiday", "name": "停课周"},
        "2026-11-06": {"kind": "holiday", "name": "停课周"},
        # 调休上课的周六
        "2026-11-14": {"kind": "school", "name": "调休上课", "asWeekday": 5},
        # 只放周一
        "2026-11-23": {"kind": "holiday", "name": "校庆"},
        # 单日放假（周三）
        "2026-11-25": {"kind": "holiday", "name": "秋游"},
    }
}

CYCLE = {"groups": ["A", "B"], "anchor": "2026-09-07", "anchorGroup": "A", "status": "confirmed"}


def g(day: str):
    return sc.group_for(CAL, CYCLE, dt.date.fromisoformat(day))


def d(day: str):
    return sc.resolve_day(CAL, dt.date.fromisoformat(day))


def main() -> None:
    print("校历：上不上学")
    check(d("2026-10-01")["inSchool"] is False, "国庆当天不上学")
    check(d("2026-10-03")["reason"] == "weekend", "普通周六记 weekend")
    check(d("2026-10-01")["label"] == "国庆节", "放假带得出名字")
    check(d("2026-10-08")["inSchool"] is True, "国庆后周四照常上学")
    check(d("2026-11-14")["inSchool"] is True, "调休周六要上学")
    check(d("2026-11-14")["asWeekday"] == 5, "调休周六按周五课表")
    check(d("2026-11-16")["inSchool"] is True, "普通周一上学")

    print("轮岗：只数有课的周")
    check(g("2026-09-07") == ("A", None), "起始周是 A 组", str(g("2026-09-07")))
    check(g("2026-09-14") == ("B", None), "第二周换 B", str(g("2026-09-14")))
    check(g("2026-09-28") == ("B", None), "国庆前一周仍是 B", str(g("2026-09-28")))
    check(g("2026-10-08") == ("A", None), "国庆那周仍算一周（放了 5 天，上了 2 天）",
          str(g("2026-10-08")))
    check(g("2026-10-12") == ("B", None), "下一周正常换组", str(g("2026-10-12")))
    check(g("2026-11-09") == ("A", None), "整周停课不消耗轮次，回来还是 A",
          str(g("2026-11-09")))
    check(g("2026-11-14") == ("A", None), "调休周六不额外推进轮次", str(g("2026-11-14")))
    check(g("2026-11-16") == ("B", None), "停课后第一周结束后照常换", str(g("2026-11-16")))
    check(g("2026-11-23") == ("A", None), "只放周一仍算一周，照常换组", str(g("2026-11-23")))
    check(g("2026-11-24") == ("A", None), "这一周用同一组", str(g("2026-11-24")))
    check(g("2026-11-25") == ("A", None), "单日放假不改组（只是当天不上学）",
          str(g("2026-11-25")))
    check(g("2026-09-01") == (None, "before-anchor"), "起始前不给结论", str(g("2026-09-01")))

    print("未确认时不许猜")
    check(sc.group_for(CAL, dict(CYCLE, status="unconfirmed"), dt.date(2026, 9, 7))
          == (None, "cycle-unconfirmed"), "status 未确认 → unknown")
    check(sc.group_for(CAL, dict(CYCLE, anchorGroup=None), dt.date(2026, 9, 7))
          == (None, "cycle-anchor-missing"), "缺 anchorGroup → unknown")

    print("无校历也能跑")
    empty = {"days": {}}
    check(sc.resolve_day(empty, dt.date(2026, 10, 1))["inSchool"] is True, "没校历时按周一到周五")
    check(sc.group_for(empty, CYCLE, dt.date(2026, 9, 14)) == ("B", None), "没校历时按日历周数")

    bad = [c for c in RESULTS if c[1]]
    print(f"\n{len(RESULTS)} 项，{len(bad)} 项失败")
    if bad:
        sys.exit(1)


if __name__ == "__main__":
    main()
