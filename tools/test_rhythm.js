/* 用 node 直接跑 app/rhythm.js 的渲染逻辑，确认每个时段给出的卡片是对的。
   node tools/test_rhythm.js */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
global.window = global;
/* 在 node 里跑浏览器脚本：藏掉 module/exports，让 UMD 走浏览器分支，
   否则 engine 会把自己挂到 module.exports，window.Schedule 就是空的。
   self 显式指向全局，模拟浏览器。 */
function loadBrowserScript(f) {
  const code = fs.readFileSync(path.join(ROOT, f), "utf8");
  new Function("module", "exports", "require", "self", code)(undefined, undefined, undefined, global);
}
["app/data.js", "app/engine/schedule.js", "app/rhythm.js", "app/runtime.js"].forEach(loadBrowserScript);

/* 不再从 data.js 里取现成的一天：测试和页面走同一条路，现算。 */
const RT = global.window.Runtime;
const R = global.window.Rhythm;

let pass = 0, fail = 0;
function check(ok, title, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + title + (detail ? "  · " + detail : ""));
  ok ? pass++ : fail++;
}
function at(date, hhmm, opts) {
  const day = RT.day(date);
  const p = hhmm.split(":").map(Number);
  return R.stateAt(day, p[0] * 60 + p[1], opts);
}
function duty(date, hhmm) {
  const day = RT.day(date);
  const p = hhmm.split(":").map(Number);
  return R.dutiesAt(day, p[0] * 60 + p[1]);
}

/* 周四：7 节正课，第 4 节书法 */
const first = RT.day("2026-11-05").timeline.filter(b => b.type === "class" && b.periodNo === 1)[0];
let s = at("2026-11-05", "08:30");
check(s.kind === "class" && s.title === "第 1 节 · 语文" && s.sub === first.teacher,
  "上课卡：第 1 节 语文 / " + first.teacher, s.title + " / " + s.sub);
check(!s.countdown.visible, "上课不显示倒计时");

s = at("2026-11-05", "11:25");
check(s.kind === "class" && s.title.indexOf("第 4 节") === 0 && s.title.indexOf("书法") > 0,
  "第 4 节是书法（11:20–11:40）", s.title);
check(s.items.length === 0, "上课期间不再列准备清单（清单在课前课间已经列过）",
  s.items.join("、") || "空");

s = at("2026-11-05", "11:10");
check(s.kind === "break" && s.sub === "下一节 书法", "课间提示下一节书法", s.sub);
check(s.items.indexOf("墨汁") >= 0, "书法要带的墨汁在课间开头就列出来");
check(s.countdown.visible && s.countdown.text.indexOf("还有") === 0,
  "课间倒计时（距上课）", s.countdown.text);

s = at("2026-11-05", "10:18");
check(s.kind === "break" && s.items.length === 2 && s.items[0] === "英语书",
  "课间第一秒就列下一节要带的清单（不再分 level）",
  s.items.join("、") || "空");
check(s.lines.length === 2 && s.lines[0].items.join("/") === "喝水/上厕所",
  "课间第一行：喝水 上厕所", JSON.stringify(s.lines[0]));
check(s.lines[1].label === "准备好" && s.lines[1].items[0] === "英语书",
  "课间第二行：准备好，直接列英语书", JSON.stringify(s.lines[1]));

s = at("2026-11-05", "10:24");
check(s.items.length > 0, "课间最后 1 分钟清单仍然在", s.items.join("、"));

/* 早读 8:10 下课 → 8:10 立刻切到第一节课的准备清单 */
s = at("2026-11-05", "08:10");
check(s.kind === "break" && s.items.length === 3 && s.note.indexOf("现在就摆好") >= 0,
  "08:10 早读一结束就投放第一节的用品", s.kind + " / " + s.items.join("、"));
s = at("2026-11-05", "08:20");
check(s.kind === "class" && s.title.indexOf("第 1 节") === 0 && s.items.length === 0,
  "08:20 正式上课后不再占用品页", s.title);

/* 9:00 第一节课下课 → 9:00 立刻是大课间，不是课间准备 */
s = at("2026-11-05", "09:00");
check(s.kind === "ritual" && s.title === "大课间", "09:00 整点切到大课间", s.title);

/* 大课间（09:00–09:30）后是第 2 节（09:30）：最后 10 分钟必须露出下一节。
   以前大课间走 ritual 分支，到最后 3 分钟只剩「还剩几分钟」，科目和用品全没了。 */
