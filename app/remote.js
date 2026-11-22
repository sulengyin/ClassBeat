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

  var BASE_PORT = 8765, PORT_SPAN = 10;
  var given = params.get("hub") || sameHost;
  var fixedHub = !!given;

  function normalize(v) {
    return /^https?:\/\//.test(v) ? v.replace(/\/$/, "") : "http://" + v;
  }

  var HUB = normalize(given || "127.0.0.1:" + BASE_PORT);

  var es = null;
  var lastSeq = 0;
  /* 服务的状态：大屏「手机」面板靠它决定画不画二维码 */
  var info = { online: false, phone: "", addrChanged: false, lastLan: "" };
  var hubReady = null;

  /* 服务端口被别的软件占了会自己往后挪（8766、8767…），大屏不知道挪到哪，
     就在本机挨个问 8765–8774。都问不到就按默认端口继续——和没有服务时一样，
     不报错、不提示、不挡屏。指定了 ?hub= 或同源打开时不扫。 */
  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error("timeout")); }, ms);
      promise.then(
        function (v) { clearTimeout(t); resolve(v); },
        function (e) { clearTimeout(t); reject(e); }
      );
    });
  }

  function pingAt(base) {
    return withTimeout(fetch(base + "/api/ping", { cache: "no-store" }), 900)
      .then(function (r) { return r.json(); });
  }

  function discover() {
    if (fixedHub) return Promise.resolve(HUB);
    var i = 0;
    function step() {
      if (i >= PORT_SPAN) return Promise.resolve(HUB);
      var base = "http://127.0.0.1:" + (BASE_PORT + i);
      i++;
      return pingAt(base).then(function (d) {
        /* app 用来区分「自己的服务」和「8766 上别的软件」。
           老版本服务没有这个字段，也认——否则升级到一半会互相找不到。 */
        var mine = d && d.ok && (d.app === undefined || d.app === "classbeat");
        if (mine) {
          HUB = base;
          if (root.Remote) root.Remote.hub = HUB;
          return HUB;
        }
        return step();
      }, step);
    }
    return step();
  }

  function hubUrl() {
    return hubReady || (hubReady = discover());
  }

  function nowHM() {
    var m = Screen.nowMinutes();
    var h = Math.floor(m / 60), mm = Math.floor(m % 60);
    return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
  }

  /* 消息到期没有：比的是「到点时间」，但存下来的是 HH:MM。
     23:55 发一条 10 分钟的消息，until 会写成 00:05 —— 跨了零点，字符串比较
     （"23:55" >= "00:05"）会当场判成过期，大屏上什么都看不到。服务端
     messages.rs 的 expired() 早就对 00:00–06:00 这一段做了同样的例外，
     这里以前漏了：结果是服务认为消息还活着、页面却把它藏起来，两边打架。
     2026-11-22 23:53 的 CI 就是因为这个红了 6 条（本地跑都在零点以后，看不见）。 */
  function noticeExpired(until, now) {
    if (!until) return false;
    if (until >= "00:00" && until < "06:00") return false;   // 跨零点，不算过期
    return now >= until;
  }

  /* 只认「给全班看」的消息。给自己记的不上屏——教室屏是学生语言区。 */
  function visible(msg) {
    if (!msg || !msg.text) return false;
    if (msg.forWhom && msg.forWhom !== "class") return false;
    if (noticeExpired(msg.until, nowHM())) return false;
    return true;
  }

  function clearNotice() {
    try {
      Store.patchDayOverride(Screen.todayKey(), { notice: null });
    } catch (e) { return; }
    if (Screen.hideMessage) Screen.hideMessage();
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

  /* 远程改配置（ROADMAP 9.4 P2 B2/B3）：手机把设置送到服务，这里取回
     应用。两种形态：
     - kind=full：整份 rhythm-config/v1，直接 importAll；
     - kind=patch：手机只送改动的字段（名册在手机上看不到），这里以
       当前配置为底稿合并后再 importAll。
     应用只走 Store.importAll 一条路——要么整份成功，要么一个字不动；
     校验不在此地重复做。应用结果回 ack 给服务，手机那头看得到。
     服务不在、没待办、校验失败，都安静收手：大屏继续用本机配置。 */
  var configBusy = false;
  function ackConfig(ok, why) {
    return fetch(HUB + "/api/config/remote/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: ok, why: why })
    }).catch(function () {});
  }

  function mergePatch(base, patch) {
    var p = patch || {}, c = p.config || {};
    if (p.texts) base.texts = p.texts;
    if (p.phrases) base.phrases = p.phrases;
    if (c.meta) base.config.meta = Object.assign({}, base.config.meta || {}, c.meta);
    if (c.timetable) base.config.timetable = c.timetable;
    if (c.schedule) base.config.schedule = c.schedule;
    return base;
  }

  function pullConfig() {
    if (configBusy) return null;
    configBusy = true;
    var done = function () { configBusy = false; };
    try {
      return fetch(HUB + "/api/config/remote", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.pending) return false;
          var target = null;
          if (d.kind === "patch" && d.patch) {
            var base = null;
            try { base = Store.exportAll(); } catch (e) { base = null; }
            if (!base || !base.config) {
              return ackConfig(false, "大屏拿不到当前配置，补丁没法合并")
                .then(function () { return false; });
            }
            target = mergePatch(base, d.patch);
          } else if (d.config) {
            target = d.config;
          }
          if (!target) return false;
          var res = null;
          try { res = Store.importAll(target); } catch (e) { res = null; }
          var ok = !!(res && res.ok);
          var why = ok ? "" : ((res && res.why) || "大屏拒绝应用这份设置");
          return ackConfig(ok, why).then(function () { return ok; });
        })
        .catch(function () { return false; })
        .then(function (v) { done(); return v; });
    } catch (e) {
      done();
      return null;
    }
  }

  /* fresh=true 才是"刚到的消息"，要弹卡片；开机恢复的那条只贴便签。
     否则早上发的一条通知，中午重启大屏会再吓全班一次。 */
  function apply(msg, fresh) {
    if (msg && msg.type === "clear") { clearNotice(); return; }
    if (msg && msg.retractedAt) { return; }
    if (!visible(msg)) return;
    var notice = {
      text: msg.text,
      level: msg.level === "urgent" ? "urgent" : "normal",
      at: msg.at || "",
      until: msg.until || "",
      createdAt: msg.createdAt || Date.now()
    };
    try {
      Store.patchDayOverride(Screen.todayKey(), { notice: notice });
    } catch (e) {
      return;               // 存储坏了也不能把大屏搞挂
    }
    if (Screen.render) Screen.render();
    if (fresh && Screen.showMessage) Screen.showMessage(notice);
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
      apply(msg, true);
    };

    /* 断线由 EventSource 自己重连；重连要从 lastSeq 续，不然会重复上屏 */
    es.onerror = function () {
      if (es && es.readyState === 2) {
        setTimeout(function () { connect(lastSeq); }, 5000);
      }
    };
  }

  /* 问服务要它自己的局域网地址。二维码要写这个，不能写 127.0.0.1——
     手机打开 127.0.0.1 打开的是手机自己。 */
  function probe() {
    return hubUrl().then(function () {
      return fetch(HUB + "/api/ping", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          info.online = !!(d && d.ok);
          info.phone = (d && d.lan) || "";
          /* 服务端记着上次启动的地址：对不上就说明这台机器的 IP 变了，
             老师存的钉钉链接会失效，面板要提示一句。 */
          info.addrChanged = !!(d && d.addrChanged);
          info.lastLan = (d && d.lastLan) || "";
          return info;
        });
    }).catch(function () {
      info.online = false;
      /* 服务可能比大屏晚开，也可能因为端口被占换了地方：
         把发现结果作废，下次再问时重新从 8765 扫一遍。 */
      if (!fixedHub) hubReady = null;
      return info;
    });
  }

  function boot() {
    hubUrl().then(function () {
      probe();
      if (root.Clock) syncClock();
      /* 一台屏可能开一整天，隔一段时间再校一次，避免慢慢走偏 */
      if (root.setInterval) root.setInterval(syncClock, 10 * 60 * 1000);

      /* 手机改了设置要及时上屏。开机先拉一次，之后隔 15 秒再问；
         没有待办就是一次极小的 GET，服务不在时安静失败。 */
      pullConfig();
      if (root.setInterval) root.setInterval(pullConfig, 15 * 1000);

      /* 老师常常先开大屏、后双击启动服务。没连上就每分钟重找一次，
         一旦连上就补一次 connect，屏不用刷新。 */
      if (root.setInterval) {
        root.setInterval(function () {
          if (info.online || fixedHub) return;
          probe().then(function (i) {
            if (i && i.online) connect(lastSeq);
          });
        }, 60 * 1000);
      }

      /* 先取最新一条：大屏重启时，如果那条还没过期，应该还在屏上 */
      return fetch(HUB + "/api/messages?n=8", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var list = (d && d.messages) || [];
          if (list.length) lastSeq = list[list.length - 1].seq || 0;
          /* 只恢复「没撤回、没过期」的那条，否则一开机把上午的旧通知弹回来 */
          for (var i = list.length - 1; i >= 0; i--) {
            if (!list[i].retractedAt && visible(list[i])) { apply(list[i], false); break; }
          }
          connect(lastSeq);
        })
        .catch(function () {
          /* 服务不在：什么也不做。大屏继续用本地数据，和没有这个模块一样 */
          connect(-1);
        });
    });
  }

  root.Remote = {
    hub: HUB, info: info, probe: probe,
    connect: connect, retract: retract, syncClock: syncClock,
    pullConfig: pullConfig,
    /* 给 test_dom 用的纯函数：跨零点那条边界最容易写错 */
    _noticeExpired: noticeExpired
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
