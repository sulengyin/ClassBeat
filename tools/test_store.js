/* P3 数据层测试：覆盖、换人、名单排序、话术、时间词、验证码。
   node tools/test_store.js */
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
["app/data.js", "app/engine/schedule.js", "app/rhythm.js", "app/store.js", "app/runtime.js"].forEach(loadBrowserScript);

const D = global.window.RHYTHM_DATA;
const RT = global.window.Runtime;
const S = global.window.Store;

let pass = 0, fail = 0;
function check(ok, title, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + title + (detail ? "  · " + detail : ""));
  ok ? pass++ : fail++;
}

/* ---------- 出厂文字：本机没改过时吃包里烤好的那份 ---------- */
/* 模拟 bundle.py 把老师导出的 texts.json 烤进 data.js */
D.texts = { breakActions: ["喝水", "上厕所", "洗手"], genericPrep: "下节课的书" };
check(S.texts().breakActions.length === 3,
  "没本机改动时，用包里烤好的文字", (S.texts().breakActions || []).join("/"));
S.patchTexts({ genericPrep: "课本" });
check(S.texts().genericPrep === "课本", "本机改过就听本机的");
S.patchTexts({ genericPrep: null });
delete D.texts;

/* 老机器上存过半份文案，新包又加了默认文案：新加的那块必须还能出现。
   这正是五5班一体机上「戴好红领巾」消失的原因。 */
D.texts = { reading: { "1": { subject: "英语" } } };
S.resetTexts();
S.patchTexts({ reading: { "1": { subject: "英语", task: "跟读单词" } } });
D.texts.reminders = { default: "戴好红领巾，打扫好个人卫生" };
check(S.texts().reminders && S.texts().reminders.default === "戴好红领巾，打扫好个人卫生",
  "本机只改过晨间自主管理，包里新加的提醒事项仍然生效",
  JSON.stringify(S.texts().reminders || null));
check(S.texts().reading["1"].task === "跟读单词", "本机改过的那条仍然优先");
S.resetTexts();
delete D.texts;

/* ---------- 覆盖：只改指定的一节 ---------- */
const thu = RT.day("2026-11-05");
const out = S.applyOverrides(thu, { lessons: { 4: { subject: "自习", teacher: "代课老师" } } });
const p4 = out.timeline.filter(b => b.type === "class" && b.periodNo === 4)[0];
const p5 = out.timeline.filter(b => b.type === "class" && b.periodNo === 5)[0];
const p5raw = thu.timeline.filter(b => b.type === "class" && b.periodNo === 5)[0];

check(p4.subject === "自习" && p4.teacher === "代课老师", "调课：第 4 节改成自习", p4.subject + "/" + p4.teacher);
check(p5.subject === p5raw.subject, "第 5 节不受影响", p5.subject);
check(thu.timeline.filter(b => b.type === "class" && b.periodNo === 4)[0].subject === "书法",
  "原数据没被改动（纯函数）");

/* ---------- 覆盖：换人只动那条岗位 ---------- */
const tue = RT.day("2026-11-10");
const before = tue.duties.filter(d => d.at === "17:10");
check(before.filter(d => d.roleId === "r15")[0].status === "unknown", "换人前 r15 是 unknown");

const out2 = S.applyOverrides(tue, { roles: { r15: { people: ["同学甲", "同学乙"] } } });
const d15 = out2.duties.filter(d => d.roleId === "r15" && d.at === "17:10")[0];
const d02 = out2.duties.filter(d => d.roleId === "r02")[0];
const d16 = out2.duties.filter(d => d.roleId === "r16" && d.at === "17:10")[0];

check(d15.people.length === 2 && d15.status === "ok", "换人后 r15 变成有名字", d15.people.join("、"));
const d02before = before.filter(d => d.roleId === "r02")[0];
check(d02.people.join("、") === d02before.people.join("、"), "同班其他岗位不动", d02.people.join("、"));
check(d16.status === "unknown", "同组其他岗位也不串", d16.status);

/* ---------- 覆盖：午间 ---------- */
const out3 = S.applyOverrides(thu, { noon: { title: "大扫除", tip: "先打扫自己的座位" } });
const noon = out3.timeline.filter(b => b.type === "noon")[0];
check(noon.name === "大扫除" && noon.tip === "先打扫自己的座位", "午间覆盖生效", noon.name);

/* ---------- 名单检索 ----------
   用一份编造的名单，不读真实名册：这样公开仓库跑测试也不碰任何真实姓名。
   两个「林予」开头的名字是故意留的——只差一个字的名字必须都列全名。 */
const NAMES = ["林予安", "林予宁", "陈子墨", "赵一诺", "孙思远",
  "周雨桐", "吴梓萱", "郑浩然", "王若曦", "冯嘉禾"];
const stu = NAMES.map((n, i) => ({ id: "t" + i, name: n, active: true }));

const lin = S.rankStudents(stu, "林予", [], 8);
check(lin.length === 2 && lin.every(s => s.name.indexOf("林予") === 0),
  "输入「林予」同时出两个人", lin.map(s => s.name).join("、"));

