/* 版本显示、更新提示、换地址后的迁移提示，以及「版本与更新」面板。
   几条底线：
   1. 服务不在、更新源连不上 = 大屏照常跑，只在面板里给一句老师看得懂的话。
   2. 不参与主界面重绘，版本只在启动时写一次文字。
   3. 提示都能关，关掉后同一版本不再弹（记在本机浏览器里）。
   4. 更新是异步的：面板开着、设置页开着或正在更新时自动轮询状态，
      不给老师「点了没反应」的感觉。 */
(function (root) {
  "use strict";

  var V = root.AppVersion || { version: "", build: "", text: function () { return ""; } };
  var KEY_DISMISS = "rhythm.update.dismissed.v1";
  var KEY_MIGRATE = "rhythm.migrate.hint.v1";
  var POLL_MS = 30 * 60 * 1000;
  var UI_POLL_MS = 2000;
  var DOWNLOAD_PAGE = "https://github.com/sulengyin/ClassBeat/releases/latest";

  var latest = "";       /* 更新源报上来的新版本号 */
  var migrateOn = false; /* 是否在提示「旧地址的设置可以导过来」 */
  var timer = null;
  var restarting = false; /* 「重启服务」已点下，等服务回来就整页重载 */

  /* 「版本与更新」面板的共享状态：大屏弹层和设置页共用一份。 */
  var ui = {
    hosts: [],
    status: null,
    legacy: null,
    single: false,
    busy: false,
    checking: false,
    inflight: false,
    refreshing: false,
    panelOpen: false,
    autoChecked: false,
    error: "",
    poll: null
  };

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

  // ---------------------------------------------------------------- 网络

  function ajax(path, method) {
    var base = originBase();
    if (!base || !root.fetch) {
      var e = new Error("offline");
      return Promise.reject(e);
    }
    var opt = { method: method || "GET", cache: "no-store" };
    if (method === "POST") {
      opt.headers = { "Content-Type": "application/json" };
      opt.body = "{}";
    }
    return root.fetch(base + path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { ok: !!r.ok, status: r.status, data: d || {} };
      });
    });
  }

  // ---------------------------------------------------------------- 渲染

  function make(tag, cls, text) {
    var d = doc();
    var node = d.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function viewModel() {
    var st = ui.status || {};
    var lg = ui.legacy || {};
    var state = st.state || "idle";
    var single = ui.single || st.selfUpdate === false;
    var busy = !!ui.busy || !!st.busy || restarting;
    var version = st.version || st.currentVersion || V.version || "";
    var newLatest = st.latest || lg.latest || "";
    var available = st.available === true || (st.available === undefined && lg.available === true);
    var progress = Math.max(0, Math.min(100, Number(st.progress) || 0));

    var text = "";
    if (restarting) text = "服务重启中，马上回来…";
    else if (ui.checking) text = "正在检查更新…";
    else if (single) text = st.blockedReason
      || "这是单文件版，不能自己更新；请到下载页获取新版。";
    else if (busy) {
      var active = state === "checking" || state === "downloading" || state === "installing"
        || state === "verifying" || state === "rolling_back";
      /* 刚点下按钮、服务端状态还没翻页时，别把上一轮的「还没有检查更新」端出来 */
      text = active && st.message ? st.message : "正在更新，请稍等…";
    }
    else if (state === "failed") text = "";
    else if (state === "done") text = st.message || "更新完成。";
    else if (available && newLatest) text = "发现新版本 v" + newLatest + "。";
    else if (st.latest) text = "已经是最新版本。";
    else if (lg.available && lg.latest) {
      text = "发现新版本 v" + lg.latest + "，点「检查更新」看更新说明。";
    } else text = "还没有检查更新。";

    var error = ui.error || st.error || "";
    if (!error && state === "failed") error = st.message || "更新失败，已回到原来的版本。";

    var showBar = busy || state === "downloading" || state === "installing"
      || state === "verifying" || state === "rolling_back";
    /* 只有服务进程自己认得 /api/update/restart（canRestart 标记）才亮按钮：
       程序内更新后跑着的还是旧代码，它没有这个接口，点了只会 404。 */
    var restart = state === "done" && !busy && st.canRestart === true;

    return {
      version: version,
      build: st.build || "",
      text: text,
      progress: progress,
      showBar: showBar,
      notes: st.notes || "",
      error: error,
      restart: restart,
      single: single,
      busy: busy,
      canCheck: !single && !busy,
      canApply: !single && st.canApply === true && !busy,
      canRollback: !single && st.hasBackup === true && !busy,
      downloadPage: st.downloadPage || DOWNLOAD_PAGE
    };
  }

  function paint(part, vm) {
    part.ver.textContent = "当前版本 v" + (vm.version || "?")
      + (vm.build ? " · " + vm.build : "");
    part.state.textContent = vm.text;
    part.state.hidden = !vm.text;

    part.barWrap.hidden = !vm.showBar;
    part.bar.style.width = vm.progress + "%";

    part.notes.textContent = vm.notes;
    part.notes.hidden = !vm.notes;

    part.error.textContent = vm.error;
    part.error.hidden = !vm.error;

    part.restart.textContent = "重启服务，立即生效";
    part.restart.hidden = !vm.restart;

    part.check.hidden = !vm.canCheck;
    part.check.disabled = vm.busy;
    part.apply.hidden = !vm.canApply;
    part.apply.disabled = vm.busy;
    part.rollback.hidden = !vm.canRollback;
    part.rollback.disabled = vm.busy;
    part.download.hidden = !vm.single;
    part.download.href = vm.downloadPage;
  }

  function render() {
    var vm = viewModel();
    var alive = [];
    for (var i = 0; i < ui.hosts.length; i++) {
      var part = ui.hosts[i];
      if (part.host && part.host.isConnected) {
        paint(part, vm);
        alive.push(part);
      }
    }
    ui.hosts = alive;
  }

  /* 把一个空容器挂成更新卡片。设置页每次重绘都会新建容器，所以可重复调用。 */
  function mount(host) {
    if (!host || !doc()) return null;
    for (var i = 0; i < ui.hosts.length; i++) {
      if (ui.hosts[i].host === host) {
        paint(ui.hosts[i], viewModel());
        return ui.hosts[i];
      }
    }

    var part = { host: host };
    part.ver = make("p", "up-ver");
    part.state = make("p", "up-state");
    part.barWrap = make("div", "up-bar");
    part.bar = make("i");
    part.barWrap.appendChild(part.bar);
    part.notes = make("p", "up-notes");
    part.error = make("p", "up-error");
    part.restart = make("button", "setup-btn primary", "重启服务，立即生效");
    part.restart.type = "button";
    part.restart.setAttribute("data-act", "restart");
    part.acts = make("div", "up-acts");

    part.check = make("button", "setup-btn ghost", "检查更新");
    part.apply = make("button", "setup-btn primary", "立即更新");
    part.rollback = make("button", "setup-btn", "回滚到上一版");
    part.download = make("a", "setup-btn", "去下载新版");
    part.check.setAttribute("data-act", "check");
    part.apply.setAttribute("data-act", "apply");
    part.rollback.setAttribute("data-act", "rollback");
    part.download.setAttribute("data-act", "download");
    part.check.type = "button";
    part.apply.type = "button";
    part.rollback.type = "button";
    part.download.target = "_blank";
    part.download.rel = "noopener";

    part.check.addEventListener("click", function () { doAction("check"); });
    part.apply.addEventListener("click", function () { doAction("apply"); });
    part.rollback.addEventListener("click", function () { doAction("rollback"); });
    part.restart.addEventListener("click", function () { doRestart(); });

    part.acts.appendChild(part.check);
    part.acts.appendChild(part.apply);
    part.acts.appendChild(part.rollback);
    part.acts.appendChild(part.download);

    host.innerHTML = "";
    host.appendChild(part.ver);
    host.appendChild(part.state);
    host.appendChild(part.barWrap);
    host.appendChild(part.notes);
    host.appendChild(part.error);
    host.appendChild(part.restart);
    host.appendChild(part.acts);

    ui.hosts.push(part);
    paint(part, viewModel());
    if (reachable()) refresh();
    return part;
  }

  // ---------------------------------------------------------------- 动作

  function doAction(name) {
    if (ui.inflight) return;
    ui.inflight = true;
    ui.error = "";
    if (name === "check") {
      ui.checking = true;
    } else {
      ui.busy = true;
    }
    render();

    ajax("/api/update/" + name, "POST").then(function (res) {
      ui.checking = false;
      if (!res.ok) {
        ui.busy = false;
        ui.error = (res.data && (res.data.error || res.data.message))
          || "操作没成功，请稍后再试。";
        render();
        return;
      }
      if (name === "check") {
        refresh();
      } else {
        ensurePoll();
        refresh();
      }
    }).catch(function () {
      ui.checking = false;
      ui.busy = false;
      ui.error = "操作没成功，请确认本机服务在运行后再试。";
      render();
    }).then(function () {
      ui.inflight = false;
    });
  }

  // ---------------------------------------------------------------- 重启服务

  /* 更新完成后把新代码真正跑起来的最后一步。服务重启期间端口会
     短暂失联：每秒探一次 /api/version，回来就整页重载加载新 UI。
     超时（45 秒）就停手，告诉老师手动出路，不再干等。 */
  function doRestart() {
    if (ui.inflight || restarting) return;
    ui.inflight = true;
    restarting = true;
    ui.error = "";
    render();
    ajax("/api/update/restart", "POST").then(function (res) {
      ui.inflight = false;
      if (!res.ok) {
        restarting = false;
        ui.error = (res.data && (res.data.error || res.data.message))
          || "重启没成功，请稍后再试。";
        render();
        return;
      }
      waitServerBack(Date.now() + 45000);
    }).catch(function () {
      ui.inflight = false;
      restarting = false;
      ui.error = "重启没成功，请确认本机服务在运行后再试。";
      render();
    });
  }

  function waitServerBack(deadline) {
    var base = originBase();
    if (!base || !root.fetch) { giveUpRestart(); return; }
    root.fetch(base + "/api/version", { cache: "no-store" })
      .then(function (r) {
        if (r && r.ok) {
          /* 新服务站稳一下再整页重载，别抢在它回话之前 */
          root.setTimeout(function () { root.location.reload(); }, 800);
          return;
        }
        retryWait(deadline);
      })
      .catch(function () { retryWait(deadline); });
  }

  function retryWait(deadline) {
    if (Date.now() > deadline) { giveUpRestart(); return; }
    root.setTimeout(function () { waitServerBack(deadline); }, 1000);
  }

  function giveUpRestart() {
    restarting = false;
    ui.error = "服务重启没等到回音：等半分钟刷新一次页面；"
      + "还不行就关掉程序，双击桌面图标重新打开。";
    render();
  }

  // ---------------------------------------------------------------- 刷新

  function reachable() {
    if (ui.panelOpen || ui.busy) return true;
    for (var i = 0; i < ui.hosts.length; i++) {
      var h = ui.hosts[i].host;
      if (h && h.isConnected && h.getClientRects().length) return true;
    }
    return false;
  }

  function ensurePoll() {
    if (ui.poll || !root.setInterval) return;
    ui.poll = root.setInterval(function () {
      if (reachable()) refresh();
    }, UI_POLL_MS);
  }

  function refresh() {
    if (ui.refreshing || restarting) return;
    ui.refreshing = true;
    Promise.all([
      ajax("/api/update/status").catch(function () { return null; }),
      ajax("/api/update").catch(function () { return null; })
    ]).then(function (arr) {
      var st = arr[0];
      var lg = arr[1];
      if (st && st.ok && st.data && st.data.ok !== false && st.data.state) {
        ui.status = st.data;
        ui.single = st.data.selfUpdate === false;
        ui.busy = !!st.data.busy;
      } else {
        /* 读不到状态：没有服务（单文件版 / 服务没起），只留下载入口 */
        ui.status = null;
        ui.single = true;
        ui.busy = false;
      }
      if (lg && lg.ok && lg.data) ui.legacy = lg.data;
      render();
      paintDot();

      /* 旧接口只知道「有新版」，不知道更新说明。
         面板刚打开且确实有新版时，自动补一次清单，别让老师多点一下。 */
      if (ui.panelOpen && !ui.autoChecked && ui.legacy && ui.legacy.available
          && !(ui.status && ui.status.latest) && !ui.inflight && !ui.checking) {
        ui.autoChecked = true;
        doAction("check");
      }
    }).then(function () {
      ui.refreshing = false;
    });
  }

  // ---------------------------------------------------------------- 入口

  /* ⋯菜单里「更新」一项的红点：有新版就亮，不用老师记得点开看 */
  function paintDot() {
    var d = el("update-dot");
    if (d) d.hidden = !(ui.legacy && ui.legacy.available);
  }

  function openPanel() {
    var modal = el("updatePanel");
    if (!modal) return;
    ui.panelOpen = true;
    modal.hidden = false;
    refresh();
  }

  function closePanel() {
    var modal = el("updatePanel");
    if (!modal) return;
    ui.panelOpen = false;
    modal.hidden = true;
  }

  function initPanel() {
    var body = el("updateBody");
    if (body) mount(body);

    var open = el("btn-update");
    if (open) open.addEventListener("click", openPanel);
    var shut = el("upClose");
    if (shut) shut.addEventListener("click", closePanel);

    var modal = el("updatePanel");
    if (modal) {
      modal.addEventListener("click", function (e) {
        if (e.target === modal) closePanel();
      });
    }
    var d = doc();
    if (d && d.addEventListener) {
      d.addEventListener("keydown", function (e) {
        if (e && e.key === "Escape") closePanel();
      });
    }

    ensurePoll();
    refresh();
    paintDot();
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
    initPanel();
  }

  root.Update = {
    init: init,
    check: check,
    dismiss: dismiss,
    mount: mount,
    refresh: refresh,
    openPanel: openPanel,
    closePanel: closePanel,
    /* 测试用：直接摆出提示，不用真去连服务 */
    _renderTip: renderTip,
    _setMigrate: function (v) { migrateOn = !!v; },
    _setLatest: function (v) { latest = v ? String(v) : ""; }
  };

  if (doc() && doc().readyState !== "loading") init();
  else if (doc() && doc().addEventListener) doc().addEventListener("DOMContentLoaded", init);
})(typeof window !== "undefined" ? window : this);
