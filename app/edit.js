/* P3 编辑面板。原则：
   1. 进编辑先盖住大屏（面板不是浮层，是整屏），输入过程不上屏
   2. 一次只改一件事，不重填整张表
   3. 凡是靠猜的都要求确认一次（时间词、替换的人） */
(function (root) {
  "use strict";

  var S = root.Store;
  var DATA = root.RHYTHM_DATA || {};
  var R = root.Rhythm;

  var rootEl = null;
  var gateEl = null;
  var panelEl = null;
  var bodyEl = null;
  var tab = "today";
  var unlockedTill = 0;
  var challenge = null;
  var gateInput = "";
  var draft = { level: "normal", minutes: 10, text: "", pinned: false, timeAck: false };

  var SUBJECTS = [
    "语文", "数学", "英语", "科学", "音乐", "美术", "体育",
    "书法", "道德与法治", "劳动", "信息科技", "班队", "自习"
  ];

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------- 打开 / 关闭 ---------- */
  function open() {
    ensureDom();
    rootEl.classList.add("show");
    document.body.classList.add("editing");
    if (Date.now() < unlockedTill) showPanel();
    else showGate();
  }

  function close() {
    rootEl.classList.remove("show");
    document.body.classList.remove("editing");
    gateEl.style.display = "none";
    panelEl.style.display = "none";
    if (root.Screen) root.Screen.render();
  }

  function ensureDom() {
    if (rootEl) return;
    rootEl = h("div", "edit-root");
    rootEl.id = "editRoot";

    gateEl = h("div", "gate");
    gateEl.appendChild(h("div", "gate-brand", CFG.label("设置")));
    var box = h("div", "gate-box");
    box.appendChild(h("div", "gate-tip", "老师验证后进入"));
    var q = h("div", "gate-q");
    q.id = "gateQ";
    box.appendChild(q);
    var val = h("div", "gate-val");
    val.id = "gateVal";
    box.appendChild(val);
    var keys = h("div", "gate-keys");
    "123456789 0".split("").forEach(function (c) {
      if (c === " ") return;
      var b = h("button", "gk", c);
      b.addEventListener("click", function () { gateTap(c); });
      keys.appendChild(b);
    });
    var back = h("button", "gk wide", "退格");
    back.addEventListener("click", function () { gateInput = gateInput.slice(0, -1); paintGate(); });
    keys.appendChild(back);
    var ok = h("button", "gk wide primary", "进入");
    ok.addEventListener("click", submitGate);
    keys.appendChild(ok);
    box.appendChild(keys);
    var cancel = h("button", "gate-cancel", "返回大屏");
    cancel.addEventListener("click", close);
    box.appendChild(cancel);
    gateEl.appendChild(box);

    panelEl = h("div", "ep");
    var head = h("header", "ep-head");
    var ht = h("div", "ep-title");
    ht.id = "epTitle";
    head.appendChild(ht);
    head.appendChild(h("div", "ep-hint", "这一屏学生也看得见，别写会伤人的话"));
    var done = h("button", "ep-close", "完成");
    done.addEventListener("click", close);
    head.appendChild(done);
    panelEl.appendChild(head);

    var tabs = h("nav", "ep-tabs");
    [["today", "今天"], ["duty", "值日"], ["text", "文字"], ["phrase", "话术"]].forEach(function (t) {
      var b = h("button", null, t[1]);
      b.dataset.tab = t[0];
      b.addEventListener("click", function () { tab = t[0]; paintTabs(); renderBody(); });
      tabs.appendChild(b);
    });
    var undo = h("button", "ep-undo", "撤销上一步");
    undo.addEventListener("click", function () {
      if (S.undo(S.dayKey())) { renderBody(); flash("已撤销"); }
      else flash("没有可撤销的修改");
    });
    tabs.appendChild(undo);
    panelEl.appendChild(tabs);

    bodyEl = h("div", "ep-body");
    panelEl.appendChild(bodyEl);

    rootEl.appendChild(gateEl);
    rootEl.appendChild(panelEl);
    document.body.appendChild(rootEl);
  }

  /* ---------- 验证码 ---------- */
  function showGate() {
    challenge = S.makeChallenge();
    gateInput = "";
    panelEl.style.display = "none";
    gateEl.style.display = "flex";
    paintGate();
  }

  function paintGate() {
    var q = document.getElementById("gateQ");
    var v = document.getElementById("gateVal");
    if (q) q.textContent = challenge.text + " = ?";
    if (v) v.textContent = gateInput.replace(/./g, "•") || "　";
    var lock = S.lockState();
    var tip = gateEl.querySelector(".gate-tip");
    if (lock.until && Date.now() < lock.until) {
      tip.textContent = "连续答错，请 " + Math.ceil((lock.until - Date.now()) / 1000) + " 秒后再试";
      tip.classList.add("bad");
    } else {
      tip.textContent = "老师验证后进入";
      tip.classList.remove("bad");
    }
  }

  function gateTap(c) {
    if (gateInput.length >= 5) return;
    gateInput += c;
    paintGate();
  }

  function submitGate() {
    var lock = S.lockState();
    if (lock.until && Date.now() < lock.until) { paintGate(); return; }
    if (parseInt(gateInput, 10) === challenge.answer) {
      S.resetFail();
      unlockedTill = Date.now() + 5 * 60 * 1000;
      showPanel();
    } else {
      S.recordFail();
      gateInput = "";
      paintGate();
      var v = document.getElementById("gateVal");
      if (v) { v.classList.remove("shake"); void v.offsetWidth; v.classList.add("shake"); }
    }
  }

  /* ---------- 面板 ---------- */
  function showPanel() {
    gateEl.style.display = "none";
    panelEl.style.display = "flex";
    var t = document.getElementById("epTitle");
    if (t) {
      var d = new Date();
      var hh = d.getHours(), mm = d.getMinutes();
      t.textContent = CFG.klass() + " · " + (d.getMonth() + 1) + "月" + d.getDate() + "日　"
        + (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
    }
    paintTabs();
    renderBody();
  }

  function paintTabs() {
    Array.prototype.forEach.call(panelEl.querySelectorAll(".ep-tabs button[data-tab]"), function (b) {
      b.classList.toggle("on", b.dataset.tab === tab);
    });
  }

  function flash(msg) {
    var n = document.getElementById("epFlash");
    if (!n) {
      n = h("div", "ep-flash");
      n.id = "epFlash";
      panelEl.appendChild(n);
    }
    n.textContent = msg;
    n.classList.add("show");
    clearTimeout(flash.t);
    flash.t = setTimeout(function () { n.classList.remove("show"); }, 1800);
  }

  function renderBody() {
    bodyEl.innerHTML = "";
    var key = S.dayKey();
    var ov = S.getDayOverride(key) || {};

    if (tab === "today") renderToday(ov, key);
    if (tab === "duty") renderDuty(ov, key);
    if (tab === "text") renderText();
    if (tab === "phrase") renderPhrase();
  }

  /* ---------- Tab：今天 ---------- */
  function renderToday(ov, key) {
    var raw = DATA.days ? DATA.days[key] : null;
    /* 面板上要显示"改完之后长什么样"，所以套上覆盖再列 */
    var day = raw ? S.applyOverrides(raw, ov) : null;

    /* 1. 通知 */
    var sec1 = h("section", "ep-sec");
    sec1.appendChild(h("h3", null, "发一条通知"));
    if (!day) {
      sec1.appendChild(h("p", "ep-note", "今天的数据不在包里，先重新生成 data.js 再改。"));
    }

    var ta = document.createElement("textarea");
    ta.className = "ep-input";
    ta.id = "ntText";
    ta.placeholder = "写给学生的具体动作，比如：现在整理书包，到走廊排队";
    ta.value = draft.text;
    ta.addEventListener("input", function () { draft.text = ta.value; paintHintRow(); });
    sec1.appendChild(ta);

    var hintRow = h("div", "ep-hintrow");
    hintRow.id = "ntHint";
    sec1.appendChild(hintRow);

    /* 场景话术召回 */
    var recalls = S.recall("notice");
    if (recalls.length) {
      var ph = h("div", "ep-recall");
      ph.appendChild(h("span", "ep-recall-label", "用过的"));
      recalls.forEach(function (p) {
        var b = h("button", "ep-pill", p.text);
        b.title = p.pinned ? "已记住" : "最近用过";
        b.addEventListener("click", function () {
          draft.text = p.text;
          draft.timeAck = false;
          ta.value = p.text;
          paintHintRow();
          S.remember("notice", p.text, false);
        });
        ph.appendChild(b);
      });
      sec1.appendChild(ph);
    }

    var opt = h("div", "ep-opts");
    var lvNormal = h("button", "ep-opt" + (draft.level === "normal" ? " on" : ""), "普通提示");
    lvNormal.addEventListener("click", function () { draft.level = "normal"; renderBody(); });
    var lvUrgent = h("button", "ep-opt urgent" + (draft.level === "urgent" ? " on" : ""), "紧急 · 红框");
    lvUrgent.addEventListener("click", function () { draft.level = "urgent"; renderBody(); });
    opt.appendChild(lvNormal);
    opt.appendChild(lvUrgent);

    [10, 20, 30].forEach(function (m) {
      var b = h("button", "ep-opt" + (draft.minutes === m ? " on" : ""), m + " 分钟");
      b.addEventListener("click", function () { draft.minutes = m; renderBody(); });
      opt.appendChild(b);
    });
    sec1.appendChild(opt);

    var pinRow = h("label", "ep-check");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = draft.pinned;
    cb.addEventListener("change", function () { draft.pinned = cb.checked; });
    pinRow.appendChild(cb);
    pinRow.appendChild(document.createTextNode("记住这条，下次同类场景直接选"));
    sec1.appendChild(pinRow);

    var actRow = h("div", "ep-actrow");
    var save = h("button", "ep-primary", draft.level === "urgent" ? "立即上屏（红框）" : "发到大屏");
    save.addEventListener("click", function () { saveNotice(key); });
    actRow.appendChild(save);
    if (ov.notice && ov.notice.text) {
      var stop = h("button", "ep-ghost", "撤下当前通知");
      stop.addEventListener("click", function () {
        S.patchDayOverride(key, { notice: null });
        draft.text = ""; draft.timeAck = false;
        flash("通知已撤下");
        renderBody();
      });
      actRow.appendChild(stop);
    }
    sec1.appendChild(actRow);
    bodyEl.appendChild(sec1);

    /* 2. 改课 */
    if (day) {
      var sec2 = h("section", "ep-sec");
      sec2.appendChild(h("h3", null, "今天改哪一节"));
      var list = h("div", "ep-rows");
      (day.timeline || []).filter(function (b) { return b.type === "class"; }).forEach(function (b) {
        var changed = ov.lessons && ov.lessons[b.periodNo];
        var row = h("button", "ep-row" + (changed ? " changed" : ""));
        row.appendChild(h("span", "p", "第 " + b.periodNo + " 节"));
        row.appendChild(h("span", "s", b.subject || "—"));
        row.appendChild(h("span", "t", b.teacher || ""));
        row.appendChild(h("span", "x", changed ? "已改" : "改"));
        row.addEventListener("click", function () { openLessonEditor(b, key); });
        list.appendChild(row);
      });
      sec2.appendChild(list);
      bodyEl.appendChild(sec2);
    }

    /* 3. 午间 */
    if (day) {
      var noonBlock = (day.timeline || []).filter(function (b) { return b.type === "noon"; })[0];
      if (noonBlock) {
        var sec3 = h("section", "ep-sec");
        sec3.appendChild(h("h3", null, "今天的午间（" + noonBlock.start + "–" + noonBlock.end + "）"));
        var presets = [
          { title: "午间休息", tip: "闭眼休息，不说话" },
          { title: "大扫除", tip: "先打扫自己的座位，湿手不碰插座" },
          { title: "自主作业", tip: "安静写作业，有问题举手" }
        ];
        var seg = h("div", "ep-opts");
        presets.forEach(function (p) {
          var on = (ov.noon && ov.noon.title === p.title) || (!ov.noon && noonBlock.name === p.title);
          var b = h("button", "ep-opt" + (on ? " on" : ""), p.title);
          b.addEventListener("click", function () {
            S.patchDayOverride(key, { noon: { title: p.title, tip: p.tip } });
            flash("午间改为" + p.title);
            renderBody();
          });
          seg.appendChild(b);
        });
        sec3.appendChild(seg);
        bodyEl.appendChild(sec3);
      }
    }

    if (ov.updatedAt) {
      bodyEl.appendChild(h("p", "ep-stamp", "今天的改动：" + (ov.updatedAt || "").replace("T", " ").slice(0, 16)));
    }
  }

  function paintHintRow() {
    var box = document.getElementById("ntHint");
    if (!box) return;
    box.innerHTML = "";
    draft.timeAck = draft.timeAck || false;

    var words = S.findTimeWords(draft.text);
    if (!words.length) { draft.timeAck = true; return; }

    draft.timeAck = false;
    var warn = h("div", "ep-warn");
    warn.appendChild(h("span", null, "这条里有「" + words.join("、") + "」，放到别的日子就不对了。"));
    var ok = h("button", "ep-mini", "时间没问题");
    ok.addEventListener("click", function () {
      draft.timeAck = true;
      box.innerHTML = "";
      box.appendChild(h("span", "ep-oknote", "已确认时间"));
    });
    warn.appendChild(ok);
    box.appendChild(warn);
  }

  function saveNotice(key) {
    if (!draft.text.trim()) { flash("还没写内容"); return; }
    if (!draft.timeAck) { flash("先确认时间对不对"); paintHintRow(); return; }

    var now = new Date();
    var until = R.m2t(now.getHours() * 60 + now.getMinutes() + draft.minutes);
    S.patchDayOverride(key, {
      notice: {
        text: draft.text.trim(),
        level: draft.level,
        at: R.m2t(now.getHours() * 60 + now.getMinutes()),
        until: until,
        createdAt: Date.now()
      }
    });
    S.remember("notice", draft.text.trim(), draft.pinned);

    draft.text = "";
    draft.pinned = false;
    draft.timeAck = false;
    draft.level = "normal";
    draft.minutes = 10;
    close();
  }

  function openLessonEditor(b, key) {
    var wrap = h("div", "ep-dialog");
    wrap.appendChild(h("div", "ep-dialog-title", "第 " + b.periodNo + " 节"));

    var sub = document.createElement("input");
    sub.className = "ep-input";
    sub.value = b.subject || "";
    sub.placeholder = "科目";
    sub.setAttribute("list", "subjList");
    wrap.appendChild(sub);

    var dl = document.createElement("datalist");
    dl.id = "subjList";
    SUBJECTS.forEach(function (s) { var o = document.createElement("option"); o.value = s; dl.appendChild(o); });
    wrap.appendChild(dl);

    var tea = document.createElement("input");
    tea.className = "ep-input";
    tea.value = b.teacher || "";
    tea.placeholder = "任课老师（可留空）";
    wrap.appendChild(tea);

    var row = h("div", "ep-actrow");
    var save = h("button", "ep-primary", "保存");
    save.addEventListener("click", function () {
      var lessons = (S.getDayOverride(key) || {}).lessons || {};
      lessons[b.periodNo] = { subject: sub.value.trim(), teacher: tea.value.trim() };
      S.patchDayOverride(key, { lessons: lessons });
      wrap.remove();
      flash("第 " + b.periodNo + " 节已改");
      renderBody();
    });
    var cancel = h("button", "ep-ghost", "取消");
    cancel.addEventListener("click", function () { wrap.remove(); });
    row.appendChild(save);
    row.appendChild(cancel);
    wrap.appendChild(row);

    panelEl.appendChild(wrap);
    sub.focus();
  }

  /* ---------- Tab：文字 ---------- */
  /* 屏上的字分两类：
     一类是「什么时候说什么」，由节律算，不在这里改；
     一类是「说的是什么」，是老师的话，必须能改。这里改的是后者。
     没改过的沿用系统默认，所以以后默认文案更新，老师没动的地方会自动跟上。 */
  function splitWords(v) {
    return String(v || "").split(/[,，、;；\s]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function field(label, placeholder, value, onSave) {
    var row = h("label", "ep-field");
    row.appendChild(h("span", "ep-flabel", label));
    var inp = document.createElement("input");
    inp.className = "ep-input";
    inp.placeholder = placeholder || "";
    inp.value = value || "";
    inp.addEventListener("change", function () {
      onSave(inp.value);
      flash("已保存，大屏已经换了");
      if (root.Screen) root.Screen.render();
    });
    row.appendChild(inp);
    return row;
  }

  /* 一天里出现过的非上课时段，按第一次出现的顺序排 */
  function blockNames() {
    var seen = {}, out = [];
    var days = DATA.days || {};
    Object.keys(days).sort().forEach(function (k) {
      (days[k].timeline || []).forEach(function (b) {
        if (b.type === "class" || !b.name || seen[b.name]) return;
        seen[b.name] = 1;
        out.push({ name: b.name, tip: b.tip || "" });
      });
    });
    return out;
  }

  /* 到校前 / 放学后 / 休息日：不在作息表里，是每天的两头 */
  var STAGES = [
    { key: "before",  label: "到校（打铃前）", title: "早上好",   note: "到校后先交作业、整理书包" },
    { key: "closed",  label: "放学以后",       title: "放学了",   note: "整理好书包，路上注意安全" },
    { key: "holiday", label: "休息日",         title: "今天不上学", note: "好好休息，明天见" }
  ];

  /* 早读：到校后到第 1 节前。按星期排，因为"周一三五语文、周二四英语"
     是常态；空着就等于这天没安排，屏上不显示，不去猜。 */
  var WEEKDAYS = [
    { n: 1, label: "周一" }, { n: 2, label: "周二" }, { n: 3, label: "周三" },
    { n: 4, label: "周四" }, { n: 5, label: "周五" }
  ];

  function setReading(n, field, v) {
    var r = Object.assign({}, S.texts().reading);
    var cur = Object.assign({}, r[String(n)]);
    if (Array.isArray(v)) {
      if (v.length) cur[field] = v; else delete cur[field];
    } else if (v && v.trim()) {
      cur[field] = v.trim();
    } else {
      delete cur[field];
    }
    if (Object.keys(cur).length) r[String(n)] = cur;
    else delete r[String(n)];
    S.patchTexts({ reading: Object.keys(r).length ? r : null });
  }

  function readInput(ph, value, onSave) {
    var inp = document.createElement("input");
    inp.className = "ep-input";
    inp.placeholder = ph || "";
    inp.value = value || "";
    inp.addEventListener("change", function () {
      onSave(inp.value);
      flash("已保存，大屏已经换了");
      if (root.Screen) root.Screen.render();
    });
    return inp;
  }

  function setStage(key, field, v) {    var stage = Object.assign({}, S.texts().stage);
    var cur = Object.assign({}, stage[key]);
    if (v.trim()) cur[field] = v.trim();
    else delete cur[field];
    if (Object.keys(cur).length) stage[key] = cur;
    else delete stage[key];
    S.patchTexts({ stage: Object.keys(stage).length ? stage : null });
  }

  function renderText() {
    var T = S.texts();

    var sec0 = h("section", "ep-sec wide");
    sec0.appendChild(h("h3", null, "到校 · 放学 · 休息日"));
    sec0.appendChild(h("p", "ep-note",
      "这三个时刻不在作息表里，是每天的两头。留空就是原来的话。"));
    STAGES.forEach(function (st) {
      var cur = (T.stage || {})[st.key] || {};
      sec0.appendChild(field(st.label + " · 大字", st.title, cur.title || "",
        function (v) { setStage(st.key, "title", v); }));
      sec0.appendChild(field(st.label + " · 一句话", st.note, cur.note || "",
        function (v) { setStage(st.key, "note", v); }));
    });
    bodyEl.appendChild(sec0);

    var secR = h("section", "ep-sec wide");
    secR.appendChild(h("h3", null, "早读"));
    secR.appendChild(h("p", "ep-note",
      "到校后到第 1 节前这一段。按星期填，科目空着这天就不显示早读。"
      + "第二格是今天读什么，留空就只上一个大字。"));
    var rd = T.reading || {};

    var head = h("div", "ep-read head");
    head.appendChild(h("span", "ep-read-day", ""));
    head.appendChild(h("span", "ep-read-tag", "科目"));
    head.appendChild(h("span", "ep-read-tag", "早读建议（会显示在屏上）"));
    secR.appendChild(head);

    WEEKDAYS.forEach(function (w) {
      var cur = rd[String(w.n)] || {};
      var row = h("div", "ep-read");
      row.appendChild(h("span", "ep-read-day", w.label));
      row.appendChild(readInput("语文", cur.subject,
        function (v) { setReading(w.n, "subject", v); }));
      row.appendChild(readInput("今天读第 5 课，背《古诗三首》", cur.task,
        function (v) { setReading(w.n, "task", v); }));
      secR.appendChild(row);
    });
    bodyEl.appendChild(secR);

    var sec1 = h("section", "ep-sec wide");
    sec1.appendChild(h("h3", null, "课间这一屏"));
    sec1.appendChild(h("p", "ep-note",
      "大字是第一眼看到的，下面是两行：先做什么、带什么。"));
    sec1.appendChild(field("课间 · 大字", "课间", T.breakTitle,
      function (v) { S.patchTexts({ breakTitle: v.trim() || null }); }));
    sec1.appendChild(field("第一行（用逗号隔开）", "喝水，上厕所",
      T.breakActions ? T.breakActions.join("，") : "",
      function (v) { S.patchTexts({ breakActions: splitWords(v) }); }));
    sec1.appendChild(field("第二行开头", "准备好", T.prepLabel,
      function (v) { S.patchTexts({ prepLabel: v.trim() || null }); }));
    sec1.appendChild(field("还没到列清单时先写", "下节课的书", T.genericPrep,
      function (v) { S.patchTexts({ genericPrep: v.trim() || null }); }));
    bodyEl.appendChild(sec1);

    var sec2 = h("section", "ep-sec wide");
    sec2.appendChild(h("h3", null, "各时段的提示语"));
    sec2.appendChild(h("p", "ep-note", "留空就是原来的话，清空即恢复。"));
    blockNames().forEach(function (b) {
      sec2.appendChild(field(b.name, b.tip || "（这一时段没有提示语）",
        (T.tips || {})[b.name] || "",
        function (v) {
          var tips = Object.assign({}, S.texts().tips);
          if (v.trim()) tips[b.name] = v.trim();
          else delete tips[b.name];
          S.patchTexts({ tips: tips });
        }));
    });
    bodyEl.appendChild(sec2);

    var sec3 = h("section", "ep-sec wide");
    sec3.appendChild(h("h3", null, "每科要带什么"));
    sec3.appendChild(h("p", "ep-note", "用逗号隔开。改了之后，「准备好」那一行跟着变。"));
    (DATA.content || []).forEach(function (s) {
      var cur = (T.prep || {})[s.key];
      sec3.appendChild(field(s.key, (s.items || []).join("，"),
        cur ? cur.join("，") : "",
        function (v) {
          var prep = Object.assign({}, S.texts().prep);
          var list = splitWords(v);
          if (list.length) prep[s.key] = list;
          else delete prep[s.key];
          S.patchTexts({ prep: prep });
        }));
    });
    bodyEl.appendChild(sec3);

    var sec4 = h("section", "ep-sec wide");
    sec4.appendChild(h("p", "ep-note", "改动只存在这台机器上，不影响别人的班。"));
    var reset = h("button", "ep-ghost", "全部恢复系统默认");
    reset.addEventListener("click", function () {
      S.resetTexts();
      flash("已恢复默认文字");
      if (root.Screen) root.Screen.render();
      renderBody();
    });
    sec4.appendChild(reset);
    bodyEl.appendChild(sec4);

    renderBackup();
  }

  /* ---------- Tab：值日 ---------- */
  function renderDuty(ov, key) {
    var sec = h("section", "ep-sec");
    sec.appendChild(h("h3", null, "换人只改这一条"));
    sec.appendChild(h("p", "ep-note", "点一下岗位，从名单里选。改的是今天，不影响以后的排班。"));

    var roles = DATA.roles || [];
    var list = h("div", "ep-rows");
    roles.forEach(function (r) {
      var changed = ov.roles && ov.roles[r.id];
      var row = h("button", "ep-row" + (changed ? " changed" : ""));
      row.appendChild(h("span", "p", r.name));

      var who = "";
      if (changed) who = (ov.roles[r.id].people || []).join("、");
      else if (r.people) who = r.people.join("、");
      else if (r.peopleMap) who = Object.keys(r.peopleMap).sort().map(function (k) { return r.peopleMap[k]; }).join("、");
      else if (r.groups) who = "A/B 组";

      row.appendChild(h("span", "s", who || "未定"));
      row.appendChild(h("span", "x", changed ? "已换" : "换"));
      row.addEventListener("click", function () { openPicker(r, key); });
      list.appendChild(row);
    });
    sec.appendChild(list);
    bodyEl.appendChild(sec);
  }

  /* 换人时候选的排序依据：这个岗位原本是谁，就先出谁。
     岗位的人可能在 people、peopleMap、groups 三处，三处都要算进来。 */
  function relatedNames(role) {
    var out = (role.people || []).slice();
    if (role.peopleMap) Object.keys(role.peopleMap).forEach(function (k) { out.push(role.peopleMap[k]); });
    if (role.groups) Object.keys(role.groups).forEach(function (k) { out = out.concat(role.groups[k] || []); });
    return out.concat(role.substitute || []);
  }

  function openPicker(role, key) {
    var wrap = h("div", "ep-dialog picker");
    wrap.appendChild(h("div", "ep-dialog-title", "换人 · " + role.name));

    var q = document.createElement("input");
    q.className = "ep-input";
    q.placeholder = "打一个字就出人";
    wrap.appendChild(q);

    var grid = h("div", "ep-people");
    wrap.appendChild(grid);

    var selected = [];
    var related = relatedNames(role);

    function paint() {
      grid.innerHTML = "";
      var res = S.rankStudents(DATA.students || [], q.value, related, 24);
      if (!res.length) {
        grid.appendChild(h("p", "ep-note", "名单里没有这个人"));
        return;
      }
      res.forEach(function (s) {
        var b = h("button", "ep-person" + (selected.indexOf(s.name) >= 0 ? " on" : ""), s.name);
        b.addEventListener("click", function () {
          var i = selected.indexOf(s.name);
          if (i >= 0) selected.splice(i, 1);
          else { selected.push(s.name); S.markPicked(s.name); }
          paint();
        });
        grid.appendChild(b);
      });
    }

    q.addEventListener("input", paint);
    paint();

    var row = h("div", "ep-actrow");
    var save = h("button", "ep-primary", "就是 TA");
    save.addEventListener("click", function () {
      if (!selected.length) { flash("先选人"); return; }
      var roles = (S.getDayOverride(key) || {}).roles || {};
      roles[role.id] = { people: selected.slice() };
      S.patchDayOverride(key, { roles: roles });
      wrap.remove();
      flash(role.name + " 今天换给 " + selected.join("、"));
      renderBody();
    });
    var clear = h("button", "ep-ghost", "恢复原样");
    clear.addEventListener("click", function () {
      var roles = (S.getDayOverride(key) || {}).roles || {};
      delete roles[role.id];
      S.patchDayOverride(key, { roles: roles });
      wrap.remove();
      renderBody();
    });
    row.appendChild(save);
    row.appendChild(clear);
    wrap.appendChild(row);

    panelEl.appendChild(wrap);
    q.focus();
  }

  /* ---------- Tab：话术 ---------- */
  function renderPhrase() {
    var sec = h("section", "ep-sec");
    sec.appendChild(h("h3", null, "通知话术"));
    sec.appendChild(h("p", "ep-note", "勾了「记住」的排前面，系统自己留最近 5 条。"));

    var list = S.recall("notice");
    if (!list.length) {
      sec.appendChild(h("p", "ep-note", "还没有。在「今天」里发一条通知就会出现在这里。"));
    }
    var wrap = h("div", "ep-rows");
    list.forEach(function (p) {
      var row = h("div", "ep-row static");
      row.appendChild(h("span", "s", p.text));
      row.appendChild(h("span", "x", (p.pinned ? "记住 · " : "") + (p.useCount || 1) + " 次"));
      var del = h("button", "ep-mini danger", "删");
      del.addEventListener("click", function () {
        S.removePhrase(p.id);
        renderBody();
      });
      row.appendChild(del);
      wrap.appendChild(row);
    });
    sec.appendChild(wrap);
    bodyEl.appendChild(sec);

    renderBackup();
  }

  /* ---------- 备份 / 迁移 ---------- */
  /* 老师改的文字只在这台机器的浏览器里。想换机器、或者请人重新打包，
     得先把它导出来——不然对面拿到的永远是出厂文案。 */
  function renderBackup() {
    var sec = h("section", "ep-sec wide");
    sec.appendChild(h("h3", null, "带走这些修改"));
    sec.appendChild(h("p", "ep-note",
      "这里改的内容只存在这台机器上，重新打包、换一体机都会没有。"
      + "导出后把文件（或下面这段文字）发给我，就能烤进新包里。"));

    var text = JSON.stringify(S.exportAll(), null, 2);

    var row = h("div", "ep-backup");
    var out = h("button", "ep-mini", "导出设置");
    out.addEventListener("click", function () { doExport(text); });
    row.appendChild(out);

    var file = h("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.style.display = "none";
    file.addEventListener("change", function () { doImport(file); });
    var inp = h("button", "ep-mini", "导入设置");
    inp.addEventListener("click", function () { file.click(); });
    row.appendChild(inp);
    row.appendChild(file);

    var copy = h("button", "ep-mini", "复制这段文字");
    copy.addEventListener("click", function () {
      var ta = panelEl.querySelector(".ep-dump");
      if (!ta) return;
      ta.focus(); ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      flash(ok ? "已复制，粘贴发给老师就行" : "请手动全选复制");
    });
    row.appendChild(copy);
    sec.appendChild(row);

    var ta = h("textarea", "ep-dump");
    ta.rows = 5;
    ta.spellcheck = false;
    ta.readOnly = true;
    ta.value = text;
    sec.appendChild(ta);

    bodyEl.appendChild(sec);
  }

  function dumpName() {
    var d = new Date();
    return CFG.fileSlug() + "节律屏-设置-" + d.getFullYear()
      + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2) + ".json";
  }

  function doExport(text) {
    var ok = false;
    try {
      var blob = new Blob([text], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = dumpName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      ok = true;
    } catch (e) { ok = false; }
    flash(ok ? "已下载，下面是同一份内容" : "这台机器不让下载，请复制下面的文字");
  }

  function doImport(input) {
    var f = input.files && input.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () {
      var obj = null;
      try { obj = JSON.parse(String(fr.result)); } catch (e) { obj = null; }
      var r = S.importAll(obj);
      input.value = "";
      if (r.ok) { flash("已导入，马上刷新"); setTimeout(function () { location.reload(); }, 700); }
      else flash(r.why || "导入失败");
    };
    fr.readAsText(f, "utf-8");
  }

  root.Edit = { open: open, close: close };
})(window);
