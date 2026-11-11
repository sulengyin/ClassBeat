/* 配置向导的数据层测试：模板能不能算出一整天。
   node tools/test_setup.js
   这里只测纯数据（模板、校验），DOM 交互走浏览器 e2e。 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
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
  meta: { klass: "五（1）班" },
  students: JSON.parse(fs.readFileSync(path.join(ROOT, "sample/students.json"), "utf8")).students
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
    tag + "：晨间自主管理 07:30–08:10", b[0].start + "–" + b[0].end);

  const marks = (tpl.marks || []).map(x => x.kind).sort().join(",");
  check(marks === "arrive,dismiss", tag + "：到校和放学两个标记都有", marks);
});

check(m(T[1].blocks[T[1].blocks.length - 1].end) < m(T[0].blocks[T[0].blocks.length - 1].end) &&
      m(T[0].blocks[T[0].blocks.length - 1].end) < m(T[2].blocks[T[2].blocks.length - 1].end),
  "35 / 40 / 45 分钟课的放学时间依次推后",
  T.map(t => t.blocks[t.blocks.length - 1].end).join(" → "));

/* ---------- B5：首次启动 ---------- */
const S = global.Setup;
const savedReady = global.Runtime.ready;
global.Runtime.ready = () => false;
check(S._needsSetup() === true, "缺作息 / 课表时自动进向导");
global.Runtime.ready = () => true;
check(S._needsSetup() === false, "配置齐了不打扰老师");
global.Runtime.ready = savedReady;

/* 空包：没有 blocks 时先套第一套模板，第二步不是一张空表 */
const savedCfg = global.Runtime.config;
global.Runtime.config = () => ({});
const blank = S._loadCurrent();
global.Runtime.config = savedCfg;
check(blank.blocks.length > 20 && blank.tplId === T[0].id,
  "空配置默认套上第一套模板", blank.tplId + " / " + blank.blocks.length + " 段");
check(blank.klass === "" && blank.entries.length === 0 && blank.roles === null,
  "空配置不带别人的班名、课表和岗位");

/* 校验：空、缝隙、倒置 */
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

/* 回归：执行频率里的时间也要能改（r03 这类 daily 岗位） */
const freqEdited = S2._editRoleFreqTimes(roleSet, "r03", ["11:50"]);
const r03e = freqEdited.roles.filter(r => r.id === "r03")[0];
const r03o = roleSet.roles.filter(r => r.id === "r03")[0];
check(r03e.freq.times[0] === "11:50" && r03e.freq.kind === "daily",
  "岗位执行频率里的时间可以改，kind 保留", r03e.freq.times.join("、"));
check(r03o.freq.times[0] === "11:45", "原岗位对象没有被就地改掉",
  r03o.freq.times.join("、"));
check(JSON.stringify(r03e.people) === JSON.stringify(r03o.people),
  "改时间不动人员");
check(S2._roleChangedCount(freqEdited, roleSet) === 1,
  "只改时间也计入改动，确认页会说要写入",
  String(S2._roleChangedCount(freqEdited, roleSet)));

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

/* ---------- B4b：岗位表导入与辅助识别 ---------- */
const S3 = global.Setup;
const ROSTER = global.RHYTHM_DATA.students.filter(s => s.active !== false).map(s => s.name);

const csvText = "岗位,职责,负责人\n路队长,提醒静齐排队,孙星野、孔子墨\n图书角管理员,整理图书角,周予宁";
const pCsv = S3._parseImport(csvText, ROSTER, roleSet);
check(pCsv.format === "csv" && pCsv.rows.length === 2, "CSV：识别两行岗位",
  pCsv.format + " / " + pCsv.rows.length);
check(pCsv.rows[0].name === "路队长" && pCsv.rows[0].duty === "提醒静齐排队"
      && pCsv.rows[0].targetId === "r01", "CSV：命中现有岗位，只改名称/职责");
