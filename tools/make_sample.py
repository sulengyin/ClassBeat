#!/usr/bin/env python3
"""把 data/ 里的真实班级数据换成化名，生成可以公开的 sample/。

为什么要这一步：data/ 里是 48 个未成年人的真实姓名、班主任与任课老师姓名、
学校名。这些东西一旦推到公开仓库就收不回来了——GitHub 的历史会留着，
fork 会留着，爬虫也已经抓走。所以公开仓库里只能有化名数据。

    python3 tools/make_sample.py            # data/ → sample/
    python3 tools/make_sample.py --check    # 只检查 sample/ 里有没有漏网的真名

替换规则：
  · 学生姓名 → 固定化名池，顺序一一对应，结构完全不变
  · 教师姓名 → 「张老师」「李老师」……同一个老师前后一致
  · 学校 / 班级 → 示例小学 / 五（1）班
  · source 字段里的真实文件名 → 抹掉
  · texts.json 不复制——那是老师自己写的话术，不属于示例数据
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data"
DST = ROOT / "sample"

# 化名池：常见姓 + 两字名，纯属编造。故意让第 10、11 个只差一个字，
# 用来保留「两个名字只差一个字」那种必须显示全名的场景。
SURNAMES = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜"
GIVEN = [
    "子墨", "一诺", "思远", "雨桐", "梓萱", "浩然", "若曦", "嘉禾",
    "予安", "予宁", "知远", "书瑶", "沐辰", "清越", "星野", "和风",
    "乐言", "望舒", "南乔", "亦然", "白露", "青禾", "明轩", "静姝",
]
TEACHER_SURNAMES = ["张", "李", "王", "刘", "陈", "杨", "赵", "黄"]


def fake_students(n: int) -> list[str]:
    out = []
    for i in range(n):
        s = SURNAMES[i % len(SURNAMES)]
        g = GIVEN[(i * 7) % len(GIVEN)]
        # 撞名就往后错一位，保证唯一
        while s + g in out:
            g = GIVEN[(GIVEN.index(g) + 1) % len(GIVEN)]
        out.append(s + g)
    # 第 10、11 个做成「只差一个字」，保留近似姓名的测试场景
    out[9] = "周予安"
    out[10] = "周予宁"
    return out


def walk_strings(node, fn):
    if isinstance(node, str):
        return fn(node)
    if isinstance(node, list):
        return [walk_strings(x, fn) for x in node]
    if isinstance(node, dict):
        return {k: walk_strings(v, fn) for k, v in node.items()}
    return node


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只检查 sample/ 有没有残留真名")
    args = ap.parse_args()

    if args.check:
        check()
        return

    students = json.loads((SRC / "students.json").read_text(encoding="utf-8"))
    names = [s["name"] for s in students["students"]]
    alias = dict(zip(names, fake_students(len(names))))

    # 教师：从课表和班主任字段里收集，按出现顺序编号
    sched = json.loads((SRC / "schedule.json").read_text(encoding="utf-8"))
    teachers: list[str] = []
    for t in [sched.get("headTeacher")] + [e.get("teacher") for e in sched["entries"]]:
        if t and t not in teachers:
            teachers.append(t)
    tmap = {t: TEACHER_SURNAMES[i % len(TEACHER_SURNAMES)] + "老师" for i, t in enumerate(teachers)}

    # 长名优先，避免长名被更短的词先切走
    subst = sorted({**alias, **tmap}.items(), key=lambda kv: -len(kv[0]))

    def rename(text: str) -> str:
        # 备注里也会写人名（"6 号某某是替补"），所以不能只做整串匹配
        for real, fake in subst:
            if real in text:
                text = text.replace(real, fake)
        text = text.replace("春江中心小学", "示例小学").replace("五（5）班", "五（1）班")
        # 真实素材文件名不带走
        if text.startswith("assets/source/") or "五5班" in text:
            return "示例素材（已隐去）"
        return text

    DST.mkdir(exist_ok=True)
    for name in ["students", "roles", "schedule", "timetable", "noon", "content"]:
        data = json.loads((SRC / f"{name}.json").read_text(encoding="utf-8"))
        data = walk_strings(data, rename)
        (DST / f"{name}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    print(f"已生成 {DST.relative_to(ROOT)}/：6 个文件，{len(alias)} 个化名学生，{len(tmap)} 位化名老师")
    print("texts.json 未复制（老师自己写的话术不进示例数据）")

    # PLAN.md 里有真实姓名的事例（错字、近似名），公开仓库放化名版
    doc_dir = ROOT / "docs"
    doc_dir.mkdir(exist_ok=True)
    for src, dst in [("PLAN.md", "PLAN.md"), ("PROJECT_BRIEF.md", "PROJECT_BRIEF.md")]:
        p = ROOT / src
        if not p.exists():
            continue
        text = rename(p.read_text(encoding="utf-8"))
        head = "<!-- 由 tools/make_sample.py 生成：姓名、校名、班名已化名，结构未改 -->\n\n"
        (doc_dir / dst).write_text(head + text, encoding="utf-8")
        print(f"已生成 docs/{dst}（化名版）")


def check() -> None:
    """确保 sample/ 里任何真实姓名都没漏。"""
    real = set()
    for f in ["students", "roles", "schedule"]:
        data = json.loads((SRC / f"{f}.json").read_text(encoding="utf-8"))
        real |= {s["name"] for s in data.get("students", []) if isinstance(s, dict) and "name" in s}
        for r in data.get("roles", []):
            real |= set(r.get("people") or [])
            real |= set((r.get("peopleMap") or {}).values())
        real |= {e["teacher"] for e in data.get("entries", []) if e.get("teacher")}
        if data.get("headTeacher"):
            real.add(data["headTeacher"])
    real = {n for n in real if n and len(n) >= 2}
    # 「走班」是课表里表示"换教室"的占位值，不是人名
    real -= {"走班"}

    leaks = []
    for p in sorted(DST.glob("*.json")):
        text = p.read_text(encoding="utf-8")
        for n in real:
            if n in text:
                leaks.append(f"{p.name}: {n}")

    if leaks:
        sys.exit("发现真实姓名残留：\n  " + "\n  ".join(leaks))
    print(f"干净：sample/ 内无 {len(real)} 个真实姓名的任何一个")


if __name__ == "__main__":
    main()
