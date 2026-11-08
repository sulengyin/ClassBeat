/* 配置向导的数据层测试：模板能不能算出一整天。
   node tools/test_setup.js
   这里只测纯数据（模板、校验），DOM 交互走浏览器 e2e。 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function check(ok, title, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + title + (detail ? "  · " + detail : ""));
  ok ? pass++ : fail++;
}

global.window = global;

/* 内存版 localStorage：B4a 要验证“写进去、读回来”和失败回滚 */
const mem = {};
global.localStorage = {
  getItem(k) { return mem[k] === undefined ? null : mem[k]; },
  setItem(k, v) { mem[k] = String(v); },
  removeItem(k) { delete mem[k]; }
};

global.RHYTHM_DATA = {
  texts: { reminders: { default: "戴好红领巾，打扫好个人卫生" } },
  meta: { klass: "五（1）班" }
};

function load(f) {
  new Function(fs.readFileSync(path.join(ROOT, f), "utf8"))();
}
load("app/templates.js");
load("app/setup.js");
load("app/store.js");

/* 和 runtime.js 同样的合并顺序：本机优先，包内兜底 */
const BAKED = { meta: { klass: "五（1）班" }, roles: null };
global.Screen = { render() {} };
global.Runtime = {
  config() {
    const o = global.Store.config();
    const pick = k => o[k] !== undefined ? o[k] : BAKED[k];
    return {
      meta: Object.assign({}, BAKED.meta, o.meta || {}),
      timetable: pick("timetable"), schedule: pick("schedule"),
      content: pick("content"), roles: pick("roles"), noon: pick("noon")
    };
  },
  patch(p) { global.Store.patchConfig(p); },
  reload() {},
  ready() { return true; }
};

const T = global.RHYTHM_TEMPLATES;
check(Array.isArray(T) && T.length === 3, "三套作息模板都在", T && T.length);

function m(t) {
  const p = String(t).split(":").map(Number);
  return p[0] * 60 + p[1];
}

T.forEach(tpl => {
  const tag = tpl.label;
  const b = tpl.blocks;

  let gap = null, back = null;
  for (let i = 0; i < b.length; i++) {
    if (m(b[i].start) >= m(b[i].end)) back = b[i];
    if (i && b[i].start !== b[i - 1].end) gap = i + 1;
  }
  check(!gap && !back, tag + "：首尾相接、时间递增",
    gap ? "第 " + gap + " 段有缝" : (back ? "第 " + (b.indexOf(back) + 1) + " 段倒置" : b.length + " 段"));

  const cls = b.filter(x => x.type === "class").map(x => +x.periodNo).sort((a, c) => a - c);
  check(cls.length === 7 && cls.every((v, i) => v === i + 1),
    tag + "：正好 7 节正课", cls.join(","));

  const noon = b.filter(x => x.type === "noon")[0];
  check(!!noon && tpl.noonBand.lunchEnd === noon.start && tpl.noonBand.noonEnd === noon.end,
    tag + "：午间时间带和午间块对得上",
    noon ? noon.start + "–" + noon.end : "缺午间块");

  check(b[0].type === "reading" && b[0].start === "07:30" && b[0].end === "08:10",
    tag + "：早读 07:30–08:10", b[0].start + "–" + b[0].end);

  const marks = (tpl.marks || []).map(x => x.kind).sort().join(",");
  check(marks === "arrive,dismiss", tag + "：到校和放学两个标记都有", marks);
});

check(m(T[1].blocks[T[1].blocks.length - 1].end) < m(T[0].blocks[T[0].blocks.length - 1].end) &&
      m(T[0].blocks[T[0].blocks.length - 1].end) < m(T[2].blocks[T[2].blocks.length - 1].end),
  "35 / 40 / 45 分钟课的放学时间依次推后",
  T.map(t => t.blocks[t.blocks.length - 1].end).join(" → "));

/* 校验：空、缝隙、倒置 */
const S = global.Setup;
check(Object.keys(S._errors([])).length === 0, "空作息不报错");
check(Object.keys(S._errors(T[0].blocks)).length === 0, "模板本身通过校验");

const gapBlocks = JSON.parse(JSON.stringify(T[0].blocks));
gapBlocks[3].start = "09:05";
check(Object.keys(S._errors(gapBlocks)).length === 1, "中间留缝只指那一段",
  JSON.stringify(S._errors(gapBlocks)));

const backBlocks = JSON.parse(JSON.stringify(T[0].blocks));
backBlocks[2].end = backBlocks[2].start;
const backErrs = S._errors(backBlocks);
check(!!backErrs[2], "结束等于开始算倒置", JSON.stringify(backErrs));

/* ---------- B4a：岗位 / 文案 ---------- */
const S2 = global.Setup;
const STORE = global.Store;
const roleSet = JSON.parse(fs.readFileSync(path.join(ROOT, "sample/roles.json"), "utf8"));
const clone = v => JSON.parse(JSON.stringify(v));

