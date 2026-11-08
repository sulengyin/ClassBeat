/* 没有浏览器时用最小 DOM 桩跑一遍 boot / 编辑面板，抓运行时异常。
   它不能替代真机目视（字号、反光、触摸都测不到），只保证"页面起得来、不白屏"。
   node tools/test_dom.js */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function check(ok, title, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + title + (detail ? "  · " + detail : ""));
  ok ? pass++ : fail++;
}

/* ---------- 最小 DOM ---------- */
function ClassList(node) {
  this.n = node;
}
ClassList.prototype._list = function () {
  return (this.n.className || "").split(/\s+/).filter(Boolean);
};
ClassList.prototype.add = function (c) {
  const l = this._list(); if (l.indexOf(c) < 0) l.push(c);
  this.n.className = l.join(" ");
};
ClassList.prototype.remove = function (c) {
  this.n.className = this._list().filter(x => x !== c).join(" ");
};
ClassList.prototype.contains = function (c) { return this._list().indexOf(c) >= 0; };
ClassList.prototype.toggle = function (c, force) {
  const has = this.contains(c);
  const want = force === undefined ? !has : !!force;
  want ? this.add(c) : this.remove(c);
  return want;
};

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.dataset = {};
    this.id = "";
    this._text = "";
    this.value = "";
    this.checked = false;
    this.classList = new ClassList(this);
  }
  get textContent() {
    if (this.children.length) return this.children.map(c => c.textContent).join("");
    return this._text;
  }
  set textContent(v) { this._text = v == null ? "" : String(v); this.children = []; }
  set innerHTML(v) { this.children = []; this._text = v == null ? "" : String(v); }
  get innerHTML() { return this._text; }
  get offsetWidth() { return 100; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    }
  }
  addEventListener(type, fn) { (this._h || (this._h = {}))[type] = fn; }
  setAttribute(k, v) { this["attr_" + k] = v; }
  appendData() {}
  focus() {}
  querySelectorAll(sel) {
    const cls = (sel.match(/\.([\w-]+)/g) || []).map(s => s.slice(1));
    const attr = sel.match(/\[([\w-]+)\]/);
    const out = [];
    const walk = n => {
      n.children.forEach(c => {
        if (cls.length && !cls.every(x => c.classList.contains(x))) { walk(c); return; }
        if (attr) {
          const k = attr[1].replace(/^data-/, "").replace(/-([a-z])/g, (m, g) => g.toUpperCase());
          if (c.dataset[k] === undefined) { walk(c); return; }
        }
        out.push(c); walk(c);
      });
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

const body = new El("body");
const document = {
  body: body,
  documentElement: new El("html"),
  readyState: "complete",
  title: "",
  createElement: t => new El(t),
  getElementById(id) {
    let found = null;
    const walk = n => {
      if (found) return;
      if (n.id === id) { found = n; return; }
      n.children.forEach(walk);
    };
    walk(body);
    return found;
  },
  addEventListener() {},
  querySelector(sel) { return body.querySelectorAll(sel)[0] || null; },
  querySelectorAll(sel) { return body.querySelectorAll(sel); },
  fullscreenElement: null
};

/* 主屏骨架：与 index.html 的 id 对齐 */
["cls", "date", "clock", "sec", "main", "band", "bandText", "spine", "heroMain", "heroSub", "after", "chips",
 "duty", "dutyDetail", "warn", "warn-title", "warn-text", "corner",
 "btn-cd", "btn-full", "btn-reduce", "btn-edit", "btn-gear", "btn-demo", "btn-theme", "btn-phone",
 "qr-panel", "qr-url", "qr-empty", "qr-close",
 "msgModal", "msgCard", "msgContent", "msgBody", "msgTitle", "msgTime", "msgClose",
 "setup", "btn-setup",
 "demo", "d-play", "d-now", "d-ribbon", "d-range", "d-speed", "d-close"].forEach(id => {
  const e = new El(id.indexOf("btn") === 0 || id === "warn-title" ? "button" : "div");
  e.id = id;
  body.appendChild(e);
});

/* 「手机」面板里的画布：桩只记录被填了多少个方块，够判断"码画出来了" */
const qrCanvas = new El("canvas");
qrCanvas.id = "qr-canvas";
qrCanvas.width = 512;
qrCanvas.height = 512;
let qrRects = 0;
qrCanvas.getContext = () => ({
  fillStyle: "",
  fillRect() { qrRects++; }
});
body.appendChild(qrCanvas);
/* 与真实 DOM 一致：状态词在 .band 里面，倒计时靠 dataset.text 取原文 */
const bandEl = document.getElementById("band");
const bandTextEl = document.getElementById("bandText");
bandTextEl.remove();
bandEl.appendChild(bandTextEl);

const demoBar = () => document.getElementById("demo");
/* 演练条的跳转按钮：querySelectorAll(".d-jump") 要能找到 */
["07:20", "10:16", "10:23", "11:42", "17:12"].forEach(t => {
  const b = new El("button");
  b.className = "d-btn d-jump";
  b.dataset.t = t;
  demoBar().appendChild(b);
});

global.setInterval = () => 0;
global.setTimeout = () => 0;
global.clearTimeout = () => {};
global.requestAnimationFrame = fn => { global.__raf = fn; return 1; };
global.cancelAnimationFrame = () => {};
global.document = document;
global.window = global;
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};
global.location = { search: "?t=11:10&date=2026-11-05" };
global.matchMedia = () => ({ matches: false });

/* 教室消息服务：测试环境里当作"不存在"，验证降级路径不报错 */
global.fetch = () => Promise.reject(new Error("no hub"));
global.EventSource = class {
  constructor(url) { this.url = url; this.readyState = 0; global.__es = this; }
  close() { this.readyState = 2; }
};

document.createTextNode = function (t) {
  const n = new El("#text");
  n._text = String(t);
  return n;
};

/* ---------- 加载 ---------- */
/* 在 node 里跑浏览器脚本：藏掉 module/exports，让 UMD 走浏览器分支，
   否则 engine 会把自己挂到 module.exports，window.Schedule 就是空的。
   self 显式指向全局，模拟浏览器。 */
function loadBrowserScript(f) {
  const code = fs.readFileSync(path.join(ROOT, f), "utf8");
  new Function("module", "exports", "require", "self", code)(undefined, undefined, undefined, global);
}

/* 第三方库走 UMD：给它一个 exports 对象，才会把工厂结果交出来 */
function loadVendor(f, name) {
  const code = fs.readFileSync(path.join(ROOT, f), "utf8");
  const m = { exports: {} };
  new Function("module", "exports", "require", "self", code)(m, m.exports, undefined, global);
  global[name] = m.exports;
}

loadVendor("app/vendor/qrcode.min.js", "qrcode");

["app/data.js", "app/engine/schedule.js", "app/qr.js", "app/clock.js", "app/config.js", "app/rhythm.js", "app/store.js", "app/runtime.js", "app/screen.js", "app/remote.js", "app/phoneui.js", "app/edit.js", "app/demo.js", "app/templates.js", "app/setup.js"]
  .forEach(loadBrowserScript);

check(!!global.Screen, "screen.js 注册成功");

/* 班级名只有一个来源：data.js 的 meta。页面文件里不该再出现具体班名——
   这条就是防止以后又把具体班名写回页面。 */
check(!!global.CFG, "config.js 注册成功");
check(CFG.klass() === window.RHYTHM_DATA.meta.klass, "班名取自数据", CFG.klass());
/* 班名以数据里那个为准，这样真数据、示例数据都能查同一件事 */
const pageFiles = ["app/index.html", "app/screen.js", "app/edit.js", "app/config.js", "app/rhythm.js", "app/store.js"];
const KNAME = (window.RHYTHM_DATA.meta || {}).klass;
const hard = pageFiles.filter(f => fs.readFileSync(path.join(ROOT, f), "utf8").includes(KNAME));
check(!!KNAME && hard.length === 0, "页面里没有写死的班名", hard.join(", ") || "无");
check(!!global.Edit, "edit.js 注册成功");
check(!!global.Demo, "demo.js 注册成功");
check(!!global.Remote, "remote.js 注册成功");
check(global.Remote && /127\.0\.0\.1:8765/.test(global.Remote.hub), "默认连本机服务", global.Remote && global.Remote.hub);

/* boot 在加载时已跑（readyState=complete） */
const band = document.getElementById("band");
const hero = document.getElementById("heroMain");
/* 倒计时是滚轮 DOM，正文要读 dataset.text；普通状态仍是 textContent */
const heroText = (n) => (n || hero).dataset.text || (n || hero).textContent;
check(!!band.textContent, "顶栏状态词已渲染", band.textContent);
check(!!heroText(), "主视觉已渲染", heroText());
check(String(hero.style.fontSize).indexOf("vmin") > 0, "字号按字数算出", hero.style.fontSize);

/* 每个时段都跑一遍，确认没有分支报错，并抽查文案 */
const times = ["07:35", "08:30", "09:10", "10:12", "10:24", "11:25", "11:45",
               "12:20", "12:55", "13:20", "15:45", "16:35", "17:15", "18:00"];
const Screen = global.Screen;
let err = null;
const seen = {};

times.forEach(t => {
  try {
    const p = t.split(":").map(Number);
    global.__rhythmTime = p[0] * 60 + p[1];
    Screen.render();
    seen[t] = heroText();
  } catch (e) { err = err || e; }
});
check(!err, "各时段渲染无异常", times.length + " 个时点");
check(/^\d+:\d{2}$/.test(seen["10:24"] || ""), "课间最后 1 分钟主角换成倒计时", seen["10:24"]);
check((seen["11:25"] || "").indexOf("书法") > 0, "第 4 节书法上屏", seen["11:25"]);
check((seen["08:30"] || "").indexOf("语文") > 0, "第 1 节语文上屏", seen["08:30"]);
check(seen["10:24"] !== seen["10:12"], "焦点随时间真的变了",
  seen["10:12"] + " → " + seen["10:24"]);

/* 早读：7:30–8:10 是真实的一段；提醒事项单独一块，比建议更醒目 */
global.__rhythmDate = "2026-11-05";
global.__rhythmTime = 7 * 60 + 30;
global.Store.patchTexts({
  reading: { "4": { subject: "英语", task: "读 Unit 4 单词" } },
  reminders: { "default": "带齐回执" }
});
Screen.render();
check(heroText() === "英语早读", "周四 7:30 上早读", heroText());
const remRow = document.querySelector(".reminder-line");
check(!!remRow && remRow.textContent.indexOf("带齐回执") >= 0,
  "提醒事项单独一块上屏", remRow ? remRow.textContent : "缺失");
global.Store.resetTexts();

/* 紧急通知：红色只由老师手动发，文字要能占住主区 */
const Store = global.Store;
Store.patchDayOverride("2026-11-05", {
  notice: {
    text: "现在全部同学停止手上的事情，带上水杯到走廊排成一列，按小组顺序下楼",
    level: "urgent", at: "10:00", until: "23:59", createdAt: Date.now()
  }
});
global.__rhythmTime = 10 * 60;
Screen.render();
check(document.getElementById("band").textContent === "紧急通知", "紧急通知顶栏变红底",
  document.getElementById("band").textContent);
check(document.body.dataset.alert === "1", "红框被打开");
check(document.body.dataset.tone === "red", "整屏语气切到红");
const nsz = parseFloat(document.getElementById("heroMain").style.fontSize);
check(nsz >= 8, "长通知的字号仍然够大", nsz.toFixed(1) + "vmin");

/* 普通通知不该触发红框 */
Store.patchDayOverride("2026-11-05", {
  notice: { text: "今天午饭后把作业本交到讲台", level: "normal", at: "10:00", until: "23:59", createdAt: Date.now() }
});
Screen.render();
check(document.body.dataset.alert === "0", "普通通知不红");
check(!!document.querySelector(".notice-bar"), "普通通知占一条窄带");

/* 关闭按钮：单击不算，按住 0.9 秒才生效 */
const nx = document.querySelector(".notice-x");
check(!!nx, "通知条上有长按关闭");

(function () {
  const realST = global.setTimeout;
  global.setTimeout = fn => { fn(); return 1; };
  nx._h.pointerdown({ preventDefault() {} });
  global.setTimeout = realST;
  Screen.render();
  check(!document.querySelector(".notice-bar"), "按住后通知从屏上撤掉");
})();

Store.clearDayOverride("2026-11-05");

/* 演练：把时间推到某一刻，屏上必须真的跟着变 */
try {
  global.Demo.open(10 * 60 + 23, false);
} catch (e) { err = e; }
check(!err && document.body.dataset.demo === "1", "演练条能打开", err ? err.message : "无异常");
check(global.__rhythmTime === 10 * 60 + 23, "演练接管屏幕时间", String(global.__rhythmTime));
check(document.getElementById("d-now").textContent === "10:23", "时间轴读数是推到的时刻",
  document.getElementById("d-now").textContent);
check(/^\d+:\d{2}$/.test(heroText()),
  "推到课间收尾，主视觉是倒计时", heroText());
check(document.getElementById("d-ribbon").children.length >= 20,
  "一天的结构条画出来了", document.getElementById("d-ribbon").children.length + " 段");

global.Demo.seek(17 * 60 + 22, true);
check(heroText().indexOf("放学") >= 0,
  "拖到放学，主视觉跟着换", heroText());

global.Demo.close();
check(document.body.dataset.demo === "0" && global.__rhythmTime === null,
  "关掉演练回到真实时间", String(global.__rhythmTime));

/* ---------- 教室消息接入（PLAN 2.22） ---------- */
(function () {
  global.Remote.connect(0);
  const es = global.__es;
  check(!!es && /\/api\/stream\?since=0/.test(es.url), "连上服务后订阅 SSE", es && es.url);

  const today = global.Screen.todayKey();
  const key = "rhythm.overrides.v1";

  es.onmessage({ data: JSON.stringify({
    seq: 9, text: "现在到走廊集合", level: "normal",
    at: "11:10", until: "23:59", forWhom: "class"
  }) });
  let all = JSON.parse(localStorage.getItem(key) || "{}");
  check(all[today] && all[today].notice && all[today].notice.text === "现在到走廊集合",
        "手机消息写进本地覆盖层", all[today] && all[today].notice && all[today].notice.text);

  es.onmessage({ data: JSON.stringify({
    seq: 10, text: "记得带教研材料", level: "normal",
    at: "11:10", until: "23:59", forWhom: "self"
  }) });
  all = JSON.parse(localStorage.getItem(key) || "{}");
  check(all[today].notice.text === "现在到走廊集合",
        "只给自己看的不上屏", all[today].notice.text);

  es.onmessage({ data: "这不是 json" });
  check(true, "坏消息不让页面崩");

  /* ---------- 手机消息弹窗：卡片展开 ----------
     真机验收的是"最后一排看不看得清"，这里只保证结构对：
     消息一来就弹、紧急换红标签、按住能关且撤回。 */
  const modal = document.getElementById("msgModal");
  const card = document.getElementById("msgCard");
  check(!!modal && !!card, "页面里有消息弹窗");

  es.onmessage({ data: JSON.stringify({
    seq: 11, text: "明天体检，早上空腹，不要吃早饭", level: "normal",
    at: "11:11", until: "23:59", forWhom: "class"
  }) });
  check(modal.classList.contains("open"), "新消息到达，弹窗打开");
  check(document.getElementById("msgBody").textContent.indexOf("体检") >= 0,
        "正文是老师那句话", document.getElementById("msgBody").textContent);

  /* 展开要等两帧：第一帧遮罩，第二帧卡片 */
  global.__raf(); global.__raf();
  check(card.dataset.expanded === "true", "卡片按宽高展开，不是缩放");
  const msgFs = parseFloat(document.getElementById("msgBody").style.fontSize);
  check(msgFs >= 5, "正文比通知条大两档", msgFs + "vmin");

  es.onmessage({ data: JSON.stringify({
    seq: 12, text: "立即停止活动", level: "urgent",
    at: "11:12", until: "23:59", forWhom: "class"
  }) });
  check(modal.dataset.level === "urgent", "紧急消息换红标签");
  check(document.getElementById("msgTitle").textContent === "紧急通知", "标签写紧急通知");

  const mc = document.getElementById("msgClose");
  const realST2 = global.setTimeout;
  global.setTimeout = fn => { fn(); return 1; };
  mc._h.pointerdown({ preventDefault() {} });
  global.setTimeout = realST2;
  check(!modal.classList.contains("shown"), "按住后卡片先收起");
  check(!modal.classList.contains("open"), "收起后整层撤掉");
  const all2 = JSON.parse(localStorage.getItem(key) || "{}");
  check(!(all2[today] && all2[today].notice), "关闭弹窗同时撤回这条消息");
})();

/* ---------- 运行时：改一条作息，下一次重绘就变 ---------- */
/* 换一天做，避开上面那条通知覆盖 */
global.__rhythmDate = "2026-11-09";
global.__rhythmTime = 8 * 60 + 10;   /* 08:10：第一节 08:20 还没开始 */
Screen.render();
const beforeShift = heroText();
/* 周一第一节是什么科，从当天的课表里取，不写死 */
const mon1 = global.Runtime.day("2026-11-09").timeline
  .filter(b => b.type === "class")[0].subject;
/* 早读标题里也会出现科目名（「英语早读」），所以不能拿科目名判断；
   上课卡一定是「第 1 节 · 科目」 */
check(beforeShift.indexOf("第 1 节") < 0, "08:10 还没上第一节", beforeShift);
/* 「下一节 语文」写在主视觉下面那行 #after 上，不是 #heroSub。
   这条是 CI 抓出来的：e2e 按 #heroSub 断言，三台大屏一起红。 */
const afterTxt = document.getElementById("after").textContent;
check(afterTxt.indexOf("下一节") >= 0, "08:10 课间写清楚下一节是什么", afterTxt);

const moved = JSON.parse(JSON.stringify(window.RHYTHM_DATA.timetable));
/* 第一节前面还有早读和准备课间，不能拿 blocks[0] 当第一节 */
const classIdx = moved.blocks.findIndex(b => b.type === "class");
moved.blocks[classIdx - 1].end = "08:05";
moved.blocks[classIdx].start = "08:05";
global.Runtime.patch({ timetable: moved });
const afterShift = heroText();
check(afterShift.indexOf("第 1 节") >= 0 && afterShift.indexOf(mon1) >= 0,
  "把第一节提前到 08:05，屏上立刻改成" + mon1, beforeShift + " → " + afterShift);
check(global.Runtime.rev() > 0, "配置改过之后版本号变了", "rev=" + global.Runtime.rev());

/* 还原，别影响后面的用例。不能用 patch 把当前值再写一遍——
   那样写进去的是已经改过的 08:00，等于没还原。 */
global.Store.resetConfig();

/* ---------- 跨午夜：日期变了就取新的一天 ---------- */
global.__rhythmDate = "2026-11-06";
global.__rhythmTime = 18 * 60 + 30;  /* 周五放学后 */
Screen.render();
const fri = heroText();
global.__rhythmDate = "2026-11-09";  /* 周一早上，第一节 08:20 已经开始 */
global.__rhythmTime = 8 * 60 + 30;
Screen.render();
const mon = heroText();
check(fri !== mon && mon.indexOf("第 1 节") >= 0,
  "过了零点自动换到新的一天", "周五 18:30「" + fri + "」→ 周一 08:30「" + mon + "」");

/* 编辑面板 */
try {
  global.Edit.open();
} catch (e) {
  err = e;
}
check(!err, "编辑面板能打开", err ? err.message : "无异常");
check(!!document.getElementById("gateQ"), "先出验证码，不直接进面板",
  document.getElementById("gateQ") ? document.getElementById("gateQ").textContent : "缺失");

/* ---------- 验证码答对后进面板，切到「作息」 ---------- */
const qText = document.getElementById("gateQ").textContent.replace(" = ?", "");
const answer = String(qText.split("×").map(x => parseInt(x, 10)).reduce((a, b) => a * b, 1));
const gks = document.querySelectorAll(".gk");
answer.split("").forEach(d => {
  const b = gks.filter(k => k.textContent === d)[0];
  if (b) b._h.click();
});
gks.filter(k => k.textContent === "进入")[0]._h.click();
check(!!document.getElementById("epTitle"), "验证码答对后进入面板");
check(document.getElementById("epTitle").textContent.indexOf("·") > 0,
  "面板抬头带班名", document.getElementById("epTitle").textContent);

const tabs = document.querySelectorAll(".ep-tab");
const hoursTab = tabs.filter(b => b.textContent === "作息")[0];
check(!!hoursTab, "面板里有「作息」这一页");
hoursTab._h.click();
const rows = document.querySelectorAll(".tt-row");
check(rows.length >= 10, "作息表按段列出", rows.length + " 段");
check(document.querySelectorAll(".tt-time").length === rows.length * 2,
  "每段两个时间框", String(document.querySelectorAll(".tt-time").length));

/* 改第一段（早读）的开始时间：不点保存——输入框 change 就该立刻生效。
   第一段前面没有别的段，改开始时间不会破坏首尾相接。 */
const beforeTime = global.Runtime.day("2026-11-09").timeline[0].start;
const firstTime = document.querySelectorAll(".tt-time")[0];
firstTime.value = "07:45";
firstTime._h.change();
const afterTime = global.Runtime.day("2026-11-09").timeline[0].start;
check(afterTime === "07:45" && beforeTime !== afterTime,
  "在面板里改早读开始时间，配置立刻重算", beforeTime + " → " + afterTime);

/* 校验：把结束时间改到开始之前，必须拒绝，不能写成断档 */
const endTime = document.querySelectorAll(".tt-time")[1];
endTime.value = "07:00";
endTime._h.change();
check(global.Runtime.day("2026-11-09").timeline[0].end === "08:10",
  "结束早于开始时不写入", global.Runtime.day("2026-11-09").timeline[0].end);

global.Store.resetConfig();
global.Edit.close();

/* remote.js 的 hub 选择：从服务打开时同源，双击文件时才用本机 8765。
   以前默认写死 127.0.0.1，服务在另一台电脑上就永远连不上。 */
function hubFor(loc) {
  const win = {
    location: loc,
    document: { readyState: "loading", addEventListener() {} },
    Screen: {}, Store: {}
  };
  new Function("window", "document", "URLSearchParams",
    fs.readFileSync(path.join(ROOT, "app/remote.js"), "utf8")
  )(win, win.document, URLSearchParams);
  return win.Remote && win.Remote.hub;
}

check(hubFor({ search: "", protocol: "http:", host: "192.168.1.5:8765" })
  === "http://192.168.1.5:8765", "从服务打开时同源连，不用手写 IP");
check(hubFor({ search: "", protocol: "file:", host: "" }) === "http://127.0.0.1:8765",
  "双击 html 打开时退回本机 8765");
check(hubFor({ search: "?hub=10.0.0.2:9000", protocol: "http:", host: "1.2.3.4:8765" })
  === "http://10.0.0.2:9000", "URL 上写了 hub 就听 URL 的");

/* ---------- 手机二维码 ---------- */
check(!!global.qrcode && !!global.QR, "二维码库与封装都注册了");

const q1 = global.QR.make("http://192.168.1.5:8765/");
check(!!q1 && q1.getModuleCount() === 25, "25 字节地址编成 25×25 的码",
  q1 && String(q1.getModuleCount()));

/* 固定内容 → 固定图形。换库、改编码模式、动错版本，这条会立刻红。 */
const qrRows = [];
for (let r = 0; r < q1.getModuleCount(); r++) {
  let line = "";
  for (let c = 0; c < q1.getModuleCount(); c++) line += q1.isDark(r, c) ? "1" : "0";
  qrRows.push(line);
}
const qrHash = require("crypto").createHash("sha256")
  .update(qrRows.join("\n")).digest("hex").slice(0, 16);
check(qrHash === "0219b9445ec0ed76", "码的图形固定（换库或改封装会报错）", qrHash);

global.Remote.info.phone = "http://192.168.1.5:8765";
global.Remote.info.online = true;
global.PhoneUI.open();
const qrPanel = document.getElementById("qr-panel");
check(qrPanel.classList.contains("open"), "点「手机」打开二维码面板");
check(document.getElementById("qr-url").textContent === "http://192.168.1.5:8765/",
  "面板上写出手机要打开的地址", document.getElementById("qr-url").textContent);
check(qrRects > 200, "二维码真的画进了画布", qrRects + " 个方块");
check(document.getElementById("qr-empty").hidden === true, "有地址时不显示操作提示");

/* 服务只报回环地址：手机连不上，必须改成操作步骤，不能画一个扫不开的码 */
global.Remote.info.phone = "http://127.0.0.1:8765";
global.PhoneUI.open();
check(document.getElementById("qr-empty").hidden === false,
  "只有本机地址时改成操作提示");
check(qrCanvas.hidden === true, "这时把画布藏起来");

global.PhoneUI.close();
check(!qrPanel.classList.contains("open"), "「关闭」能收起面板");
global.Remote.info.phone = "";

/* ---------- 配置向导（P5） ---------- */
(function () {
  const box = document.getElementById("setup");
  const btn = document.getElementById("btn-setup");

  /* 桩的 querySelectorAll 只认 class，不认标签；这里自己按 tagName 走一遍 */
  const inputsIn = node => {
    const out = [];
    (function walk(n) {
      n.children.forEach(c => { if (c.tagName === "INPUT") out.push(c); walk(c); });
    })(node);
    return out;
  };

  btn._h.click();
  check(box.classList.contains("open"), "点「配置班级」打开向导");
  check(box.querySelectorAll(".setup-step").length === 4, "向导是四步",
    String(box.querySelectorAll(".setup-step").length));
  check(inputsIn(box).length >= 4, "第一步能填学校/班级/班主任/开学日",
    String(inputsIn(box).length));

  const next = () => box.querySelectorAll(".setup-btn")
    .filter(b => b.textContent === "下一步")[0];

  next()._h.click();
  const tpls = box.querySelectorAll(".setup-tpl");
  check(tpls.length === 3, "第二步给三套作息模板", String(tpls.length));
  const rows = box.querySelectorAll(".setup-row");
  check(rows.length > 20, "第二步列出每一段起止", rows.length + " 行");

  next()._h.click();
  const cells = inputsIn(box);
  check(cells.length === 35, "第三步是 5×7 课表", cells.length + " 格");

  next()._h.click();
  const doneBtns = box.querySelectorAll(".setup-btn").map(b => b.textContent);
  check(doneBtns.indexOf("导出设置 JSON") >= 0, "完成页能导出设置",
    doneBtns.join(" / "));
  check(doneBtns.indexOf("导入设置 JSON") >= 0, "完成页能导入另一台机器的设置",
    doneBtns.join(" / "));

  /* B4a：第四步列出岗位卡片和可折叠的文案分组，仍然只有四步 */
  const roleCards = box.querySelectorAll(".setup-role");
  const bakedRoles = (window.RHYTHM_DATA.roles || {}).roles || [];
  check(roleCards.length === bakedRoles.length, "第四步按岗位逐个列卡片",
    roleCards.length + " / " + bakedRoles.length);
  check(box.querySelectorAll(".setup-src").length === 1, "第四步标明岗位来源班");
  check(box.querySelectorAll(".setup-text-sec").length >= 4, "第四步有可折叠的文案分组",
    String(box.querySelectorAll(".setup-text-sec").length));
  check(doneBtns.indexOf("恢复至修改前") >= 0, "完成页有恢复快照的入口",
    doneBtns.join(" / "));
  check(inputsIn(box).length > 35, "岗位和文案都能直接编辑",
    String(inputsIn(box).length));

  box.querySelector(".setup-x")._h.click();
  check(!box.classList.contains("open"), "「×」能关掉向导");
})();

console.log("\n" + pass + "/" + (pass + fail) + " 通过");
process.exit(fail ? 1 : 0);