const one = S.rankStudents(stu, "林", [], 8);
check(one.length > 0 && one.every(s => s.name.indexOf("林") >= 0), "输入一个字就出候选",
  one.slice(0, 3).map(s => s.name).join("、"));

const rel = S.rankStudents(stu, "", ["林予宁"], 3);
check(rel[0].name === "林予宁", "本岗位的人排第一位", rel.map(s => s.name).join("、"));

const capped = S.rankStudents(stu, "", [], 8);
check(capped.length === 8, "候选最多 8 条", capped.length + " 条");

/* 别人做的设置文件里，名单可能是纯字符串数组。不归一化的话
   `s.name.indexOf` 会直接抛错，换人面板整块空掉——看起来就是「打一个字不出人」。 */
const strHit = S.rankStudents(["林予安", "陈子墨"], "林", [], 8);
check(Array.isArray(strHit) && strHit.length === 1 && strHit[0].name === "林予安",
  "名单是纯字符串数组时也能按姓氏出人", JSON.stringify(strHit));

/* name 本身是对象、或者已经被写成 "[object Object]" 的老数据 */
const objHit = S.rankStudents(
  [{ id: "o1", name: { name: "林予宁" } }, { id: "o2", name: "[object Object]" }],
  "林", [], 8);
check(objHit.length === 1 && objHit[0].name === "林予宁",
  "姓名存成对象时取出内层名字，[object Object] 不进候选", JSON.stringify(objHit));

/* 相关人（这个岗位原来是谁）也可能是对象：取名字后仍要排第一位 */
const relObj = S.rankStudents(stu, "", [{ name: "孙思远" }], 8);
check(relObj[0].name === "孙思远", "相关人是对象时取名字排序", relObj[0].name);

/* ---------- 时间词 ---------- */
check(S.findTimeWords("今天 12:50 大扫除").join("、") === "今天、12:50",
  "抓出「今天」和「12:50」", S.findTimeWords("今天 12:50 大扫除").join("、"));
check(S.findTimeWords("现在整理书包，到走廊排队").length === 0, "没有时间词就不打扰");

/* ---------- 话术 ---------- */
S.remember("notice", "今天 12:50 大扫除", true);
S.remember("notice", "现在整理书包到走廊排队", false);
S.remember("notice", "现在整理书包到走廊排队", false);

const rc = S.recall("notice");
check(rc.length === 2, "同一条不重复存", S.allPhrases().length + " 条");
check(rc[0].pinned === true, "记住的排前面", rc[0].text);
check(rc[1].useCount === 2, "复用次数累加", "useCount=" + rc[1].useCount);

for (var i = 0; i < 8; i++) S.remember("notice", "临时话术" + i, false);
const rc2 = S.recall("notice");
check(rc2.filter(p => !p.pinned).length <= 5, "未勾选的只留最近 5 条",
  rc2.filter(p => !p.pinned).length + " 条");

/* ---------- 撤销 ---------- */
const K = "2026-12-01";
S.patchDayOverride(K, { notice: { text: "测试" } });
check(S.canUndo(K), "改完可以撤销");
S.undo(K);
check(!S.getDayOverride(K) || !S.getDayOverride(K).notice, "撤销后恢复原状");

/* ---------- 本机配置：改作息立刻重算 ---------- */
const base = RT.day("2026-11-05").timeline[0].start;
const tt = JSON.parse(JSON.stringify(D.timetable));
tt.blocks[0].start = "08:00";
S.patchConfig({ timetable: tt });
check(RT.day("2026-11-05").timeline[0].start === "08:00",
  "改作息后当天立刻重算", RT.day("2026-11-05").timeline[0].start);
check(S.config().timetable.blocks[0].start === "08:00", "本机配置只留改过的块");
check(S.exportAll().config.timetable.blocks[0].start === "08:00", "导出带上作息");
check(S.config().badKey === undefined, "不认识的配置块不写进去");

S.resetConfig();
check(RT.day("2026-11-05").timeline[0].start === base,
  "恢复出厂后回到原来的时间", RT.day("2026-11-05").timeline[0].start);
check(Object.keys(S.config()).length === 0, "恢复出厂后本机配置为空");

/* ---------- 导出 / 导入 ---------- */
S.patchTexts({ breakTitle: "课间休息" });
S.patchDayOverride("2026-12-02", { note: "临时" });
const dump = S.exportAll();
check(dump.format === "rhythm-config/v1" && dump.texts.breakTitle === "课间休息",
  "导出带上改过的文字", dump.format);
check(JSON.parse(JSON.stringify(dump)).texts.breakTitle === "课间休息",
  "导出内容能转 JSON 再读回来");

S.resetTexts();
check(!S.texts().breakTitle, "清空后回到默认");
const rBad = S.importAll({ hello: 1 });
check(rBad.ok === false, "不认识的文件不导入", rBad.why);
const rOk = S.importAll(JSON.parse(JSON.stringify(dump)));
check(rOk.ok === true && S.texts().breakTitle === "课间休息",
  "导入后文字回来了", "n=" + rOk.n);