check(pCsv.rows[0].people.every(p => p.state === "exact"), "CSV：人员精确命中名册",
  pCsv.rows[0].people.map(p => p.state).join(","));
check(pCsv.rows[1].targetId === null, "CSV：表上没有的岗位标为新增");

const tsvText = "项目\t职责\tA组\tB组\n擦黑板\t擦黑板槽\t孙星野\t孔子墨";
const pTsv = S3._parseImport(tsvText, ROSTER, roleSet);
check(pTsv.format === "tsv" && pTsv.rows.length === 1, "TSV：制表符分列");
check(pTsv.rows[0].people.length === 2 && pTsv.rows[0].people.every(p => p.state === "exact"),
  "TSV：A/B 组都拿来核对");
check(pTsv.rows[0].pending.indexOf("A/B 组未拆分") >= 0, "TSV：A/B 组标待确认，不擅自拆");

const mdText = "| 岗位 | 职责 | 负责人 |\n| --- | --- | --- |\n| 节能小队长 | 记得关灯 | 吕雨桐 |";
const pMd = S3._parseImport(mdText, ROSTER, roleSet);
check(pMd.format === "markdown" && pMd.rows.length === 1
      && pMd.rows[0].targetId === "r02", "Markdown 表格：跳过表头和分隔行", pMd.format);

const htmlText = "<table><tr><th>岗位</th><th>职责</th><th>负责人</th></tr>"
  + "<tr><td>窗户小管家</td><td>擦窗台</td><td>周予安</td></tr></table>";
const pHtml = S3._parseImport(htmlText, ROSTER, roleSet);
check(pHtml.format === "html" && pHtml.rows.length === 1
      && pHtml.rows[0].people[0].state === "exact", "Excel 复制的 HTML 表格能读",
  pHtml.format + " / " + pHtml.rows.length);

/* Word 表格复制出来的是更臃肿的 HTML：无 th、单元格里套 <p><span>、带 &nbsp; */
const wordHtml = '<html xmlns:o="urn:schemas-microsoft-com:office:office">'
  + '<head><meta charset="utf-8"><style>p.MsoNormal{margin:0}</style></head>'
  + '<body><div class=WordSection1><table class=MsoNormalTable border=0 cellspacing=0 cellpadding=0>'
  + '<tr><td width=90 valign=top><p class=MsoNormal><span>岗位</span></p></td>'
  + '<td width=120><p class=MsoNormal><span>职责</span></p></td>'
  + '<td width=100><p class=MsoNormal><span>负责人</span></p></td></tr>'
  + '<tr><td><p class=MsoNormal><span>路队长</span></p></td>'
  + '<td><p class=MsoNormal><span>提醒&nbsp;静齐排队</span></p></td>'
  + '<td><p class=MsoNormal><span>孙星野、孔子墨</span></p></td></tr>'
  + '</table></div></body></html>';
const pWord = S3._parseImport(wordHtml, ROSTER, roleSet);
check(pWord.format === "html" && pWord.rows.length === 1
      && pWord.rows[0].name === "路队长" && pWord.rows[0].duty === "提醒 静齐排队",
  "Word 表格复制的 HTML 能读，单元格里的 <p><span> 会被剥掉",
  pWord.format + " / " + pWord.rows.length + " / " + (pWord.rows[0] && pWord.rows[0].duty));
check(pWord.rows[0].people.length === 2
      && pWord.rows[0].people.every(p => p.state === "exact"),
  "Word 表格里的姓名同样拿名册核对");
check(pWord.rows[0].targetId === "r01", "Word 表格同样能命中现有岗位");

const jsonText = JSON.stringify([{ name: "讲台小助手", duty: "每节课擦讲台", people: ["赵子墨"] }]);
const pJson = S3._parseImport(jsonText, ROSTER, roleSet);
check(pJson.format === "json" && pJson.rows.length === 1
      && pJson.rows[0].name === "讲台小助手" && pJson.rows[0].duty === "每节课擦讲台",
  "JSON：对象数组按字段名识别", pJson.format);
