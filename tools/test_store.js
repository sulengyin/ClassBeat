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
  "本机只改过早读，包里新加的提醒事项仍然生效",
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
  "改一项文字不会抹掉包里烤好的早读和提醒", JSON.stringify(baked));
S.resetTexts();
delete D.texts;

/* ---------- 验证码 ---------- */
var okShape = true;
for (var j = 0; j < 30; j++) {
  var c = S.makeChallenge();
  if (!(c.a >= 102 && c.a <= 989 && c.b >= 2 && c.b <= 9 && c.answer === c.a * c.b)) okShape = false;
}
check(okShape, "验证码是三位数 × 一位数", "30 次抽样");

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

var badGroups = JSON.parse(JSON.stringify(S.exportAll()));
badGroups.config.peopleGroups = [{ name: "坏人", memberIds: "s01" }];
check(S.importAll(badGroups).ok === false,
  "人群组格式不对时整份拒绝导入", "memberIds 不是数组");
var goodGroups = JSON.parse(JSON.stringify(S.exportAll()));
goodGroups.config.peopleGroups = [
  { id: "g9", name: "值日组", source: "manual", memberIds: ["s01"] }
];
check(S.importAll(goodGroups).ok === true && S.peopleGroups().length === 1,
  "合法人群组能随备份恢复", "1 条");
S.resetConfig();

/* ---------- 配置版本：老备份原地升级，更高版本整份拒绝 ---------- */
check(S.schemaVersion() === 1, "本机配置版本是 1", String(S.schemaVersion()));
check(S.exportAll().schemaVersion === 1, "导出文件带版本号", "schemaVersion");

var legacy = S.exportAll();
delete legacy.schemaVersion;
legacy.config = { meta: { klass: "旧版班级" }, students: ["同学甲"] };
var legacyRes = S.importAll(legacy);
check(legacyRes.ok === true, "没有版本号的旧备份能导入", legacyRes.why || "");
check(S.schemaVersion() === 1 && S.config().meta.klass === "旧版班级",
  "导入旧备份后补上版本号，配置原样保留",
  "v" + S.schemaVersion() + "/" + S.config().meta.klass);

var future = S.exportAll();
future.schemaVersion = 99;
var futureRes = S.importAll(future);
check(futureRes.ok === false && S.config().meta.klass === "旧版班级",
  "更高版本的备份整份拒绝，不动现有配置", futureRes.why || "");

S.resetConfig();
check(S.schemaVersion() === 1, "重置配置不回退版本号", "v" + S.schemaVersion());

console.log("\n" + pass + "/" + (pass + fail) + " 通过");
process.exit(fail ? 1 : 0);
