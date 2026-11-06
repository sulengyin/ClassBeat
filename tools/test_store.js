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

/* ---------- 验证码 ---------- */
var okShape = true;
for (var j = 0; j < 30; j++) {
  var c = S.makeChallenge();
  if (!(c.a >= 102 && c.a <= 989 && c.b >= 2 && c.b <= 9 && c.answer === c.a * c.b)) okShape = false;
}
check(okShape, "验证码是三位数 × 一位数", "30 次抽样");

console.log("\n" + pass + "/" + (pass + fail) + " 通过");
process.exit(fail ? 1 : 0);