check(pJson.rows[0].people[0].state === "exact", "JSON：人员仍然拿名册核对");

const plainText = "路队长：孙星野、孔子墨\n图书角管理员（整理图书角）：周予宁";
const pPlain = S3._parseImport(plainText, ROSTER, roleSet);
check(pPlain.format === "text" && pPlain.rows.length === 2, "纯文本：每行一个岗位",
  pPlain.format + " / " + pPlain.rows.length);
check(pPlain.rows[0].name === "路队长" && pPlain.rows[0].duty === ""
      && pPlain.rows[0].people.length === 2, "纯文本：冒号后是人员");
check(pPlain.rows[1].duty === "整理图书角", "纯文本：括号里的职责能拆出来");

const four = S3._matchPeople("孙星野、孔子默、王小明", ROSTER);
check(four[0].state === "exact" && four[1].state === "typo" && four[2].state === "missing",
  "四态：精确 / 疑似错字 / 未找到", four.map(x => x.state).join(","));
check(four[1].suggestion === "孔子墨", "疑似错字给出唯一候选", four[1].suggestion);
const same = S3._matchPeople("李青禾", ["李青禾", "李青禾"]);
check(same[0].state === "same", "名册里两个同名：标同名，不擅自选一个");

const numbered = S3._parseImport("擦窗台小助手：1 周予宁 / 2 赵子墨", ROSTER, roleSet);
check(numbered.rows[0].pending.indexOf("编号未解释") >= 0, "数字只当编号，标待确认");
check(numbered.rows[0].people.every(p => p.state === "exact" && p.numbered),
  "编号剥掉后姓名仍能精确核对，编号只记在草稿元数据里");
check(S3._parseImport("1\n2\n3", ROSTER, roleSet).rows.length === 0,
  "只有序号的表不生成岗位");

const beforeRoster = JSON.stringify(ROSTER);
const pMissing = S3._parseImport("岗位,职责,负责人\n新岗位,职责,王小明", ROSTER, roleSet);
const mMissing = S3._mergeRoleImport(roleSet, pMissing.rows);
const missingRole = mMissing.roles.roles.filter(r => r.name === "新岗位")[0];
check(mMissing.added === 1 && missingRole && missingRole.people.length === 0,
  "未找到的学生不写入，也不自动新增学生");
check(JSON.stringify(ROSTER) === beforeRoster, "名册没有被导入改动");
check(JSON.stringify(global.RHYTHM_DATA.students).indexOf("王小明") < 0, "RHYTHM_DATA 里没有凭空加学生");

const beforeRoleSet = JSON.stringify(roleSet);
const mergedCsv = S3._mergeRoleImport(roleSet, pCsv.rows);
const mR01 = mergedCsv.roles.roles.filter(r => r.id === "r01")[0];
const mNew = mergedCsv.roles.roles.filter(r => r.name === "图书角管理员")[0];
check(mergedCsv.updated === 1 && mergedCsv.added === 1, "合并：更新一个、新增一个",
  mergedCsv.updated + " / " + mergedCsv.added);
check(mR01.duty === "提醒静齐排队" && mR01.people.length === 2
      && mR01.freq.kind === "event" && mR01.order === 90,
  "命中现有岗位：只改职责，人员/频率/顺序原样保留");
check(mNew && mNew.freq.kind === "unset" && mNew.people.length === 1
      && mNew.people[0] === "周予宁" && mNew.assign === "fixed" && mNew.grp === null,
  "新增岗位：freq=unset，人员只写核对通过的", mNew && JSON.stringify(mNew));
check(JSON.stringify(roleSet) === beforeRoleSet, "合并不会就地改掉原岗位对象");
check(S3._addedRoleCount(mergedCsv.roles, roleSet) === 1, "新增岗位计数正确");