/* ---------- 导入的原子性：坏文件不能写进去一半 ---------- */
S.patchTexts({ breakTitle: "本机原样" });
const beforeTitle = S.texts().breakTitle;
const rHalf = S.importAll({
  format: "rhythm-config/v1",
  texts: { breakTitle: "别人的班" },
  config: { timetable: { blocks: "坏掉的" } }
});
check(rHalf.ok === false, "作息结构坏掉时整份拒绝", rHalf.why);
check(S.texts().breakTitle === beforeTitle, "拒绝后文字没被改", S.texts().breakTitle);
check(!S.config().timetable || Array.isArray(S.config().timetable.blocks),
  "拒绝后配置也没被改");

const rArr = S.importAll({ format: "rhythm-config/v1", texts: ["不是对象"] });
check(rArr.ok === false, "文字不是对象时拒绝", rArr.why);
const rFmt = S.importAll({ format: "别的程序/v1", texts: {} });
check(rFmt.ok === false, "格式标记不对时拒绝", rFmt.why);

const rGood = S.importAll({
  format: "rhythm-config/v1",
  texts: { breakTitle: "导入的班" },
  phrases: ["站队", "安静"]
});
check(rGood.ok === true && S.texts().breakTitle === "导入的班",
  "合法文件整份导入", "n=" + rGood.n);

/* ---------- 换电脑：A 导出、B 导入，班级和作息都要对上 ---------- */
S.patchConfig({ meta: { klass: "搬家测试班" } });
S.patchConfig({ students: [{ name: "孙星野", active: true }, { name: "新同学", active: true }] });
const move = JSON.parse(JSON.stringify(S.exportAll()));
check(Array.isArray(move.config.students) && move.config.students.length === 2
      && move.config.students[1].name === "新同学",
  "导出带上名册修正", String((move.config.students || []).length));
S.resetConfig();
const rMove = S.importAll(move);
check(rMove.ok === true && (S.config().meta || {}).klass === "搬家测试班",
  "导入后班级名对上", rMove.klass);
check(Array.isArray((S.config().timetable || {}).blocks),
  "导入后作息表还在", String(((S.config().timetable || {}).blocks || []).length) + " 段");
check((((S.config().students || [])[1] || {}).name === "新同学"),
  "导入后名册修正还在", String(((S.config().students || []).length)));

/* ---------- 烤进包里的文字不能被一次小修改抹掉 ---------- */
D.texts = {
  reading: { "4": { subject: "英语" } },
  reminders: { "default": "带齐回执" }
};
S.resetTexts();
S.patchTexts({ breakTitle: "课间十分钟" });
var baked = S.texts();
check(baked.breakTitle === "课间十分钟" && baked.reading && baked.reading["4"]
  && baked.reminders && baked.reminders["default"] === "带齐回执",
  "改一项文字不会抹掉包里烤好的晨间自主管理和提醒", JSON.stringify(baked));
S.resetTexts();
delete D.texts;

/* ---------- 验证码：小数 ÷ 整数，除得尽，五年级口算 ---------- */
var okShape = true, okExact = true, okDigits = true, okSmall = true, badShape = "";
for (var j = 0; j < 300; j++) {
  var c = S.makeChallenge();
  /* 只要一位或两位小数的被除数、一位整数除数 */
  if (!/^[0-9]\.[0-9]([0-9])? ÷ [2-9]$/.test(c.text)) { okShape = false; badShape = c.text; }
  /* 没有余数：商 × 除数要正好回到被除数 */
  if (Math.abs(c.a - c.answer * c.b) > 1e-9) okExact = false;
  if (Math.abs(c.a / c.b - c.answer) > 1e-9) okExact = false;
  /* 商最多两位小数，学生口算能落笔 */
  if (Math.abs(Math.round(c.answer * 100) - c.answer * 100) > 1e-9) okDigits = false;
  if (c.a >= 10) okSmall = false;
}
check(okShape, "验证码是「一位/两位小数 ÷ 一位整数」", badShape || "300 次抽样");
check(okExact, "除得尽，没有余数");
check(okDigits, "商最多两位小数，口算能出");
check(okSmall, "被除数小于 10，不用算大数");

/* ---------- 岗位顺序：班主任定的先后，值日条照它排 ---------- */
var roleDoc0 = JSON.parse(JSON.stringify(D.roles));
var orders0 = roleDoc0.roles.map(function (r) { return r.order; }).join(",");
var movedUp = S.reorderRoles(roleDoc0.roles, "r14", -1);
check(movedUp.changed === true && movedUp.roles.length === roleDoc0.roles.length,
  "上移返回整份新岗位表", String(movedUp.roles.length) + " 条");
check(movedUp.roles.every(function (r, i, a) { return i === 0 || a[i - 1].order < r.order; }),
  "重排后 order 严格递增（不再并列）",
  movedUp.roles.map(function (r) { return r.order; }).join(","));
