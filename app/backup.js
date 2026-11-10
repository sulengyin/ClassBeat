/* 配置自动备份：老师不用点任何按钮。
 *
 * 教室的实际用法是「打开大屏.bat」→ 浏览器开 127.0.0.1:8765/screen，
 * 所以主力路径是：页面每分钟比一次配置签名，变了就把整份导出 JSON
 * POST 给本机服务，服务按天落 backups/config/rhythm-日期.json，留最近 14 天。
 *
 * file:// 打开时写不进磁盘，退化成浏览器里一格副本（rhythm.autobak.v1），
 * 只保最近一次，面板里能恢复；不报错、不弹窗、不拖慢大屏。
 *
 * 一切失败都吞掉：备份坏了是小事，打断课堂是大事。
 */
(function (root) {
  "use strict";

  var KEY = "rhythm.autobak.v1";     // file:// 用的单格副本
  var TICK = 60 * 1000;              // 一分钟比一次：改完最多一分钟落盘
  var FIRST = 3 * 1000;              // 启动 3 秒后再备份，别和首屏抢时间
  var SLOW = 5 * 60 * 1000;          // file:// 没有写盘压力，五分钟一次就够
  var MAX_BYTES = 400 * 1024;        // localStorage 一格别撑爆，超了就只留服务端

  var mode = "";
  var lastSig = "";
  var lastDay = "";
  var timer = 0;

  function loopbackHttp() {
    var l = root.location || {};
    if (!/^https?:$/.test(l.protocol || "")) return false;
    var host = l.hostname || "";
    return host === "127.0.0.1" || host === "localhost"
      || host === "::1" || host === "[::1]";
  }

  /* 空壳页面也会导出一份配置，格式合法但没班名；这种快照盖掉真备份最坏事。 */
  function usable(obj) {
    var meta = (obj && obj.config && obj.config.meta) || {};
    return !!(meta.klass || meta.school);
  }

  function snapshotText() {
    var cfg = null;
    try { cfg = root.Store.exportAll(); } catch (e) { return ""; }
    if (!usable(cfg)) return "";
    /* savedAt 每次都变，去掉它才能比对「配置有没有真的动过」 */
    delete cfg.savedAt;
    try { return JSON.stringify(cfg); } catch (e) { return ""; }
  }

  function signature(text) {
    var h = 0;
    for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return text.length + ":" + h;
  }

  function post(text) {
    if (!root.fetch) return;
    try {
      root.fetch("/api/config/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
        keepalive: true,
        cache: "no-store"
      }).then(function (r) {
        return r && r.ok ? r.json() : null;
      }).then(function (d) {
        if (d && d.ok && d.day) lastDay = d.day;
      }).catch(function () { /* 服务没起或断网：下次再试 */ });
    } catch (e) { /* 老浏览器没有 fetch：放弃，导出按钮还在 */ }
  }

  function saveLocal(text) {
    try {
      if (text.length > MAX_BYTES) return false;
      root.localStorage.setItem(KEY, JSON.stringify({
        savedAt: new Date().toISOString(),
        data: JSON.parse(text)
      }));
      return true;
    } catch (e) { return false; }
  }

  function tick() {
    var text = snapshotText();
    if (!text) return;
    var sig = signature(text);
    if (sig === lastSig) return;
    lastSig = sig;
    if (mode === "http") post(text);
    else if (saveLocal(text)) lastDay = "浏览器本地";
  }

  function start() {
    mode = loopbackHttp() ? "http" : "local";
    if (mode === "http") {
      root.setTimeout(tick, FIRST);
      timer = root.setInterval(tick, TICK);
    } else {
      root.setTimeout(tick, FIRST + 7000);
      timer = root.setInterval(tick, SLOW);
    }
    try {
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") tick();
      });
    } catch (e) { /* 没有 document：测试环境，忽略 */ }
    if (mode === "http") hintIfEmpty();
  }

  /* 换来源（file:// → 8765）后 localStorage 是空的：本机有备份就提示一句，
     不给老师弹模态框，也不挡屏。 */
  function hintIfEmpty() {
    root.setTimeout(function () {
      if (snapshotText()) return;                 // 当前有配置，不用提示
      list(function (items) {
        if (!items || !items.length) return;
        var box = document.getElementById("tip");
        var txt = document.getElementById("tipText");
        if (!box || !txt) return;
        txt.textContent = "这台电脑上有 " + items[0].day + " 的班级配置备份，"
          + "点右下角「⋯」→ 编辑 → 带走这些修改 → 本机自动备份，可以恢复。";
        box.hidden = false;
      });
    }, FIRST + 2000);
  }

  /* ---- 面板用的接口 ---- */

  function list(cb) {
    if (mode !== "http" || !root.fetch) return cb([]);
    try {
      root.fetch("/api/config/backup", { cache: "no-store" })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (d) { cb((d && d.ok && d.items) || []); })
        .catch(function () { cb([]); });
    } catch (e) { cb([]); }
  }

  function local() {
    try {
      var raw = root.localStorage.getItem(KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      return obj && obj.data ? obj : null;
    } catch (e) { return null; }
  }

  function apply(obj, cb) {
    var r = null;
    try { r = root.Store.importAll(obj); } catch (e) { r = null; }
    cb(r || { ok: false, why: "这份备份打不开" });
  }

  function restore(day, cb) {
    if (mode !== "http" || !root.fetch) {
      return cb({ ok: false, why: "当前不是 8765 打开，读不到磁盘备份" });
    }
    try {
      root.fetch("/api/config/backup/" + encodeURIComponent(day), { cache: "no-store" })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) return cb({ ok: false, why: "这份备份读不出来" });
          apply(d, cb);
        })
        .catch(function () { cb({ ok: false, why: "连不上本机服务" }); });
    } catch (e) { cb({ ok: false, why: "连不上本机服务" }); }
  }

  function restoreLocal(cb) {
    var obj = local();
    if (!obj) return cb({ ok: false, why: "浏览器里没有本地副本" });
    apply(obj.data, cb);
  }

  root.Backup = {
    start: start,
    tick: tick,
    mode: function () { return mode; },
    day: function () { return lastDay; },
    list: list,
    local: local,
    restore: restore,
    restoreLocal: restoreLocal
  };

  if (root.Store) start();
})(window);
