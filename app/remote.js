/* 大屏接入教室消息服务（PLAN 2.22 / P4）。
   三条原则：
   1. 服务不在 = 和没有它完全一样。不报错、不提示、不挡屏。
   2. 消息写回本地覆盖层，渲染仍走 screen.js 原路径，不改任何判断。
   3. 开机只恢复「仍在有效期内」的那条，不重放上午的通知。

   入口：?hub=192.168.1.5:8765   默认 http://127.0.0.1:8765
*/
(function (root) {
  "use strict";

  var Screen = root.Screen;
  var Store = root.Store;
  if (!Screen || !Store) return;

  var params = new URLSearchParams((root.location && root.location.search) || "");
  /* 从服务打开的（/screen 或 http://IP:8765/screen）就同源连，不用再传 IP；
     只有双击 html（file://）时才回落到本机 8765。 */
  var sameHost = (root.location && /^https?:$/.test(root.location.protocol))
    ? root.location.host : "";
  var raw = params.get("hub") || sameHost || "127.0.0.1:8765";
  var HUB = /^https?:\/\//.test(raw) ? raw.replace(/\/$/, "") : "http://" + raw;

  var es = null;
  var lastSeq = 0;

  function nowHM() {
    var m = Screen.nowMinutes();
    var h = Math.floor(m / 60), mm = Math.floor(m % 60);
    return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
  }

  /* 只认「给全班看」的消息。给自己记的不上屏——教室屏是学生语言区。 */
  function visible(msg) {
    if (!msg || !msg.text) return false;
    if (msg.forWhom && msg.forWhom !== "class") return false;
    if (msg.until && nowHM() >= msg.until) return false;
    return true;
  }

  function clearNotice() {
    try {
      Store.patchDayOverride(Screen.todayKey(), { notice: null });
    } catch (e) { return; }
    if (Screen.render) Screen.render();
  }

  function retract() {
    try {
      return fetch(HUB + "/api/retract", { method: "POST" })
        .then(function (r) { return r.json(); })
        .catch(function () { return null; });
    } catch (e) {
      return null;
    }
  }

  /* 设备时钟可能走偏（一体机常年不关机、系统时区被改过）。
     服务在同一局域网时，用它的时间校准一次；校不到就继续用系统时间，
     绝不因为校时失败挡住大屏。 */
  function syncClock() {
    try {
      return fetch(HUB + "/api/time", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var ok = !!(d && root.Clock && root.Clock.sync(d.now));
          if (ok && Screen.render) { Screen.render(); }
          return ok;
        })
        .catch(function () { return false; });
    } catch (e) {
      return null;
    }
  }

  function apply(msg) {
    if (msg && msg.type === "clear") { clearNotice(); return; }
    if (msg && msg.retractedAt) { return; }
    if (!visible(msg)) return;
    try {
      Store.patchDayOverride(Screen.todayKey(), {
        notice: {
          text: msg.text,
          level: msg.level === "urgent" ? "urgent" : "normal",
          at: msg.at || "",
          until: msg.until || "",
          createdAt: msg.createdAt || Date.now()
        }
      });
    } catch (e) {
      return;               // 存储坏了也不能把大屏搞挂
    }
    if (Screen.render) Screen.render();
  }

  function connect(baseline) {
    if (es) { try { es.close(); } catch (e) {} }
    var url = HUB + "/api/stream?since=" + (baseline == null ? -1 : baseline);

    try {
      es = new EventSource(url);
    } catch (e) {
      return;
    }

    es.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.seq && msg.seq > lastSeq) lastSeq = msg.seq;
      apply(msg);
    };

    /* 断线由 EventSource 自己重连；重连要从 lastSeq 续，不然会重复上屏 */
    es.onerror = function () {
      if (es && es.readyState === 2) {
        setTimeout(function () { connect(lastSeq); }, 5000);
      }
    };
  }

  function boot() {
    if (root.Clock) syncClock();
    /* 一台屏可能开一整天，隔一段时间再校一次，避免慢慢走偏 */
    if (root.setInterval) root.setInterval(syncClock, 10 * 60 * 1000);

    /* 先取最新一条：大屏重启时，如果那条还没过期，应该还在屏上 */
    fetch(HUB + "/api/messages?n=8", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var list = (d && d.messages) || [];
        if (list.length) lastSeq = list[list.length - 1].seq || 0;
        /* 只恢复「没撤回、没过期」的那条，否则一开机把上午的旧通知弹回来 */
        for (var i = list.length - 1; i >= 0; i--) {
          if (!list[i].retractedAt && visible(list[i])) { apply(list[i]); break; }
        }
        connect(lastSeq);
      })
      .catch(function () {
        /* 服务不在：什么也不做。大屏继续用本地数据，和没有这个模块一样 */
        connect(-1);
      });
  }

  root.Remote = { hub: HUB, connect: connect, retract: retract, syncClock: syncClock };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