check(roleDoc0.roles.map(function (r) { return r.order; }).join(",") === orders0,
  "不改动传入的旧数组", orders0);
check(movedUp.roles.map(function (r) { return r.id; }).indexOf("r14")
      < movedUp.roles.map(function (r) { return r.id; }).indexOf("r18"),
  "擦窗户挪到同一时刻更前面", "r14 在 r18 之前");
check(S.reorderRoles(roleDoc0.roles, "r07", -1).changed === false
      && S.reorderRoles(roleDoc0.roles, "r01", 1).changed === false,
  "排到两头就不再动", "首条上移 / 末条下移都不改");
check(S.reorderRoles(roleDoc0.roles, "no-such", 1).changed === false,
  "找不到岗位就原样返回", "no-such");

/* 存进本机配置后，Runtime 立刻按新顺序给屏用 */
var nextDoc = JSON.parse(JSON.stringify(D.roles));
nextDoc.roles = movedUp.roles;
S.patchConfig({ roles: nextDoc });
var confRoles = RT.config().roles.roles;
check(confRoles.map(function (r) { return r.id; }).indexOf("r14")
      < confRoles.map(function (r) { return r.id; }).indexOf("r18"),
  "保存后本机配置按新顺序生效", "r14 在 r18 之前");
S.resetConfig();

/* 人群组：只存老师显式「存成组」的点名组，排班组不落库（PLAN 2.18） */
var g0 = S.upsertGroup([], {
  id: "g1", name: "  放学留下  ",
  memberIds: ["s01", "s02", "s01", ""]
});
check(g0.length === 1 && g0[0].name === "放学留下" && g0[0].memberIds.length === 2,
  "存组会去掉首尾空白、成员去重", JSON.stringify(g0.map(function (g) { return g.memberIds; })));
check(S.upsertGroup([], { id: "g2", name: "", memberIds: ["s01"] }).length === 0
      && S.upsertGroup([], { id: "g3", name: "临时", memberIds: [] }).length === 0,
  "没名字或没成员不存", "空组被丢掉");
check(S.upsertGroup([], { id: "g4", name: "排班", source: "role", memberIds: ["s01"] }).length === 0,
  "排班组不落库，按岗位实时取人", "source:role 被拒绝");

var g0b = S.upsertGroup(g0, { id: "g1", name: "放学留下", memberIds: ["s03"] });
check(g0b.length === 1 && g0b[0].memberIds[0] === "s03",
  "同 id 再存是改名/换人，不新增一条", JSON.stringify(g0b[0].memberIds));
check(S.removeGroup(g0b, "g1").length === 0, "删组按 id 只删这一条", "剩 0 条");

/* 组员存成对象时，旧代码 String(m) 会写成 "[object Object]" 并永久落库
   （真机反馈：更新后分组里还留着这个词）。
   2026-11-23 起改为「姓名优先、id 只作别名」：学生 id 是手写在
   students.json 里的 s01/s02，换一份名单就全变，老师的组会整片对不上；
   姓名才是老师认的身份。所以这里期望 name:张三 / name:李四，
   而不再是 s01。 */
var objMember = S.upsertGroup([], {
  id: "g5", name: "对象成员",
  memberIds: [{ id: "s01", name: "张三" }, { name: "李四" }]
});
check(objMember.length === 1
      && objMember[0].memberIds.indexOf("name:张三") >= 0
      && objMember[0].memberIds.indexOf("name:李四") >= 0,
  "对象成员存成 name:姓名（换名单不丢），不落成 [object Object]",
  JSON.stringify(objMember[0] && objMember[0].memberIds));

var junkMember = S.upsertGroup([], {
  id: "g6", name: "脏数据",
  memberIds: ["[object Object]", "name:[object Object]", "s02"]
});
check(junkMember.length === 1 && junkMember[0].memberIds.length === 1
      && junkMember[0].memberIds[0] === "s02",
  "救不回来的 [object Object] 丢掉，组和其余成员保留",
  JSON.stringify(junkMember[0] && junkMember[0].memberIds));

var savedGroup = S.saveGroup({
  id: "g9", name: "值日组", memberIds: ["s01", "s02"], order: 0
});
var savedConf = S.config().peopleGroups;
check(savedGroup.ok && savedConf.length === 1 && savedConf[0].name === "值日组",
  "saveGroup 写入本机配置", "1 条");
check(S.exportAll().config.peopleGroups.length === 1,
  "备份导出带上人群组", "peopleGroups 在 config 里");
S.resetConfig();
check(S.peopleGroups().length === 0, "重置配置后组也没了", "0 条");

/* memberIds 被写成单个值（"s01"）而不是数组：能救就救。
   以前这里是整份拒绝——而 exportAll 又会原样导出这种数据，于是
   「程序自己导出的备份，自己导不回来」，老师的组就这样凭空消失。 */
