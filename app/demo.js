/* 演练：把一整天压缩成几分钟，让老师看见"屏怎么变"。
   只做时间轴，不改任何节律判断——所有文案仍由 rhythm.js 出。
   启用方式：地址加 ?demo=1，或点右下角「演练」。 */
(function (root) {
  "use strict";

  var R = root.Rhythm;
  var RT = root.Runtime;
  var params = new URLSearchParams((root.location && root.location.search) || "");
  var hash = String((root.location && root.location.hash) || "").replace(/^#/, "");

  var T0 = 7 * 60 + 15;   /* 07:15 晨间自主管理开始前 */
  var T1 = 18 * 60;       /* 18:00 放学后 */
  var SPEEDS = [30, 120, 480];

  var cur = T0;
  var speedIdx = 1;
  var playing = false;
  var raf = 0, lastTs = 0, lastDraw = 0, idleTimer = 0;
  var el = {};
  var ready = false;

  function $(id) { return document.getElementById(id); }
  function clamp(m) { return Math.max(T0, Math.min(T1, m)); }
  function speed() { return SPEEDS[speedIdx]; }

  function dayKey() {
    return root.Screen ? root.Screen.todayKey() : "1970-01-01";
  }

  /* ---------- 一天的结构条：哪段上课、哪段课间，一眼看出节奏 ---------- */
  function buildRibbon() {
    var day = RT ? RT.day(dayKey()) : null;
    el.ribbon.innerHTML = "";
    if (!day) return;
    day.timeline.forEach(function (b) {
      var s = R.t2m(b.start), e = R.t2m(b.end);
      var i = document.createElement("i");
      i.className = "rb rb-" + (b.type || "class");
      i.style.left = ((s - T0) / (T1 - T0) * 100) + "%";
      i.style.width = Math.max(0.3, (e - s) / (T1 - T0) * 100) + "%";
      el.ribbon.appendChild(i);
    });
  }

  /* ---------- 状态与绘制 ---------- */
  function paint() {
    el.now.textContent = R.m2t(Math.floor(cur));
    if (document.activeElement !== el.range) el.range.value = String(cur);
  }

  function draw() {
    root.__rhythmTime = cur;
    paint();
    if (root.Screen) root.Screen.render();
  }

  function wake() {
    document.body.classList.remove("d-idle");
    clearTimeout(idleTimer);
    if (playing) idleTimer = setTimeout(sleep, 4000);
  }

  function sleep() {
    if (playing) document.body.classList.add("d-idle");
  }

  function setPlaying(on) {
    playing = !!on;
    el.play.textContent = playing ? "❙❙" : "▶";
    el.play.setAttribute("aria-label", playing ? "暂停" : "播放");
    el.play.classList.toggle("on", playing);
    lastTs = 0;
    if (playing) {
      if (cur >= T1) cur = T0;
      wake();
      if (!raf) raf = requestAnimationFrame(loop);
    } else {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      clearTimeout(idleTimer);
      document.body.classList.remove("d-idle");
    }
  }

  function loop(ts) {
    raf = 0;
    if (!playing) return;

    if (!lastTs) lastTs = ts;
    var dt = Math.min(0.2, (ts - lastTs) / 1000);
    lastTs = ts;

    cur += dt * speed() / 60;
    if (cur >= T1) { cur = T1; draw(); setPlaying(false); return; }

    /* 10 帧/秒足够：屏上只显示到分钟，再快也看不出来 */
    if (ts - lastDraw > 80) { lastDraw = ts; draw(); }
    raf = requestAnimationFrame(loop);
  }

  function seek(m, stop) {
    cur = clamp(m);
    if (stop && playing) setPlaying(false);
    draw();
    wake();
  }

  /* ---------- 开合 ---------- */
  function open(start, autoplay) {
    if (!ready) return;
    document.body.dataset.demo = "1";
    buildRibbon();
    if (start != null) cur = clamp(start);
    draw();
    setPlaying(autoplay !== false);
  }

  function close() {
    setPlaying(false);
    document.body.dataset.demo = "0";
    root.__rhythmTime = null;
    if (root.Screen) root.Screen.render();
  }

  function isOpen() { return document.body.dataset.demo === "1"; }

  /* ---------- 绑定 ---------- */
  function boot() {
    el = {
      bar: $("demo"), play: $("d-play"), now: $("d-now"), ribbon: $("d-ribbon"),
      range: $("d-range"), speed: $("d-speed"), close: $("d-close")
    };
    if (!el.bar) return;
    ready = true;

    el.range.min = String(T0);
    el.range.max = String(T1);
    el.range.step = "0.5";

    el.play.addEventListener("click", function () { setPlaying(!playing); });

    el.range.addEventListener("input", function () {
      cur = clamp(parseFloat(el.range.value));
      if (playing) setPlaying(false);
      draw();
    });

    el.speed.addEventListener("click", function () {
      speedIdx = (speedIdx + 1) % SPEEDS.length;
      el.speed.textContent = "×" + speed();
      wake();
    });

    el.close.addEventListener("click", close);

    Array.prototype.forEach.call(el.bar.querySelectorAll(".d-jump"), function (b) {
      b.addEventListener("click", function () {
        seek(R.t2m(b.dataset.t), true);
      });
    });

    document.addEventListener("mousemove", function () { if (isOpen()) wake(); }, { passive: true });
    document.addEventListener("touchstart", function () { if (isOpen()) wake(); }, { passive: true });
    document.addEventListener("keydown", function (e) {
      if (!isOpen()) return;
      if (e.key === "Escape") close();
      if (e.key === " ") { e.preventDefault(); setPlaying(!playing); }
    });

    var btn = $("btn-demo");
    if (btn) btn.addEventListener("click", function () {
      if (isOpen()) close(); else open(T0, true);
    });

    el.speed.textContent = "×" + speed();

    var t = params.get("t");
    var auto = params.get("demo") || (hash === "demo" ? "1" : "");
    if (auto && auto !== "0") open(t ? R.t2m(t) : T0, true);
  }

  root.Demo = { open: open, close: close, pause: function () { setPlaying(false); },
                seek: seek, isOpen: isOpen };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window);
