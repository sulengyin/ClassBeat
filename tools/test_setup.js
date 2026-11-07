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
global.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {}
};

function load(f) {
  new Function(fs.readFileSync(path.join(ROOT, f), "utf8"))();
}
load("app/templates.js");
load("app/setup.js");

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

console.log("\n" + pass + "/" + (pass + fail) + " 通过");
process.exit(fail ? 1 : 0);
