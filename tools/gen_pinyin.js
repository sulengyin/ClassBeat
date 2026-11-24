/* 生成 app/pinyin.js（拼音匹配表）。构建期工具，运行时不依赖 pinyin-pro。
 *
 *   npm install            # 装好 devDependencies（pinyin-pro）
 *   node tools/gen_pinyin.js
 *
 * 两张表：
 *   SURNAME —— 姓氏读音。单家的「单」是 shan 不是 dan，「解」是 xie 不是 jie，
 *              所以用 pinyin-pro 的 surname 模式单独取，不能拿常用读音凑。
 *   CH      —— 常用字的读音，多音字把几个读音都收进来（乐 le|yue），
 *              老师打哪个都能找到人。
 *   ü 一律写成 v（吕 lv），和拼音输入法的习惯一致。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { pinyin } = require("pinyin-pro");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "app", "pinyin.js");

function norm(py) {
  return String(py || "").trim().toLowerCase().replace(/ü/g, "v").replace(/[^a-z|]/g, "");
}

/* 姓氏表：从 store.js 的 SURNAME_GROUPS 里取全部姓，保证两边是同一批字 */
function surnameChars() {
  const src = fs.readFileSync(path.join(ROOT, "app", "store.js"), "utf8");
  const m = src.match(/var SURNAME_GROUPS = \{([\s\S]*?)\n  \};/);
  if (!m) throw new Error("store.js 里找不到 SURNAME_GROUPS");
  const set = new Set();
  for (const ch of m[1]) if (/[\u4e00-\u9fa5]/.test(ch)) set.add(ch);
  return [...set].sort();
}

const surnames = {};
for (const ch of surnameChars()) {
  const py = norm(pinyin(ch, { toneType: "none", surname: "head" }));
  if (py) surnames[ch] = py;
}

/* 常用字表：CJK 基本区里 pinyin-pro 认得的字，多音字收全部读音 */
const chars = {};
for (let cp = 0x4e00; cp <= 0x9fa5; cp++) {
  const ch = String.fromCharCode(cp);
  const one = norm(pinyin(ch, { toneType: "none", multiple: true }));
  if (!one) continue;
  const list = one.split("|").filter(Boolean);
  if (!list.length) continue;
  const uniq = [...new Set(list)];
  chars[ch] = uniq.join("|");
}

/* 按音节分组存，比「字 → 拼音」逐条写省一半体积 */
const bySyl = {};
for (const ch of Object.keys(chars)) {
  for (const py of chars[ch].split("|")) {
    (bySyl[py] = bySyl[py] || []).push(ch);
  }
}
const sylKeys = Object.keys(bySyl).sort();
const sylLines = sylKeys.map((k) => "    " + JSON.stringify(k) + ":" + JSON.stringify(bySyl[k].join("")));
const surnameLines = Object.keys(surnames).sort().map((k) => "    " + JSON.stringify(k) + ":" + JSON.stringify(surnames[k]));

const out = `/* 生成物，请勿手改。改拼音规则请改 tools/gen_pinyin.js 再重跑：
 *
 *   npm install && node tools/gen_pinyin.js
 *
 * 姓用姓氏读音（单 shan、解 xie、曾 zeng）；常用字收全部读音（乐 le|yue）。
 * ü 写成 v（吕 lv），和拼音输入法一致。
 * 共 ${Object.keys(surnames).length} 个姓、${Object.keys(chars).length} 个字、${sylKeys.length} 个音节。
 */
(function (root) {
  "use strict";

  var SURNAME = {
${surnameLines.join(",\n")}
  };

  var SYL = {
${sylLines.join(",\n")}
  };

  /* 字 → 读音（"le|yue"），第一次用到时才建，建完缓存 */
  var CH = null;
  function index() {
    if (CH) return CH;
    CH = {};
    for (var py in SYL) {
      var s = SYL[py];
      for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        CH[c] = CH[c] ? CH[c] + "|" + py : py;
      }
    }
    return CH;
  }

  function surnamePy(name) {
    if (!name) return "";
    return SURNAME[String(name).charAt(0)] || "";
  }

  function charPy(ch) {
    return index()[ch] || "";
  }

  /* 一个名字的逐字读音：["zhou", "yu", "ning"]；不认得的字给空串 */
  function namePys(name) {
    var s = String(name || "");
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(charPy(s.charAt(i)));
    return out;
  }

  root.Pinyin = { surname: surnamePy, char: charPy, name: namePys };
})(window);
`;

fs.writeFileSync(OUT, out, "utf8");
const kb = (Buffer.byteLength(out, "utf8") / 1024).toFixed(1);
console.log(`写出 ${path.relative(ROOT, OUT)}：${kb} KB，${Object.keys(surnames).length} 姓 / ${Object.keys(chars).length} 字 / ${sylKeys.length} 音节`);