check(R.PREP_LEAD === 10, "课前准备默认提前 10 分钟", String(R.PREP_LEAD));
s = at("2026-11-05", "09:28");
check(s.kind === "ritual" && s.sub === "下一节 数学", "大课间剩 2 分钟写明下一节", s.sub || "空");
check((s.prepItems || []).indexOf("数学书") >= 0, "大课间剩 2 分钟列出要带的书本",
  (s.prepItems || []).join("、") || "空");
check(s.lines.some(l => l.kind === "prep" && l.items.indexOf("数学书") >= 0),
  "用品单独一行，不和活动提示打架", JSON.stringify(s.lines));
check(s.note === "排队下楼，靠右行走，不推不挤", "大课间自己的安全提示还在", s.note);
check(s.focus === "countdown" && s.timer, "倒计时照常，信息没被挤掉", s.timer);

s = at("2026-11-05", "09:20");
check(s.sub === "下一节 数学", "正好 10 分钟就开始提示", s.sub);
s = at("2026-11-05", "09:19");
check(s.kind === "ritual" && !s.sub && !(s.prepItems || []).length,
  "超过 10 分钟不显示下一节", s.sub || "空");

s = at("2026-11-05", "09:19", { prepLead: 11 });
check(s.sub === "下一节 数学", "提前量走配置，不是写死", s.sub);
s = at("2026-11-05", "09:25", { prepLead: 3 });
check(!s.sub, "把提前量调小也生效", s.sub || "空");

/* 长课间前段先保留「现在是课间」，最后 10 分钟再切准备 */
s = at("2026-11-05", "11:05");
check(s.kind === "break" && !s.sub && s.items.length === 0,
  "长课间前段不抢课间信息", s.sub || "空");

/* 当天已无正课：不挂「下一节」 */
s = at("2026-11-05", "15:48");
check(s.kind === "break" && !s._next && s.items.length === 0,
  "当天没有后续课程时不提示下一节", s.sub || "空");

/* 午休、午餐不进入课前准备 */
s = at("2026-11-05", "12:20");
check(s.kind === "noon" && !s._next && !(s.prepItems || []).length,
  "午休不挂下一节", s.sub || "空");
s = at("2026-11-05", "12:07");
check(s.kind === "meal" && !s._next, "午餐不挂下一节", s.sub || "空");

/* 跨午休的第一节：午休结束后的课间照常提示 */
s = at("2026-11-05", "12:55");
check(s.kind === "break" && (s.sub || "").indexOf("下一节") === 0,
  "跨午休的第一节课前照常提示", s.sub || "空");

/* 界面输入归一到 1–30 的整数：空回默认，越界夹住，非数字拒绝 */
check(R.normalizePrepLead("") === R.PREP_LEAD && R.normalizePrepLead(null) === R.PREP_LEAD,
  "空值回到默认 10 分钟", String(R.normalizePrepLead("")));
check(R.normalizePrepLead(0) === null && R.normalizePrepLead(-7) === null,
  "0 和负数都拒绝，不写入", String(R.normalizePrepLead(0)));
check(R.normalizePrepLead(99) === 30 && R.normalizePrepLead(30) === 30,
  "超过 30 夹到 30", String(R.normalizePrepLead(99)));
check(R.normalizePrepLead("abc") === null && R.normalizePrepLead(NaN) === null,
  "非数字不写入", String(R.normalizePrepLead("abc")));
check(R.normalizePrepLead("12.4") === 12, "小数取整", String(R.normalizePrepLead("12.4")));

/* 提前量改成 15：09:18（差 12 分钟）就该开始提示 */
s = at("2026-11-05", "09:18", { prepLead: 15 });
check(s.sub === "下一节 数学", "提前量 15 分钟时更早开始提示", s.sub || "空");
s = at("2026-11-05", "09:18", { prepLead: 10 });
check(!s.sub, "提前量 10 分钟时同一时刻还不提示", s.sub || "空");

/* 第二行的清单跟科目走，且老师改过的词要顶掉默认 */
s = at("2026-11-05", "11:10");
check(s.lines[1].items.indexOf("墨汁") >= 0, "课间第二行列出书法要带的东西",
  s.lines[1].items.join("、"));

s = at("2026-11-05", "10:18", {
  texts: { breakActions: ["补水"], prepLabel: "准备" }
});
check(s.lines[0].items[0] === "补水" && s.lines[1].label === "准备",
  "老师改过的课间用词会覆盖默认", JSON.stringify(s.lines));

/* 任务类不套「准备好」——大扫除的条目本身就是动作 */
s = at("2026-11-10", "11:55");
check(s.lines[0].kind === "action" && s.lines[0].items.length === 4,
  "大扫除四项任务是动作行，不是准备行", JSON.stringify(s.lines[0]));

/* 午间与午餐 */
s = at("2026-11-05", "12:20");
check(s.kind === "noon" && s.title === "午间休息", "午间卡", s.title);