var badGroups = JSON.parse(JSON.stringify(S.exportAll()));
badGroups.config.peopleGroups = [{ name: "坏人", memberIds: "s01" }];
var badRes = S.importAll(badGroups);
check(badRes.ok === true && S.peopleGroups().length === 1
      && S.peopleGroups()[0].memberIds[0] === "s01",
  "memberIds 是单个值时救回来，不整份拒绝", badRes.why || JSON.stringify(S.peopleGroups()));
S.resetConfig();
var goodGroups = JSON.parse(JSON.stringify(S.exportAll()));
goodGroups.config.peopleGroups = [
  { id: "g9", name: "值日组", source: "manual", memberIds: ["s01"] }
];
check(S.importAll(goodGroups).ok === true && S.peopleGroups().length === 1,
  "合法人群组能随备份恢复", "1 条");
S.resetConfig();

/* ---------- 旧机器上的脏数据自愈（schema 1 → 2） ----------
   真机反馈：分组里出现过 [object Object]，更新后还在。修法是升级时
   清洗一次，不要求老师重新分组；能救的救（对象取 id / 名字），
   救不回来的只丢那一个成员，组名和其余成员一律保留。 */
var dirty = {
  meta: { klass: "脏数据班" },
  students: ["张三", { id: "s02", name: { name: "李四" } }, { id: "s03", name: "[object Object]" }],
  peopleGroups: [
    { id: "g1", name: "第一组", source: "manual", memberIds: [{ id: "s01", name: "张三" }, "[object Object]"] },
    { id: "g2", name: { name: "第二组" }, source: "manual", memberIds: ["name:李四"] }
  ],
  roles: { roles: [
    { id: "r1", name: "扫地", people: [{ name: "王五" }, "[object Object]"] },
    { id: "r2", name: "擦窗", peopleMap: { "1": { name: "赵六" }, "2": "[object Object]" } },
    { id: "r3", name: "值日", groups: { A: [{ name: "孙七" }], B: "[object Object]" } },
    { id: "r4", name: "替补", substitute: [{ name: "周八" }] }
  ] }
};
var healed = S.sanitizeConfig(dirty);
check(healed.students.length === 2 && healed.students[0].name === "张三"
      && healed.students[1].name === "李四",
  "自愈：名单归一化，[object Object] 学生丢掉",
  JSON.stringify(healed.students.map(function (s) { return s.name; })));
check(healed.peopleGroups.length === 2
      && healed.peopleGroups[0].memberIds.length === 1
      && healed.peopleGroups[0].memberIds[0] === "name:张三"
      && healed.peopleGroups[1].name === "第二组",
  "自愈：组员对象救回姓名，脏成员丢弃，组名与组本身保留",
  JSON.stringify(healed.peopleGroups));
check(healed.roles.roles[0].people.length === 1 && healed.roles.roles[0].people[0] === "王五",
  "自愈：岗位人员里的对象取名字", JSON.stringify(healed.roles.roles[0].people));
check(healed.roles.roles[1].peopleMap["1"] === "赵六"
      && healed.roles.roles[1].peopleMap["2"] === undefined,
  "自愈：按星期轮换的对象取名字",
  JSON.stringify(healed.roles.roles[1].peopleMap));
check(healed.roles.roles[2].groups.A[0] === "孙七"
      && healed.roles.roles[2].groups.B === undefined,
  "自愈：A/B 组里的对象取名字，不是数组的丢",
  JSON.stringify(healed.roles.roles[2].groups));
check(healed.roles.roles[3].substitute[0].name === "周八",
  "自愈：替补列表里的对象取名字", JSON.stringify(healed.roles.roles[3].substitute));
check(dirty.peopleGroups[0].memberIds.length === 2 && dirty.students[0] === "张三",
  "自愈不改原对象（纯函数）", "输入保持原样");

/* 走导入这条路：别人做的设置文件里带字符串名单与对象成员，落盘前也要洗干净 */
var dirtyFile = JSON.parse(JSON.stringify(S.exportAll()));
dirtyFile.config.students = ["张三", "李四"];
dirtyFile.config.peopleGroups = [
  { id: "gx", name: "导入组", source: "manual", memberIds: [{ id: "s01", name: "张三" }] }
];
var impRes = S.importAll(dirtyFile);
check(impRes.ok === true && S.config().students[0].name === "张三"
      && S.peopleGroups()[0].memberIds[0] === "name:张三",
  "导入时把字符串名单与对象成员洗干净", JSON.stringify(S.peopleGroups()));
S.resetConfig();

/* ---------- 配置版本：老备份原地升级，更高版本整份拒绝 ---------- */
/* 版本号是配置格式的契约：加迁移就要同步改这里，别让它变成同义反复 */
check(S.schemaVersion() === 2, "本机配置版本是 2", String(S.schemaVersion()));
check(S.exportAll().schemaVersion === 2, "导出文件带版本号", "schemaVersion");