check(/不产生提醒/.test(S2._freqText({ kind: "unset" })), "unset 岗位明确说不产生提醒",
  S2._freqText({ kind: "unset" }));
check(S2._freqText({ kind: "daily", times: ["07:50"] }).indexOf("07:50") >= 0,
  "有频率的岗位照实显示时间");

const edited = S2._editRole(roleSet, "r01", "duty", "改成新的职责");
const r01 = edited.roles.filter(r => r.id === "r01")[0];
const r01old = roleSet.roles.filter(r => r.id === "r01")[0];
check(r01.duty === "改成新的职责" && r01.name === "路队长"
      && r01.people.length === 2 && r01.freq.kind === "event" && r01.order === 90,
  "岗位只改职责：ID / 名称 / 人员 / 频率 / 顺序都不动", r01.duty);
check(edited.roles.length === roleSet.roles.length, "岗位数量不变", String(edited.roles.length));
check(r01old.duty === "提醒静齐排队，清点人数，有序进场", "原岗位对象没有被就地改掉");
check(S2._roleChangedCount(edited, roleSet) === 1, "改动计数按字段算", String(S2._roleChangedCount(edited, roleSet)));

const baseTexts = {
  reminders: { default: "戴好红领巾", 1: "周一提醒" },
  stage: { before: { title: "早上好", note: "交作业" } },
  reading: { 1: { subject: "语文", task: "读第 5 课" } }
};
const curTexts = clone(baseTexts);
curTexts.reminders.default = "换了提醒";
delete curTexts.stage;
const tp = S2._textPatch(curTexts, baseTexts);
check(tp.reminders && tp.reminders.default === "换了提醒" && tp.reminders[1] === "周一提醒",
  "文案只提交改过的组，组内没改的键还在");
check(tp.stage === null, "清空整组时提交 null");
check(!("reading" in tp), "没动过的组不提交");

const baseBreak = { breakTitle: "课间", prepLabel: "准备好" };
const curBreak = { breakTitle: "歇一会儿", prepLabel: "准备好", breakActions: ["喝水", "上厕所"] };
const tpBreak = S2._textPatch(curBreak, baseBreak);
check(tpBreak.breakTitle === "歇一会儿" && tpBreak.breakActions.length === 2
      && !("prepLabel" in tpBreak), "课间 3 项按项比较，没改的不提交");
check(S2._textPatch({ breakTitle: "" }, baseBreak).breakTitle === null, "清空大字提交 null");

check(STORE.textsLocal() === null, "没改过时本机文案是空的");
STORE.setTextsLocal({ reminders: { default: "本机改过" } });
check(STORE.textsLocal().reminders.default === "本机改过", "原始文案能原样读回");
check(STORE.texts().reminders.default === "本机改过", "生效文案优先用本机改动");

STORE.patchTexts({ reminders: { default: "再改一次", 1: "周一提醒" } });
check(STORE.textsLocal().reminders.default === "再改一次"
      && STORE.textsLocal().reminders[1] === "周一提醒",
  "patchTexts 仍是“从当前生效文案起步”的合并语义");

STORE.setupSnapshot({ savedAt: "t", roles: { id: "x" }, texts: { a: 1 } });
check(STORE.setupSnapshot().roles.id === "x" && STORE.setupSnapshot().texts.a === 1,
  "快照能存能取");
STORE.setupSnapshot(null);
check(STORE.setupSnapshot() === null, "快照能清空");

const okRoles = S2._editRole(roleSet, "r02", "name", "省电小队长");
check(S2._commit(okRoles, { reminders: { default: "新提醒" } }) === true, "岗位和文案能写入");
check(global.Runtime.config().roles.roles[1].name === "省电小队长", "写入后读回岗位一致");
check(STORE.textsLocal().reminders.default === "新提醒", "写入后读回文案一致");
check(!!STORE.setupSnapshot().savedAt, "写入前留了快照");

const beforeRoles = clone(global.Runtime.config().roles);
const origPatch = STORE.patchTexts;
STORE.patchTexts = function () { throw new Error("quota"); };
const failOk = S2._commit(S2._editRole(okRoles, "r03", "name", "不该生效"), { reminders: { default: "不该写进去" } });
STORE.patchTexts = origPatch;
check(failOk === false, "写入失败返回 false");
check(JSON.stringify(global.Runtime.config().roles) === JSON.stringify(beforeRoles),
  "失败时岗位回到写入前");
check(STORE.textsLocal().reminders.default === "新提醒", "失败时文案回到写入前");

STORE.setTextsLocal({ reminders: { default: "独自改的" } });
STORE.patchTexts({ reminders: null });
check(STORE.texts().reminders.default === "戴好红领巾，打扫好个人卫生",
  "清空组后回落到包内默认");

console.log("\n" + pass + "/" + (pass + fail) + " 通过");
process.exit(fail ? 1 : 0);