s = at("2026-11-05", "12:07");
check(s.kind === "meal" && s.countdown.visible, "午餐最后 5 分钟倒计时", s.countdown.text);

/* 周二：大扫除插在午餐与午间之间 */
s = at("2026-11-10", "11:55");
check(s.kind === "action" && s.title === "大扫除", "周二 11:55 显示大扫除", s.title);
check(s.items.length === 4, "大扫除 4 项任务", s.items.join("、"));
check(s.note.indexOf("湿手不碰插座") >= 0, "大扫除安全提示上屏", s.note);

s = at("2026-11-10", "12:20");
check(s.kind === "noon" && s.title === "午间休息", "大扫除后进入午间", s.title);

/* 放学与周末 */
s = at("2026-11-05", "17:30");
check(s.kind === "closed" && s.title === "放学了", "17:20 之后显示放学");

s = at("2026-11-07", "10:00");
check(s.kind === "holiday" && s.title === "今天不上学", "周六显示不上学");

/* 两头的话也能改：到校前、放学后、休息日不在作息表里，但老师最常改的正是这几句 */
s = at("2026-11-05", "07:25");
check(s.kind === "before" && s.title === "早上好", "7:25 显示到校（早读还没开始）", s.title);
check(s.note.indexOf("交作业") >= 0, "到校前那句默认是交作业", s.note);
check(s.arrived === true, "7:25 已经到校（顶部标签不应再写「还没到校」）");

s = at("2026-11-05", "07:15");
check(s.arrived === false, "7:15 还没到校");

s = at("2026-11-05", "07:25", {
  texts: { stage: { before: { title: "早读开始", note: "交作业、交回执" } } }
});
check(s.title === "早读开始" && s.note === "交作业、交回执", "到校前的话能被老师改",
  s.title + " / " + s.note);

s = at("2026-11-05", "17:30", { texts: { stage: { closed: { note: "排队出校门，跟老师再见" } } } });
check(s.kind === "closed" && s.note === "排队出校门，跟老师再见", "放学那句能被改", s.note);

s = at("2026-11-07", "10:00", { texts: { stage: { holiday: { title: "今天休息" } } } });
check(s.kind === "holiday" && s.title === "今天休息", "休息日标题能被改", s.title);

s = at("2026-11-05", "10:18", { texts: { breakTitle: "课间休息" } });
check(s.title === "课间休息", "课间大字能被改", s.title);

/* 值日条 */
let d = duty("2026-11-05", "10:18");
check(d.items.length > 0 && d.quiet === true, "课间只挂日常岗位且降权",
  d.items.map(x => x.name).join("、"));

d = duty("2026-11-10", "17:11");
const names = d.items.map(x => x.name);
check(names[0] === "值日组", "放学 4 件事合并成「值日组」一条", names.join(" → "));
check(names[names.length - 1] === "路队长", "路队长排最后", names.join(" → "));
check(d.items[0].tasks.length === 4, "值日组合并了 4 项", d.items[0].tasks.join("、"));
check(d.items[0].people.length === 0 && d.items[0].unknown === true,
  "A/B 组未确认时显示「待定」，不编人名");

d = duty("2026-11-05", "08:30");
check(d.items.length === 0, "上课时间值日条不出现");

/* 倒计时三档 */
s = at("2026-11-05", "11:10", { countdownMode: "off" });
check(!s.countdown.visible, "全部关闭时课间也不倒计时");

s = at("2026-11-05", "08:30", { countdownMode: "all" });
check(s.countdown.visible, "全部显示时上课也倒计时", s.countdown.text);

/* ---------- 早读 ---------- */
/* 11-05 是周四。早读在作息表里是一段真实的块（07:30–08:10），
   读什么按星期配；配了才显示科目，没配不猜。 */
const rd = { texts: { reading: { "4": { subject: "英语", task: "读 Unit 4 单词" } } } };

s = at("2026-11-05", "07:30", rd);
check(s.kind === "reading" && s.title === "英语学习建议", "周四 7:30 标题写「英语学习建议」", s.title);
check(s.reading === true, "标了 reading，顶栏写「晨间自主管理」");
check(s.advice === "读 Unit 4 单词" && s.lines.length === 0,
  "老师填的建议单独成行，不再挤成小字清单", s.advice + " / " + JSON.stringify(s.lines));
check(s.items.length === 0, "早读不出准备清单", s.items.join("、") || "空");

s = at("2026-11-05", "08:09", rd);
check(s.kind === "reading", "8:09 早读还没下课", s.kind);

s = at("2026-11-05", "07:29", rd);
check(s.kind === "before" && s.title === "早上好", "7:29 还没到早读，不提前催", s.title);