var legacy = S.exportAll();
delete legacy.schemaVersion;
legacy.config = { meta: { klass: "旧版班级" }, students: ["同学甲"] };
var legacyRes = S.importAll(legacy);
check(legacyRes.ok === true, "没有版本号的旧备份能导入", legacyRes.why || "");
check(S.schemaVersion() === 2 && S.config().meta.klass === "旧版班级",
  "导入旧备份后补上版本号，配置原样保留",
  "v" + S.schemaVersion() + "/" + S.config().meta.klass);

var future = S.exportAll();
future.schemaVersion = 99;
var futureRes = S.importAll(future);
check(futureRes.ok === false && S.config().meta.klass === "旧版班级",
  "更高版本的备份整份拒绝，不动现有配置", futureRes.why || "");

S.resetConfig();
check(S.schemaVersion() === 2, "重置配置不回退版本号", "v" + S.schemaVersion());

/* ---------- 存人的字段：写入即干净，导出能导回 ----------
   这几个用例是「自己导出的文件自己导不回来」那个死锁的最小复现：
   写入不清洗 → 脏数据进得去；导出原样吐 → 脏数据被固化；
   导入用元素级条件整份拒绝 → 能救的也救不回来。 */
S.resetConfig();
S.patchConfig({ peopleGroups: [{ id: "g9", name: { name: "一组" },
  memberIds: [{ id: "s1", name: "张三" }, { id: "s2", name: "李四" }] }] });
var g9 = (S.config().peopleGroups || [])[0];
check(!!g9 && typeof g9.name === "string" && g9.name === "一组",
  "写入时就洗净：组名不再是对象", JSON.stringify(g9 && g9.name));
check(!!g9 && Array.isArray(g9.memberIds) && g9.memberIds.every(m => typeof m === "string"),
  "写入时就洗净：组员 id 全是字符串", JSON.stringify(g9 && g9.memberIds));

var round = S.importAll(S.exportAll());
check(round.ok === true, "自己导出的设置能自己导回来", round.why || "");

S.resetConfig();
var ovRes = S.importAll({ format: "rhythm-config/v1", schemaVersion: 2,
  overrides: { "2026-11-23": { roles: { sweep: { people: [{ id: "s1", name: "张三" }] } } } } });
var ovp = ((S.getDayOverride("2026-11-23") || {}).roles || {}).sweep;
check(ovRes.ok === true && !!ovp, "含临时调整的备份能导入", ovRes.why || "");
check(!!ovp && Array.isArray(ovp.people) && ovp.people.every(p => typeof p === "string"),
  "临时调整里的人也要洗净：people 全是字符串", JSON.stringify(ovp && ovp.people));
check(!!ovp && ovp.people[0] === "张三", "对象被还原成人名，而不是丢掉", ovp && ovp.people[0]);

/* 旧数据里放错地方的排班组（source:"role" 出现在 peopleGroups 里）：
   清洗时按手动组救回来，不让老师分好的组凭空消失。
   注意这与上面「排班组不落库」不矛盾——那条测的是老师显式存组的路径，
   这条测的是清洗旧数据的路径，两者本来就该有不同的宽严。 */
S.resetConfig();
S.patchConfig({ peopleGroups: [{ id: "g10", name: "扫地组", source: "role", memberIds: ["张三", "李四"] }] });
var keptRole = (S.config().peopleGroups || [])[0];
check(!!keptRole && keptRole.name === "扫地组" && keptRole.source === "manual"
      && keptRole.memberIds.length === 2,
  "旧数据里放错地方的排班组被救成手动组，不丢", JSON.stringify(keptRole));

S.resetConfig();
var rescue = S.importAll({ format: "rhythm-config/v1", schemaVersion: 2,
  config: { peopleGroups: [{ id: "g11", name: { name: "擦窗组" },
    memberIds: [{ id: "s1", name: "张三" }] }] } });
check(rescue.ok === true, "组名是对象的备份不再被整份拒绝", rescue.why || "");
check((S.config().peopleGroups || [])[0] && (S.config().peopleGroups || [])[0].name === "擦窗组",
  "能救回来的组名要救回来",
  JSON.stringify((S.config().peopleGroups || []).map(g => g && g.name)));
S.resetConfig();

/* 「今天这个岗位是谁」只有引擎一个答案。
   编辑面板现在直接调 Schedule.resolvePeople，所以这个顺序就是面板的顺序，
   不会再出现「面板按 peopleMap 显示、大屏按 groups 显示」两套答案。 */
const SCH = global.window.Schedule;
const rrGroup = SCH.resolvePeople({ id: "x1", groups: { A: ["甲"], B: ["乙"] }, peopleMap: { "1": "丙" } }, "A", null, 1);
check(rrGroup[0].join("、") === "甲" && rrGroup[2] === "group",
  "有 A/B 组又有星期表时，按轮换组出人（不是星期表）", JSON.stringify(rrGroup));
const rrPeople = SCH.resolvePeople({ id: "x2", people: ["丁"], groups: { A: ["甲"] }, peopleMap: { "1": "丙" } }, "A", null, 1);
check(rrPeople[0].join("、") === "丁" && rrPeople[2] === "people",
  "老师指定的人优先于轮换组与星期表", JSON.stringify(rrPeople));

