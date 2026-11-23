/* 科目词典：一份，给所有用到「科目」的地方共用。
 *
 * 为什么单独一个文件：科目名在不同环节各有各的叫法，而且这些环节互相咬合——
 *   - 课表识别（setup.js）要判断格子里「哪半截是科目、哪半截是老师」；
 *   - 课务下拉（edit.js）要靠科目找到任课老师，同义的科目不能在列表里并列两条；
 *   - 准备清单按科目 key 挂"要带什么"，课表填的和清单写的必须是同一个名字。
 * 以前 setup.js 和 edit.js 各存一份，写法还不一样（一个是常用科目表、
 * 一个是同义归并组）。两边各自长一长就会漂：识别时认「道法」、下拉里叫
 * 「道德与法治」，老师选了后者就带不出老师。所以收成这一份。
 *
 * 结构：每个数组的第一项是标准名，其余是常见别名。学校自己的叫法
 * 通过 Subjects.extra() 追加，不必改这里——课表里出现过一次的名字会自动被认。
 */
(function (root) {
  "use strict";

  var GROUPS = [
    ["语文", "语文阅读", "阅读"],
    ["数学", "数学思维"],
    ["英语", "英语口语", "口语"],
    ["道德与法治", "道法", "道德", "法治"],
    ["劳动", "劳综", "劳综短课", "劳综一", "劳技", "劳动技术", "劳动与技术"],
    ["信息科技", "信息", "信息技术", "计算机", "电脑"],
    ["班队", "班会", "班队会", "心理/班队", "心理", "心理健康"],
    ["体育", "体育一", "体育二", "体育三", "体育活动"],
    ["科学", "科学课"],
    ["音乐", "唱游"],
    ["美术", "绘画"],
    ["书法", "写字课", "毛笔"],
    ["自习", "自修", "自主"]
  ];

  /* 任意写法 → 标准名 */
  var ALIAS = {};
  GROUPS.forEach(function (g) {
    g.forEach(function (name) { ALIAS[name] = g[0]; });
  });

  /* 本机/本次用到的额外科目名（课表里出现过的、老师手填的） */
  var extraNames = [];
  var extraKey = {};

  function tidy(s) {
    return String(s == null ? "" : s)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\r\n]+/g, " ")
      .trim();
  }

  /* 归一键：同一科的不同叫法给出同一个值。
     没登记过的写法先去掉「一/二/三…」和「短课」再试一次，
     还认不出就返回它自己——未知科目不该被硬塞进某一组。 */
  function key(name) {
    var s = tidy(name);
    if (!s) return "";
    if (ALIAS[s]) return ALIAS[s];
    if (extraKey[s]) return extraKey[s];
    var base = s.replace(/[一二三四五六七八九十]$/, "").replace(/短课$/, "");
    if (base !== s && base) return key(base);
    return s;
  }

  /* 标准名：认得出就返回标准写法，认不出原样返回 */
  function canonical(name) {
    var k = key(name);
    return ALIAS[k] ? k : tidy(name);
  }

  /* 判断两串是不是同一科 */
  function same(a, b) {
    var ka = key(a), kb = key(b);
    return !!ka && ka === kb;
  }

  /* 标准科目列表（下拉兜底用） */
  function list() {
    return GROUPS.map(function (g) { return g[0]; }).concat(extraNames);
  }

  /* 所有认识的写法（课表识别用的词典） */
  function all(extra) {
    var out = [];
    Object.keys(ALIAS).forEach(function (a) { out.push(a); });
    extraNames.forEach(function (n) { out.push(n); });
    (extra || []).forEach(function (n) {
      var v = tidy(n);
      if (v) out.push(v);
    });
    return out;
  }

  /* 登记一个外部科目名（课表里出现过的本校写法） */
  function learn(name) {
    var s = tidy(name);
    if (!s || ALIAS[s] || extraKey[s]) return;
    extraKey[s] = s;
    if (extraNames.indexOf(s) < 0) extraNames.push(s);
  }

  /* 一个词是不是科目：原样认识，或者归一键落在已知科目上 */
  function isSubject(name, extra) {
    var s = tidy(name);
    if (!s) return false;
    if (ALIAS[s] || extraKey[s]) return true;
    if ((extra || []).indexOf(s) >= 0) return true;
    var k = key(s);
    if (ALIAS[k]) return true;
    return (extra || []).some(function (x) { return key(x) === k; });
  }

  /* 在 s 的开头找最长的已知科目名（用于「语文王老师」这种粘连写法） */
  function prefixOf(s, extra) {
    var text = tidy(s);
    if (!text) return "";
    var best = "";
    all(extra).forEach(function (k) {
      if (k && text.indexOf(k) === 0 && k.length > best.length) best = k;
    });
    return best;
  }

  root.Subjects = {
    GROUPS: GROUPS,
    key: key,
    canonical: canonical,
    same: same,
    list: list,
    all: all,
    learn: learn,
    isSubject: isSubject,
    prefixOf: prefixOf
  };
})(typeof window !== "undefined" ? window : globalThis);
