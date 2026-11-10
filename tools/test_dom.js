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
/* 记下挂到 document 上的监听：Esc 关卡片这类全局快捷键要靠它复现 */
const docHandlers = {};
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
  addEventListener(type, fn) { (docHandlers[type] || (docHandlers[type] = [])).push(fn); },
  querySelector(sel) { return body.querySelectorAll(sel)[0] || null; },
  querySelectorAll(sel) { return body.querySelectorAll(sel); },
  fullscreenElement: null
};

/* 主屏骨架：与 index.html 的 id 对齐 */
["cls", "date", "clock", "sec", "main", "band", "bandText", "spine", "heroMain", "heroSub", "heroTask", "after", "chips",
 "duty", "dutyDetail", "warn", "warn-title", "warn-text", "corner",
 "btn-cd", "btn-full", "btn-reduce", "btn-edit", "btn-gear", "btn-demo", "btn-theme", "btn-phone",
 "qr-panel", "qr-url", "qr-empty", "qr-close",
 "qr-copy-row", "qr-copy", "qr-copied", "qr-change",
 "msgModal", "msgCard", "msgContent", "msgBody", "msgTitle", "msgTime", "msgClose",
 "setup", "btn-setup", "ver", "tip", "tipText", "tipClose",
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

/* 固定夹具，不读 app/data.js：本机 app/data.js 是真实班级，CI 是 sample，
   两种数据跑同一套断言必然一边红。夹具由
   `python3 tools/bundle.py --data sample --out tools/fixtures/data.sample.js` 生成。 */
["tools/fixtures/data.sample.js", "app/version.js", "app/engine/schedule.js", "app/qr.js", "app/clock.js", "app/config.js", "app/rhythm.js", "app/store.js", "app/runtime.js", "app/screen.js", "app/remote.js", "app/phoneui.js", "app/edit.js", "app/update.js", "app/demo.js", "app/templates.js", "app/setup.js"]
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

/* 版本号只有一个来源；更新/迁移提示都不该打扰大屏 */
check(!!global.AppVersion && /^\d+\.\d+\.\d+$/.test(AppVersion.version),
  "版本号是语义版本", AppVersion && AppVersion.version);
const verEl = document.getElementById("ver");
check(verEl.textContent === AppVersion.text(), "界面上的版本取自同一份", verEl.textContent);
const versionDefs = fs.readdirSync(path.join(ROOT, "app"))
  .filter(f => f.endsWith(".js") && f !== "version.js")
  .filter(f => /var\s+VERSION\s*=/.test(fs.readFileSync(path.join(ROOT, "app", f), "utf8")));
check(versionDefs.length === 0, "版本号只在 app/version.js 定义", versionDefs.join(",") || "无");
const pageHtml = fs.readFileSync(path.join(ROOT, "app/index.html"), "utf8");
check((pageHtml.match(/src="version\.js"/g) || []).length === 1, "index.html 只引入一次 version.js");
check(/stamped_version_js/.test(fs.readFileSync(path.join(ROOT, "tools/package.py"), "utf8")),
  "打包脚本会把版本与构建号写进发布包");

const tipEl = document.getElementById("tip");
const tipText = document.getElementById("tipText");
Update._setLatest("");
Update._setMigrate(true);
Update._renderTip();
check(!tipEl.hidden && tipText.textContent.includes("导出"),
  "换地址后第一次打开会提示怎么搬设置", tipText.textContent);
document.getElementById("tipClose")._h.click();
Update._renderTip();
check(tipEl.hidden === true && localStorage.getItem("rhythm.migrate.hint.v1") === "1",
  "迁移提示点掉后不再出现");

Update._setMigrate(false);
Update._setLatest("9.9.9");
Update._renderTip();
check(!tipEl.hidden && tipText.textContent.includes("9.9.9"),
  "发现新版时给非阻断提示", tipText.textContent);
document.getElementById("tipClose")._h.click();
Update._renderTip();
check(tipEl.hidden === true, "「知道了」能关掉更新提示");
Update._renderTip();
check(tipEl.hidden === true, "同一版本关掉后不再反复弹");
Update._setLatest("9.9.10");
Update._renderTip();
check(!tipEl.hidden, "更高的新版本会再提示一次");

Update._setLatest("");
let updThrew = false;
const realFetch = global.fetch;
global.fetch = () => Promise.reject(new Error("offline"));
try { Update.check(); } catch (e) { updThrew = true; }
global.fetch = realFetch;
Update._renderTip();
check(!updThrew && tipEl.hidden === true, "断网检查更新不抛错、不弹提示");

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

/* 周末 / 节假日没有时间线：脊柱留空，但重绘不能抛错。
   真浏览器在周六验收配置向导时，这里会把「应用」误判成写入失败。 */
global.__rhythmDate = "2026-11-07";
global.__rhythmTime = 10 * 60;
let holidayErr = null;
try { Screen.render(); } catch (e) { holidayErr = e; }
check(!holidayErr, "周末重绘不报错", holidayErr ? holidayErr.message : "无异常");
check(heroText() === "今天不上学", "周末主视觉仍是「今天不上学」", heroText());

/* 早读：7:30–8:10 是真实的一段；标题写「英语学习建议」，建议本身另起一行大字 */
global.__rhythmDate = "2026-11-05";
global.__rhythmTime = 7 * 60 + 30;
global.Store.patchTexts({
  reading: { "4": { subject: "英语", task: "读 Unit 4 单词" } },
  reminders: { "default": "带齐回执" }
});
Screen.render();
check(heroText() === "英语学习建议", "周四 7:30 标题是「英语学习建议」", heroText());
const taskEl = document.getElementById("heroTask");
check(taskEl.textContent === "读 Unit 4 单词。",
  "老师填的建议在标题下一行，自带句号", taskEl.textContent);
check(taskEl.style.fontSize && taskEl.style.fontSize === document.getElementById("heroMain").style.fontSize,
  "建议和标题同字号", taskEl.style.fontSize + " / " + document.getElementById("heroMain").style.fontSize);
const remRow = document.querySelector(".reminder-line");
check(!!remRow && remRow.textContent.indexOf("带齐回执") >= 0,
  "提醒事项单独一块上屏", remRow ? remRow.textContent : "缺失");
check(document.querySelectorAll(".prep-line").length === 0,
  "建议不再以小字清单的形式出现");

/* 到校一句话跟到 08:10：早读期间在大字下面，同一句不只留贴纸 */
global.Store.patchTexts({
  stage: { before: { title: "早上好", note: "戴好红领巾，打扫好个人卫生。" } }
});
Screen.render();
check(document.getElementById("after").textContent.indexOf("戴好红领巾") >= 0,
  "早读期间一句话仍是到校那句",
  document.getElementById("after").textContent);
check(!!document.querySelector(".reminder-line"),
  "提醒和这句话不同时，黄色贴纸仍在");
global.Store.patchTexts({ reminders: { "default": "戴好红领巾，打扫好个人卫生。" } });
Screen.render();
check(!!document.querySelector(".reminder-line"),
  "同一句仍然用黄色贴纸呈现，不缺席");
check(document.getElementById("after").textContent === "",
  "贴纸已经承载这句话，正文那句不再重复",
  document.getElementById("after").textContent);
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

/* 大课间最后 2 分钟：科目和用品不能被「还剩几分钟」挤掉 */
global.__rhythmDate = "2026-11-05";
global.__rhythmTime = 9 * 60 + 28;
Screen.render();
const bdMain = heroText();
check(bdMain.indexOf("2:00") >= 0, "大课间剩 2 分钟进入倒计时", bdMain);
const bdNext = global.Runtime.day("2026-11-05").timeline.filter(b => b.type === "class")[1];
const bdAfter = document.getElementById("after").textContent;
check(bdAfter.indexOf("下一节") >= 0 && bdAfter.indexOf(bdNext.subject) >= 0,
  "倒计时下仍写清下一节是什么", bdAfter);
const bdTask = document.getElementById("heroTask").textContent;
check(bdTask.indexOf(bdNext.prep.items[0]) >= 0, "倒计时下仍列出要带的东西", bdTask);
check(parseFloat(document.getElementById("heroTask").style.fontSize) >= 6,
  "倒计时下用品字够大，不是小字",
  document.getElementById("heroTask").style.fontSize);
global.__rhythmDate = "2026-11-09";
global.__rhythmTime = 8 * 60 + 10;
Screen.render();

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
/* 小数 ÷ 整数：按两位小数四舍五入再抹掉尾零，避免浮点尾巴 */
const qm = qText.match(/^([0-9]+\.[0-9]+) ÷ ([0-9]+)$/);
check(!!qm, "验证码是一道小数除法", qText);
const answer = qm
  ? (Number(qm[1]) / Number(qm[2])).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
  : "";
const gks = document.querySelectorAll(".gk");
/* 回归：输入框以前把数字替换成「•」，老师看不清自己敲了什么 */
gks.filter(k => k.textContent === answer[0])[0]._h.click();
check(document.getElementById("gateVal").textContent === answer[0],
  "验证码输入框显示数字，不用圆点掩码",
  "显示「" + document.getElementById("gateVal").textContent + "」");
answer.slice(1).split("").forEach(d => {
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

/* 岗位顺序：在「值日」页把「擦窗户」往前挪一位，本机配置立刻记下 */
const dutyTab = tabs.filter(b => b.textContent === "值日")[0];
check(!!dutyTab, "面板里有「值日」这一页");
dutyTab._h.click();
const roleLines = document.querySelectorAll(".ep-rowline");
check(roleLines.length === global.Runtime.config().roles.roles.length
      && roleLines.length >= 10,
  "每一条岗位都带上下移按钮", roleLines.length + " 条");
const windowLine = roleLines.filter(l => l.textContent.indexOf("擦窗户") >= 0)[0];
check(!!windowLine && windowLine.children.length === 3,
  "岗位行 = 换人按钮 + ▲ + ▼", windowLine ? windowLine.children.length + " 个子元素" : "没找到");
windowLine.children[1]._h.click();

const confRoles = global.Runtime.config().roles.roles;
const idx14 = confRoles.map(r => r.id).indexOf("r14");
const idx18 = confRoles.map(r => r.id).indexOf("r18");
check(idx14 >= 0 && idx14 < idx18,
  "▲ 调完顺序立刻进本机配置，且排到同一时刻更前面",
  "r14=" + idx14 + "，r18=" + idx18);

/* 人群组：换人弹窗里点组一次带出整组；临时勾选不落库，显式存组才落库 */
const cleanLine = document.querySelectorAll(".ep-rowline")
  .filter(l => l.textContent.indexOf("擦窗户") >= 0)[0];
cleanLine.children[0]._h.click();
const groupChips = document.querySelectorAll(".ep-group-chip");
const roleGroupChip = groupChips.filter(c => c.textContent === "值日组")[0];
check(!!roleGroupChip && groupChips.length >= 1,
  "换人弹窗里有「点组带出」，排班组按当天值日实时出人",
  groupChips.map(c => c.textContent).join("、"));
const groupsBefore = global.Store.peopleGroups().length;
roleGroupChip._h.click();
const groupPicked = document.querySelectorAll(".ep-person.on");
check(groupPicked.length === 8 && global.Store.peopleGroups().length === groupsBefore,
  "点「值日组」把整组 8 人一次选上，且没有自动落库",
  groupPicked.length + " 人，配置里 " + groupsBefore + " 组");
const confirmBtn = document.querySelector(".ep-primary");
check(!!confirmBtn && confirmBtn.textContent.indexOf("已选 8 人") >= 0,
  "多选岗位才保留「确定」，并显示已选人数",
  confirmBtn ? confirmBtn.textContent : "没有确定按钮");
check(document.querySelector(".ep-group-modify").style.display === "none",
  "还没点已存组时「保存修改」不出现，避免误改旧组");
document.querySelector(".ep-group-name").value = "放学留下";
document.querySelector(".ep-group-save-btn")._h.click();
const savedGroup = global.Store.peopleGroups();
check(savedGroup.length === 1 && savedGroup[0].name === "放学留下"
      && savedGroup[0].memberIds.length === 8,
  "点「另存为新组」才写入本机配置，成员不重复",
  savedGroup.length + " 组，" + (savedGroup[0] || {}).memberIds.length + " 人");
const manualChip = document.querySelectorAll(".ep-group-chip")
  .filter(c => c.textContent === "放学留下")[0];
check(!!manualChip, "存好的组立刻出现在「点组带出」里");

/* 回归：已存的组要能就地改成员，不新增重复组 */
manualChip._h.click();
const modifyBtn = document.querySelector(".ep-group-modify");
check(!!modifyBtn && modifyBtn.textContent === "保存修改" && modifyBtn.style.display === "",
  "点已存组后出现「保存修改」，写回原组");
document.querySelectorAll(".ep-person.on")[0]._h.click();
check(document.querySelectorAll(".ep-person.on").length === 7,
  "再点一下能减掉一个人", document.querySelectorAll(".ep-person.on").length + " 人");
check(global.Store.peopleGroups()[0].memberIds.length === 8,
  "没点保存前改动不落库", global.Store.peopleGroups()[0].memberIds.length + " 人");
modifyBtn._h.click();
const updatedGroup = global.Store.peopleGroups();
check(updatedGroup.length === 1 && updatedGroup[0].name === "放学留下"
      && updatedGroup[0].memberIds.length === 7,
  "「保存修改」更新原组成员，不新增重复组",
  updatedGroup.length + " 组，" + (updatedGroup[0] || {}).memberIds.length + " 人");

document.querySelectorAll(".ep-group-del")[0]._h.click();
check(global.Store.peopleGroups().length === 0,
  "删组只删这一条，不动名单", global.Store.peopleGroups().length + " 组");

/* 回归：单选岗位点一下就该选定，不该再要求点「就是 TA」二次确认 */
document.querySelectorAll(".ep-dialog.picker").forEach(n => n.remove());
const energyLine = document.querySelectorAll(".ep-rowline")
  .filter(l => l.textContent.indexOf("节能小队长") >= 0)[0];
check(!!energyLine, "值日页找得到单选岗位「节能小队长」");
energyLine.children[0]._h.click();
/* 回归：点确定后不能跳回顶部，要停在用户刚才那个岗位 */
document.querySelector(".ep-rows").scrollTop = 120;
document.querySelector(".ep-body").scrollTop = 40;
const firstMate = document.querySelectorAll(".ep-person")[0];
const pickName = firstMate.textContent;
firstMate._h.click();
const pickOv = global.Store.getDayOverride("2026-11-09") || {};
const pickedPeople = (pickOv.roles && pickOv.roles.r02) ? pickOv.roles.r02.people : [];
check(pickedPeople.length === 1 && pickedPeople[0] === pickName,
  "单选岗位点候选人就直接写入，不用再点一次确认",
  pickName + " → " + pickedPeople.join("、"));
check(document.querySelector(".ep-rows").scrollTop === 120
      && document.querySelector(".ep-body").scrollTop === 40,
  "确定后岗位列表与整页滚动位置都保留，不跳回顶部",
  "rows=" + document.querySelector(".ep-rows").scrollTop
  + " body=" + document.querySelector(".ep-body").scrollTop);
check(document.querySelectorAll(".ep-rowline")
  .filter(l => l.dataset.roleId === "r02").length === 1,
  "重绘后的行仍然带着岗位 id，锚点找得到");
check(document.querySelectorAll(".ep-dialog.picker").length === 0,
  "点完自动关窗回到岗位列表");
check(document.querySelectorAll(".ep-primary")
  .filter(b => b.textContent.indexOf("就是") >= 0).length === 0,
  "单选岗位的换人弹窗不再出现「就是 TA」");

/* 回归：换人卡片要有明确的关闭入口，且同一时刻只能存在一张
   一体机上没有鼠标，旧卡叠在新卡下面时用户只能再操作一次。 */
const shutRow = document.querySelectorAll(".ep-rowline")
  .filter(l => l.textContent.indexOf("擦窗户") >= 0)[0];
const shutRoleId = shutRow.dataset.roleId;
shutRow.children[0]._h.click();
const shutBtn = document.querySelector(".ep-dialog-close");
check(!!shutBtn && shutBtn.textContent === "关闭",
  "换人卡片右上角有显式「关闭」按钮", shutBtn ? shutBtn.textContent : "没有关闭按钮");
const closeRule = (fs.readFileSync(path.join(ROOT, "app/edit.css"), "utf8")
  .match(/\.ep-dialog-close\{[^}]*\}/) || [""])[0];
check(/min-width:\s*44px/.test(closeRule) && /min-height:\s*44px/.test(closeRule),
  "关闭按钮触摸区域不小于 44px", closeRule.replace(/\s+/g, " "));
check(!!document.querySelector(".ep-picker-mask"), "卡片下面有遮罩，挡住后面的岗位");
shutBtn._h.click();
check(document.querySelectorAll(".ep-dialog.picker").length === 0
      && document.querySelectorAll(".ep-picker-mask").length === 0,
  "点「关闭」后卡片和遮罩都消失");

/* 叠加根因：openPicker 只 append 不清理旧卡，且没有遮罩拦背后点击 */
shutRow.children[0]._h.click();
shutRow.children[0]._h.click();
check(document.querySelectorAll(".ep-dialog.picker").length === 1,
  "连点两次也只留一张换人卡片",
  document.querySelectorAll(".ep-dialog.picker").length + " 张");
const otherRow = document.querySelectorAll(".ep-rowline")
  .filter(l => l.textContent.indexOf("节能小队长") >= 0)[0];
otherRow.children[0]._h.click();
check(document.querySelectorAll(".ep-dialog.picker").length === 1,
  "开着一张卡时再点别的岗位，也只留一张",
  document.querySelectorAll(".ep-dialog.picker").length + " 张");
document.querySelector(".ep-picker-mask")._h.click();
check(document.querySelectorAll(".ep-dialog.picker").length === 0,
  "点遮罩能关掉卡片");

otherRow.children[0]._h.click();
(docHandlers.keydown || []).forEach(fn => fn({ key: "Escape" }));
check(document.querySelectorAll(".ep-dialog.picker").length === 0,
  "按 Esc 能关掉卡片");

/* 取消不写配置；关掉卡片后岗位列表和滚动位置都还在 */
document.querySelector(".ep-rows").scrollTop = 77;
document.querySelector(".ep-body").scrollTop = 21;
const ovBeforeClose = JSON.stringify(global.Store.getDayOverride("2026-11-09") || {});
shutRow.children[0]._h.click();
document.querySelectorAll(".ep-person")[0]._h.click();
check(JSON.stringify(global.Store.getDayOverride("2026-11-09") || {}) === ovBeforeClose,
  "只勾选还没确定，配置不变");
document.querySelector(".ep-dialog-close")._h.click();
check(JSON.stringify(global.Store.getDayOverride("2026-11-09") || {}) === ovBeforeClose,
  "点关闭后这次选择没写进配置", "role=" + shutRoleId);
check(document.querySelector(".ep-rows").scrollTop === 77
      && document.querySelector(".ep-body").scrollTop === 21,
  "关掉卡片后滚动位置和列表状态都还在",
  "rows=" + document.querySelector(".ep-rows").scrollTop
  + " body=" + document.querySelector(".ep-body").scrollTop);

global.Store.resetConfig();
global.Edit.close();

/* ---------- 课前准备提前量：老师自己在「文字」页改 ---------- */
const prepLead = global.Store.prefs().prepLead;
check(prepLead === undefined, "默认没写提前量，走系统 10 分钟", String(prepLead));

/* 正在看的课间：09:19 还差 11 分钟，不该提示下一节 */
global.__rhythmDate = "2026-11-05";
global.__rhythmTime = 9 * 60 + 19;
global.Screen.render();
check(document.getElementById("after").textContent.indexOf("下一节") < 0,
  "提前 11 分钟时屏上没有下一节");

global.Edit.open();
const textTab = document.querySelectorAll(".ep-tab").filter(b => b.textContent === "文字")[0];
textTab._h.click();
const leadInput = document.querySelector(".ep-stepnum");
const leadBtns = document.querySelectorAll(".ep-stepbtn");
check(!!leadInput && leadBtns.length === 2 && leadInput.value === "10",
  "文字页有分钟数输入框和 − ＋", leadInput ? leadInput.value : "没有输入框");

leadBtns[1]._h.click();
check(global.Store.prefs().prepLead === 11 && leadInput.value === "11",
  "点 ＋ 立刻加一分钟并落盘", String(global.Store.prefs().prepLead));
check(document.getElementById("after").textContent.indexOf("下一节") >= 0,
  "提前量改完后，当前这一屏马上重算", document.getElementById("after").textContent);

leadInput.value = "15";
leadInput._h.change();
check(global.Store.prefs().prepLead === 15, "输入 15 分钟并保存", String(global.Store.prefs().prepLead));

leadInput.value = "";
leadInput._h.change();
check(global.Store.prefs().prepLead === 10 && leadInput.value === "10",
  "清空输入框回到默认 10", String(global.Store.prefs().prepLead));

["0", "-3", "abc"].forEach(function (bad) {
  leadInput.value = bad;
  leadInput._h.change();
  check(global.Store.prefs().prepLead === 10 && leadInput.value === bad,
    "非法输入 " + bad + " 不改配置，留在框里等重填",
    "store=" + global.Store.prefs().prepLead + " input=" + leadInput.value);
});
leadInput.value = "99";
leadInput._h.change();
check(global.Store.prefs().prepLead === 30, "超过上限按 30 分钟算", String(global.Store.prefs().prepLead));

/* 退出重进仍是设定值；导出导入带着走 */
global.Edit.close();
global.Edit.open();
document.querySelectorAll(".ep-tab").filter(b => b.textContent === "文字")[0]._h.click();
check(document.querySelector(".ep-stepnum").value === "30",
  "退出再进面板，提前量没丢", document.querySelector(".ep-stepnum").value);
const exported = global.Store.exportAll();
check(exported.prefs.prepLead === 30, "导出文件里带着提前量", String(exported.prefs.prepLead));
global.Store.setPref("prepLead", 5);
const imported = global.Store.importAll(exported);
check(imported.ok && global.Store.prefs().prepLead === 30,
  "导入后提前量恢复", imported.ok ? String(global.Store.prefs().prepLead) : imported.why);

/* 步进按钮的触摸区 */
const stepRule = (fs.readFileSync(path.join(ROOT, "app/edit.css"), "utf8")
  .match(/\.ep-stepbtn\{[^}]*\}/) || [""])[0];
check(/min-width:\s*44px/.test(stepRule) && /min-height:\s*44px/.test(stepRule),
  "− ＋ 按钮触摸区域不小于 44px", stepRule.replace(/\s+/g, " "));
global.Edit.close();
delete localStorage._d["rhythm.prefs.v1"];

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
check(document.getElementById("qr-copy-row").hidden === false, "有地址时出现「复制地址」");

/* 地址变化：服务记着上次的地址，对不上就在面板上说清楚，别让老师以为坏了 */
global.Remote.info.addrChanged = true;
global.Remote.info.lastLan = "http://192.168.1.8:8765";
global.PhoneUI.open();
const changeEl = document.getElementById("qr-change");
check(changeEl.hidden === false && String(changeEl.textContent).indexOf("192.168.1.8") >= 0,
  "地址变了会提示上次的地址", changeEl.textContent);

/* 复制：file:// 下走 textarea + execCommand，成功时给一句「已复制」 */
El.prototype.select = function () {};
document.execCommand = () => true;
document.getElementById("qr-copy")._h.click();
check(document.getElementById("qr-copied").hidden === false
      && document.getElementById("qr-copied").textContent === "已复制",
  "点「复制地址」后有反馈", document.getElementById("qr-copied").textContent);

global.Remote.info.addrChanged = false;
global.Remote.info.lastLan = "";

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
(async function () {
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
  check(box.querySelectorAll(".setup-time-file").length === 1
        && box.querySelector(".setup-time-file").accept === ".xlsx,.docx",
    "第二步能直接选作息表文件");
  check(box.querySelector(".setup-time-apply").disabled === true,
    "没识别前「套用到作息」不可点");
  const timeTa = box.querySelector(".setup-import-text");
  timeTa.value = "8:10—8:50\t第 一 节\n8:50—9:20\t大课间（升旗仪式）";
  timeTa._h.input();
  box.querySelector(".setup-time-run")._h.click();
  check(box.querySelector(".setup-time-apply").disabled === false, "识别作息后可以套用");
  check(/读到 2 行/.test(box.querySelector(".setup-msg").textContent),
    "识别作息给出读数", box.querySelector(".setup-msg").textContent);

  next()._h.click();
  const cells = inputsIn(box).filter(i => i.type !== "file");
  check(cells.length === 35, "第三步是 5×7 课表", cells.length + " 格");
  check(box.querySelectorAll(".setup-grid-file").length === 1
        && box.querySelector(".setup-grid-file").accept === ".xlsx,.docx",
    "第三步能直接选班级课表文件");
  const gridTa = box.querySelector(".setup-import-text");
  gridTa.value = "周一\t周二\t周三\t周四\t周五\n第 1 节\t英语\t语文\t语文\t语文\t数学";
  gridTa._h.input();
  box.querySelector(".setup-grid-run")._h.click();
  check(/识别到 5 格/.test(box.querySelector(".setup-msg").textContent),
    "识别课表给出格数", box.querySelector(".setup-msg").textContent);

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
  /* 配置本来就一致时，最后一步只给「完成」；「重新应用」是次要动作，
     不会出现「完成」一关就把草稿丢掉的路径。 */
  check(doneBtns.indexOf("完成") >= 0 && doneBtns.indexOf("重新应用") >= 0
        && doneBtns.indexOf("应用到这台机器") < 0,
    "未改动时最后一步先给「完成」，应用是次要动作", doneBtns.join(" / "));

  /* 完成页的时间线预览：不用等到明天，当场看到配完的样子 */
  const tl = box.querySelectorAll(".tl-row");
  check(tl.length >= 10, "完成页有当天时间线预览", tl.length + " 行");
  check(tl.length && tl[0].textContent.indexOf(
        (window.RHYTHM_DATA.timetable.blocks || [])[0].start) >= 0,
    "预览从作息第一段开始", tl.length ? tl[0].textContent : "");
  check(inputsIn(box).length > 35, "岗位和文案都能直接编辑",
    String(inputsIn(box).length));

  /* B4b：从岗位表导入。粘贴 → 识别 → 核对四态 → 并入草稿 */
  const studentsBefore = JSON.stringify(window.RHYTHM_DATA.students);
  check(box.querySelectorAll(".setup-import-open").length === 1,
    "第四步有「从岗位表导入」入口");
  box.querySelector(".setup-import-open")._h.click();
  check(box.querySelectorAll(".setup-import-block").length === 1
        && box.querySelectorAll(".setup-import-roster-names").length === 1,
    "打开后先出现①学生名单板块", String(box.querySelectorAll(".setup-import-block").length));
  check(box.querySelector(".setup-import-roster-names").textContent.indexOf("孙星野") >= 0,
    "①里列出名册姓名");
  check(box.querySelectorAll(".setup-import-text").length === 0
        && box.querySelectorAll(".setup-import-gate").length === 1,
    "名单没确认前，岗位表上传入口不出现");

  /* 名册修正：只改本机核对用的名单，② 仍要先重新确认 */
  check(box.querySelectorAll(".setup-roster-fix").length === 1, "①有「修正名单」入口");
  box.querySelector(".setup-roster-fix")._h.click();
  check(box.querySelectorAll(".setup-roster-text").length === 1, "点修正后出现名单编辑框");
  box.querySelector(".setup-roster-text").value = "孙星野\n孔子墨\n新同学测试";
  box.querySelector(".setup-roster-save")._h.click();
  check(box.querySelectorAll(".setup-roster-text").length === 0, "保存后收起编辑框");
  check(box.querySelectorAll(".setup-import-text").length === 0,
    "名单变了，岗位表要重新确认");
  const fixedNames = box.querySelector(".setup-import-roster-names").textContent;
  check(fixedNames.indexOf("新同学测试") >= 0 && fixedNames.indexOf("赵子墨") < 0,
    "①显示修正后的名单", fixedNames);
  box.querySelector(".setup-roster-reset")._h.click();
  const backNames = box.querySelector(".setup-import-roster-names").textContent;
  check(backNames.indexOf("新同学测试") < 0 && backNames.indexOf("赵子墨") >= 0,
    "「恢复班级名单」回到原名单", backNames.slice(0, 20));

  box.querySelector(".setup-roster-ok")._h.click();
  check(box.querySelectorAll(".setup-import-block").length === 2,
    "确认名单后出现②岗位表板块", String(box.querySelectorAll(".setup-import-block").length));
  check(box.querySelectorAll(".setup-import-text").length === 1,
    "打开后有粘贴框");

  const ta = box.querySelector(".setup-import-text");
  ta.value = "岗位,职责,负责人\n路队长,提醒静齐排队,孙星野、孔子墨\n图书角管理员,整理图书角,周予宁";
  ta._h.input();
  box.querySelector(".setup-import-run")._h.click();
  check(box.querySelectorAll(".setup-import-row").length === 2,
    "CSV 识别出两行岗位", String(box.querySelectorAll(".setup-import-row").length));
  check(box.querySelectorAll(".setup-import-person.exact").length === 3,
    "三名人员精确命中名册", String(box.querySelectorAll(".setup-import-person.exact").length));
  const tags = box.querySelectorAll(".setup-import-tag").map(t => t.textContent);
  check(tags.indexOf("更新「路队长」") >= 0 && tags.indexOf("新增岗位") >= 0,
    "预览分清「更新现有」和「新增」", tags.join(" / "));

  box.querySelector(".setup-import-apply")._h.click();
  check(box.querySelectorAll(".setup-role").length === bakedRoles.length + 1,
    "并入草稿后岗位卡片多一个", box.querySelectorAll(".setup-role").length + " / " + bakedRoles.length);
  check(inputsIn(box).some(i => i.value === "图书角管理员"),
    "新增岗位出现在草稿里");
  check(!(JSON.parse(localStorage.getItem("rhythm.config.v1") || "{}").roles),
    "只进草稿，没写大屏配置");
  check(box.querySelectorAll(".setup-import").length === 0
        && box.querySelectorAll(".setup-import-count").length === 1,
    "并入后收起面板，留下待确认计数");

  /* 疑似错字 / 未找到：先列差异，老师点「采用」才写 */
  box.querySelector(".setup-import-open")._h.click();
  const ta2 = box.querySelector(".setup-import-text");
  ta2.value = "窗户小管家：孙星野、孔子默、王小明";
  ta2._h.input();
  box.querySelector(".setup-import-run")._h.click();
  check(box.querySelectorAll(".setup-import-person.typo").length === 1
        && box.querySelectorAll(".setup-import-person.missing").length === 1,
    "疑似错字和未找到都列出来，不静默写入");
  const useBtn = box.querySelector(".setup-import-use");
  check(!!useBtn, "疑似错字旁边有「采用」按钮");
  useBtn._h.click();
  check(box.querySelector(".setup-import-person.typo").textContent.indexOf("已采用") >= 0,
    "点「采用」后确认候选姓名");
  box.querySelector(".setup-import-cancel")._h.click();
  check(box.querySelectorAll(".setup-import").length === 0, "「取消」收起导入面板");

  /* Word 表格粘贴：textarea 只会插入纯文本，HTML 结构要从剪贴板另外接住 */
  const wordHtml = '<html><head><style>p{margin:0}</style></head><body><table>'
    + '<tr><td><p><span>岗位</span></p></td><td><p><span>职责</span></p></td>'
    + '<td><p><span>负责人</span></p></td></tr>'
    + '<tr><td><p><span>路队长</span></p></td><td><p><span>提醒&nbsp;静齐排队</span></p></td>'
    + '<td><p><span>孙星野、孔子墨</span></p></td></tr></table></body></html>';
  box.querySelector(".setup-import-open")._h.click();
  const ta3 = box.querySelector(".setup-import-text");
  ta3.value = "";
  ta3._h.paste({
    clipboardData: { getData: t => t === "text/html" ? wordHtml : "" },
    preventDefault() {}
  });
  ta3._h.input();
  box.querySelector(".setup-import-run")._h.click();
  check(box.querySelectorAll(".setup-import-row").length === 1,
    "Word 表格粘贴：接住剪贴板里的 HTML，而不是只读纯文本",
    String(box.querySelectorAll(".setup-import-row").length));
  check(box.querySelector(".setup-import-name").value === "路队长",
    "Word 表格：岗位名识别正确", box.querySelector(".setup-import-name").value);
  check(box.querySelectorAll(".setup-import-person.exact").length === 2,
    "Word 表格：姓名仍然拿名册核对");
  box.querySelector(".setup-import-cancel")._h.click();

  /* 直接选 .xlsx 文件：文件直读是异步的，change 之后要等它 render */
  const zipOf = entries => {
    const locals = [], centrals = [];
    let off = 0;
    entries.forEach(e => {
      const name = Buffer.from(e.name, "utf8");
      const body = Buffer.from(e.body);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt32LE(body.length, 18);
      lh.writeUInt32LE(body.length, 22);
      lh.writeUInt16LE(name.length, 26);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt32LE(body.length, 20);
      ch.writeUInt32LE(body.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(off, 42);
      locals.push(lh, name, body);
      centrals.push(ch, name);
      off += 30 + name.length + body.length;
    });
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    return Buffer.concat([Buffer.concat(locals), cd, eocd]);
  };
  const xlsxBytes = zipOf([
    { name: "xl/workbook.xml", body:
      '<workbook><sheets><sheet name="岗位表" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: "xl/_rels/workbook.xml.rels", body:
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: "xl/sharedStrings.xml", body:
      '<sst><si><t>岗位</t></si><si><t>职责</t></si><si><t>负责人</t></si>'
      + '<si><t>窗户小管家</t></si><si><t>擦窗台</t></si><si><t>周予安</t></si></sst>' },
    { name: "xl/worksheets/sheet1.xml", body:
      '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row>'
      + '</sheetData></worksheet>' }
  ]);

  box.querySelector(".setup-import-open")._h.click();
  const fileInput = box.querySelector(".setup-import-file");
  check(!!fileInput && fileInput.type === "file" && fileInput.accept === ".xlsx,.docx",
    "导入面板能直接选 .xlsx / .docx 文件",
    fileInput && (fileInput.type + " / " + fileInput.accept));
  fileInput.files = [{ name: "岗位表.xlsx", arrayBuffer: () => Promise.resolve(xlsxBytes) }];
  fileInput._h.change();
  /* 桩把 setTimeout 换成了空实现，这里用 setImmediate 等微任务链跑完 */
  await new Promise(r => setImmediate(r));
  check(box.querySelectorAll(".setup-import-row").length === 1,
    "选 .xlsx 文件后直接出预览", String(box.querySelectorAll(".setup-import-row").length));
  check(box.querySelector(".setup-import-name").value === "窗户小管家",
    "xlsx 文件里的岗位名读对了", box.querySelector(".setup-import-name").value);
  const flash = box.querySelectorAll(".setup-msg").map(m => m.textContent);
  check(flash.some(t => t.indexOf("岗位表.xlsx") >= 0),
    "提示里说明读的是哪个文件", flash.join(" | "));
  box.querySelector(".setup-import-cancel")._h.click();

  check(JSON.stringify(window.RHYTHM_DATA.students) === studentsBefore,
    "导入全程没有新增学生");

  box.querySelector(".setup-x")._h.click();
  check(!box.classList.contains("open"), "「×」能关掉向导");

  /* ---------- B5：改班名 → 课表落盘 → 刷新仍在 ----------
     向导只写 localStorage；"刷新"在 node 里用一个干净的 window 重放
     data.js + store.js + runtime.js 来模拟，不依赖真实浏览器。 */
  localStorage.removeItem("rhythm.setup.draft.v1");
  btn._h.click();
  const nameInput = inputsIn(box)[1];
  nameInput.value = "测试二班";
  nameInput._h.input();
  next()._h.click();

  const startInput = inputsIn(box)[0];
  startInput.value = "07:40";
  startInput._h.change();
  next()._h.click();
  next()._h.click();
  /* 还没点应用，预览也必须是刚改的 07:40——它读的是草稿，不是已保存配置 */
  const pvEl = box.querySelector(".setup-timeline");
  check(!!pvEl && pvEl.textContent.indexOf("07:40") >= 0,
    "预览跟着还没应用的草稿走", pvEl ? pvEl.textContent.slice(0, 60) : "没有预览");
  box.querySelectorAll(".setup-btn").filter(b => b.textContent === "应用到这台机器")[0]._h.click();
  box.querySelectorAll(".setup-btn").filter(b => b.textContent === "确认保存")[0]._h.click();

  const landed = JSON.parse(localStorage.getItem("rhythm.config.v1") || "{}");
  check(landed.meta && landed.meta.klass === "测试二班",
    "改的班名写进了本机配置", landed.meta && landed.meta.klass);
  check(landed.timetable && landed.timetable.blocks[0].start === "07:40",
    "改的作息也落盘了", landed.timetable && landed.timetable.blocks[0].start);

  const afterBtns = box.querySelectorAll(".setup-btn").map(b => b.textContent);
  check(afterBtns.indexOf("完成") >= 0 && afterBtns.indexOf("应用到这台机器") < 0,
    "应用成功后主按钮变成「完成」", afterBtns.join(" / "));

  /* 应用后不用刷新，抬头当场就是新班名（B5 真浏览器验收时补上的） */
  Screen.render();
  check(document.getElementById("cls").textContent === "测试二班",
    "应用后不刷新抬头就换班名", document.getElementById("cls").textContent);

  /* 用一个完全干净的 window 重放页面脚本，等价于刷新 */
  const fresh = { console, localStorage: global.localStorage };
  fresh.window = fresh; fresh.self = fresh;
  ["app/data.js", "app/engine/schedule.js", "app/clock.js", "app/config.js", "app/store.js", "app/runtime.js"]
    .forEach(f => new Function("window", "self", "module", "exports", "localStorage", "console",
      fs.readFileSync(path.join(ROOT, f), "utf8"))(fresh, fresh, undefined, undefined, global.localStorage, console));
  check(fresh.Runtime.config().meta.klass === "测试二班", "刷新后班名还在",
    fresh.Runtime.config().meta.klass);
  check(fresh.Runtime.config().timetable.blocks[0].start === "07:40",
    "刷新后作息还在", fresh.Runtime.config().timetable.blocks[0].start);
  check(fresh.CFG.klass() === "测试二班", "刷新后屏上抬头用的是新班名", fresh.CFG.klass());
  const freshDay = fresh.Runtime.day("2026-11-09");
  check(!!freshDay && freshDay.timeline[0].start === "07:40",
    "刷新后当天时间线按新作息算", freshDay && freshDay.timeline[0].start);

  box.querySelector(".setup-x")._h.click();
  localStorage.removeItem("rhythm.setup.draft.v1");
  global.Store.resetConfig();

  /* ---------- B5：空配置自动进向导 ---------- */
  const baked = window.RHYTHM_DATA;
  delete window.RHYTHM_DATA;
  loadBrowserScript("app/setup.js");
  check(box.classList.contains("open"), "空配置打开页面就直接进向导");
  check(document.body.dataset.setup === "1", "向导打开时主屏的提示先让位");
  const blankName = inputsIn(box)[1];
  blankName.value = "空包测试班";
  blankName._h.input();
  next()._h.click();
  check(box.querySelectorAll(".setup-row").length > 20,
    "空包第二步已经套上一套模板，不是空表",
    String(box.querySelectorAll(".setup-row").length));
  next()._h.click();
  next()._h.click();
  const blankTl = box.querySelectorAll(".tl-row");
  check(blankTl.length > 20, "空包完成页也能预览时间线", String(blankTl.length));
  box.querySelector(".setup-x")._h.click();
  check(document.body.dataset.setup === "", "关掉向导后主屏提示恢复");

  window.RHYTHM_DATA = baked;
  localStorage.removeItem("rhythm.setup.draft.v1");
  global.Store.resetConfig();
  loadBrowserScript("app/setup.js");
  check(!box.classList.contains("open"), "配置齐全时启动不自动弹向导");

  /* ---------- 课间：「准备好」提到「课间」下一行、同字号 ---------- */
  global.__rhythmDate = "2026-11-05";
  global.__rhythmTime = 10 * 60 + 18;
  Screen.render();
  const chipRows = document.getElementById("chips").children;
  const bTask = document.getElementById("heroTask");
  const bMain = document.getElementById("heroMain");
  check(chipRows.length === 1 && chipRows[0].className === "chip-row",
    "课间底部只留喝水/上厕所，不再重复清单",
    chipRows.map(r => r.className).join(" → "));
  check(bTask.textContent.indexOf("准备好") === 0,
    "「准备好」在「课间」的下一行",
    bTask.textContent);
  check(bTask.style.fontSize === bMain.style.fontSize,
    "「准备好」和「课间」同字号",
    bTask.style.fontSize + " / " + bMain.style.fontSize);

  console.log("\n" + pass + "/" + (pass + fail) + " 通过");
  process.exit(fail ? 1 : 0);
})();