/* 临时换人的 people 被写成单个字符串（"乙"）而不是数组：
   以前 applyOverrides 用 r.people.slice()，对字符串来说返回的还是字符串，
   后面 peopleText 调 .map 直接抛错，整条值日条白掉。 */
const dayStr = { timeline: [], duties: [{ roleId: "z1", name: "扫地", people: ["甲"], status: "ok" }] };
const outStr = S.applyOverrides(dayStr, { roles: { z1: { people: "乙" } } });
check(Array.isArray(outStr.duties[0].people) && outStr.duties[0].people[0] === "乙",
  "临时换人的 people 是单个字符串时，归一成数组而不是把值日条弄崩",
  JSON.stringify(outStr.duties[0].people));
check(outStr.duties[0].peopleFrom === "override", "套用临时换人后标明来源是覆盖层",
  String(outStr.duties[0].peopleFrom));

/* 老师名：被写成对象时存成人名；已经被腌成 "[object Object]" 的口子在写入时清掉。
   这条链是「显示故障 → 老师点确定 → 变成合法数据 → 再也洗不掉」。 */
S.resetConfig();
S.patchDayOverride("2026-11-23", { lessons: { 4: { subject: "语文", teacher: { name: "王老师" } } } });
check(S.getDayOverride("2026-11-23").lessons[4].teacher === "王老师",
  "临时调课的老师名是对象时，写入即成人名",
  JSON.stringify(S.getDayOverride("2026-11-23").lessons[4].teacher));
S.patchDayOverride("2026-11-23", { lessons: { 4: { subject: "语文", teacher: "[object Object]" } } });
check(S.getDayOverride("2026-11-23").lessons[4].teacher === "",
  "已经腌成 [object Object] 的老师名，再写入时清掉",
  JSON.stringify(S.getDayOverride("2026-11-23").lessons[4].teacher));
S.resetConfig();

/* ---------- 数据体检：形状没坏、只是「人对不上」的那类 ---------- */
S.resetConfig();
check(S.auditPeople().ok === true,
  "没录名单时不报「对不上」——那是还没填，不是错误");

S.patchConfig({ students: [{ id: "s01", name: "赵子墨", active: true },
                            { id: "s02", name: "钱嘉禾", active: true }] });
S.patchConfig({ peopleGroups: [{ id: "ga", name: "值日组", memberIds: ["s01", "name:查无此人"] }] });
var fixedKeys = S.fixGroupKeys();
check(fixedKeys.fixed === 1 && S.peopleGroups()[0].memberIds[0] === "name:赵子墨",
  "旧 id 编码就地换成姓名编码（换名单也不会整片丢人）",
  JSON.stringify(S.peopleGroups()[0].memberIds));

var audit = S.auditPeople();
check(audit.ok === false && audit.items.length === 1
      && audit.items[0].detail.indexOf("查无此人") >= 0,
  "对不上名单的成员列进体检清单，不静默丢", JSON.stringify(audit.items));

S.patchConfig({ roles: { roles: [{ id: "r1", name: "扫地", people: ["赵子墨", "王不存在"] }] } });
var audit2 = S.auditPeople();
check(audit2.items.some(function (i) { return i.kind === "role" && i.detail.indexOf("王不存在") >= 0; }),
  "岗位人员里对不上名单的名字也列出来", JSON.stringify(audit2.items));
S.resetConfig();

/* 常驻岗位（被选进「课间」等时段、freq=unset）：配置里没人时该是 unknown，
   老师今天指定了人之后，那一段的每一个时刻都必须显示这个人。
   真机反馈就是这条：「值日岗位选了某某学生，大屏下方展示该岗位却显示待定」。 */
const cfgTmp = JSON.parse(JSON.stringify({
  timetable: D.timetable, schedule: D.schedule, content: D.content,
  roles: D.roles, noon: D.noon, calendar: D.calendar
}));
cfgTmp.roles.roles.push({ id: "zz", name: "测试岗", freq: { kind: "unset" }, order: 1 });
cfgTmp.dutyPresents = { break: ["zz"] };
const dayTmp = SCH.buildDay(cfgTmp, "2026-11-23");
check(dayTmp.duties.filter(d => d.roleId === "zz").every(d => d.people === null && d.status === "unknown"),
  "常驻岗位配置里没人时是 unknown（大屏显示「待定」）",
  JSON.stringify(dayTmp.duties.filter(d => d.roleId === "zz").map(d => d.status)));

const dayOv = S.applyOverrides(dayTmp, { roles: { zz: { people: ["吴书瑶"] } } });
const zzOk = dayOv.duties.filter(d => d.roleId === "zz");
check(zzOk.length > 0
      && zzOk.every(d => Array.isArray(d.people) && d.people[0] === "吴书瑶" && d.status === "ok"),
  "常驻岗位今天指定了人，每一段都变成有名字（不再是待定）",
  JSON.stringify(zzOk.map(d => d.people)));

