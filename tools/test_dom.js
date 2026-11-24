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
  contains(n) {
    if (n === this) return true;
    return this.children.some(c => c.contains(n));
  }
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
const BTN_IDS = new Set(["warn-title", "btn-help", "btn-min", "btn-exit",
  "exitCancel", "exitGo", "guideSkip", "guideNext", "helpClose", "helpCloseBtn", "helpPhone",
  "cdAuto", "cdDone"]);
["cls", "date", "clock", "sec", "main", "band", "bandText", "stageTip", "spine", "heroMain", "heroSub", "heroTask", "after", "chips",
 "duty", "dutyDetail", "warn", "warn-title", "warn-text", "corner", "menu",
 "btn-cd", "btn-full", "btn-reduce", "btn-edit", "btn-gear", "btn-demo", "btn-theme", "btn-phone",
 "btn-update", "update-dot", "btn-help", "btn-min", "btn-exit",
 "exitModal", "exitCancel", "exitGo", "exitText",
 "guideModal", "guideTitle", "guideText", "guideDots", "guideSkip", "guideNext",
 "cdModal", "cdList", "cdAuto", "cdDone",
 "helpModal", "helpClose", "helpCloseBtn", "helpPhone",
 "qr-panel", "qr-url", "qr-empty", "qr-close",
 "qr-copy-row", "qr-copy", "qr-copied", "qr-change",
 "msgModal", "msgCard", "msgContent", "msgBody", "msgTitle", "msgTime", "msgClose",
 "setup", "btn-setup", "ver", "tip", "tipText", "tipClose",
 "demo", "d-play", "d-now", "d-ribbon", "d-range", "d-speed", "d-close"].forEach(id => {
  const e = new El(id.indexOf("btn") === 0 || BTN_IDS.has(id) ? "button" : "div");
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
["tools/fixtures/data.sample.js", "app/version.js", "app/engine/schedule.js", "app/qr.js", "app/clock.js", "app/config.js", "app/subjects.js", "app/rhythm.js", "app/pinyin.js", "app/store.js", "app/runtime.js", "app/screen.js", "app/remote.js", "app/phoneui.js", "app/edit.js", "app/update.js", "app/backup.js", "app/demo.js", "app/templates.js", "app/setup.js"]
  .forEach(loadBrowserScript);

check(!!global.Screen, "screen.js 注册成功");

/* 班级名只有一个来源：data.js 的 meta。页面文件里不该再出现具体班名——
   这条就是防止以后又把具体班名写回页面。 */
check(!!global.CFG, "config.js 注册成功");
check(CFG.klass() === window.RHYTHM_DATA.meta.klass, "班名取自数据", CFG.klass());
/* 班名以数据里那个为准，这样真数据、示例数据都能查同一件事 */
const pageFiles = ["app/index.html", "app/screen.js", "app/edit.js", "app/config.js", "app/rhythm.js", "app/pinyin.js", "app/store.js"];
const KNAME = (window.RHYTHM_DATA.meta || {}).klass;
const hard = pageFiles.filter(f => fs.readFileSync(path.join(ROOT, f), "utf8").includes(KNAME));
check(!!KNAME && hard.length === 0, "页面里没有写死的班名", hard.join(", ") || "无");
check(!!global.Edit, "edit.js 注册成功");
check(!!global.Demo, "demo.js 注册成功");
check(!!global.Remote, "remote.js 注册成功");
check(global.Remote && /127\.0\.0\.1:8765/.test(global.Remote.hub), "默认连本机服务", global.Remote && global.Remote.hub);

/* 消息过期判定：until 只有 HH:MM，跨零点时字符串比较会反过来。
   23:55 发一条 10 分钟的消息，until=00:05 —— 不能当场判成"已过期"，否则
   老师晚上发的通知大屏上什么都不显示（2026-11-22 23:53 的 CI 就是这么红的）。 */
{
  const exp = global.Remote._noticeExpired;
  check(typeof exp === "function", "跨零点判定是可单测的纯函数");
  if (typeof exp === "function") {
    check(exp("00:05", "23:55") === false, "23:55 发的 10 分钟消息，零点前不算过期");
    check(exp("00:05", "00:01") === false, "跨零点后仍在有效期内");
    check(exp("12:30", "12:31") === true, "同一天过点就算过期");
    check(exp("12:30", "12:29") === false, "还没到点");
    check(exp("", "23:59") === false, "没有 until 就不过期");
  }
}

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
/* 单文件演示版由 Rust 打包器出（0.5.3 起 tools/package.py 退役），
   它必须把真实版本与构建号写进去，别让老师看到 v0.0.0 · dev */
check(/stamp_version/.test(fs.readFileSync(path.join(ROOT, "desktop/tools-rs/src/single.rs"), "utf8")),
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

/* 一键重启服务（0.3.17）：按钮只在服务认得 restart 路由时亮 */
const updateSrc = fs.readFileSync(path.join(ROOT, "app/update.js"), "utf8");
/* 0.5.3 起服务是 Rust：能力标记与重启路由去 desktop/server-rs 里核对 */
const serverSrc = fs.readFileSync(path.join(ROOT, "desktop/server-rs/src/routes.rs"), "utf8")
  + fs.readFileSync(path.join(ROOT, "desktop/server-rs/src/main.rs"), "utf8");
check(updateSrc.includes("/api/update/restart") && updateSrc.includes("重启服务，立即生效")
      && updateSrc.includes("canRestart") && updateSrc.includes("waitServerBack"),
  "更新面板：重启按钮走能力探测 + 轮询恢复");
check(serverSrc.includes("canRestart") && serverSrc.includes("/api/update/restart")
      && serverSrc.includes("--wait-port"),
  "服务端：restart 路由 + canRestart 能力标记 + --wait-port 自重启");

/* 跨代更新还给手动出路。
   0.3.x 时这条出路是「kiosk 启动脚本发现服务比包旧就换新进程」；0.5.x 起
   没有启动脚本了，换新由桌面壳统一管（托盘 → 检查更新），页面只负责在
   面板里把「关掉大屏程序 / 双击桌面图标」说清楚。 */
check(updateSrc.includes("关掉大屏程序") && updateSrc.includes("双击桌面图标"),
  "跨代更新：面板给手动出路指引");

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

/* 晨间自主管理：7:30–8:10 是真实的一段；标题固定，学习建议不再上屏 */
global.__rhythmDate = "2026-11-05";
global.__rhythmTime = 7 * 60 + 30;
global.Store.patchTexts({
  reading: { "4": { subject: "英语", task: "读 Unit 4 单词" } },
  reminders: { "default": "带齐回执" }
});
Screen.render();
check(heroText() === "晨间自主管理", "周四 7:30 标题是「晨间自主管理」", heroText());
const taskEl = document.getElementById("heroTask");
check(taskEl.textContent === "",
  "以前填的学习建议不再上屏，主视觉下面为空", JSON.stringify(taskEl.textContent));
const remRow = document.querySelector(".reminder-line");
check(!!remRow && remRow.textContent.indexOf("带齐回执") >= 0,
  "提醒事项单独一块上屏", remRow ? remRow.textContent : "缺失");
check(document.querySelectorAll(".prep-line").length === 0,
  "建议不再以小字清单的形式出现");

/* 打铃前也归入晨间：7:29 的主视觉和顶栏都不再出现「到校」字样 */
global.__rhythmTime = 7 * 60 + 29;
Screen.render();
check(heroText() === "晨间自主管理", "7:29 打铃前也是「晨间自主管理」", heroText());
check(document.getElementById("bandText").textContent === "晨间自主管理",
  "顶栏写「晨间自主管理」", document.getElementById("bandText").textContent);
check(document.body.textContent.indexOf("到校") < 0,
  "整屏不再出现「到校」字样");
global.__rhythmTime = 7 * 60 + 30;
Screen.render();

/* 第二行整段晨间都在：大字下面，同一句不只留贴纸 */
global.Store.patchTexts({
  stage: { before: { title: "早上好", note: "戴好红领巾，打扫好个人卫生。" } }
});
Screen.render();
check(document.getElementById("after").textContent.indexOf("戴好红领巾") >= 0,
  "晨间自主管理期间一句话仍是到校那句",
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

/* 晨间大字：老师在「晨间自主管理 · 大字」里写的那句话上主视觉。
   按 screen.js 同一套字宽估算量标题高度，确认长句折行后不顶出贴纸。 */
function heroHeight(text, size) {
  const w = Math.max(Array.from(text).reduce((n, ch) => {
    const c = ch.charCodeAt(0);
    return n + (c > 255 ? 1 : c === 32 ? 0.3 : 0.58);
  }, 0), 1);
  const lines = Math.max(1, Math.ceil((w * size - 0.5) / 70));
  return { lines, h: lines * size * 1.13 };
}
function bigText(title, note, rem) {
  global.Store.patchTexts({
    stage: { before: { title: title, note: note || "" } },
    reminders: { "default": rem || "带齐回执" }
  });
  Screen.render();
  return parseFloat(document.getElementById("heroMain").style.fontSize);
}

const b1 = bigText("读", "坐直，把书立起来。");
check(heroText() === "读" && b1 === 16, "一个字的大字顶到 16vmin", b1 + "vmin");

const t12 = "安静读英语，准备好听写本";
const s12 = bigText(t12);
const h12 = heroHeight(t12, s12);
check(heroText() === t12, "十二个字原样上屏", heroText());
check(s12 < 12 && s12 >= 8, "十二个字自动降一档", s12.toFixed(2) + "vmin");
check(h12.h <= 30.2, "十二个字折行后不超 30vmin", h12.lines + " 行 / " + h12.h.toFixed(1) + "vmin");
check(!!document.querySelector(".reminder-line"), "长句时黄色贴纸仍在");

const t32 = "安静读英语，把书立起来，坐直身体，准备好听写本，不要说话，认真读";
const s32 = bigText(t32, "坐直，把书立起来。");
const h32 = heroHeight(t32, s32);
check(heroText() === t32, "三十多个字原样上屏", t32.length + " 字");
check(s32 >= 4.6, "长句字号有下限，不会缩没", s32.toFixed(2) + "vmin");
check(h32.h <= 30.2, "长句折行后不超 30vmin", h32.lines + " 行 / " + h32.h.toFixed(1) + "vmin");
check(h32.h + 5.9 <= 41, "标题 + 第二行仍在 41vmin 的旧预算内",
  (h32.h + 5.9).toFixed(1) + "vmin");
check(!!document.querySelector(".reminder-line"), "长句时黄色贴纸没被顶掉");
check(document.getElementById("after").textContent.indexOf("坐直") >= 0,
  "第二行还是晨间那句", document.getElementById("after").textContent);

const sEmpty = bigText("   ");
check(heroText() === "晨间自主管理", "大字只有空白时回退，主视觉不空", JSON.stringify(heroText()));
check(sEmpty >= 10, "回退标题仍是大字", sEmpty.toFixed(2) + "vmin");

bigText("安静读英语", "戴好红领巾。", "戴好红领巾");
check(document.getElementById("after").textContent === "",
  "大字不影响同句让位：正文不再重复", document.getElementById("after").textContent);

bigText("换成新的一句");
check(heroText() === "换成新的一句", "改大字后不用刷新就能更新", heroText());
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
/* 真机反馈 2026-11-20：倒计时只有「后上课」不带课名，老师不知道下一节是什么 */
check(document.getElementById("heroSub").textContent.indexOf(bdNext.subject) >= 0,
  "倒计时文案带课名：后上X课",
  document.getElementById("heroSub").textContent);

/* 真机反馈 2026-11-20：noonBand 三个分界点与块表错位（午间结束被拖到
   第一节结束之后）时，重写出的午间会盖住正课——引擎输出后要把前块
   夹到后块的开始，宁可截短午间也不能遮住课。 */
global.__rhythmDate = "2026-11-09";
global.__rhythmTime = 12 * 60 + 52;
/* 12:52 的下一节是下午第一节（不是上午的 mon1），从当天 timeline 动态取 */
const pmFirst = global.Runtime.day("2026-11-09").timeline
  .filter(b => b.type === "class" && b.start >= "13:00")[0].subject;
const ttShift = JSON.parse(JSON.stringify(window.RHYTHM_DATA.timetable));
ttShift.noonBand.noonEnd = "13:40";   /* 午间一直拖到第一节结束 */
global.Runtime.patch({ timetable: ttShift });
Screen.render();
check(document.getElementById("bandText").textContent === "课间"
      && document.getElementById("after").textContent.indexOf(pmFirst) >= 0,
  "午间结束错拖到 13:40 时不得盖住第一节（12:52 已是课间、指向下一节）",
  document.getElementById("bandText").textContent + " / "
  + document.getElementById("after").textContent);
global.Store.resetConfig();

/* 两块之间的空档（比如午间与第一节之间没排课间）不能显示「放学了」，
   按课间对待，指向下一块。 */
const ttGap = JSON.parse(JSON.stringify(window.RHYTHM_DATA.timetable));
ttGap.blocks = ttGap.blocks.filter(b => !(b.type === "break" && b.start === "12:50"));
global.Runtime.patch({ timetable: ttGap });
Screen.render();
check(document.getElementById("bandText").textContent === "课间"
      && heroText().indexOf("放学") < 0,
  "块间空档按课间显示，不是「放学了」",
  document.getElementById("bandText").textContent + " / " + heroText());
check(document.getElementById("after").textContent.indexOf(pmFirst) >= 0,
  "空档写清下一节是什么课", document.getElementById("after").textContent);
global.Store.resetConfig();
Screen.render();

/* 真机反馈 2026-11-20：大课间提示语的三条规则。
   ① 准备窗口（上课前十分钟）起提示语整体让位，不再拼在「下一节」后面；
   ② 倒计时接管主视觉时提示语上移到数字上方（#stageTip）；
   ③ 逐段勾选倒计时真正接管显示（0.3.14 弹窗的债：card.countdown 无人消费）。 */
const ritualTip = (global.Runtime.day("2026-11-05").timeline
  .filter(b => b.type === "ritual")[0] || {}).tip || "";
check(ritualTip !== "", "夹具里有大课间提示语可用", ritualTip);
check(document.getElementById("after").textContent.indexOf(ritualTip) < 0,
  "大课间收尾：时段提示语不再垫在「下一节」后面",
  document.getElementById("after").textContent);
check(document.getElementById("stageTip").textContent === "",
  "收尾在准备窗口内：提示语不上移（整体让位）");

global.__rhythmTime = 9 * 60 + 10;   // 大课间前段：无倒计时、无准备窗口
Screen.render();
check(document.getElementById("after").textContent.indexOf(ritualTip) >= 0,
  "大课间前段：提示语还是老位置（主视觉下面单独一行）",
  document.getElementById("after").textContent);
check(document.getElementById("stageTip").textContent === "",
  "无倒计时时提示语不上移");

global.Store.setPref("cdMode", "all");   // 全程倒计时：与提示语共存
Screen.render();
check(document.getElementById("stageTip").textContent.indexOf(ritualTip) === 0,
  "倒计时接管时提示语上移到数字上方",
  document.getElementById("stageTip").textContent);
check(document.getElementById("after").textContent.indexOf(ritualTip) < 0,
  "提示语上移后原位置不再重复");
global.Store.setPref("cdMode", "auto");

global.Store.setPref("cdPicks", { ritual: true });   // 勾选大课间倒计时
global.__rhythmTime = 9 * 60 + 25;   // 剩 5 分钟：推荐（收尾 3 分钟）不到，勾选窗口到
Screen.render();
check(heroText().indexOf(":") >= 0,
  "勾选大课间倒计时：收尾窗口外也出（勾选真正接管显示）", heroText());
global.Store.setPref("cdPicks", null);

global.Store.setPref("cdPicks", { break: false });   // 去勾课间
global.__rhythmTime = 10 * 60 + 24;   // 课间最后 1 分钟：推荐会出，去勾后不出
Screen.render();
check(heroText().indexOf(":") < 0,
  "去勾课间倒计时：连收尾倒计时也不出", heroText());
global.Store.setPref("cdPicks", null);
Screen.render();
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

/* 改课编辑器（0.3.22）：学科下拉直选，老师按课表自动带出，学生不打字。
   单师科自动填那一位；双师科并列「A老师/B老师」（如心理/班队）。 */
const editSrcNow = fs.readFileSync(path.join(ROOT, "app/edit.js"), "utf8");
check(editSrcNow.includes("subjectTeachers") && editSrcNow.includes("join(\"/\")"),
  "改课编辑器：学科老师绑定来自课表聚合，双师用斜杠并列");
const tRows = document.querySelectorAll(".ep-row");
check(tRows.length > 0, "今天页列出可改的课", String(tRows.length));
tRows[0]._h.click();
const dlgSelect = document.querySelectorAll(".ep-select")[0];
check(!!dlgSelect && dlgSelect.children.length > 5,
  "改课弹层里学科是下拉框，选项足够多",
  dlgSelect ? dlgSelect.children.length + " 个选项" : "没有下拉框");
const dlgTea = document.querySelectorAll(".ep-tea")[0];
/* 第一行的学科与老师，从课表绑定关系里动态取，不写死 */
const bindFor = (subject) => {
  const set = [];
  global.Runtime.config().schedule.entries.forEach(e => {
    if (e.subject === subject && e.teacher && set.indexOf(e.teacher) < 0) set.push(e.teacher);
  });
  return set;
};
const rowSubject = dlgSelect.value;
const bound = bindFor(rowSubject);
check(!!dlgTea && dlgTea.value === bound.join("/"),
  "打开弹层：老师按课表自动带出（" + rowSubject + "）",
  "期望 " + bound.join("/") + "，实际 " + (dlgTea ? dlgTea.value : "无输入框"));
/* 换一个两位老师执教的学科（如心理/班队），老师自动变成并列两人 */
const dual = Object.keys(
  global.Runtime.config().schedule.entries.reduce((m, e) => {
    if (!e.subject || !e.teacher) return m;
    (m[e.subject] = m[e.subject] || new Set()).add(e.teacher);
    return m;
  }, {})
).find(s => bindFor(s).length >= 2);
if (dual) {
  dlgSelect.value = dual;
  dlgSelect._h.change();
  check(dlgTea.value === bindFor(dual).join("/"),
    "换成「" + dual + "」：两位老师并列自动带出", dlgTea.value);
}
/* 保存走原有 override 通道 */
document.querySelectorAll(".ep-lesson-save")[0]._h.click();
const ovAfter = global.Store.getDayOverride(global.Store.dayKey());
check(!!(ovAfter && ovAfter.lessons && Object.keys(ovAfter.lessons).length),
  "改课保存走今日覆盖", JSON.stringify(ovAfter && ovAfter.lessons));
global.Store.clearDayOverride(global.Store.dayKey());

/* 真机反馈 2026-11-23：上传课表后改课务，要能下拉选科目、自动带出老师，
   老师还得能改；同义科目不能在列表里并列两条（选错那条就没老师）。 */
document.querySelectorAll(".ep-row")[0]._h.click();
const sel30 = document.querySelectorAll(".ep-select")[0];
const seenKey = {};
let dupSub = null;
Array.from(sel30.children).forEach(o => {
  const k = global.Subjects.key(o.value);
  if (seenKey[k]) dupSub = seenKey[k] + " / " + o.value;
  seenKey[k] = o.value;
});
check(!dupSub, "科目下拉里没有同义重复（道法 / 道德与法治只留一条）", dupSub || "无重复");
const chips30 = document.querySelectorAll(".ep-teacher-chip");
check(chips30.length > 0, "这一科的老师做成可点的按钮，不用打字",
  chips30.length + " 个候选");
const tea30 = document.querySelectorAll(".ep-tea")[0];
if (chips30.length) {
  const last = chips30[chips30.length - 1];
  last._h.click();
  check(tea30.value === last.textContent,
    "点一下老师就填进输入框（填完仍可手改）", tea30.value);
}

/* 「以后都改」写课表本身，而不是只改今天 */
const dayKey30 = global.Store.dayKey();
const wd30 = global.Runtime.day(dayKey30).weekday;
const p30 = global.Runtime.day(dayKey30).timeline
  .filter(b => b.type === "class")[0].periodNo;
const schedBefore = JSON.parse(JSON.stringify(global.Runtime.config().schedule));
const pickSub30 = sel30.value;
document.querySelectorAll(".ep-lesson-always")[0]._h.click();
const entriesAfter = global.Runtime.config().schedule.entries;
const hit30 = entriesAfter.filter(e => +e.weekday === wd30 && +e.periodNo === p30)[0];
check(!!hit30 && hit30.subject === pickSub30,
  "「以后都改」写进课表本身（周" + wd30 + " 第 " + p30 + " 节）",
  hit30 ? hit30.subject : "没找到该节");
check(entriesAfter.length === schedBefore.entries.length,
  "改的是已有那一节，没有多塞条目", "节数 " + entriesAfter.length);
check(!(global.Store.getDayOverride(dayKey30) || {}).lessons
      || !(global.Store.getDayOverride(dayKey30).lessons || {})[p30],
  "改到课表时清掉那节的「今天覆盖」，否则它还会盖住新配置");
global.Store.patchConfig({ schedule: schedBefore });
global.Store.clearDayOverride(dayKey30);
document.querySelectorAll(".ep-dialog").forEach(n => n.remove());


/* 时段常驻（0.3.23）：课间/晨间自主管理/午间各配哪些岗位整段挂出，
   自由多选；选进来的触发走 present（freq 不再另算），没选的照旧。 */
const screenSrc = fs.readFileSync(path.join(ROOT, "app/screen.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(ROOT, "app/index.html"), "utf8");
check(editSrcNow.includes("renderDutyPresents")
      && fs.readFileSync(path.join(ROOT, "app/engine/schedule.js"), "utf8").includes("dutyPresents"),
  "时段常驻：编辑面板配置区 + 引擎读 dutyPresents 都在");
check(screenSrc.includes("duty-track") && indexSrc.includes("duty-marquee"),
  "值日条跑马灯：track 包裹 + 循环滚动样式都在");
const unsetRole = global.Runtime.config().roles.roles.find(r => r.freq && r.freq.kind === "unset");
check(!!unsetRole, "样例里有未设时间的岗位（绿植守护者）");
global.__rhythmDate = "2026-11-09";
global.__rhythmTime = 10 * 60 + 24;   /* 课间 */
global.Screen.render();
check(document.getElementById("duty").textContent.indexOf(unsetRole.name) < 0,
  "没配常驻时 unset 岗位不上屏");
global.Store.patchConfig({ dutyPresents: { break: [unsetRole.id], reading: [], noon: [] } });
global.Screen.render();
const dutyTxt = document.getElementById("duty").textContent;
check(dutyTxt.indexOf(unsetRole.name) >= 0
      && !!document.querySelector("#duty .duty-track"),
  "选进课间常驻后整段挂出（值日条在 track 里）", dutyTxt);
const presDuties = global.Runtime.day("2026-11-09").duties.filter(d => d.roleId === unsetRole.id);
check(presDuties.length > 0 && presDuties.every(d => d.freqKind === "present"),
  "常驻岗位触发走 present，freq 不再另算");
/* 组岗位常驻：格子要带具体任务名（"值日组·扫地"），不能只剩"值日组" */
const grpRole = global.Runtime.config().roles.roles.find(r => r.grp && r.groups);
check(!!grpRole, "样例里有组岗位（扫地）");
global.Store.patchConfig({ dutyPresents: { break: [grpRole.id], reading: [], noon: [] } });
global.Screen.render();
const grpTxt = document.getElementById("duty").textContent;
check(grpTxt.indexOf(grpRole.name) >= 0,
  "组岗位常驻时格子带具体任务名，不只是组名", grpTxt);
global.Store.patchConfig({ dutyPresents: null });
global.Screen.render();

/* 值日页有多选配置区（切页验证一次真实 UI），三个时段有标题分隔 */
document.querySelectorAll(".ep-tab").filter(b => b.textContent === "值日")[0]._h.click();
check(document.body.textContent.indexOf("哪些岗位整段常驻") >= 0,
  "值日页有「哪些岗位整段常驻」多选区");
const slots = document.querySelectorAll(".ep-slot");
check(slots.length === 3
      && slots[0].querySelector(".ep-slot-title").textContent === "晨间自主管理"
      && slots[1].querySelector(".ep-slot-title").textContent === "课间"
      && slots[2].querySelector(".ep-slot-title").textContent === "午间",
  "三个时段各有标题子块分隔", slots.length + " 块");
document.querySelectorAll(".ep-tab").filter(b => b.textContent === "今天")[0]._h.click();

const tabs = document.querySelectorAll(".ep-tab");
const hoursTab = tabs.filter(b => b.textContent === "作息")[0];
check(!!hoursTab, "面板里有「作息」这一页");
hoursTab._h.click();
const rows = document.querySelectorAll(".tt-row");
check(rows.length >= 10, "作息表按段列出", rows.length + " 段");
check(document.querySelectorAll(".tt-time").length === rows.length * 2,
  "每段两个时间框", String(document.querySelectorAll(".tt-time").length));

/* 作息保护（0.3.21）：正课/眼保健操/课间默认锁住，点解锁才可改；
   午间、课后服务等其余段落照旧自由改。 */
const editSrc = fs.readFileSync(path.join(ROOT, "app/edit.js"), "utf8");
check(editSrc.includes("timeLocked") && editSrc.includes("hoursUnlocked = false"),
  "作息保护：锁定判定与默认锁定都在源码里");
let unlockBtn = document.querySelectorAll(".tt-unlock")[0];
check(!!unlockBtn && unlockBtn.textContent.indexOf("已按作息表锁住") >= 0,
  "作息页有保护开关，默认锁定", unlockBtn ? unlockBtn.textContent : "缺失");
const findRow = (label) => Array.from(document.querySelectorAll(".tt-row")).find(r => {
  const tag = r.querySelector(".tt-tag");
  return tag && tag.textContent.indexOf(label) >= 0;
});
let classTimes = (findRow("正课") || {}).querySelectorAll
  ? findRow("正课").querySelectorAll(".tt-time") : [];
check(classTimes.length === 2 && classTimes[0].readOnly && classTimes[1].readOnly,
  "默认：正课时间框锁住，改不了");
let noonTimes = (findRow("午间") || {}).querySelectorAll
  ? findRow("午间").querySelectorAll(".tt-time") : [];
check(noonTimes.length === 2 && !noonTimes[0].readOnly,
  "默认：午间时间框不锁，可以自由改");
unlockBtn._h.click();
unlockBtn = document.querySelectorAll(".tt-unlock")[0];
classTimes = (findRow("正课") || { querySelectorAll: () => [] }).querySelectorAll(".tt-time");
check(unlockBtn.textContent.indexOf("已解锁") >= 0
      && classTimes.length === 2 && !classTimes[0].readOnly,
  "点解锁后：正课时间框可编辑");
unlockBtn._h.click();
classTimes = (findRow("正课") || { querySelectorAll: () => [] }).querySelectorAll(".tt-time");
check(classTimes.length === 2 && classTimes[0].readOnly,
  "再点一下：恢复锁定");

/* 改第一段（晨间自主管理）的开始时间：不点保存——输入框 change 就该立刻生效。
   第一段前面没有别的段，改开始时间不会破坏首尾相接。 */
const beforeTime = global.Runtime.day("2026-11-09").timeline[0].start;
const firstTime = document.querySelectorAll(".tt-time")[0];
firstTime.value = "07:45";
firstTime._h.change();
const afterTime = global.Runtime.day("2026-11-09").timeline[0].start;
check(afterTime === "07:45" && beforeTime !== afterTime,
  "在面板里改晨间自主管理开始时间，配置立刻重算", beforeTime + " → " + afterTime);

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

/* ---------- 换人面板（0.5.6 重构） ----------
   候选名单在最上面、已选人名紧贴着；打姓或名的拼音都能出人；
   固定 / A·B 轮流 / 按星期在同一屏里互切。 */
global.Store.patchConfig({ students: global.window.RHYTHM_DATA.students });
global.__rhythmDate = "2026-11-09";
const cleanLine = document.querySelectorAll(".ep-rowline")
  .filter(l => l.textContent.indexOf("擦窗户") >= 0)[0];
check(cleanLine.children[0].querySelectorAll(".ep-namechip").length === 8,
  "值日行上的人名各自是一个按钮（点谁就改谁）",
  cleanLine.children[0].textContent.replace(/\s+/g, " "));
cleanLine.children[0]._h.click();

const openedPeople = document.querySelectorAll(".ep-person").map(b => b.textContent);
const allRoster = global.Store.config().students.map(s => s.name);
check(openedPeople.length > 0 && openedPeople.length <= 16 && openedPeople.length < allRoster.length,
  "打开面板不铺整份名单（候选最多 16 个）",
  openedPeople.length + " 人 / 名单 " + allRoster.length + " 人");
check(document.querySelectorAll(".ep-pickchip").length === 8,
  "已选区同时列出这个岗位现在的人",
  document.querySelectorAll(".ep-pickchip").map(c => c.textContent).join("、"));
check(document.querySelectorAll(".ep-person.on").length === document.querySelectorAll(".ep-pickchip").length,
  "候选人里在岗的有按下态，和已选区对得上",
  document.querySelectorAll(".ep-person.on").length + " 人");

/* 姓名检索：打完整拼音只出这个姓；打名的拼音也找得到人 */
const qEl = document.querySelector(".ep-input");
qEl.value = "zhou";
qEl._h.input();
const zhouHits = document.querySelectorAll(".ep-person").map(b => b.textContent);
check(zhouHits.length > 0 && zhouHits.every(n => n.charAt(0) === "周"),
  "打 zhou 只出姓周的（以前赵、郑、朱也一起出来）", zhouHits.join("、"));
qEl.value = "yu";
qEl._h.input();
const yuHits = document.querySelectorAll(".ep-person").map(b => b.textContent);
check(yuHits.indexOf("周予宁") >= 0 && yuHits.indexOf("杨望舒") < 0,
  "打 yu 能找到「予宁」，不再出姓杨的", yuHits.join("、"));

/* 候选人点一下加、再点一下减；已选区的人名点一下也去掉 */
qEl.value = "孔子墨";
qEl._h.input();
const addOne = document.querySelectorAll(".ep-person")[0];
check(addOne.textContent === "孔子墨", "命中的人排在候选最前面", addOne.textContent);
addOne._h.click();
check(document.querySelectorAll(".ep-pickchip").length === 9,
  "点候选人就加进已选区", document.querySelectorAll(".ep-pickchip").length + " 人");
document.querySelectorAll(".ep-person")[0]._h.click();
check(document.querySelectorAll(".ep-pickchip").length === 8,
  "同一个人在候选里再点一下就从已选区去掉",
  document.querySelectorAll(".ep-pickchip").length + " 人");
document.querySelectorAll(".ep-pickchip")[0]._h.click();
check(document.querySelectorAll(".ep-pickchip").length === 7,
  "点已选区的人名也能去掉", document.querySelectorAll(".ep-pickchip").length + " 人");
qEl.value = "";
qEl._h.input();

/* 保存 = 写岗位配置（以后都这样） */
document.querySelector(".ep-primary")._h.click();
const r14 = global.Store.config().roles.roles.filter(r => r.id === "r14")[0];
check(r14.people.length === 7, "「保存」把结果写进岗位配置", r14.people.join("、"));
check(document.querySelectorAll(".ep-dialog.picker").length === 0, "保存后自动关窗回到列表");

/* 只改今天：写当天覆盖，岗位配置一个字不动 */
const confBeforeToday = JSON.stringify(global.Store.config().roles.roles.filter(r => r.id === "r14")[0].people);
document.querySelectorAll(".ep-rowline").filter(l => l.textContent.indexOf("擦窗户") >= 0)[0].children[0]._h.click();
const todayPick = document.querySelectorAll(".ep-person").filter(b => !b.classList.contains("on"))[0];
const todayName = todayPick.textContent;
todayPick._h.click();
document.querySelector(".ep-todayonly")._h.click();
const r14ov = (global.Store.getDayOverride("2026-11-09") || {}).roles || {};
check(!!r14ov.r14 && r14ov.r14.people.indexOf(todayName) >= 0,
  "「只改今天」写当天的临时覆盖", JSON.stringify(r14ov.r14));
check(JSON.stringify(global.Store.config().roles.roles.filter(r => r.id === "r14")[0].people) === confBeforeToday,
  "「只改今天」不动岗位配置");

/* 保存会把今天的临时覆盖清掉，否则屏上还是旧人，老师以为没保存上 */
document.querySelectorAll(".ep-rowline").filter(l => l.textContent.indexOf("擦窗户") >= 0)[0].children[0]._h.click();
document.querySelector(".ep-primary")._h.click();
const ovAfterSave = ((global.Store.getDayOverride("2026-11-09") || {}).roles || {}).r14;
check(!ovAfterSave, "保存岗位配置时顺手清掉今天的临时覆盖");

/* ---------- 出人方式：固定 ⇄ A/B ⇄ 按星期，同一屏里双向切 ---------- */
const energyLine = document.querySelectorAll(".ep-rowline")
  .filter(l => l.textContent.indexOf("节能小队长") >= 0)[0];
energyLine.children[0]._h.click();
const modeBtns = document.querySelectorAll(".ep-modebtn");
check(modeBtns.length === 3, "面板里有固定 / A·B 轮流 / 按星期三种方式",
  modeBtns.map(b => b.textContent).join("、"));
const onMode = modeBtns.filter(b => b.classList.contains("on"))[0];
check(!!onMode && onMode.textContent === "固定", "当前方式是「固定」时那个按钮按下去",
  onMode ? onMode.textContent : "没有按下态");
modeBtns.filter(b => b.textContent === "A/B 轮流")[0]._h.click();
check(document.querySelectorAll(".ep-seat").length === 2,
  "切到 A/B 轮流后出现两个槽位",
  document.querySelectorAll(".ep-seat").map(b => b.textContent).join("、"));
check(document.querySelectorAll(".ep-seat.on")[0].textContent.indexOf("A 组") === 0,
  "自动落到 A 组（新方式的第一格）",
  document.querySelectorAll(".ep-seat.on")[0].textContent);
check(document.querySelectorAll(".ep-pickchip").map(c => c.textContent).join("、").indexOf("吕雨桐") === 0,
  "原来固定的人整批搬进 A 组，不丢",
  document.querySelectorAll(".ep-pickchip").map(c => c.textContent).join("、"));
document.querySelector(".ep-primary")._h.click();
const r02 = global.Store.config().roles.roles.filter(r => r.id === "r02")[0];
check(r02.mode === "ab" && (r02.groups.A || []).join("、") === "吕雨桐",
  "保存后这个岗位按 A/B 组出人，A 组是原来那个人",
  JSON.stringify({ mode: r02.mode, A: r02.groups.A }));

/* 反向：A/B 的岗位也能改回固定，取全并集 */
document.querySelectorAll(".ep-rowline").filter(l => l.textContent.indexOf("节能小队长") >= 0)[0].children[0]._h.click();
check(document.querySelectorAll(".ep-modebtn").filter(b => b.classList.contains("on"))[0].textContent === "A/B 轮流",
  "再打开时按下去的是 A/B 轮流（方式已经存进岗位配置）");
document.querySelectorAll(".ep-modebtn").filter(b => b.textContent === "固定")[0]._h.click();
check(document.querySelector(".ep-seats").hidden === true, "切回固定后槽位区收起");
document.querySelector(".ep-primary")._h.click();
const r02b = global.Store.config().roles.roles.filter(r => r.id === "r02")[0];
check(r02b.mode === "fixed" && r02b.people.join("、") === "吕雨桐",
  "切回固定：把 A/B 组的人合成一份",
  JSON.stringify({ mode: r02b.mode, people: r02b.people }));

/* 按星期的岗位：五个槽位，点哪格就看哪格 */
document.querySelectorAll(".ep-rowline").filter(l => l.textContent.indexOf("黑板清洁师") >= 0)[0].children[0]._h.click();
check(document.querySelectorAll(".ep-modebtn").filter(b => b.classList.contains("on"))[0].textContent === "按星期",
  "按星期的岗位打开就是「按星期」按下去");
check(document.querySelectorAll(".ep-seat").length === 5, "五个槽位：周一到周五",
  document.querySelectorAll(".ep-seat").map(b => b.textContent).join("、"));
const tueSeat = document.querySelectorAll(".ep-seat").filter(b => b.textContent.indexOf("周二") === 0)[0];
tueSeat._h.click();
check(document.querySelectorAll(".ep-pickchip").length === 1
      && document.querySelector(".ep-picked-t").textContent.indexOf("周二") === 0,
  "点周二槽位，已选区只显示周二那个人",
  document.querySelector(".ep-picked-t").textContent + " / "
  + document.querySelectorAll(".ep-pickchip").map(c => c.textContent).join("、"));
document.querySelector(".ep-dialog-close")._h.click();

/* 常用组：点一下就整组带进当前槽 */
document.querySelectorAll(".ep-rowline").filter(l => l.textContent.indexOf("擦窗户") >= 0)[0].children[0]._h.click();
const groupChips = document.querySelectorAll(".ep-group-chip");
const roleGroupChip = groupChips.filter(c => c.textContent.indexOf("值日组") === 0)[0];
check(!!roleGroupChip && groupChips.length >= 1,
  "面板里有「常用组」，排班组按当天值日实时出人",
  groupChips.map(c => c.textContent).join("、"));
const groupsBefore = global.Store.peopleGroups().length;
roleGroupChip._h.click();
const dutyGroupN = global.Store.config().roles.roles.filter(r => r.id === "r14")[0].people.length;
check(document.querySelectorAll(".ep-pickchip").length === dutyGroupN
      && global.Store.peopleGroups().length === groupsBefore,
  "点「值日组」把整组 " + dutyGroupN + " 人带进当前槽，且不会自己存成一个新组",
  document.querySelectorAll(".ep-pickchip").length + " 人，配置里 " + groupsBefore + " 组");

/* 存为组：点开才出现名字框，不占屏幕 */
document.querySelectorAll(".ep-group-chip").filter(c => c.textContent.indexOf("存为组") >= 0)[0]._h.click();
const gNameInput = document.querySelector(".ep-group-name");
check(!!gNameInput, "点「＋ 存为组」才出现名字输入框");
gNameInput.value = "放学留下";
document.querySelectorAll(".ep-mini").filter(b => b.textContent === "存")[0]._h.click();
const savedGroup = global.Store.peopleGroups();
check(savedGroup.length === 1 && savedGroup[0].name === "放学留下"
      && savedGroup[0].memberIds.length === dutyGroupN,
  "存下来的组进本机配置，成员不重复",
  savedGroup.length + " 组，" + (savedGroup[0] || {}).memberIds.length + " 人");
const manualChip = document.querySelectorAll(".ep-group-chip")
  .filter(c => c.textContent.indexOf("放学留下") === 0)[0];
check(!!manualChip, "存好的组立刻出现在常用组里");
document.querySelectorAll(".ep-group-del")[0]._h.click();
check(global.Store.peopleGroups().length === 0,
  "删组只删这一条，不动名单", global.Store.peopleGroups().length + " 组");

/* 组里有人不在名单：数量写在 chip 上（一体机没有悬停） */
const stud0 = window.RHYTHM_DATA.students[0];
global.Store.patchConfig({ peopleGroups: [{ id: "g-test", name: "擦黑板组",
  memberIds: [stud0.id, "ghost-id-404"], order: 0 }] });
document.querySelectorAll(".ep-dialog.picker").forEach(n => n.remove());
document.querySelectorAll(".ep-rowline").filter(l => l.textContent.indexOf("擦窗户") >= 0)[0].children[0]._h.click();
const warnChip = document.querySelectorAll(".ep-group-chip")
  .filter(c => c.textContent.indexOf("擦黑板组") === 0)[0];
check(!!warnChip && warnChip.classList.contains("ep-group-warn"),
  "成员 id 失配的组仍在常用组里显示，并带警示标记");
check(!!warnChip && warnChip.textContent.indexOf("缺1") >= 0,
  "失配组的 chip 上直接写「缺 1」，不靠悬停提示", warnChip ? warnChip.textContent : "");
document.querySelectorAll(".ep-dialog.picker").forEach(n => n.remove());
global.Store.patchConfig({ peopleGroups: null });

/* 名单整份换掉（新学年、新接一个班）时，排班组也不能消失 */
global.Store.patchConfig({ students: [{ name: "新同学甲" }, { name: "新同学乙" }] });
const swapLine = document.querySelectorAll(".ep-rowline")
  .filter(l => l.textContent.indexOf("擦窗户") >= 0)[0];
swapLine.children[0]._h.click();
const roleChipAfterSwap = document.querySelectorAll(".ep-group-chip")
  .filter(c => c.textContent.indexOf("值日组") === 0)[0];
check(!!roleChipAfterSwap,
  "名单整份换掉后，排班组仍在常用组里，不会无声消失");
check(!!roleChipAfterSwap && roleChipAfterSwap.classList.contains("ep-group-warn"),
  "组员全对不上时给警示标记，而不是假装这组是空的",
  roleChipAfterSwap ? roleChipAfterSwap.className : "没找到 chip");
document.querySelectorAll(".ep-dialog.picker").forEach(n => n.remove());
global.Store.patchConfig({ students: window.RHYTHM_DATA.students });

/* 2026-11-19 真机反馈②：名单没录入时绝不拿样例名单冒充本班学生 */
global.Store.patchConfig({ students: null });
document.querySelectorAll(".ep-dialog.picker").forEach(n => n.remove());
const bareLine = document.querySelectorAll(".ep-rowline")
  .filter(l => l.textContent.indexOf("节能小队长") >= 0)[0];
bareLine.children[0]._h.click();
const bareNames = Array.from(document.querySelectorAll(".ep-person")).map(b => b.textContent);
check(bareNames.length > 0 && bareNames.every(n => window.RHYTHM_DATA.students.some(s => s.name === n))
      && bareNames.indexOf("吕雨桐") >= 0,
  "名单没录入时候选只含岗位现有的人（节能小队长是吕雨桐）",
  bareNames.join("、"));

/* 光有一句「去配置班级补录」不算解决：打字找不到人时就地能加 */
const bareQ = document.querySelectorAll(".ep-input")[0];
bareQ.value = "新转来的同学";
bareQ._h.input();
const addBtn = document.querySelectorAll(".ep-addperson")[0];
check(!!addBtn && /加进名单/.test(addBtn.textContent),
  "搜不到人时就地给「加进名单」，而不是一句指路",
  addBtn ? addBtn.textContent : "没有按钮");
addBtn._h.click();
check(global.Store.config().students.some(s => s.name === "新转来的同学"),
  "点一下就写进本班名单", JSON.stringify(global.Store.config().students));
check(Array.from(document.querySelectorAll(".ep-person")).some(b => b.textContent === "新转来的同学"),
  "加完立刻出现在候选里，不用关窗口重来");
document.querySelectorAll(".ep-dialog.picker").forEach(n => n.remove());
global.Store.patchConfig({ students: window.RHYTHM_DATA.students });

/* 屏面人名解析：岗位成员里存了学生 id 时，上屏前用名册解析成人名 */
const rolesBackup = JSON.parse(JSON.stringify(global.Runtime.config().roles));
const rolesMutated = JSON.parse(JSON.stringify(global.Runtime.config().roles));
const r07 = rolesMutated.roles.find(r => r.id === unsetRole.id);
r07.people = ["s01"];
global.Store.patchConfig({
  roles: rolesMutated,
  dutyPresents: { break: [unsetRole.id], reading: [], noon: [] }
});
global.__rhythmDate = "2026-11-09";
global.__rhythmTime = 10 * 60 + 24;
global.Screen.render();
const idTxt = document.getElementById("duty").textContent;
check(idTxt.indexOf("赵子墨") >= 0 && idTxt.indexOf("s01") < 0,
  "岗位成员存学生 id 时屏面显示人名而非字母串", idTxt);
const idDetail = document.querySelectorAll("#duty .duty")[0];
check(idDetail && idDetail.dataset.people === "赵子墨",
  "点开详情的人名列表同样解析成人名", idDetail ? idDetail.dataset.people : "缺失");
global.Store.patchConfig({ roles: rolesBackup, dutyPresents: null });
global.Screen.render();

/* 常驻区标注：没选人的岗位在「哪些岗位整段常驻」里当场标出来 */
const rolesEmpty = JSON.parse(JSON.stringify(global.Runtime.config().roles));
rolesEmpty.roles.find(r => r.id === unsetRole.id).people = [];
global.Store.patchConfig({ roles: rolesEmpty });
document.querySelectorAll(".ep-tab").filter(b => b.textContent === "值日")[0]._h.click();
const warnOpt = document.querySelectorAll(".ep-opt-warn")[0];
check(!!warnOpt && warnOpt.textContent.indexOf("还没选人") >= 0,
  "常驻区当场标出没选人的岗位（还没选人）", warnOpt ? warnOpt.textContent : "缺失");
global.Store.patchConfig({ roles: rolesBackup });
document.querySelectorAll(".ep-tab").filter(b => b.textContent === "值日")[0]._h.click();

/* 单选岗位：点人就是换人（不是追加） */
document.querySelectorAll(".ep-dialog.picker").forEach(n => n.remove());
const energyRow2 = document.querySelectorAll(".ep-rowline")
  .filter(l => l.textContent.indexOf("节能小队长") >= 0)[0];
energyRow2.children[0]._h.click();
const beforeSingle = document.querySelectorAll(".ep-pickchip").map(c => c.textContent).join("、");
const another = document.querySelectorAll(".ep-person").filter(b => !b.classList.contains("on"))[0];
const anotherName = another.textContent;
another._h.click();
const afterSingle = document.querySelectorAll(".ep-pickchip").map(c => c.textContent).join("、");
check(afterSingle.indexOf(anotherName) === 0 && document.querySelectorAll(".ep-pickchip").length === 1,
  "单人岗位上点谁就是换谁，不会越点越多",
  beforeSingle + " → " + afterSingle);
document.querySelector(".ep-primary")._h.click();
check(document.querySelectorAll(".ep-dialog.picker").length === 0, "保存后自动关窗");

/* 回归：卡片要有明确关闭入口，同一时刻只能有一张，遮罩与 Esc 都能关 */
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
check(document.querySelectorAll(".ep-dialog.picker").length === 0, "点遮罩能关掉卡片");

otherRow.children[0]._h.click();
(docHandlers.keydown || []).forEach(fn => fn({ key: "Escape" }));
check(document.querySelectorAll(".ep-dialog.picker").length === 0, "按 Esc 能关掉卡片");

/* 点人名格子进来：直接落到他所在的那个槽位 */
const focusRoleLine = document.querySelectorAll(".ep-rowline")
  .filter(l => l.textContent.indexOf("黑板清洁师") >= 0)[0];
const focusChip = focusRoleLine.children[0].querySelectorAll(".ep-namechip")[0];
const focusName0 = focusChip.textContent;
focusChip._h.click();
check(document.querySelectorAll(".ep-dialog.picker").length === 1,
  "点值日行上的人名就能打开面板");
check(document.querySelectorAll(".ep-pickchip").map(c => c.textContent).join("、").indexOf(focusName0) >= 0,
  "打开后已经定位到这个人（已选区里就有他）", focusName0);
document.querySelector(".ep-dialog-close")._h.click();

/* 取消不写配置；关掉卡片后岗位列表和滚动位置都还在 */
document.querySelector(".ep-rows").scrollTop = 77;
document.querySelector(".ep-body").scrollTop = 21;
const ovBeforeClose = JSON.stringify(global.Store.getDayOverride("2026-11-09") || {});
shutRow.children[0]._h.click();
document.querySelectorAll(".ep-person")[0]._h.click();
check(JSON.stringify(global.Store.getDayOverride("2026-11-09") || {}) === ovBeforeClose,
  "只勾选还没保存，配置不变");
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

/* ---------- 动效默认关（2026-11-19 真机反馈③） ---------- */
/* 旧机器没按过开关（无 reduceChosen）：升级后一律进"无动效" */
global.Store.setPref("cdMode", "all");   /* 顺手存点别的东西，模拟旧偏好 */
check(global.Store.prefs().reduce === true
      && global.Store.prefs().reduceChosen === false,
  "没主动选过时动效默认关（旧偏好迁移）",
  JSON.stringify(global.Store.prefs()));
/* 点了「增加动效」才算老师的选择 */
global.Store.setPref("reduce", false);
check(global.Store.prefs().reduce === false
      && global.Store.prefs().reduceChosen === true,
  "点「增加动效」后动效开，并记住是老师自己选的");
global.Store.setPref("reduce", true);
check(global.Store.prefs().reduce === true
      && global.Store.prefs().reduceChosen === true,
  "再点「关闭动效」又回到无动效");
/* 别的偏好不丢 */
global.Store.setPref("prepLead", 12);
check(global.Store.prefs().prepLead === 12 && global.Store.prefs().cdMode === "all",
  "动效迁移不丢 theme/倒计时这些别的偏好",
  JSON.stringify(global.Store.prefs()));
global.Store.setPref("prepLead", undefined);

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
  check(box.querySelectorAll(".setup-step").length === 5, "向导是五步",
    String(box.querySelectorAll(".setup-step").length));
  check(inputsIn(box).length >= 4, "第一步能填学校/班级/班主任/开学日",
    String(inputsIn(box).length));

  const next = () => box.querySelectorAll(".setup-btn")
    .filter(b => b.textContent === "下一步")[0];

  next()._h.click();

  /* 第二步是名单。它单独占一步，不再藏在「从岗位表导入」的第①块里——
     那条路要走六层，入口还叫「从岗位表导入」，老师根本想不到名单在那儿。 */
  const stepTexts = box.querySelectorAll(".setup-step").map(s => s.textContent);
  check(/名单/.test(stepTexts[1] || ""), "第二步是名单", stepTexts.join(" / "));

  /* 名单页是「列表 + 勾选」，不是一个装整份名单的大文本框：
     文本框只能整份重写，老师想加三个转来的学生也得把 45 个名字抄一遍。 */
  const roster0 = box.querySelectorAll(".setup-roster-item").length;
  check(roster0 > 0, "名单页把每个学生列成一条（可点选）", String(roster0));
  check(box.querySelectorAll(".setup-roster-pick").length === 1, "名单步能选表格文件");
  check(!!box.querySelector(".setup-roster-new"), "名单步有「打一个姓名」的输入框");
  check(!box.querySelector(".setup-roster-save"),
    "没改动时不摆「保存名单」——省掉一个点了也没事的按钮");

  /* 从 Excel 整列复制会带上表头和序号。它们不是学生：
     真放进去，换人时候选里会多出一个叫「姓名」的假人。 */
  const addInput = box.querySelector(".setup-roster-new");
  addInput.value = "序号\t姓名\t性别\n1\t测试甲\t男\n2\t测试乙\t男\n3\t测试丙\t男";
  box.querySelector(".setup-roster-addbtn")._h.click();
  check(/加入 3 人/.test(box.querySelector(".setup-msg").textContent),
    "从表格整列粘进来只认姓名，表头与序号不进名单",
    box.querySelector(".setup-msg").textContent);
  check(box.querySelectorAll(".setup-roster-item").length === roster0 + 3,
    "加完当场出现在列表里（不用再找一次）",
    String(box.querySelectorAll(".setup-roster-item").length));

  /* 保存只弹一次框。框里写的是后果：加了谁、人数怎么变。 */
  const saveBtn = box.querySelector(".setup-roster-save");
  check(!!saveBtn && /保存名单/.test(saveBtn.textContent),
    "有改动才出现「保存名单（N 人）」", saveBtn ? saveBtn.textContent : "(没有)");
  saveBtn._h.click();
  const dlg = box.querySelector(".setup-modal");
  check(!!dlg, "点保存先弹一次确认框，不直接写库");
  check(/加上 3 人/.test(dlg.textContent), "框里写明加了谁", dlg.textContent);
  check(/\d+ 人 → \d+ 人/.test(dlg.textContent), "框里写明人数怎么变", dlg.textContent);
  check(!/确定保存/.test(box.querySelector(".setup-msg").textContent),
    "框还没点，什么都不该写进去");
  dlg.querySelectorAll(".setup-btn").filter(b => b.textContent === "确定保存")[0]._h.click();
  check(!box.querySelector(".setup-modal"), "点确定后框自己关掉");
  check(/已保存/.test(box.querySelector(".setup-msg").textContent),
    "确认之后才写库", box.querySelector(".setup-msg").textContent);
  check(global.Store.config().students.length === roster0 + 3,
    "名单真的落库了", String(global.Store.config().students.length));

  /* 全选 → 取消全选：48 个人逐个点不现实，全选是"换一整班"的第一步 */
  const allBtn = box.querySelector(".setup-roster-all");
  allBtn._h.click();
  check(box.querySelectorAll(".setup-roster-item.on").length === roster0 + 3,
    "全选选中所有人",
    String(box.querySelectorAll(".setup-roster-item.on").length));
  check(allBtn.textContent === "取消全选", "全选后按钮变成「取消全选」", allBtn.textContent);
  allBtn._h.click();
  check(box.querySelectorAll(".setup-roster-item.on").length === 0, "再点一次取消全选");

  /* 选中一个人 → 删除选中。删的是"待保存的名单"，没点保存不算数。
     挑一个确实挂在岗位/分组里的人，才能验到「要不要一起清掉」那一步。 */
  const roleJson = JSON.stringify(global.Runtime.config().roles || {});
  const rosterItems = box.querySelectorAll(".setup-roster-item");
  const targetItem = rosterItems.filter(
    it => roleJson.indexOf(it.textContent.replace("已停用", "")) >= 0)[0] || rosterItems[0];
  targetItem._h.click();
  check(/已选 1 人/.test(box.querySelector(".setup-roster-picked").textContent),
    "点一下就选中，不用先点「编辑」",
    box.querySelector(".setup-roster-picked").textContent);
  const delBtn = box.querySelector(".setup-roster-del");
  check(/删除选中 1 人/.test(delBtn.textContent), "删除按钮跟着选中数走", delBtn.textContent);
  delBtn._h.click();
  check(box.querySelectorAll(".setup-roster-item").length === roster0 + 2,
    "删掉后列表立刻少一条",
    String(box.querySelectorAll(".setup-roster-item").length));
  check(/移除 1 人/.test(box.querySelector(".setup-msg").textContent),
    "删了还没保存，要说清楚（只差一步）",
    box.querySelector(".setup-msg").textContent);

  /* 删掉的那个人可能正挂在分组/岗位上。要不要顺手清掉，是老师的事——
     框里给一个勾选项，默认不勾（删名单可撤销，清分组不可逆）。 */
  box.querySelector(".setup-roster-save")._h.click();
  const delDlg = box.querySelector(".setup-modal");
  check(!!delDlg && /删掉 1 人/.test(delDlg.textContent), "删人时框里写明删了谁",
    delDlg ? delDlg.textContent : "(没有框)");
  check(!!delDlg.querySelector(".setup-modal-check"),
    "删的人若在岗位/分组里，框里问一句「要不要一起清掉」");
  delDlg.querySelectorAll(".setup-btn").filter(b => b.textContent === "确定保存")[0]._h.click();
  check(global.Store.config().students.length === roster0 + 2, "删完确认后落库",
    String(global.Store.config().students.length));

  /* 改错了要能回去。这不是「二次确认」，是任何可编辑列表都该有的出口：
     没有它，删错一个人只能把名字重新打一遍。 */
  const afterSave = box.querySelectorAll(".setup-roster-item").length;
  box.querySelector(".setup-roster-new").value = "临时甲";
  box.querySelector(".setup-roster-addbtn")._h.click();
  check(box.querySelectorAll(".setup-roster-item").length === afterSave + 1,
    "加人后列表多一条");
  check(!!box.querySelector(".setup-roster-undo"), "有改动时才出现「放弃改动」");
  box.querySelector(".setup-roster-undo")._h.click();
  check(box.querySelectorAll(".setup-roster-item").length === afterSave,
    "放弃改动回到原样", String(box.querySelectorAll(".setup-roster-item").length));
  check(!box.querySelector(".setup-roster-save"), "放弃之后不残留「保存名单」");

  next()._h.click();

  const tpls = box.querySelectorAll(".setup-tpl");
  check(tpls.length === 3, "第三步给三套作息模板", String(tpls.length));
  const rows = box.querySelectorAll(".setup-row");
  check(rows.length > 20, "第三步列出每一段起止", rows.length + " 行");
  check(box.querySelectorAll(".setup-time-file").length === 1
        && box.querySelector(".setup-time-file").accept === ".xlsx,.docx",
    "第三步能直接选作息表文件");
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
  check(cells.length === 35, "第四步是 5×7 课表", cells.length + " 格");
  check(box.querySelectorAll(".setup-grid-file").length === 1
        && box.querySelector(".setup-grid-file").accept === ".xlsx,.docx",
    "第四步能直接选班级课表文件");
  const gridTa = box.querySelector(".setup-import-text");
  gridTa.value = "周一\t周二\t周三\t周四\t周五\n第 1 节\t英语\t语文\t语文\t语文\t数学";
  gridTa._h.input();
  box.querySelector(".setup-grid-run")._h.click();
  check(/识别到 5 格/.test(box.querySelector(".setup-msg").textContent),
    "识别课表给出格数", box.querySelector(".setup-msg").textContent);

  next()._h.click();
  const doneBtns = box.querySelectorAll(".setup-btn").map(b => b.textContent);
  check(doneBtns.indexOf("导出成文件") >= 0, "完成页能把设置导出成文件",
    doneBtns.join(" / "));
  check(doneBtns.indexOf("从文件导入") >= 0, "完成页能从另一台机器导入设置",
    doneBtns.join(" / "));
  /* 主路径是「本机备份与恢复」，导出/导入只是换电脑时的次要手段：
     面板必须自己出现，不能藏在 JSON 文本框后面。 */
  check(box.querySelector(".setup-backup") !== null, "完成页有本机备份与恢复面板",
    String(!!box.querySelector(".setup-backup")));

  /* B4a：最后一步列出岗位卡片和可折叠的文案分组，一共五步 */
  const roleCards = box.querySelectorAll(".setup-role");
  const bakedRoles = (window.RHYTHM_DATA.roles || {}).roles || [];
  check(roleCards.length === bakedRoles.length, "最后一步按岗位逐个列卡片",
    roleCards.length + " / " + bakedRoles.length);
  check(box.querySelectorAll(".setup-src").length === 1, "最后一步标明岗位来源班");
  check(box.querySelectorAll(".setup-text-sec").length >= 4, "最后一步有可折叠的文案分组",
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

  /* B4b：从岗位表导入。粘贴 → 识别 → 核对四态 → 并入草稿。
     名单已经独立成一步，这里不再摆一份「①学生名单」——同一份名单
     只能有一个入口，否则在导入面板里改的和名单页显示的迟早不一致。 */
  const studentsBefore = JSON.stringify(window.RHYTHM_DATA.students);
  check(box.querySelectorAll(".setup-import-open").length === 1,
    "最后一步有「从岗位表导入」入口");
  box.querySelector(".setup-import-open")._h.click();
  check(box.querySelectorAll(".setup-import-block").length === 1,
    "导入面板只有「岗位表」一块，不再重复摆一份名单",
    String(box.querySelectorAll(".setup-import-block").length));
  check(box.querySelectorAll(".setup-import-text").length === 1,
    "打开后有粘贴框");

  /* 名单为空时不能只写一句「先去补名单」——指路要能走：
     给一个按钮，一点就跳到「名单」那一步。 */
  const studentsBackup = window.RHYTHM_DATA.students;
  window.RHYTHM_DATA.students = [];
  global.Store.patchConfig({ students: null });
  box.querySelector(".setup-import-open")._h.click();
  box.querySelector(".setup-import-open")._h.click();
  check(box.querySelectorAll(".setup-import-gate").length === 1
        && box.querySelector(".setup-import-goroster")
        && box.querySelector(".setup-import-goroster").textContent === "去录入名单",
    "名单为空时给出「去录入名单」按钮");
  window.RHYTHM_DATA.students = studentsBackup;
  global.Store.patchConfig({ students: null });
  box.querySelector(".setup-import-open")._h.click();
  box.querySelector(".setup-import-open")._h.click();

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
  next()._h.click();          /* 班级 → 名单 */
  next()._h.click();          /* 名单 → 作息 */

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
  ["app/data.js", "app/engine/schedule.js", "app/clock.js", "app/config.js", "app/pinyin.js", "app/store.js", "app/runtime.js"]
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
  /* 空包没有名单。这一页必须仍然给得出录入框：
     以前名册为空时整块 return，老师被指到这儿却发现无处可填。 */
  check(!!box.querySelector(".setup-roster-new"),
    "空包进到名单页仍然有加人的地方，不会把人堵住");
  next()._h.click();
  check(box.querySelectorAll(".setup-row").length > 20,
    "空包第三步已经套上一套模板，不是空表",
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

  /* ---------- 配置自动备份：老师不点按钮，配置也该有第二份 ---------- */
  check(!!global.Backup && global.Backup.mode() === "local",
    "双击文件打开（没有服务）时退回浏览器副本，不报错",
    global.Backup && global.Backup.mode());

  global.Backup.tick();
  const autoRaw = localStorage.getItem("rhythm.autobak.v1");
  const autoObj = autoRaw ? JSON.parse(autoRaw) : {};
  const autoData = autoObj.data || {};
  check(autoData.format === "rhythm-config/v1"
        && ((autoData.config || {}).meta || {}).klass === window.RHYTHM_DATA.meta.klass,
    "file:// 下自动把整份配置写进浏览器副本",
    ((autoData.config || {}).meta || {}).klass);

  /* 模拟「清了缓存/换了目录」：配置归零，再从自动备份导回来 */
  const backupKlass = ((autoData.config || {}).meta || {}).klass;
  global.Store.resetConfig();
  localStorage.setItem("rhythm.config.v1", JSON.stringify({ meta: { klass: "被清掉的班" } }));
  let localRes = null;
  global.Backup.restoreLocal(r => { localRes = r; });
  check(!!localRes && localRes.ok && global.Store.config().meta.klass === backupKlass,
    "「恢复浏览器副本」能把班名导回来", localRes && localRes.ok);

  let diskRes = null;
  global.Backup.restore("2026-11-10", r => { diskRes = r; });
  check(diskRes && diskRes.ok === false && /8765/.test(diskRes.why || ""),
    "file:// 下点磁盘备份会明确说读不到，而不是静默失败", diskRes && diskRes.why);

  /* file:// 长期没导出：面板里醒目提醒 + 一键导出，但不弹窗 */
  delete localStorage._d["rhythm.export.v1"];
  global.Edit.open();
  document.querySelectorAll(".ep-tab").filter(b => b.textContent === "文字")[0]._h.click();
  const warnBox = document.querySelector(".ep-warn");
  const warnBtn = warnBox && warnBox.querySelector("button");
  check(!!warnBox && warnBtn && warnBtn.textContent.indexOf("导出") >= 0,
    "file:// 从没导出过时，面板里给提醒和导出按钮", warnBtn && warnBtn.textContent);
  check(global.Backup.staleExport() === true, "从没导出过算「很久没导」");
  global.Backup.noteExport();
  check(global.Backup.staleExport() === false, "刚导出过就不再提醒");
  localStorage._d["rhythm.export.v1"] = String(Date.now() - 31 * 86400000);
  check(global.Backup.staleExport() === true, "超过 30 天没导出重新提醒");
  global.Edit.close();

  /* 8765 打开：每分钟把整份配置 POST 给本机服务 */
  global.location = { search: "", protocol: "http:", hostname: "127.0.0.1", port: "8765" };
  let postedUrl = "", postedBody = "";
  global.fetch = (url, opt) => {
    postedUrl = url;
    postedBody = (opt && opt.body) || "";
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, day: "2026-11-10" }) });
  };
  loadBrowserScript("app/backup.js");
  check(global.Backup.mode() === "http",
    "从 127.0.0.1:8765 打开时走服务端落盘", global.Backup.mode());
  global.Backup.tick();
  const postObj = postedBody ? JSON.parse(postedBody) : {};
  check(postedUrl === "/api/config/snapshot" && postObj.format === "rhythm-config/v1"
        && postObj.savedAt === undefined,
    "POST 的是整份配置，并去掉每次都变的 savedAt",
    postedUrl + " / " + postedBody.length + " 字节");

  /* 8765 有服务端每天落盘：不该再催老师导出 */
  localStorage._d["rhythm.export.v1"] = String(Date.now() - 31 * 86400000);
  check(global.Backup.staleExport() === false, "8765 下不判「很久没导出」");
  global.Edit.open();
  document.querySelectorAll(".ep-tab").filter(b => b.textContent === "文字")[0]._h.click();
  check(!document.querySelector(".ep-warn"), "8765 模式下编辑面板不出现导出提醒");
  global.Edit.close();

  /* 服务没起、断网：只吞掉，不抛错、不动提示条 */
  const tipHiddenBefore = tipEl.hidden, tipTextBefore = tipText.textContent;
  global.Store.patchConfig({ meta: { klass: "断网班" } });
  global.fetch = () => Promise.reject(new Error("断网"));
  let postThrew = false;
  try { global.Backup.tick(); } catch (e) { postThrew = true; }
  await new Promise(r => setImmediate(r));
  check(!postThrew && tipEl.hidden === tipHiddenBefore && tipText.textContent === tipTextBefore,
    "备份失败静默：不抛异常、不改屏上提示");

  /* 别人电脑的地址打开：不把本班名册往别人那儿写 */
  global.location = { search: "", protocol: "http:", hostname: "192.168.1.5", port: "8765" };
  let lanFetched = false;
  global.fetch = () => { lanFetched = true; return Promise.reject(new Error("no hub")); };
  loadBrowserScript("app/backup.js");
  global.Store.patchConfig({ meta: { klass: "别人的电脑" } });
  global.Backup.tick();
  check(global.Backup.mode() === "local" && !lanFetched,
    "非本机地址打开时退回浏览器副本，不发写盘请求", global.Backup.mode());

  /* 作息校验（真机反馈 2026-11-19 ②）：相邻时段首尾相接不能误报；
     比较按分钟数——"9:50" 和 "09:50" 是同一个时间；报错要带上两段的时间 */
  const hp = global.Edit && global.Edit._hoursProblem;
  check(!!hp, "edit.js 暴露 _hoursProblem 测试钩子");
  if (hp) {
    const okPair = [
      { start: "11:40", end: "11:50", name: "课间" },
      { start: "11:50", end: "12:20", name: "午餐" }
    ];
    check(hp(okPair) === "", "相邻时段（11:40-11:50 / 11:50-12:20）不再误报", hp(okPair));
    const zeroPad = [
      { start: "08:00", end: "9:50", name: "课间" },
      { start: "09:50", end: "10:20", name: "午餐" }
    ];
    check(hp(zeroPad) === "", "上段结束不补零（9:50）和下段开始补零（09:50）也算接上了", hp(zeroPad));
    const gap = [
      { start: "08:00", end: "09:00", name: "课间" },
      { start: "09:10", end: "10:00", name: "午餐" }
    ];
    const gapMsg = hp(gap);
    check(gapMsg !== "" && gapMsg.includes("09:00") && gapMsg.includes("09:10"),
      "真有空档时报错并带上两段时间", gapMsg);
    const overlap = [
      { start: "08:00", end: "09:30", name: "课间" },
      { start: "09:00", end: "10:00", name: "午餐" }
    ];
    check(hp(overlap).includes("没接上"), "真有重叠时报错");
    check(hp([{ start: "", end: "09:00" }]).includes("还没填时间"), "缺时间单独提示");
    check(hp([{ start: "10:00", end: "09:00" }]).includes("早于结束"), "倒挂单独提示");
  }

  /* ---------- 2026-11-22 右下角改悬浮展开菜单 ---------- */

  /* 悬停 ⋯ 后：左侧浮出常用三项（带文字），上方两列网格收其余功能。
     视觉展开态只有一个 .show；点一下还能钉住（触屏没有 hover）。 */
  const cornerHtml = pageHtml.slice(pageHtml.indexOf('<div class="corner"'),
    pageHtml.indexOf('<div class="setup"'));
  const toolsHtml = cornerHtml.slice(cornerHtml.indexOf('<div class="tools"'),
    cornerHtml.indexOf('<button class="gear"'));
  const menuHtml = cornerHtml.slice(cornerHtml.indexOf('<div class="menu"'),
    cornerHtml.indexOf('<div class="tools"'));

  const miButtons = cornerHtml.match(/<button class="mi[^"]*"[\s\S]*?<\/button>/g) || [];
  check(miButtons.length === 12, "⋯ 展开后一共 12 个功能", miButtons.length + " 个");
  check(miButtons.every(b => /<svg /.test(b) && /<span class="mi-t">[^<]+</.test(b)),
    "每个按钮都是「图标 + 文字」，老师不用猜含义");

  /* 深浅色按钮图标（0.5.1 真机反馈：菜单里只剩「深色」两个字，前面空空的）。
     病根是 applyTheme 里 `btnTheme.textContent = ...` 把 svg 一起抹了——
     静态 HTML 看着有图标，跑起来就没了。所以两头都查：HTML 备了月亮/太阳，
     JS 只写 .mi-t 文字，且全文件只留一处带 else 兜底的 textContent。 */
  const themeChunk = (menuHtml.match(/<button class="mi"[^>]*id="btn-theme"[\s\S]*?<\/button>/) || [""])[0];
  check(/class="i-moon"/.test(themeChunk) && /class="i-sun"/.test(themeChunk),
    "深浅色按钮备了月亮和太阳两个图标");
  check(/<span class="mi-t">深色</.test(themeChunk), "浅色主题下按钮写的是「深色」");
  check(/\.corner \.mi \.i-sun\{display:none\}/.test(pageHtml)
        && /body\[data-theme="dark"\] \.corner \.mi \.i-sun\{display:block\}/.test(pageHtml),
    "浅色主题藏太阳，深色主题换成太阳");

  const screenThemeSrc = fs.readFileSync(path.join(ROOT, "app/screen.js"), "utf8");
  check(/span\.textContent = label/.test(screenThemeSrc), "切主题只改 .mi-t 的文字");
  const themeWrites = (screenThemeSrc.match(/el\.btnTheme\.textContent\s*=/g) || []).length;
  check(themeWrites === 1 && /else el\.btnTheme\.textContent/.test(screenThemeSrc),
    "没有把整个按钮的 textContent 写掉（那会连图标一起抹）",
    themeWrites + " 处写入");

  check(/id="btn-min"/.test(toolsHtml) && /id="btn-phone"/.test(toolsHtml)
        && /id="btn-edit"/.test(toolsHtml)
        && toolsHtml.indexOf('btn-min') < toolsHtml.indexOf('btn-phone')
        && toolsHtml.indexOf('btn-phone') < toolsHtml.indexOf('btn-edit'),
    "⋯ 左侧是 最小化 / 手机 / 编辑，按顺序排");
  check(!/btn-min|btn-phone|btn-edit/.test(menuHtml),
    "常用三项不再重复出现在上方网格里");

  check(["btn-demo", "btn-update", "btn-setup", "btn-help", "btn-reduce",
    "btn-theme", "btn-full", "btn-cd", "btn-exit"]
    .every(id => menuHtml.indexOf('id="' + id + '"') >= 0),
    "⋯ 上方网格收着演练/更新/配置班级/帮助/动效/主题/全屏/倒计时/退出");
  check(/id="btn-update"[\s\S]*?id="update-dot"[\s\S]*?id="ver"/.test(menuHtml),
    "红点与版本号仍挂在「更新」一项里");
  check(/class="mi mi-wide mi-danger" id="btn-exit"/.test(menuHtml)
        && menuHtml.indexOf('btn-exit') > menuHtml.indexOf('btn-cd'),
    "退出在最后、整行、危险色");
  check((menuHtml.match(/--c:[0-9];--r:[0-9]/g) || []).length >= 9,
    "每个格子都写了行列，错峰动画才有依据");

  check(/id="btn-gear"[\s\S]*?aria-expanded="false"/.test(cornerHtml)
        && /class="g-dots"/.test(cornerHtml) && /class="g-x"/.test(cornerHtml),
    "主按钮有展开状态和 ⋯↔× 两个图标");

  /* 倒计时状态写在 data-tip / aria-label 里（按钮本身是固定标签 + 高亮） */
  const cdEl = document.getElementById("btn-cd");
  check(cdEl.dataset.tip && cdEl.dataset.tip.indexOf("倒计时 · 按推荐") === 0,
    "倒计时状态写进 data-tip", cdEl.dataset.tip);
  const cdChunk = menuHtml.slice(menuHtml.indexOf('id="btn-cd"'));
  check(cdChunk.indexOf('<span class="mi-t">倒计时</span>') === 0 ||
        cdChunk.indexOf('<span class="mi-t">倒计时</span>') > 0,
    "倒计时项显示固定标签，状态靠高亮", cdChunk.slice(0, 60));

  /* 首次引导：第一次打开弹出、走完或跳过后写 localStorage 不再来 */
  const guideModal = document.getElementById("guideModal");
  check(guideModal.hidden === false, "第一次打开弹出 4 步引导");
  check(document.getElementById("guideTitle").textContent === "这块屏自己会走",
    "引导第一步讲这块屏", document.getElementById("guideTitle").textContent);
  document.getElementById("guideSkip")._h.click();
  check(guideModal.hidden === true && localStorage.getItem("cb-guide-v1") === "1",
    "跳过引导后写 localStorage，不再出现");

  /* 帮助入口在⋯菜单里，能开能关 */
  const helpModal = document.getElementById("helpModal");
  document.getElementById("btn-help")._h.click();
  check(helpModal.hidden === false, "⋯→使用帮助能打开帮助页");
  document.getElementById("helpClose")._h.click();
  check(helpModal.hidden === true, "帮助页能关掉");

  /* 退出确认：kiosk 会压掉系统 confirm，必须用页面自己的弹层；
     没有本地服务时把出路说清楚，而不是静默失败 */
  const exitModal = document.getElementById("exitModal");
  document.getElementById("btn-exit")._h.click();
  check(exitModal.hidden === false, "点退出程序先弹确认");
  global.location = { search: "", protocol: "file:", hostname: "", port: "" };
  document.getElementById("exitGo")._h.click();
  check(document.getElementById("exitText").textContent.includes("退出大屏.bat"),
    "没有本地服务时提示用退出大屏.bat", document.getElementById("exitText").textContent);
  document.getElementById("exitCancel")._h.click();
  check(exitModal.hidden === true, "确认框能取消");

  /* ---------- 2026-11-20 反馈：倒计时弹窗选择 + 提醒事项并入提示语 ---------- */

  /* 倒计时：点图标弹选择框（解释 + 逐段勾选），不再「三档循环」让人猜 */
  const cdModal = document.getElementById("cdModal");
  const cdList = document.getElementById("cdList");
  document.getElementById("btn-cd")._h.click();
  check(cdModal.hidden === false && cdList.children.length === 8,
    "点倒计时图标弹出逐段选择框", cdList.children.length + " 段");
  const cdChecked = cdList.children.filter(l => l.children[0].checked).length;
  check(cdChecked === 4, "默认勾选推荐的 4 段", cdChecked + " 段");
  const firstBox = cdList.children[0].children[0];
  firstBox.checked = false;
  firstBox._h.change();
  check(global.Store.prefs().cdPicks && global.Store.prefs().cdPicks.break === false,
    "去勾一段立即写进偏好", JSON.stringify(global.Store.prefs().cdPicks));
  document.getElementById("cdAuto")._h.click();
  check(cdModal.hidden === true && !global.Store.prefs().cdPicks,
    "「恢复按推荐」清掉逐段选择并关闭弹窗");

  /* 提醒事项按星期显示：days 缺省 = 每天；days 只含 4 → 周四显示、其他天不显示 */
  global.Store.patchTexts({ reminders: { "default": "带齐回执", days: [4] } });
  global.__rhythmDate = "2026-11-05";
  global.__rhythmTime = 7 * 60 + 30;
  Screen.render();
  check(!!document.querySelector(".reminder-line"),
    "选中的星期四贴纸照常显示");
  global.Store.patchTexts({ reminders: { "default": "带齐回执", days: [1] } });
  Screen.render();
  check(!document.querySelector(".reminder-line"),
    "没选中的星期四不显示提醒");
  global.Store.patchTexts({ reminders: { "default": "带齐回执" } });

  /* 文字页签：提醒事项不再是独立板块，并入「各时段的提示语」并带星期多选 */
  const editSrc = fs.readFileSync(path.join(ROOT, "app/edit.js"), "utf8");
  check(!editSrc.includes("secM")
        && editSrc.includes("哪几天显示")
        && editSrc.includes("ep-daybtn"),
    "编辑面板：提醒事项并入提示语并带星期多选");
  const editCssSrc = fs.readFileSync(path.join(ROOT, "app/edit.css"), "utf8");
  check(editCssSrc.includes(".ep-daybtn.on"), "星期按钮有选中态样式");

  /* ---------- 2026-11-20 反馈③：提示语逐段 = 贴纸来源 + 按星期定制 ---------- */

  /* 晨间自主管理那格就是贴纸：days 只含周四 → 周四显示、其余天不显示 */
  global.Store.patchTexts({
    reminders: null,
    tips: { "晨间自主管理": { "default": "周五带美术用品", days: [5] } }
  });
  global.__rhythmDate = "2026-11-05";
  global.__rhythmTime = 7 * 60 + 30;
  Screen.render();
  check(!document.querySelector(".reminder-line"),
    "贴纸文字来自提示语晨间那格：没选周四就不显示");
  global.Store.patchTexts({
    tips: { "晨间自主管理": { "default": "周五带美术用品", days: [4] } }
  });
  Screen.render();
  const remRowThu = document.querySelector(".reminder-line");
  check(!!remRowThu && remRowThu.textContent.indexOf("周五带美术用品") >= 0,
    "选了周四 → 贴纸显示提示语里的那句话",
    remRowThu ? remRowThu.textContent : "缺失");

  /* 同一段不同星期写不同的话：周四用覆盖那句，默认那句管其余天 */
  global.Store.patchTexts({
    tips: { "晨间自主管理": { "default": "带齐作业", "4": "今天交回执" } }
  });
  Screen.render();
  check(document.querySelector(".reminder-line").textContent.indexOf("今天交回执") >= 0,
    "周四显示按星期覆盖的那句");
  global.Store.patchTexts({ tips: null, reminders: { "default": "带齐回执" } });

  /* 普通时段的提示语也支持「哪几天显示」（走 applyTexts 的按天解析） */
  const noonBlock = (global.Runtime.day("2026-11-05").timeline || [])
    .filter(b => b.type === "noon")[0];
  if (noonBlock) {
    global.Store.patchTexts({
      tips: { [noonBlock.name]: { "default": "午休要安静", days: [1] } }
    });
    global.__rhythmTime = global.Rhythm.t2m(noonBlock.start) + 1;
    Screen.render();
    check(document.body.textContent.indexOf("午休要安静") < 0,
      "普通时段：days 不含周四 → 提示语不上屏");
    global.Store.patchTexts({
      tips: { [noonBlock.name]: { "default": "午休要安静", days: [4] } }
    });
    Screen.render();
    check(document.body.textContent.indexOf("午休要安静") >= 0,
      "普通时段：选了周四 → 提示语上屏");
    global.Store.patchTexts({ tips: null });
    global.__rhythmTime = 7 * 60 + 30;
    Screen.render();
  }

  /* 编辑面板结构：逐段分组 + 按星期展开器存在 */
  const editSrc2 = fs.readFileSync(path.join(ROOT, "app/edit.js"), "utf8");
  check(editSrc2.includes("function tipSeg") && editSrc2.includes("ep-wdrow")
        && editSrc2.includes("其中几天要写不同的话"),
    "编辑面板：每段有星期展开器（默认收起，保证简洁）");

  /* 跨代升级：0.3.x 的用户装完 0.5.x 第一次打开就是向导第一步，
     旧数据只有「导出设置 → 导入设置」一条路，入口必须在第一步，
     而不是让人先填班名走完四步再翻到最后一页。 */
  const setupSrc = fs.readFileSync(path.join(ROOT, "app/setup.js"), "utf8");
  const pageClassSrc = setupSrc.slice(setupSrc.indexOf("function pageClass"),
    setupSrc.indexOf("function pageTime"));
  check(pageClassSrc.includes("setup-legacy") && pageClassSrc.includes("pickImport"),
    "向导第一步：有「导入旧设置 JSON」入口，且复用已有的 pickImport");
  /* 断言意图而不是实现：以前这里钉的是 "state.step = 3;"，
     等于用一条用例把「最后一页的序号是 3」焊死了——加一步就得改用例，
     而用例本该告诉我们「加一步之后行为还对不对」。 */
  check(setupSrc.includes("state.step = lastStep();"),
    "向导：导入整份设置后直接跳到最后一页，只剩点「完成」");
  check(!setupSrc.includes("function pickImport2"),
    "向导：导入只有一套实现，没有为跨代另写一份");

  console.log("\n" + pass + "/" + (pass + fail) + " 通过");
  process.exit(fail ? 1 : 0);
})();