const againRows = pCsv.rows.map(r => Object.assign({}, r, { applied: true }));
const again = S3._mergeRoleImport(mergedCsv.roles, againRows);
check(again.updated === 0 && again.added === 0,
  "已并入的行再点一次也不会重复更新或重复新增");

const mergedNumbered = S3._mergeRoleImport(roleSet, numbered.rows);
const numRole = mergedNumbered.roles.roles.filter(r => r.name === "擦窗台小助手")[0];
check(numRole && numRole.people.length === 2 && !numRole.peopleMap,
  "编号没有变成周几映射，也没有写进 roles.json");

const mergedJson = JSON.stringify(mergedCsv.roles.roles);
check(!/"pending"|"confidence"|"raw"|"selected"|"targetId"|"state"/.test(mergedJson),
  "识别元数据只留草稿，不写进岗位对象");
check(!/"source"\s*:\s*"import"/.test(mergedJson), "岗位对象不带导入来源标记");

/* ---------- B4b：名册修正（只作用于核对，不写回班级数据） ---------- */
const rosterBase = S3._rosterNames().slice();
const r1 = S3._saveRoster("孙星野\n孔子墨\n李青禾\n李青禾");
check(r1.ok && r1.n === 4, "修正名单写进本机配置", JSON.stringify(r1));
check(S3._rosterNames().join("|") === "孙星野|孔子墨|李青禾|李青禾",
  "核对用的是修正后的名单", S3._rosterNames().join("|"));
check(STORE.config().students[2].id === "s04"
      && STORE.config().students[2].name === "李青禾", "原名单里的 id 保留下来");
const r2 = S3._saveRoster("1. 孙星野\n\n   \n2、孔子墨");
check(r2.ok && r2.n === 2 && S3._rosterNames().join("|") === "孙星野|孔子墨",
  "行首编号剥掉、空行忽略", S3._rosterNames().join("|"));
const r3 = S3._saveRoster("  \n");
check(!r3.ok && r3.why.indexOf("一个姓名") >= 0, "空名单被拒绝", r3.why);
check(S3._rosterNames().join("|") === "孙星野|孔子墨", "拒绝时不改动原名单");
STORE.patchConfig({ students: null });
check(S3._rosterNames().join("|") === rosterBase.join("|"), "恢复班级名单");

/* ---------- 作息表 / 班级课表识别 ---------- */
const timeRows = S3._parseTimeRows(
  "时间安排\t内 容\n" +
  "8:10—8:50\t第 一 节\n" +
  "8:50—9:20\t大课间（升旗仪式）\n" +
  "9:20—10:00\t第 二 节\n" +
  "10:00-10:05\t眼保健操\n" +
  "10:15—10:55\t第 三 节\n" +
  "11:10—11:30\t第 四 节\n" +
  "午餐、午休：11:50-13:00\n" +
  "13:10—13:50\t第 五 节\n" +
  "13:50—13:55\t眼保健操\n" +
  "14:05—14:45\t第 六 节\n" +
  "14:45—15:15\t大课间\n" +
  "15:15—15:50\t第 七 节\n" +
  "16:00—16:40\t课后服务第一时段\n" +
  "16:50—17:30\t课后服务第二时段");
check(timeRows.length === 14, "作息表读到 14 行", String(timeRows.length));

const tb = S3._blocksFromTimeRows(timeRows);
check(!tb.bad, "作息表能直接套用", tb.bad);
const classBlocks = tb.blocks.filter(b => b.type === "class");
check(classBlocks.length === 7, "七节正课都在", String(classBlocks.length));
check(classBlocks[0].start === "08:10" && classBlocks[6].end === "15:50",
  "第一节到第七节首尾对上", classBlocks[0].start + "-" + classBlocks[6].end);
