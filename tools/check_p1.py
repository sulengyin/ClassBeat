#!/usr/bin/env python3
"""P1 验收：拿真实数据把 9 条标准跑一遍。

每次改数据后重跑，避免"改了一处、错了一片"。
    python3 tools/check_p1.py
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from build_day import build, load, t2m  # noqa: E402

results: list[tuple[bool, str, str]] = []


def check(ok: bool, title: str, detail: str = "") -> None:
    results.append((ok, title, detail))


# ① 块结构：23 块、首尾相接、无重叠空洞
tt = load("timetable.json")
blocks = sorted(tt["blocks"], key=lambda b: t2m(b["start"]))
gaps = [
    f"{blocks[i]['end']}→{blocks[i+1]['start']}"
    for i in range(len(blocks) - 1)
    if blocks[i]["end"] != blocks[i + 1]["start"]
]
kinds = {}
for b in blocks:
    kinds[b["type"]] = kinds.get(b["type"], 0) + 1
check(len(blocks) == 23, "① 作息共 23 块", f"实际 {len(blocks)} 块")
check(not gaps, "① 块首尾相接", "、".join(gaps) if gaps else "从到校到放学连续")
check(kinds.get("class") == 7, "① 7 节正课", str(kinds))
check(kinds.get("ritual") == 4, "① 4 个固定仪式", str(kinds))
check(kinds.get("break") == 7, "① 7 段课间", str(kinds))
check(kinds.get("reading") == 1, "① 1 段晨间自主管理", str(kinds))

# ② 第 4 节 11:20–11:40（课表笔误 11:30，以作息为准）
d_thu = build(dt.date(2026, 11, 5))
p4 = [b for b in d_thu["timeline"] if b.get("periodNo") == 4][0]
check(p4["start"] == "11:20" and p4["end"] == "11:40", "② 第 4 节 11:20–11:40",
      f"{p4['start']}–{p4['end']} {p4['subject']}")

# ③ 周五第 7 节按周次取不同教师
fri_even = build(dt.date(2026, 11, 6))
fri_odd = build(dt.date(2026, 10, 30))
t_even = [b for b in fri_even["timeline"] if b.get("periodNo") == 7][0]["teacher"]
t_odd = [b for b in fri_odd["timeline"] if b.get("periodNo") == 7][0]["teacher"]
check(t_even != t_odd, "③ 周五第 7 节随周次换人",
      f"双周 {t_even} / 单周 {t_odd}")

# ④ 周末返回非在校日
sat = build(dt.date(2026, 11, 7))
check(sat["inSchool"] is False and sat["reason"] == "weekend", "④ 周六不报错",
      sat.get("reason", ""))

# ⑤ 18 个岗位都能被结构表达
roles = load("roles.json")["roles"]
legal = {"each", "daily", "weekly", "event", "cycle", "task", "unset"}
bad = [r["id"] for r in roles if r["freq"]["kind"] not in legal]
check(len(roles) == 18 and not bad, "⑤ 18 个岗位均被表达",
      f"{len(roles)} 个岗位，非法频率 {bad or '无'}")

# ⑥ unset 的 3 个岗位不产生任何触发
d_tue = build(dt.date(2026, 11, 3), group="A")
unset_ids = {r["id"] for r in roles if r["freq"]["kind"] == "unset"}
fired_unset = {x["roleId"] for x in d_tue["duties"]} & unset_ids
check(len(unset_ids) == 3 and not fired_unset, "⑥ unset 岗位不上屏",
      f"unset={sorted(unset_ids)}，触发={sorted(fired_unset) or '无'}")

# ⑦ 黑板清洁师：1–5 对应周一到周五，第 6 个人是替补不是第六天
b11 = [r for r in roles if r["id"] == "r11"][0]
EXPECT = b11.get("peopleMap", {})
got = {}
subs = set()
for wd in range(1, 6):
    day = build(dt.date(2026, 11, 2) + dt.timedelta(days=wd - 1))
    row = [x for x in day["duties"] if x["roleId"] == "r11"]
    got[wd] = row[0]["people"][0] if row and row[0]["people"] else None
    for x in row:
        subs |= {s["name"] for s in x["substitute"]}
check(got == {int(k): v for k, v in EXPECT.items()}, "⑦ 黑板按周几取人",
      "、".join(f"{wd}:{got[wd]}" for wd in sorted(got)))
check(not (set(got.values()) & subs), "⑦ 替补不占第六天", f"替补={sorted(subs) or '无'}")

# ⑧ 岗位里的 33 个姓名与名册零差异
students = {s["name"] for s in load("students.json")["students"]}
used: set[str] = set()
for r in roles:
    used |= set(r.get("people", []))
    used |= set(r.get("peopleMap", {}).values())
    used |= {s["name"] for s in r.get("substitute", [])}
    for names in r.get("groups", {}).values():
        used |= set(names)
check(used <= students, "⑧ 岗位姓名与名册零差异",
      f"岗位 {len(used)} 人，名册 {len(students)} 人，差异 {sorted(used - students) or '无'}")

# ⑨ 无岗位的学生仍在名单里
all_duty = set(used)
idle = students - all_duty
check(len(students) == 48 and len(idle) == 15, "⑨ 15 名学生未排岗但保留",
      f"有岗 {len(all_duty)} / 无岗 {len(idle)}")

# 附加：周二大扫除插入 pre，擦窗户跟动作走
pre = [b for b in d_tue["timeline"] if b["type"] == "action"]
window = [x for x in d_tue["duties"] if x["roleId"] == "r14"]
check(len(pre) == 1 and pre[0]["start"] == "11:50" and window and window[0]["at"] == "11:50",
      "＋ 周二大扫除 11:50–12:10，擦窗户随之触发",
      f"{pre[0]['start']}–{pre[0]['end']}" if pre else "没有插入动作")


passed = sum(1 for ok, _, _ in results if ok)
for ok, title, detail in results:
    print(f"{'PASS' if ok else 'FAIL'}  {title}" + (f"  · {detail}" if detail else ""))
print(f"\n{passed}/{len(results)} 通过")
sys.exit(0 if passed == len(results) else 1)
