/* 版本显示、更新提示、换地址后的迁移提示。
   三条底线：
   1. 服务不在、更新源连不上 = 什么都不提示，也不打印错误，绝不打扰大屏。
   2. 不参与主界面重绘，版本只在启动时写一次文字。
   3. 提示都能关，关掉后同一版本不再弹（记在本机浏览器里）。 */
(function (root) {
  "use strict";

  var V = root.AppVersion || { version: "", build: "", text: function () { return ""; } };
  var KEY_DISMISS = "rhythm.update.dismissed.v1";
  var KEY_MIGRATE = "rhythm.migrate.hint.v1";
  var POLL_MS = 30 * 60 * 1000;

  var latest = "";       /* 更新源报上来的新版本号 */
  var migrateOn = false; /* 是否在提示「旧地址的设置可以导过来」 */
  var timer = null;

  function doc() { return root.document || null; }
  function el(id) {
    var d = doc();
    return d && d.getElementById ? d.getElementById(id) : null;
  }
  function store() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }
  function get(k) {
    var s = store();
    try { return s ? s.getItem(k) : null; } catch (e) { return null; }
  }
  function set(k, v) {
    var s = store();
    try { if (s) s.setItem(k, v); } catch (e) {}
  }

  /* 和服务同源时直接用当前来源（端口顺延也跟着走）；file:// 才问 Remote 找到的地址 */
  function originBase() {
    var loc = root.location || {};
    if (loc.protocol === "http:" || loc.protocol === "https:") return loc.origin || "";
    var r = root.Remote;
    return (r && r.hub) || "";
  }

  function renderTip() {
    var box = el("tip");
    var txt = el("tipText");
    if (!box || !txt) return;
    if (migrateOn) {
      txt.textContent = "如果你之前是双击文件用的，原来的修改还留在那个地址："
        + "先到旧地址导出设置，再回到这里导入，就能带过来。";
      box.hidden = false;
      return;
    }
    if (latest && get(KEY_DISMISS) !== latest) {
      txt.textContent = "有新版本 v" + latest + " 可用，请联系管理员更新。现在照常使用。";
      box.hidden = false;
      return;
    }
    box.hidden = true;
  }

  function dismiss() {
    if (migrateOn) {
      migrateOn = false;
      set(KEY_MIGRATE, "1");
    } else if (latest) {
      set(KEY_DISMISS, latest);
    }
    renderTip();
  }

  /* 查一次更新源。失败（断网、服务没起、返回不是 JSON）一律安静收场。 */
  function check() {
    var base = originBase();
    if (!base || !root.fetch) return;
    var ctl = root.AbortController ? new root.AbortController() : null;
    var t = ctl ? root.setTimeout(function () { ctl.abort(); }, 3000) : null;
    root.fetch(base + "/api/update", { cache: "no-store", signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (d) {
        if (t) root.clearTimeout(t);
        if (!d || !d.ok || !d.available || !d.latest) return;
        latest = String(d.latest);
        renderTip();
      })
      .catch(function () {
        if (t) root.clearTimeout(t);
        /* 什么都不做：断网时大屏照常跑 */
      });
  }

  /* 这个地址上还没有老师存过的东西 → 多半是刚从 file:// 换过来。
     schema 是页面启动时自动写的，不算「用过」，否则这个提示永远不会出现。 */
  function looksFresh() {
    var s = store();
    if (!s) return false;
    try {
      for (var i = 0; i < s.length; i++) {
        var k = s.key(i);
        if (k && k.indexOf("rhythm.") === 0 && k !== "rhythm.schema.v1") return false;
      }
    } catch (e) { return false; }
    return true;
  }

  function init() {
    var ver = el("ver");
    if (ver && V.text) ver.textContent = V.text();

    var loc = root.location || {};
    if ((loc.protocol === "http:" || loc.protocol === "https:")
        && !get(KEY_MIGRATE) && looksFresh()) {
      migrateOn = true;
    }

    var shut = el("tipClose");
    if (shut && shut.addEventListener) shut.addEventListener("click", dismiss);

    renderTip();
    check();
    if (root.setInterval) {
      if (timer) root.clearInterval(timer);
      timer = root.setInterval(check, POLL_MS);
    }
  }

  root.Update = {
    init: init,
    check: check,
    dismiss: dismiss,
    /* 测试用：直接摆出提示，不用真去连服务 */
    _renderTip: renderTip,
    _setMigrate: function (v) { migrateOn = !!v; },
    _setLatest: function (v) { latest = v ? String(v) : ""; }
  };

  if (doc() && doc().readyState !== "loading") init();
  else if (doc() && doc().addEventListener) doc().addEventListener("DOMContentLoaded", init);
})(typeof window !== "undefined" ? window : this);