const mealB = tb.blocks.filter(b => b.type === "meal")[0];
check(mealB.start === "11:50" && mealB.end === "13:00" && mealB.name === "午餐、午休",
  "午餐、午休照表上的 11:50–13:00 整段保留", mealB.start + "-" + mealB.end);
check(tb.blocks.filter(b => b.type === "noon").length === 0,
  "表里没单写午休，就不再编一个午间段");
check(tb.blocks.every((b, i) => i === 0 || b.start === tb.blocks[i - 1].end),
  "空档都补成了课间，整表首尾相接");
check(tb.blocks.some(b => b.type === "break" && b.start === "10:05" && b.end === "10:15"),
  "10:05–10:15 的空档补成课间");
const band = S3._noonBandOf(tb.blocks);
check(band && band.lunchEnd === "13:00" && band.bell === "13:00" && band.noonEnd === "13:00",
  "午间分界点落在表写的段尾，不另编起点", JSON.stringify(band));
const twoRows = S3._blocksFromTimeRows(S3._parseTimeRows(
  "11:50—12:20\t午餐\n12:20—13:00\t午休"));
check(twoRows.blocks.filter(b => b.type === "meal")[0].end === "12:20"
      && twoRows.blocks.filter(b => b.type === "noon")[0].start === "12:20",
  "表上分两行写时按两段来");
const band2 = S3._noonBandOf(twoRows.blocks);
check(band2.lunchEnd === "12:20" && band2.bell === "12:20" && band2.noonEnd === "13:00",
  "两行写法算出的午间分界点", JSON.stringify(band2));
const noClass = S3._blocksFromTimeRows(S3._parseTimeRows("8:10—8:50\t早点"));
check(noClass.bad.length > 0 && noClass.blocks.length === 0, "没有节次的表不当作息用", noClass.bad);
check(Object.keys(S3._blockErrors(tb.blocks)).length === 0,
  "导入的作息能过向导自己的校验（首尾相接）",
  JSON.stringify(S3._blockErrors(tb.blocks)));
const clash = S3._blocksFromTimeRows(S3._parseTimeRows(
  "8:10—8:50\t第 一 节\n8:40—9:20\t第 二 节"));
check(clash.bad.indexOf("重叠") >= 0, "时间段重叠时整表不应用", clash.bad);

const grid = S3._gridCellRows(
  "周一\t周二\t周三\t周四\t周五\n" +
  "第 1 节 8:10—8:50\t英语 张明\t语文 王华\t语文 王华\t语文 王华\t数学 李强\n" +
  "第 4 节\t劳综短课 张明\t劳综短课 张明\t五年级选修\t书法 王华\t书法 王华\n" +
  "第 7 节\t音乐 赵敏\t美术 钱红\t信息 李强\t音乐 赵敏\t心理/班队 孙丽（双周）/李强");
const g = S3._gridFromRows(grid);
check(!g.bad && g.entries.length === 15, "课表读到 15 格", String(g.entries.length));
check(g.entries.filter(e => e.weekday === 1 && e.periodNo === 7)[0].subject === "音乐",
  "科目只取格子第一段，老师不混进来");
check(g.entries.filter(e => e.weekday === 5 && e.periodNo === 7)[0].subject === "心理/班队",
  "「心理/班队」按原样保留");
check(g.entries.filter(e => e.weekday === 1 && e.periodNo === 1)[0].teacher === "张明",
  "格子第二行的任课老师跟着这一格存");
check(g.entries.filter(e => e.weekday === 5 && e.periodNo === 7)[0].teacher === "孙丽（双周）/李强",
  "两位老师轮流上课时两位名字都留");
check(g.entries.filter(e => e.weekday === 3 && e.periodNo === 4)[0].teacher === undefined,
  "没有任课老师的格子不硬塞老师字段");
check(g.entries.filter(e => e.weekday === 3 && e.periodNo === 4)[0].subject === "五年级选修",
  "「五年级选修」不当成老师名");