/* 打字母按姓氏拼音首字母找人（老师打字慢，能少打就少打） */
const pyList = [{ name: "张三" }, { name: "李四" }, { name: "赵五" }, { name: "王六" }, { name: "周七" }];
check(S.rankStudents(pyList, "z").map(s => s.name).join("、") === "张三、赵五、周七",
  "打 z 出所有姓张/赵/周的", S.rankStudents(pyList, "z").map(s => s.name).join("、"));
check(S.rankStudents(pyList, "L").map(s => s.name).join("、") === "李四",
  "大写字母也认", S.rankStudents(pyList, "L").map(s => s.name).join("、"));
check(S.rankStudents(pyList, "wang").map(s => s.name).join("、") === "王六",
  "多打几个字母仍按姓氏首字母找，不会突然一个都不出",
  S.rankStudents(pyList, "wang").map(s => s.name).join("、"));
check(S.rankStudents(pyList, "张").length === 1, "打汉字还是按名字包含匹配");
check(S.rankStudents([{ name: "欧阳光" }], "o").length === 1, "表里有这个姓就能按首字母找到");

/* 换人面板里「把 X 加进名单」。为了补一个人不该要求老师走完整个向导：
   那条路要点六层，而且入口叫「从岗位表导入」，老师根本找不到。 */
S.patchConfig({ students: [{ id: "s1", name: "张三", active: true }] });
var addNew = S.addStudent("李四");
check(addNew.ok && !addNew.existed && addNew.n === 2,
  "加进名单：新人入册", JSON.stringify(addNew));
check(S.rankStudents(S.config().students, "李", null, 8).map(function (s) { return s.name; }).join("、") === "李四",
  "加完之后打一个字就搜得到");
var addDup = S.addStudent("李四");
check(addDup.ok && addDup.existed && addDup.n === 2,
  "同一个人重复加不会变成两份", JSON.stringify(addDup));
check(!S.addStudent("   ").ok, "空名字被拒绝，不会往名单里塞空条目");
var addObj = S.addStudent({ name: "王五" });
check(addObj.ok && S.config().students.length === 3,
  "对象形状的姓名也能加（对象取 name）", JSON.stringify(addObj));

/* 删名单里的学生时，「要不要顺手从分组/岗位上清掉」由老师在弹框里勾。
   默认不清（删名单可撤销，清分组不可逆），勾了才走 prunePeople。 */
S.patchConfig({
  students: [{ name: "张三" }, { name: "李四" }, { name: "王五" }],
  peopleGroups: [{ id: "g1", name: "扫地组", names: ["张三", "李四"] }],
  roles: {
    roles: [
      { id: "z1", name: "扫地", people: ["张三", "王五"] },
      { id: "z2", name: "擦窗", people: ["李四"], groups: { "A 组": ["张三", "王五"] },
        peopleMap: { "1": "张三" } }
    ]
  }
});
var pr = S.prunePeople(["张三"]);
check(S.config().roles.roles[0].people.join("|") === "王五",
  "清掉岗位人员里的这个人", JSON.stringify(S.config().roles.roles[0].people));
check(S.config().roles.roles[1].groups["A 组"].join("|") === "王五"
      || S.config().roles.roles[1].groups["A 组"] === undefined,
  "岗位分组里也清掉", JSON.stringify(S.config().roles.roles[1].groups));
check(!(S.config().roles.roles[1].peopleMap || {})["1"],
  "按星期指定的人也清掉", JSON.stringify(S.config().roles.roles[1].peopleMap));
check(S.config().peopleGroups[0].names.join("|") === "李四",
  "人群组里也清掉", JSON.stringify(S.config().peopleGroups[0].names));
check(pr.roles > 0 && pr.groups > 0, "清理结果报回数量，界面才能说清动了什么",
  JSON.stringify(pr));
check(S.config().students.length === 3, "清理排班不动名单本身（名单由向导另一条路写）",
  String(S.config().students.length));

/* 当天临时调整里的指定人也一并清掉，不然「今天谁做」会指向一个已删掉的人 */
S.patchDayOverride("2026-11-23", { roles: { z1: { people: ["张三"] } } });
S.prunePeople(["张三"]);
check(!S.getDayOverride("2026-11-23").roles.z1,
  "当天临时调整里的人也清掉", JSON.stringify(S.getDayOverride("2026-11-23")));
S.clearDayOverride("2026-11-23");

/* 「名单是空的」和「还没有名单」是两件事。前者是老师把人都删了，
   屏上就该没人；后者才回落到班级数据。折在一起就会出现
   「全选删除 → 保存 → 48 个人又回来了」。 */
S.patchConfig({ students: [] });
check(Array.isArray(S.config().students) && S.config().students.length === 0,
  "空名单照存空数组，不被折成「没有名单」", JSON.stringify(S.config().students));
S.patchConfig({ students: null });
check(S.config().students === undefined, "显式置空才回到「没有名单」",
  JSON.stringify(S.config().students));

console.log("\n" + pass + "/" + (pass + fail) + " 通过");
process.exit(fail ? 1 : 0);
