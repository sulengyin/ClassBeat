/* 大屏渲染。只做一件事：把 stateAt 的结果变成屏上的字。
   任何"一个时段说什么"的判断都在 rhythm.js，这里不重复。
   视觉层对应 PLAN 2.20 / 2.21：一屏一件事、四色语义、边缘流光只给紧急。 */
(function (root) {
  "use strict";

  var DATA = root.RHYTHM_DATA || { days: {} };
  var R = root.Rhythm;
  var S = root.Store;

  var params = new URLSearchParams(root.location ? root.location.search : "");
  var fixedTime = params.get("t");
  var fixedDate = params.get("date");

  var el = {};
  function $(id) { return document.getElementById(id); }

  var lastSig = "";
  var lastDutySig = "";
  var detailTimer = 0;

  /* 一日脊柱 */
  var spineKey = "", spineSegs = [], spineFrom = 0, spineSpan = 1;

  /* 倒计时滚轮 */
  var tickerLen = -1, tickerCols = [];

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function setText(node, v) { if (node && node.textContent !== v) node.textContent = v; }

  function todayKey() {
    if (fixedDate) return fixedDate;
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function nowMinutes() {
    /* 测试与调试用的注入点：设了就不看系统时间 */
    if (root.__rhythmTime != null) return root.__rhythmTime;
    if (fixedTime) {
      var p = fixedTime.split(":");
      return (+p[0]) * 60 + (+p[1]) + (+(p[2] || 0)) / 60;
    }
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  }

  function dateLabel(key) {
    var d = new Date(key + "T00:00:00");
    return (d.getMonth() + 1) + "月" + d.getDate() + "日　周" + "日一二三四五六"[d.getDay()];
  }

  /* 中英混排的视觉宽度：一个汉字算 1，数字字母算 0.58，空格算 0.3 */
  function weight(text) {
    var w = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c > 255) w += 1;
      else if (c === 32) w += 0.3;
      else w += 0.58;
    }
    return w;
  }

  /* ---------- 天光 ----------
     底色不再按"这节课是什么"换，而是按"现在几点"走：清晨偏暖、正午最亮、
     傍晚转橘、天暗转深。一天只朝一个方向变，学生不会被背景色打断。
     语义（可动 / 专注 / 准备）留给小面积的标签和数字。 */
  var LIGHT = [
    { at: 6 * 60 + 30,  paper: [243, 236, 226], card: [250, 236, 214] }, /* 晨雾 */
    { at: 7 * 60 + 40,  paper: [248, 239, 223], card: [255, 237, 206] }, /* 到校 */
    { at: 9 * 60 + 30,  paper: [251, 243, 223], card: [255, 231, 182] }, /* 上午金光 */
    { at: 11 * 60 + 40, paper: [253, 250, 241], card: [255, 248, 223] }, /* 正午最亮 */
    { at: 13 * 60 + 30, paper: [251, 244, 224], card: [255, 237, 196] }, /* 午后 */
    { at: 15 * 60 + 40, paper: [249, 238, 214], card: [252, 226, 178] }, /* 偏金 */
    { at: 16 * 60 + 40, paper: [244, 228, 201], card: [247, 213, 162] }, /* 傍晚 */
    { at: 17 * 60 + 20, paper: [235, 217, 189], card: [239, 200, 148] }, /* 暮光 */
    { at: 18 * 60 + 30, paper: [221, 203, 177], card: [226, 188, 141] }  /* 天暗 */
  ];

  var lastLight = "", lightOn = false;

  function rgb(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }
  function blend(a, b, t) {
    return [Math.round(a[0] + (b[0] - a[0]) * t),
            Math.round(a[1] + (b[1] - a[1]) * t),
            Math.round(a[2] + (b[2] - a[2]) * t)];
  }

  function applyDaylight(minutes) {
    var body = document.body;
    /* 黑板模式有自己的纸色，天光不参与，否则深色会被冲淡 */
    if (body.dataset.theme === "dark") {
      if (lightOn) {
        body.style.removeProperty("--day-paper");
        body.style.removeProperty("--day-card");
        body.style.removeProperty("--day-cream");
        lightOn = false;
        lastLight = "";
      }
      return;
    }

    var m = Math.max(LIGHT[0].at, Math.min(LIGHT[LIGHT.length - 1].at, minutes));
    var i = 0;
    while (i < LIGHT.length - 2 && m >= LIGHT[i + 1].at) i++;
    var a = LIGHT[i], b = LIGHT[i + 1];
    var t = b.at === a.at ? 0 : (m - a.at) / (b.at - a.at);

    var paper = rgb(blend(a.paper, b.paper, t));
    var card = rgb(blend(a.card, b.card, t));
    /* 便签永远比卡亮一档，否则贴纸和卡底糊在一起 */
    var cream = rgb(blend(blend(a.card, b.card, t), [255, 252, 244], .72));

    var sig = paper + card + cream;
    if (sig === lastLight) return;
    lastLight = sig;
    lightOn = true;
    body.style.setProperty("--day-paper", paper);
    body.style.setProperty("--day-card", card);
    body.style.setProperty("--day-cream", cream);
  }


  /* 字号不写死：同一句话 2 个字和 12 个字要占同样的视觉面积。
     CARD_W 是贴纸卡里真正能写字的宽度（vmin），不是整个屏宽——
     以前按 148 算，长标题会顶出卡片；进了卡片就必须按卡片算。
     单行反算和按面积反算取大的那个：能一行写完就一行，写不完就换行放大。 */
  var CARD_W = 70;
  function textSize(text, cap, maxH) {
    var w = Math.max(weight(text), 1);
    var one = CARD_W / w;
    var area = Math.sqrt((CARD_W * (maxH || 22)) / (1.15 * w));
    return Math.max(4.6, Math.min(cap || 16, Math.max(one, area)));
  }

  var BAND = {
    class: "上课", break: "课间", meal: "午餐", noon: "午间",
    action: "大扫除", after: "课后服务", before: "还没到校",
    closed: "放学", holiday: "今天休息"
  };

  function bandText(s) {
    /* 到校前和到校后是两回事：7:40 人已经在教室里，不能再写"还没到校" */
    if (s.kind === "before") {
      if (s.reading) return "早读";
      return s.arrived ? "到校" : "还没到校";
    }
    if (s.kind === "ritual") return s.title || "固定安排";
    if (s.kind === "noon") return s.title || "午间";
    return BAND[s.kind] || "";
  }

  function afterText(s) {
    if (s.kind === "class") {
      var parts = [];
      if (s.sub) parts.push(s.sub);
      if (s.range) parts.push(durText(s.range));
      return parts.join("　·　");
    }
    if (s.kind === "break" && s._next) {
      return "下一节 " + s._next.subject + (s._next.teacher ? "　" + s._next.teacher : "");
    }
    if (s.kind === "closed") return s.note || "整理好书包，明天见";
    return s.note || s.sub || "";
  }

  function durText(range) {
    var p = String(range).split("–");
    if (p.length !== 2) return "";
    var m = R.t2m(p[1]) - R.t2m(p[0]);
    return m + " 分钟";
  }

  /* ---------- 一日脊柱：今天走到哪儿 ---------- */
  function buildSpine(day) {
    if (!el.spine) return;
    var key = day.date + "|" + day.timeline.length;
    if (key === spineKey) return;
    spineKey = key;

    el.spine.innerHTML = "";
    spineSegs = [];

    var t = day.timeline;
    spineFrom = R.t2m(t[0].start);
    var end = R.t2m(t[t.length - 1].end);
    spineSpan = Math.max(1, end - spineFrom);

    t.forEach(function (b) {
      var s = R.t2m(b.start), e = R.t2m(b.end);
      var d = document.createElement("div");
      d.className = "seg " + (b.type || "class");
      d.style.top = ((s - spineFrom) / spineSpan * 100) + "%";
      d.style.height = Math.max(1.4, (e - s) / spineSpan * 100) + "%";
      el.spine.appendChild(d);
      spineSegs.push({ node: d, s: s, e: e });
    });

    var m = document.createElement("div");
    m.className = "mark";
    el.spine.appendChild(m);
    el.mark = m;
  }

  function paintSpine(minutes) {
    if (!el.mark) return;
    var pct = (minutes - spineFrom) / spineSpan;
    pct = Math.max(0, Math.min(1, pct));
    el.mark.style.top = (pct * 100) + "%";
    for (var i = 0; i < spineSegs.length; i++) {
      var g = spineSegs[i];
      var on = minutes >= g.s && minutes < g.e;
      if (on !== (g.on === true)) {
        g.on = on;
        g.node.classList.toggle("now", on);
      }
    }
  }

  /* ---------- 倒计时滚轮（collector number-ticker） ---------- */
  function buildTicker(text) {
    var host = el.heroMain;
    host.classList.add("ticker");
    host.dataset.text = text;

    if (tickerLen !== text.length) {
      host.innerHTML = "";
      tickerCols = [];
      for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        if (ch >= "0" && ch <= "9") {
          var col = document.createElement("span");
          col.className = "tk-col";
          var strip = document.createElement("span");
          strip.className = "tk-strip";
          for (var d = 0; d < 10; d++) {
            var b = document.createElement("b");
            b.textContent = String(d);
            strip.appendChild(b);
          }
          col.appendChild(strip);
          host.appendChild(col);
          tickerCols.push({ strip: strip, digit: -1 });
        } else {
          var sep = document.createElement("span");
          sep.className = "tk-sep";
          sep.textContent = ch;
          host.appendChild(sep);
          tickerCols.push({ strip: null, digit: ch });
        }
      }
      tickerLen = text.length;
    }

    for (var k = 0; k < text.length; k++) {
      var c = tickerCols[k];
      var ch2 = text.charAt(k);
      if (!c || !c.strip) continue;
      var want = +ch2;
      if (c.digit !== want) {
        c.digit = want;
        c.strip.style.transform = "translateY(" + (-want) + "em)";
      }
    }
  }

  function clearTicker() {
    if (tickerLen < 0) return;
    el.heroMain.classList.remove("ticker");
    el.heroMain.innerHTML = "";
    tickerLen = -1;
    tickerCols = [];
  }

  function setHeroText(v) {
    clearTicker();
    setText(el.heroMain, v);
    el.heroMain.dataset.text = v;
  }

  /* ---------- 值日条 ---------- */
  function renderDuty(day, minutes) {
    var res = R.dutiesAt(day, minutes);
    var sig = JSON.stringify(res.items.map(function (d) {
      return [d.name, d.people, d.unknown, d.quiet, d.tasks];
    })) + "|" + res.overflow;

    if (sig === lastDutySig) return;
    lastDutySig = sig;

    el.duty.innerHTML = "";
    hideDetail();

    if (!res.items.length) {
      var none = document.createElement("div");
      none.className = "none";
      none.textContent = "现在没有值日任务";
      el.duty.appendChild(none);
      return;
    }

    res.items.forEach(function (d, i) {
      if (i) {
        var sep = document.createElement("span");
        sep.className = "dot-sep";
        el.duty.appendChild(sep);
      }

      var item = document.createElement("div");
      item.className = "duty" + (d.quiet ? " quiet" : "");

      var task = document.createElement("span");
      task.className = "task";
      task.textContent = d.name;
      item.appendChild(task);

      var who = document.createElement("span");
      who.className = "who";
      if (d.unknown) {
        who.textContent = "待定";
        who.classList.add("none");
      } else if (d.assign === "self-organize") {
        who.textContent = "自己商量";
        who.classList.add("none");
      } else if (d.people && d.people.length) {
        who.textContent = d.people.join("、");
      }
      if (who.textContent) item.appendChild(who);

      /* 组员可以点开看，只读（PLAN 2.18）。学生能点，但点了只能看。 */
      if (!d.unknown && d.people && d.people.length) {
        item.dataset.people = d.people.join("、");
        item.dataset.task = d.tasks && d.tasks.length ? d.tasks.join("、") : d.name;
        item.addEventListener("click", function () { showDetail(item); });
      }

      el.duty.appendChild(item);
    });

    if (res.overflow) {
      var more = document.createElement("span");
      more.className = "more";
      more.textContent = "还有 " + res.overflow + " 步";
      el.duty.appendChild(more);
    }
  }

  function showDetail(item) {
    el.dutyDetail.textContent = item.dataset.task + "：" + item.dataset.people;
    el.dutyDetail.classList.add("show");
    clearTimeout(detailTimer);
    detailTimer = setTimeout(hideDetail, 10000);
  }

  function hideDetail() {
    if (el.dutyDetail) el.dutyDetail.classList.remove("show");
  }

  /* ---------- 主题 ---------- */
  function applyTheme() {
    var t = S.prefs().theme === "dark" ? "dark" : "light";
    document.body.dataset.theme = t;
    applyDaylight(nowMinutes());
    if (el.btnTheme) el.btnTheme.textContent = t === "dark" ? "浅色" : "深色";
  }

  /* ---------- 老师改过的文字 ----------
     只改"说什么"，不动"什么时候说"：提示语按时段名替换，
     准备清单按科目的 key 替换，其余规则仍由 rhythm.js 决定。
     传进来的 day 必须是可以就地改的副本（render 里保证）。 */
  function applyTexts(day) {
    var T = S.texts ? S.texts() : null;
    if (!T) return;
    var tips = T.tips || {};
    var prep = T.prep || {};
    if (!Object.keys(tips).length && !Object.keys(prep).length) return;

    (day.timeline || []).forEach(function (b) {
      if (b.name && tips[b.name] != null && tips[b.name] !== "") b.tip = tips[b.name];
      if (b.prep && b.prep.key && prep[b.prep.key] && prep[b.prep.key].length) {
        b.prep = { key: b.prep.key, level: b.prep.level, items: prep[b.prep.key].slice() };
      }
    });
  }

  /* ---------- 主渲染 ---------- */
  function render() {
    if (!el.main) return;

    var key = todayKey();
    var raw = DATA.days ? DATA.days[key] : null;
    var ov = S.getDayOverride(key);
    var day = raw ? S.applyOverrides(raw, ov) : null;
    /* applyOverrides 在没有覆盖时返回的是打包数据本身，不能就地改 */
    if (day && day === raw) day = S.clone(raw);
    if (day) applyTexts(day);
    var minutes = nowMinutes();

    applyDaylight(minutes);

    setText(el.clock, R.m2t(Math.floor(minutes)));
    if (el.sec) setText(el.sec, ":" + pad(Math.floor((minutes % 1) * 60)));
    setText(el.date, dateLabel(key));

    if (!day) {
      el.warn.classList.add("show");
      setText(el.warnTitle, "数据不包含今天（" + key + "）");
      el.warnText.innerHTML = "请在电脑上重新生成：<br><code>python3 tools/bundle.py</code>";
      setText(el.bandText, ""); setHeroText("");
      setText(el.heroSub, ""); setText(el.after, ""); el.chips.innerHTML = ""; el.duty.innerHTML = "";
      return;
    }
    el.warn.classList.remove("show");

    var mode = (S.prefs().cdMode) || "auto";
    var texts = S.texts ? S.texts() : {};
    var s = R.stateAt(day, minutes, { countdownMode: mode, texts: texts });

    /* 老师发的临时通知分两级：普通提示只占一条，紧急占整个主区 */
    var notice = activeNotice(ov);
    var urgent = notice && notice.level === "urgent";

    var tone = s.tone;
    if (urgent) tone = "red";

    document.body.dataset.kind = s.kind;
    document.body.dataset.tone = tone;
    document.body.dataset.focus = urgent ? "alert" : s.focus;
    document.body.dataset.alert = urgent ? "1" : "0";
    document.body.dataset.settled = urgent && settled(notice) ? "1" : "0";

    var isTicker = !urgent && s.focus === "countdown" && !!s.timer;
    /* 倒计时用滚轮，数字自己动；sig 里不放秒数，否则每秒重播一次入场动画 */
    var sig = [s.kind, s.title, s.focus, isTicker ? "cd" : "", urgent ? 1 : 0,
               urgent ? notice.text : "", s.items.length, s.hints.length,
               s.note, s.range].join("|");

    /* 顶栏状态词 */
    var band = urgent ? "紧急通知" : bandText(s);
    setText(el.bandText, band);
    el.band.style.letterSpacing = urgent ? ".3em" : ".2em";

    /* 主视觉 */
    var main, sub, after, size;
    if (urgent) {
      main = notice.text;
      sub = "";
      after = "老师发出　" + (notice.at || "");
      size = textSize(main, 14, 40);
    } else if (isTicker) {
      main = s.timer;
      sub = s.nextLabel || "后上课";
      after = afterText(s);
      size = 20;
    } else {
      main = s.title;
      sub = "";
      after = afterText(s);
      /* 便签占了一条，主视觉就让一点位置，别把卡片撑破 */
      size = notice ? textSize(main, 13, 17) : textSize(main, 16, 22);
    }

    if (isTicker) buildTicker(main);
    else setHeroText(main);

    setText(el.heroSub, sub);
    el.heroMain.style.fontSize = size + "vmin";
    setText(el.after, after);

    /* 普通通知：贴在主区上方一条，不改主视觉 */
    renderNotice(notice && !urgent ? notice : null);

    /* 动作 / 用品：两行——先去做什么，再带什么 */
    renderChips(urgent ? [] : (s.lines || []));

    document.title = CFG.title({ urgent: urgent, title: s.title });

    buildSpine(day);
    paintSpine(minutes);

    /* 只有状态真的变了才播入场动画。每秒重播会让人分心 */
    if (sig !== lastSig) {
      lastSig = sig;
      if (!reduced()) {
        el.heroMain.classList.remove("enter");
        void el.heroMain.offsetWidth;
        el.heroMain.classList.add("enter");
        el.after.classList.remove("enter-d");
        void el.after.offsetWidth;
        el.after.classList.add("enter-d");
      }
    }

    renderDuty(day, minutes);
  }

  /* 清单项统一以一个句号收尾。老师录入时有人写有人不写，
     屏上混着两种会很毛躁；这里补齐，不去改原数据。 */
  function dot(t) {
    t = String(t == null ? "" : t).trim();
    if (!t) return t;
    return /[。！？.!?]$/.test(t) ? t : t + "。";
  }

  function renderChips(lines) {
    var sig = JSON.stringify(lines);
    if (el.chips.dataset.sig === sig) return;
    el.chips.dataset.sig = sig;
    el.chips.innerHTML = "";
    var k = 0;

    (lines || []).forEach(function (line) {
      var row = document.createElement("div");
      row.className = line.kind === "prep" ? "prep-line" : "chip-row";

      if (line.kind === "prep") {
        var lb = document.createElement("span");
        lb.className = "plabel";
        lb.textContent = line.label || "准备好";
        row.appendChild(lb);
        (line.items || []).forEach(function (text) {
          var s = document.createElement("span");
          s.className = "pitem";
          s.style.setProperty("--d", (k++ * 55) + "ms");
          s.textContent = dot(text);
          row.appendChild(s);
        });
      } else {
        (line.items || []).forEach(function (text) {
          var n = document.createElement("span");
          n.className = "chip prep";
          n.style.setProperty("--d", (k++ * 55) + "ms");
          n.textContent = text;
          row.appendChild(n);
        });
      }

      el.chips.appendChild(row);
    });
  }

  /* 关闭当前通知：本地清掉，同时告诉服务端撤回，否则刷新又回来 */
  function dismissNotice() {
    try {
      S.patchDayOverride(todayKey(), { notice: null });
    } catch (e) {}
    if (root.Remote && root.Remote.retract) root.Remote.retract();
    lastSig = "";
    render();
  }

  /* 按住 0.9 秒才生效：单击无效，避免学生路过点掉老师的话 */
  function bindHold(node, fn) {
    var timer = 0;
    function stop() {
      if (timer) { clearTimeout(timer); timer = 0; }
      node.classList.remove("holding");
    }
    function down(e) {
      if (e && e.preventDefault) e.preventDefault();
      stop();
      node.classList.add("holding");
      timer = setTimeout(function () {
        timer = 0;
        node.classList.remove("holding");
        fn();
      }, 900);
    }
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointerup", stop);
    node.addEventListener("pointerleave", stop);
    node.addEventListener("pointercancel", stop);
  }

  function renderNotice(notice) {
    var n = el.noticeBar;
    if (!notice) {
      if (n) n.remove();
      el.noticeBar = null;
      el.noticeText = null;
      return;
    }
    if (!n) {
      n = document.createElement("div");
      n.className = "notice-bar";

      var t = document.createElement("span");
      t.className = "notice-text";
      n.appendChild(t);
      el.noticeText = t;

      var x = document.createElement("button");
      x.type = "button";
      x.className = "notice-x";
      x.textContent = "×";
      x.setAttribute("aria-label", "按住关闭通知");
      bindHold(x, dismissNotice);
      n.appendChild(x);

      el.main.insertBefore(n, el.band.nextSibling);
      el.noticeBar = n;
    }
    var txt = "老师：" + notice.text;
    if (el.noticeText.textContent !== txt) el.noticeText.textContent = txt;
  }

  /* ---------- 通知有效期 ---------- */
  function activeNotice(ov) {
    if (!ov || !ov.notice || !ov.notice.text) return null;
    var until = ov.notice.until;
    if (!until) return ov.notice;
    var now = R.m2t(Math.floor(nowMinutes()));
    if (until >= "00:00" && until < "06:00") return ov.notice;
    return now < until ? ov.notice : null;
  }

  function settled(notice) {
    if (!notice || !notice.createdAt) return false;
    return Date.now() - notice.createdAt > 60000;
  }

  function reduced() {
    var p = S.prefs();
    if (p.reduce) return true;
    try {
      return root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) { return false; }
  }

  /* ---------- 控制 ---------- */
  var MODES = ["auto", "all", "off"];
  var MODE_LABEL = { auto: "按推荐", all: "全部显示", off: "全部关闭" };

  function paintControls() {
    var p = S.prefs();
    el.btnCd.textContent = "倒计时 · " + MODE_LABEL[p.cdMode || "auto"];
    el.btnCd.classList.toggle("on", (p.cdMode || "auto") !== "auto");
    el.btnReduce.classList.toggle("on", !!p.reduce);
    document.body.dataset.reduce = p.reduce ? "1" : "0";
    applyTheme();
  }

  function boot() {
    el = {
      cls: $("cls"), date: $("date"), clock: $("clock"), sec: $("sec"),
      main: $("main"), band: $("band"), bandText: $("bandText"),
      spine: $("spine"), mark: null,
      heroMain: $("heroMain"), heroSub: $("heroSub"),
      after: $("after"), chips: $("chips"), duty: $("duty"),
      dutyDetail: $("dutyDetail"),
      warn: $("warn"), warnTitle: $("warn-title"), warnText: $("warn-text"),
      corner: $("corner"), btnCd: $("btn-cd"), btnFull: $("btn-full"),
      btnReduce: $("btn-reduce"), btnEdit: $("btn-edit"), btnGear: $("btn-gear"),
      btnTheme: $("btn-theme"),
      noticeBar: null
    };

    /* 班级名来自数据，不在页面里写死 */
    if (el.cls) el.cls.textContent = CFG.klass();

    /* ?theme=dark 只是调试用，不写入偏好，免得把教室屏改花 */
    var pt = params.get("theme");
    if (pt === "dark" || pt === "light") document.body.dataset.theme = pt;

    el.btnGear.addEventListener("click", function () {
      el.corner.classList.toggle("open");
    });

    el.btnFull.addEventListener("click", function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    });

    el.btnCd.addEventListener("click", function () {
      var cur = S.prefs().cdMode || "auto";
      S.setPref("cdMode", MODES[(MODES.indexOf(cur) + 1) % MODES.length]);
      paintControls();
      lastSig = "";
      render();
    });

    el.btnReduce.addEventListener("click", function () {
      S.setPref("reduce", !S.prefs().reduce);
      paintControls();
    });

    if (el.btnTheme) el.btnTheme.addEventListener("click", function () {
      S.setPref("theme", S.prefs().theme === "dark" ? "light" : "dark");
      applyTheme();
    });

    el.btnEdit.addEventListener("click", function () {
      /* 编辑时先停下演练，否则屏上时间还在自己走，改完看不出改的是哪一刻 */
      if (root.Demo) root.Demo.pause();
      if (root.Edit) root.Edit.open();
    });

    paintControls();
    if (pt) document.body.dataset.theme = pt;
    render();
    setInterval(render, 1000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { lastSig = ""; render(); }
    });
  }

  root.Screen = {
    render: render, todayKey: todayKey, nowMinutes: nowMinutes,
    boot: boot, applyTheme: applyTheme
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window);