s = at("2026-11-06", "07:30", rd);
check(s.kind === "reading" && s.title === "晨间自主管理" && s.lines.length === 0 && !s.advice,
  "周五没配科目：只显示「晨间自主管理」，不猜科目", s.title);

/* 旧安装的数据里存的还是「早读」：显示时换新名，数据本身不动 */
check(R.blockName({ type: "reading", name: "早读" }) === "晨间自主管理",
  "旧块名「早读」显示成「晨间自主管理」");
check(R.blockName({ type: "reading", name: "晨间自主管理" }) === "晨间自主管理",
  "新块名原样显示");
check(R.blockName({ type: "break", name: "早读" }) === "早读",
  "只换 reading 段，别的段名字不动");

/* 老安装的作息里块名还是「早读」：走到这一段时，屏上照样是新名 */
const oldNameDay = JSON.parse(JSON.stringify(RT.day("2026-11-05")));
oldNameDay.timeline.forEach(function (b) { if (b.type === "reading") b.name = "早读"; });
s = R.stateAt(oldNameDay, 7 * 60 + 30, {});
check(s.kind === "reading" && s.title === "晨间自主管理",
  "旧数据里的「早读」上屏就是「晨间自主管理」", s.title);

s = at("2026-11-05", "07:30", { texts: { reading: { "4": { subject: "英语" } } } });
check(s.title === "英语学习建议" && !s.advice, "没写建议就只上标题", s.title);

/* 提醒事项：单独一块；建议改成大字正文，不占清单 */
s = at("2026-11-05", "07:30", {
  texts: {
    reading: { "4": { subject: "英语", task: "读 Unit 4 单词" } },
    reminders: { "default": "带齐回执", "4": "今天穿校服" }
  }
});
check(s.lines[0].kind === "reminder" && s.lines[0].label === "提醒事项"
  && s.lines[0].items[0] === "今天穿校服", "提醒事项仍在清单里",
  JSON.stringify(s.lines));
check(s.lines.length === 1 && s.advice === "读 Unit 4 单词", "建议不重复进清单",
  JSON.stringify(s.lines) + " / " + s.advice);

s = at("2026-11-06", "07:30", {
  texts: { reminders: { "default": "带齐回执" } }
});
check(s.lines.length === 1 && s.lines[0].items[0] === "带齐回执",
  "没单独配的那天用「每天」的提醒", JSON.stringify(s.lines));

/* 到校一句话跟到 08:10：早读期间它在大字下面，不只在打铃前 10 分钟 */
s = at("2026-11-05", "07:45", {
  texts: {
    stage: { before: { note: "戴好红领巾，打扫好个人卫生。", title: "早上好" } },
    reminders: { "default": "戴好红领巾，打扫好个人卫生" }
  }
});
check(s.kind === "reading" && s.lines.length === 1
  && s.lines[0].kind === "reminder"
  && s.lines[0].items[0] === "戴好红领巾，打扫好个人卫生",
  "同一句用黄色贴纸承载，不缺席", JSON.stringify(s.lines));
check(s.note === "", "贴纸顶上来后，正文不再重复这句话", s.note);

s = at("2026-11-05", "07:45", {
  texts: {
    stage: { before: { note: "戴好红领巾，打扫好个人卫生。" } },
    reminders: { "default": "今天穿校服" }
  }
});
check(s.note.indexOf("戴好红领巾") >= 0 && s.lines.length === 1
  && s.lines[0].items[0] === "今天穿校服",
  "到校一句话和当天提醒不同时，两处都出", s.note + " / " + JSON.stringify(s.lines));

/* 旧作息没有 reading 块：到校后到第 1 节这段按早读处理，
   提醒事项不能因为换了分支就丢掉。 */
const oldDay = JSON.parse(JSON.stringify(RT.day("2026-11-05")));
oldDay.timeline = oldDay.timeline.filter(function (b) { return b.type !== "reading"; });
s = R.stateAt(oldDay, 7 * 60 + 30, {
  texts: {
    reading: { "4": { subject: "英语", task: "读 Unit 4 单词" } },
    reminders: { "default": "戴好红领巾，打扫好个人卫生" }
  }
});
check(s.kind === "before" && s.reading === true, "旧作息的到校段仍算晨间自主管理", s.kind);
check(s.lines.length === 1 && s.lines[0].kind === "reminder"
  && s.lines[0].items[0] === "戴好红领巾，打扫好个人卫生",
  "旧作息里提醒事项也上屏", JSON.stringify(s.lines));

console.log("\n" + pass + "/" + (pass + fail) + " 通过");
process.exit(fail ? 1 : 0);