check(S3._gridFromRows(S3._gridCellRows("第 1 节\t英语\t语文")).bad.indexOf("周一") >= 0,
  "缺表头时拒绝");

const multiRole = S3._gridFromRows(S3._gridCellRows(
  "周一\t周二\t周三\n" +
  "第 1 节\t英语 张三\t数学 张三\t数学 张三/李四（单双周）"));
const subjOf = w => multiRole.entries.filter(e => e.weekday === w)[0].subject;
check(subjOf(1) === "英语" && subjOf(2) === "数学",
  "同一个老师教两科：科目只看那个时间段的格子，不按老师身份推断",
  subjOf(1) + "/" + subjOf(2));
check(subjOf(3) === "数学", "两位老师轮流上同一门课，科目不变", subjOf(3));
check(multiRole.entries.filter(e => e.weekday === 3)[0].teacher === "张三/李四（单双周）",
  "轮流上课的两位老师原样留在这一格");

/* ---------- B4b：.xlsx / .docx 文件直读 ----------
   .xlsx/.docx 都是 ZIP + XML。这里手搓最小 ZIP（一份 deflate、一份 stored），
   覆盖解压路径和“只存不压”路径，再把读出来的 TSV 交给 parseImport 验证四态。 */
function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  entries.forEach(e => {
    const name = Buffer.from(e.name, "utf8");
    const body = Buffer.from(e.body);
    const data = e.method === 8 ? zlib.deflateRawSync(body) : body;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.method || 0, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.method || 0, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(body.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}

const SS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const xlsxZip = makeZip([
  { name: "xl/workbook.xml", method: 8, body:
    '<?xml version="1.0"?><workbook ' + SS + '><sheets>'
    + '<sheet name="岗位表" sheetId="1" r:id="rId1"/></sheets></workbook>' },
  { name: "xl/_rels/workbook.xml.rels", method: 8, body:
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>'
    + '</Relationships>' },
  { name: "xl/sharedStrings.xml", method: 8, body:
    '<sst ' + SS + '>'
    + '<si><t>岗位</t></si><si><t>职责</t></si><si><t>负责人</t></si>'
    + '<si><t>路队长</t></si><si><t>提醒静齐排队</t></si><si><t>孙星野、孔子墨</t></si>'
    + '<si><t>图书角管理员</t></si><si><t>整理图书角</t></si><si><t>周予宁</t></si>'
    + '</sst>' },
  { name: "xl/worksheets/sheet1.xml", method: 8, body:
    '<worksheet ' + SS + '><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row>'
    + '<row r="3"><c r="A3" t="s"><v>6</v></c><c r="B3" t="s"><v>7</v></c>'
    + '<c r="C3" t="inlineStr"><is><t>周予宁</t></is></c></row>'
    + '</sheetData></worksheet>' }
]);

const docxZip = makeZip([
  { name: "word/document.xml", method: 0, body:
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:tbl>'
    + '<w:tr><w:tc><w:p><w:r><w:t>岗位</w:t></w:r></w:p></w:tc>'
    + '<w:tc><w:p><w:r><w:t>职责</w:t></w:r></w:p></w:tc>'
    + '<w:tc><w:p><w:r><w:t>负责人</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>窗户小管家</w:t></w:r></w:p></w:tc>'
    + '<w:tc><w:p><w:r><w:t>擦</w:t></w:r><w:r><w:t>窗台</w:t></w:r></w:p></w:tc>'
    + '<w:tc><w:p><w:r><w:t>周予安</w:t></w:r></w:p></w:tc></w:tr>'
    + '</w:tbl>'
    + '<w:p><w:r><w:t>表格外的说明不算岗位</w:t></w:r></w:p>'
    + '</w:body></w:document>' }
]);

const docxPlainZip = makeZip([
  { name: "word/document.xml", method: 0, body:
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:t>路队长：孙星野、孔子墨</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>图书角管理员</w:t></w:r><w:r><w:tab/></w:r>'
    + '<w:r><w:t>周予宁</w:t></w:r></w:p>'
    + '</w:body></w:document>' }
]);

async function readFail(buf, name) {
  try {
    await S3._readOfficeFile(buf, name);
    return "";
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
}

(async function () {
  const x = await S3._readOfficeFile(xlsxZip, "岗位表.xlsx");
  check(x.format === "xlsx" && x.sheetName === "岗位表",
    "xlsx：读到第一个工作表的名字", x.sheetName);
  const xLines = x.text.split("\n");
  check(xLines.length === 3 && xLines[0].split("\t").join("|") === "岗位|职责|负责人",
    "xlsx：sharedStrings 与列引用还原成 TSV", xLines[0] && xLines[0].split("\t").join("|"));
  check(xLines[2].split("\t")[2] === "周予宁", "xlsx：inlineStr 单元格也能读");
  const pXlsx = S3._parseImport(x.text, ROSTER, roleSet);
  check(pXlsx.format === "tsv" && pXlsx.rows.length === 2,
    "xlsx 读出的 TSV 能继续识别岗位", pXlsx.format + " / " + pXlsx.rows.length);
  check(pXlsx.rows[0].targetId === "r01" && pXlsx.rows[0].people.every(p => p.state === "exact"),
    "xlsx：岗位命中现有、姓名精确核对");

  const d = await S3._readOfficeFile(docxZip, "岗位表.docx");
  check(d.format === "docx" && d.text.split("\n").length === 2,
    "docx：取文档里最大的表格", d.text);
  const pDocx = S3._parseImport(d.text, ROSTER, roleSet);
  check(pDocx.rows.length === 1 && pDocx.rows[0].name === "窗户小管家"
        && pDocx.rows[0].duty === "擦窗台",
    "docx：多个 w:t 拼回一个单元格，表格外的段落被忽略",
    pDocx.rows[0] && JSON.stringify([pDocx.rows[0].name, pDocx.rows[0].duty]));
  check(pDocx.rows[0].people.length === 1 && pDocx.rows[0].people[0].state === "exact",
    "docx：姓名仍然拿名册核对");

  const dp = await S3._readOfficeFile(docxPlainZip, "没有表格.docx");
  check(dp.text.split("\n").length === 2, "docx：没有表格时退化成段落行", dp.text);
  check(dp.text.split("\n")[1].indexOf("\t") > 0, "docx 段落里的 w:tab 保留成列分隔");
  const pDp = S3._parseImport(dp.text, ROSTER, roleSet);
  check(pDp.rows.length === 2 && pDp.rows[1].people.length === 1
        && pDp.rows[1].people[0].state === "exact",
    "docx 段落行：姓名列没有并进岗位名");
  check((await S3._readOfficeFile(xlsxZip, "岗位表.XLSX")).format === "xlsx",
    "扩展名大写也能判断");

  check((await readFail(Buffer.from("not a zip"), "a.xlsx")) ===
    "不是有效的 .xlsx / .docx 文件（ZIP 结构不完整）", "非 ZIP 文件给出明确提示");
  check((await readFail(xlsxZip, "老表格.xls")) ===
    "只支持 .xlsx / .docx；老的 .xls / .doc 请另存为新格式", "老式 .xls 提示另存");
  check((await readFail(makeZip([{ name: "xl/other.xml", body: "<a/>" }]), "a.xlsx")) ===
    "这个 .xlsx 里没有工作表", "xlsx 里缺工作表时提示");
  check((await readFail(makeZip([{ name: "docProps/app.xml", body: "<a/>" }]), "a.docx")) ===
    "这个 .docx 里没有正文", "docx 里缺正文时提示");

  console.log("\n" + pass + "/" + (pass + fail) + " 通过");
  process.exit(fail ? 1 : 0);
})();
