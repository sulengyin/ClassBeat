/* P3 编辑面板。原则：
   1. 进编辑先盖住大屏（面板不是浮层，是整屏），输入过程不上屏
   2. 一次只改一件事，不重填整张表
   3. 凡是靠猜的都要求确认一次（时间词、替换的人） */
(function (root) {
  "use strict";

  var S = root.Store;
  var DATA = root.RHYTHM_DATA || {};
  var RT = root.Runtime;
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
    closePicker();
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
    /* 商是小数，键盘要能输入小数点；. 只有老师用得上，学生乱按也进不来 */
    "1234567890.".split("").forEach(function (c) {
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
    [["today", "今天"], ["duty", "值日"], ["hours", "作息"], ["text", "文字"], ["phrase", "话术"]].forEach(function (t) {
      var b = h("button", "ep-tab", t[1]);
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

    /* Esc 关掉换人卡片：卡片是浮层，键盘和触摸都要有退路 */
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" || e.key === "Esc") closePicker();
    });
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
    /* 输入什么就显示什么：老师要能看清自己点了几位、点的是哪个数字 */
    if (v) v.textContent = gateInput || "　";
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
    /* 小数点只能有一个，不然「0..3」这种永远答不对 */
    if (c === "." && gateInput.indexOf(".") >= 0) return;
    gateInput += c;
    paintGate();
  }

  function submitGate() {
    var lock = S.lockState();
    if (lock.until && Date.now() < lock.until) { paintGate(); return; }
    var got = parseFloat(gateInput);
    if (isFinite(got) && Math.abs(got - challenge.answer) < 1e-9) {
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
    Array.prototype.forEach.call(panelEl.querySelectorAll(".ep-tab"), function (b) {
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

  /* 换人卡片是浮层：同一时刻只留一张。开新卡、重绘、退出面板前都先收掉旧的，
     连点或点卡片后面的岗位时不会叠出第二张。 */
  function closePicker() {
    Array.prototype.forEach.call(document.querySelectorAll(".ep-dialog.picker"), function (n) { n.remove(); });
    Array.prototype.forEach.call(document.querySelectorAll(".ep-picker-mask"), function (n) { n.remove(); });
  }

  /* 重绘是整块 innerHTML 替换，滚动条会回到顶部。
     所以重绘前先记住两处滚动位置（整页 .ep-body 和岗位列表 .ep-rows），
     重绘后原样放回去；给了 anchor 岗位再把它滚进可视区。
     岗位被删掉时找不到行，就只还原滚动位置，不会跳到列表外。 */
  function renderBody(anchorRoleId) {
    closePicker();
    var prevBody = bodyEl.scrollTop;
    var oldRows = bodyEl.querySelector(".ep-rows");
    var prevRows = oldRows ? oldRows.scrollTop : 0;

    bodyEl.innerHTML = "";
    var key = S.dayKey();
    var ov = S.getDayOverride(key) || {};

    if (tab === "today") renderToday(ov, key);
    if (tab === "duty") renderDuty(ov, key);
    if (tab === "hours") renderHours();
    if (tab === "text") renderText();
    if (tab === "phrase") renderPhrase();

    var rows = bodyEl.querySelector(".ep-rows");
    if (rows) rows.scrollTop = prevRows;
    bodyEl.scrollTop = prevBody;

    if (anchorRoleId) {
      var target = null;
      Array.prototype.forEach.call(bodyEl.querySelectorAll(".ep-rowline"), function (l) {
        if (l.dataset && l.dataset.roleId === anchorRoleId) target = l;
      });
      if (target && target.scrollIntoView) target.scrollIntoView({ block: "nearest" });
    }
  }

  /* ---------- Tab：今天 ---------- */
  function renderToday(ov, key) {
    var raw = RT ? RT.day(key) : null;
    /* 面板上要显示"改完之后长什么样"，所以套上覆盖再列 */
    var day = raw ? S.applyOverrides(raw, ov) : null;

    /* 1. 通知 */
    var sec1 = h("section", "ep-sec");
    sec1.appendChild(h("h3", null, "发一条通知"));
    if (!day) {
      sec1.appendChild(h("p", "ep-note", "今天的课表算不出来，先看配置是不是缺了文件。"));
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

  /* 一天里出现过的非上课时段，按第一次出现的顺序排。
     现算的话不能遍历 35 天，算这一周就够——同一个班的时段名是按周重复的。 */
  function blockNames() {
    var seen = {}, out = [];
    if (!RT) return out;
    RT.weekKeys(S.dayKey()).forEach(function (k) {
      var d = RT.day(k);
      ((d && d.timeline) || []).forEach(function (b) {
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

  /* 提醒事项：单独一条，按天覆盖「每天」。留空 = 用每天那条。 */
  function setReminder(key, v) {
    var r = Object.assign({}, S.texts().reminders);
    v = (v || "").trim();
    if (v) r[key] = v; else delete r[key];
    S.patchTexts({ reminders: Object.keys(r).length ? r : null });
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
    /* 时间从作息里读，不写死：老师改了早读起止，这句话要跟着变 */
    var rb = ((RT && RT.config && RT.config().timetable) || {}).blocks || [];
    var rc = rb.filter(function (b) { return b.type === "reading"; })[0];
    secR.appendChild(h("p", "ep-note",
      "早读在「作息」里是一段真实时间"
      + (rc ? "（现在 " + rc.start + "–" + rc.end + "）" : "") + "。"
      + "按星期填科目和读什么，科目空着这天就只显示「早读」，不猜。"
      + "科目填了，屏上标题就是「英语学习建议」，建议本身接在下一行、同字号。"
      + "早读一下课就自动切到第一节课的准备清单。"));
    var rd = T.reading || {};

    var head = h("div", "ep-read head");
    head.appendChild(h("span", "ep-read-day", ""));
    head.appendChild(h("span", "ep-read-tag", "科目"));
    head.appendChild(h("span", "ep-read-tag", "学习建议（会显示在屏上）"));
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

    /* 提醒事项：黄色贴纸，单独一块。每天一条，某天要换就单独填。 */
    var secM = h("section", "ep-sec wide");
    secM.appendChild(h("h3", null, "早读 · 提醒事项"));
    secM.appendChild(h("p", "ep-note",
      "这块会用黄色贴纸单独显示，比早读建议更醒目，适合放今天必须记住的事"
      + "（带回执、穿校服、带水杯）。留空的星期就用「每天」这一条。"));
    var rems = T.reminders || {};

    var mhead = h("div", "ep-read ep-rem head");
    mhead.appendChild(h("span", "ep-read-day", ""));
    mhead.appendChild(h("span", "ep-read-tag", "提醒文字（留空 = 不显示）"));
    secM.appendChild(mhead);

    var mrows = [{ key: "default", label: "每天", ph: "带齐今天要用的书和作业，课前摆好。" }]
      .concat(WEEKDAYS.map(function (w) {
        return { key: String(w.n), label: w.label, ph: rems["default"] || "" };
      }));

    mrows.forEach(function (m) {
      var row = h("div", "ep-read ep-rem");
      row.appendChild(h("span", "ep-read-day", m.label));
      row.appendChild(readInput(m.ph, rems[m.key] || "",
        function (v) { setReminder(m.key, v); }));
      secM.appendChild(row);
    });
    bodyEl.appendChild(secM);

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

  /* ---------- Tab：作息 ---------- */
  /* 只改时间，不增删正课段：正课段的数量跟课表 entries 的 periodNo 绑着，
     在这里加一节，课表就少一节的内容，屏上会直接空掉。
     所以正课 / 午餐 / 午间三类的行不给删；要加减节次得先改课表。 */
  var TT_TYPES = [
    { key: "class",  label: "正课", locked: true },
    { key: "break",  label: "课间" },
    { key: "reading",label: "早读" },
    { key: "ritual", label: "集会 / 眼操" },
    { key: "meal",   label: "午餐", locked: true },
    { key: "noon",   label: "午间", locked: true },
    { key: "action", label: "活动" },
    { key: "after",  label: "课后服务" }
  ];

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function toMin(t) { var p = String(t).split(":"); return (+p[0]) * 60 + (+p[1]); }
  function toTime(m) { return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60); }

  function timetableNow() {
    var c = RT ? RT.config() : {};
    return c.timetable ? JSON.parse(JSON.stringify(c.timetable)) : null;
  }

  /* 首尾相接才算一张完整的作息表：中间留空，屏上那段时间就没有状态。 */
  function hoursProblem(blocks) {
    for (var i = 0; i < blocks.length; i += 1) {
      var b = blocks[i];
      if (!b.start || !b.end) return "第 " + (i + 1) + " 段还没填时间";
      if (toMin(b.start) >= toMin(b.end)) return "第 " + (i + 1) + " 段：开始时间要早于结束时间";
      if (i && blocks[i - 1].end !== b.start) {
        return "第 " + i + " 段和第 " + (i + 1) + " 段之间有断档或重叠";
      }
    }
    return "";
  }

  function saveHours(blocks) {
    var tt = timetableNow();
    if (!tt) return;
    tt.blocks = blocks;
    /* noonBand 是午餐 / 午间的三个分界点，改块时间就得一起改，
       否则「午餐压缩 + 午间动作」会算到旧时间上。 */
    var band = Object.assign({}, tt.noonBand || {});
    blocks.forEach(function (b) {
      if (b.type === "meal") band.lunchEnd = b.end;
      if (b.type === "noon") { band.bell = b.start; band.noonEnd = b.end; }
    });
    tt.noonBand = band;
    S.patchConfig({ timetable: tt });
  }

  /* 某一行后面插一段，后面所有段整体后移，保持首尾相接 */
  function insertAfter(blocks, idx, dur) {
    var next = blocks.slice();
    var at = toMin(blocks[idx].end);
    for (var i = idx + 1; i < next.length; i += 1) {
      next[i] = Object.assign({}, next[i], {
        start: toTime(toMin(next[i].start) + dur),
        end: toTime(toMin(next[i].end) + dur)
      });
    }
    next.splice(idx + 1, 0, {
      seq: nextSeq(blocks), start: toTime(at), end: toTime(at + dur),
      type: "break", name: "课间"
    });
    return next;
  }

  /* 删一段，后面整体前移，不留空档 */
  function removeAt(blocks, idx) {
    var dur = toMin(blocks[idx].end) - toMin(blocks[idx].start);
    var next = [];
    blocks.forEach(function (b, i) {
      if (i === idx) return;
      if (i < idx) next.push(b);
      else next.push(Object.assign({}, b, {
        start: toTime(toMin(b.start) - dur),
        end: toTime(toMin(b.end) - dur)
      }));
    });
    return next;
  }

  function nextSeq(blocks) {
    var max = 0;
    blocks.forEach(function (b) {
      var n = parseInt(b.seq, 10);
      if (!isNaN(n) && n > max) max = n;
    });
    max += 1;
    return max === 9 ? 10 : max;   /* 9 留给午餐，旧表里的习惯 */
  }

  function renderHours() {
    var tt = timetableNow();
    var sec = h("section", "ep-sec wide");
    sec.appendChild(h("h3", null, "一天的作息"));
    sec.appendChild(h("p", "ep-note",
      "改完立刻生效，不用重新打包。相邻两段必须首尾相接——中间留空，屏上那段时间就没有状态。"));

    if (!tt) {
      sec.appendChild(h("p", "ep-note", "没有读到作息表。"));
      bodyEl.appendChild(sec);
      return;
    }

    var blocks = tt.blocks || [];
    var rows = h("div", "ep-rows tt-rows");

    blocks.forEach(function (b, idx) {
      var row = h("div", "tt-row");
      var st = document.createElement("input");
      st.type = "time"; st.className = "tt-time"; st.value = b.start || "";
      var en = document.createElement("input");
      en.type = "time"; en.className = "tt-time"; en.value = b.end || "";

      var meta = TT_TYPES.filter(function (t) { return t.key === b.type; })[0];
      var name = document.createElement("input");
      name.type = "text"; name.className = "tt-name";
      name.value = b.name || (meta ? meta.label : "");
      name.placeholder = "名称";

      row.appendChild(st);
      row.appendChild(h("span", "tt-dash", "—"));
      row.appendChild(en);

      /* 正课 / 午餐 / 午间跟课表绑着，类型不能动；
         其余段落让老师自己选，作息里多一段早读就能直接改出来。 */
      var curType = b.type;
      var curLabel = meta ? meta.label : "";
      if (meta && meta.locked) {
        row.appendChild(h("span", "tt-tag", meta.label));
      } else {
        var sel = document.createElement("select");
        sel.className = "tt-type";
        TT_TYPES.filter(function (t) { return !t.locked; }).forEach(function (t) {
          var o = document.createElement("option");
          o.value = t.key;
          o.textContent = t.label;
          sel.appendChild(o);
        });
        sel.value = TT_TYPES.some(function (t) { return !t.locked && t.key === b.type; })
          ? b.type : "break";
        curType = sel.value;
        sel.addEventListener("change", function () {
          var pick = TT_TYPES.filter(function (t) { return t.key === sel.value; })[0];
          var newLabel = pick ? pick.label : "";
          /* 原来那行叫「课间」，改成早读后名称也跟着改，别留下「课间」当早读标题 */
          if (!name.value.trim() || name.value.trim() === curLabel) name.value = newLabel;
          curLabel = newLabel;
          curType = sel.value;
          commit();
        });
        row.appendChild(sel);
      }
      row.appendChild(name);

      /* 只改时间时不重绘整块，否则输入框会失焦 */
      function commit() {
        row.classList.remove("bad");
        var next = blocks.map(function (x, i) {
          if (i !== idx) return x;
          return Object.assign({}, x, {
            start: st.value, end: en.value, name: name.value.trim() || x.name,
            type: curType
          });
        });
        var bad = hoursProblem(next);
        if (bad) { row.classList.add("bad"); flash(bad); return; }
        blocks = next;
        saveHours(blocks);
        flash("已保存，大屏已经换了");
      }
      st.addEventListener("change", commit);
      en.addEventListener("change", commit);
      name.addEventListener("change", commit);

      var ins = h("button", "tt-mini", "＋");
      ins.title = "在后面插一段 10 分钟的课间";
      ins.addEventListener("click", function () {
        var next = insertAfter(blocks, idx, 10);
        var bad = hoursProblem(next);
        if (bad) { flash(bad); return; }
        saveHours(next);
        flash("插了一段课间，后面整体后移 10 分钟");
        renderBody();
      });
      row.appendChild(ins);

      var del = h("button", "tt-mini", "删");
      if (meta && meta.locked) {
        del.disabled = true;
        del.title = "这一段跟课表绑着，不能删";
        del.classList.add("off");
      } else {
        del.addEventListener("click", function () {
          if (blocks.length <= 2) { flash("至少留两段"); return; }
          var next = removeAt(blocks, idx);
          var bad = hoursProblem(next);
          if (bad) { flash(bad); return; }
          saveHours(next);
          flash("已删掉这一段，后面整体前移");
          renderBody();
        });
      }
      row.appendChild(del);
      rows.appendChild(row);
    });

    sec.appendChild(rows);

    var actions = h("div", "tt-actions");
    var reset = h("button", "ep-ghost", "恢复出厂作息");
    reset.addEventListener("click", function () {
      S.patchConfig({ timetable: null });
      flash("已恢复出厂作息");
      renderBody();
    });
    actions.appendChild(reset);
    sec.appendChild(actions);

    var classCount = blocks.filter(function (b) { return b.type === "class"; }).length;
    sec.appendChild(h("p", "tt-sum",
      "共 " + blocks.length + " 段，其中 " + classCount + " 节正课。正课段的数量跟课表绑着，要加减节次得先改课表。"));
    sec.appendChild(h("p", "ep-note", "改完点右上角「完成」回大屏。"));

    bodyEl.appendChild(sec);
  }

  /* ---------- Tab：值日 ---------- */
  /* 岗位与顺序都以「本机生效配置」为准：向导导入过的班，岗位可能和出厂包不同。 */
  function roleDoc() {
    var cfg = (RT && RT.config) ? RT.config() : null;
    if (cfg && cfg.roles && cfg.roles.roles) return cfg.roles;
    return DATA.roles || { roles: [] };
  }

  function renderDuty(ov, key) {
    var sec = h("section", "ep-sec");
    sec.appendChild(h("h3", null, "换人只改这一条"));
    sec.appendChild(h("p", "ep-note", "点一下岗位，从名单里选。改的是今天，不影响以后的排班。"));
    sec.appendChild(h("p", "ep-note", "▲▼ 调的是同一时刻谁先做，大屏值日条跟着变。"));

    var doc = roleDoc();
    var roles = (doc.roles || []).slice().sort(function (a, b) {
      return (typeof a.order === "number" ? a.order : 0) - (typeof b.order === "number" ? b.order : 0);
    });
    var list = h("div", "ep-rows");
    roles.forEach(function (r, i) {
      var changed = ov.roles && ov.roles[r.id];
      var line = h("div", "ep-rowline");
      line.dataset.roleId = r.id;
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
      line.appendChild(row);

      var up = h("button", "ep-move", "▲");
      up.title = "往前挪";
      up.disabled = i === 0;
      up.addEventListener("click", function () { moveRole(doc, r, -1); });
      var down = h("button", "ep-move", "▼");
      down.title = "往后挪";
      down.disabled = i === roles.length - 1;
      down.addEventListener("click", function () { moveRole(doc, r, 1); });
      line.appendChild(up);
      line.appendChild(down);
      list.appendChild(line);
    });
    sec.appendChild(list);
    bodyEl.appendChild(sec);
  }

  function moveRole(doc, role, delta) {
    var res = S.reorderRoles(doc.roles || [], role.id, delta);
    if (!res.changed) { flash(delta < 0 ? "已经排在最前" : "已经排在最后"); return; }
    var next = {};
    Object.keys(doc).forEach(function (k) { next[k] = doc[k]; });
    next.roles = res.roles;
    S.patchConfig({ roles: next });
    flash("「" + role.name + "」" + (delta < 0 ? "往前挪了一位" : "往后挪了一位"));
    renderBody(role.id);
  }

  /* 换人时候选的排序依据：这个岗位原本是谁，就先出谁。
     岗位的人可能在 people、peopleMap、groups 三处，三处都要算进来。 */
  function relatedNames(role) {
    var out = (role.people || []).slice();
    if (role.peopleMap) Object.keys(role.peopleMap).forEach(function (k) { out.push(role.peopleMap[k]); });
    if (role.groups) Object.keys(role.groups).forEach(function (k) { out = out.concat(role.groups[k] || []); });
    return out.concat(role.substitute || []);
  }

  /* ---------- 人群组：点组带出（PLAN 2.18） ---------- */
  /* 名单以本机配置为准（向导可能补过），没有再回退到包里的。 */
  function rosterStudents() {
    var cfg = S.config ? S.config() : null;
    var d = cfg && cfg.students ? cfg.students : DATA.students;
    if (d && Array.isArray(d.students)) return d.students;
    return Array.isArray(d) ? d : [];
  }

  function rosterNameIndex(roster) {
    var byId = {};
    roster.forEach(function (s) {
      if (!s || !s.name || s.active === false) return;
      if (s.id) byId[s.id] = s.name;
      byId["name:" + s.name] = s.name;
    });
    return byId;
  }

  /* 排班组按 role.grp 实时取人：当天值日条已解析的优先，
     再加上岗位本身的人（含今天的临时换人），不存成员快照；
     点名组从 memberIds 取。两边都只认名单里还在用的人。 */
  function groupDefs(role, key) {
    var out = [];
    var day = RT && RT.day ? RT.day(key) : null;
    var roster = rosterStudents();
    var keep = {};
    roster.forEach(function (s) {
      if (s && s.name && s.active !== false) keep[s.name] = 1;
    });

    if (role && role.grp) {
      var names = [];
      function add(n) {
        if (n && keep[n] && names.indexOf(n) < 0) names.push(n);
      }
      if (day) {
        (S.applyOverrides(day, S.getDayOverride(key)).duties || []).forEach(function (d) {
          if (d.grp !== role.grp) return;
          (d.people || []).forEach(add);
        });
      }
      var ov = (S.getDayOverride(key) || {}).roles || {};
      (roleDoc().roles || []).forEach(function (r) {
        if (r.grp !== role.grp) return;
        var people = (ov[r.id] && ov[r.id].people) ? ov[r.id].people : [];
        if (!people.length && r.people) people = r.people;
        if (!people.length && r.peopleMap) {
          people = Object.keys(r.peopleMap).sort().map(function (k) { return r.peopleMap[k]; });
        }
        people.forEach(add);
      });
      if (names.length) {
        out.push({ id: "role:" + role.grp, name: role.grp, source: "role", names: names });
      }
    }
    var byId = rosterNameIndex(roster);
    (S.peopleGroups ? S.peopleGroups() : []).forEach(function (g) {
      var names = [];
      (g.memberIds || []).forEach(function (id) {
        var n = byId[id];
        if (n && names.indexOf(n) < 0) names.push(n);
      });
      if (names.length) out.push({ id: g.id, name: g.name, source: "manual", names: names });
    });
    return out;
  }

  /* 一个岗位通常就一个人：点谁就是谁，点完直接落库、关窗。
     只有「一班多人」的岗位（路队长、补给站、按组轮换的值日组等）才需要多选，
     这时才保留「确定」按钮。 */
  function roleIsMulti(role) {
    if (!role) return false;
    if (role.grp || role.groups) return true;
    if ((role.people || []).length > 1) return true;
    if (role.peopleMap && Object.keys(role.peopleMap).length > 1) return true;
    return false;
  }

  function openPicker(role, key) {
    /* 先收掉可能残留的旧卡：同一时刻只留一张 */
    closePicker();

    var wrap = h("div", "ep-dialog picker");
    var head = h("div", "ep-dialog-head");
    head.appendChild(h("div", "ep-dialog-title", "换人 · " + role.name));
    var shut = h("button", "ep-dialog-close", "关闭");
    shut.title = "关闭，这次的选择不保存";
    shut.addEventListener("click", function () { closePicker(); });
    head.appendChild(shut);
    wrap.appendChild(head);

    /* 遮罩挡住卡片后面的岗位：触摸时误点不会又开一张卡 */
    var mask = h("div", "ep-picker-mask");
    mask.addEventListener("click", function () { closePicker(); });

    var multi = roleIsMulti(role);
    var groupBox = null;
    if (multi) {
      groupBox = h("div", "ep-groups");
      wrap.appendChild(groupBox);
    }

    var q = document.createElement("input");
    q.className = "ep-input";
    q.placeholder = "打一个字就出人";
    wrap.appendChild(q);

    var grid = h("div", "ep-people");
    wrap.appendChild(grid);

    var selected = [];
    var saveBtn = null;
    var related = relatedNames(role);
    var activeGroup = null;   /* 从已存组带出时记住它，「保存修改」写回原组 */
    var nameInput = null;
    var groupHint = null;
    var modifyBtn = null;

    /* 选定即写入：同一天同一岗位只写这一处，关掉弹窗就是确认。 */
    function commit(names) {
      var roles = (S.getDayOverride(key) || {}).roles || {};
      roles[role.id] = { people: names.slice() };
      S.patchDayOverride(key, { roles: roles });
      wrap.remove();
      flash(role.name + " 今天换给 " + names.join("、"));
      renderBody(role.id);
    }

    /* 勾选的人名 → 名单 id；没有 id 的名单用 name: 兜底，组仍然存得住。 */
    function pickedIds() {
      var roster = rosterStudents();
      var ids = [];
      selected.forEach(function (n) {
        var hit = roster.filter(function (s) {
          return s && s.name === n && s.active !== false;
        })[0];
        if (!hit) return;
        var id = hit.id ? String(hit.id) : "name:" + hit.name;
        if (ids.indexOf(id) < 0) ids.push(id);
      });
      return ids;
    }

    /* 说清楚这次是「改已有的组」还是「另存一个新组」 */
    function paintGroupHint() {
      if (!groupHint) return;
      groupHint.textContent = activeGroup
        ? "正在改「" + activeGroup.name + "」：增减人员后点「保存修改」写回这一组；想保留原组就改名点「另存为新组」。"
        : "临时勾选不会写进配置。起个名字点「另存为新组」，或先点上面的组带出再改。";
      if (modifyBtn) modifyBtn.style.display = activeGroup ? "" : "none";
    }

    function paintGroupChips() {
      if (!groupBox) return;
      groupBox.innerHTML = "";
      var defs = groupDefs(role, key);
      if (!defs.length) return;
      groupBox.appendChild(h("span", "ep-groups-label", "点组带出"));
      defs.forEach(function (g) {
        var box = h("span", "ep-group");
        var b = h("button", "ep-group-chip", g.name);
        b.title = "点一下把这组 " + g.names.length + " 人全选上：" + g.names.join("、");
        b.addEventListener("click", function () {
          selected = g.names.slice();
          g.names.forEach(function (n) { S.markPicked(n); });
          activeGroup = (g.source === "manual") ? g : null;
          if (activeGroup && nameInput) nameInput.value = activeGroup.name;
          paintGroupHint();
          paint();
        });
        box.appendChild(b);
        if (g.source === "manual") {
          var x = h("button", "ep-group-del", "×");
          x.title = "删除这个组";
          x.addEventListener("click", function () {
            S.deleteGroup(g.id);
            if (activeGroup && activeGroup.id === g.id) activeGroup = null;
            paintGroupChips();
            paintGroupHint();
            flash("已删除「" + g.name + "」");
          });
          box.appendChild(x);
        }
        groupBox.appendChild(box);
      });
    }

    function paint() {
      grid.innerHTML = "";
      var res = S.rankStudents(rosterStudents(), q.value, related, 24);
      if (!res.length) {
        grid.appendChild(h("p", "ep-note", "名单里没有这个人"));
        return;
      }
      res.forEach(function (s) {
        var b = h("button", "ep-person" + (selected.indexOf(s.name) >= 0 ? " on" : ""), s.name);
        b.addEventListener("click", function () {
          S.markPicked(s.name);
          if (!multi) { commit([s.name]); return; }
          var i = selected.indexOf(s.name);
          if (i >= 0) selected.splice(i, 1);
          else selected.push(s.name);
          paint();
        });
        grid.appendChild(b);
      });
      if (saveBtn) {
        saveBtn.textContent = selected.length ? "确定 · 已选 " + selected.length + " 人" : "确定";
      }
    }

    q.addEventListener("input", paint);
    paintGroupChips();
    paint();

    /* 临时勾选只留在弹窗里；只有点「保存修改 / 另存为新组」才写配置。 */
    if (multi) {
      groupHint = h("p", "ep-note", "");
      wrap.appendChild(groupHint);

      var saveRow = h("div", "ep-group-save");
      nameInput = document.createElement("input");
      nameInput.className = "ep-input ep-group-name";
      nameInput.placeholder = "给这组起个名字，下次一点就带出";
      saveRow.appendChild(nameInput);

      /* 已存组：在原 id 上更新成员和名字，不新增一条。 */
      modifyBtn = h("button", "ep-mini ep-group-modify", "保存修改");
      modifyBtn.addEventListener("click", function () {
        if (!activeGroup) { flash("先点一个已存的组"); return; }
        var ids = pickedIds();
        if (!ids.length) { flash("先选人"); return; }
        var name = (nameInput.value || "").trim() || activeGroup.name;
        var r = S.saveGroup({
          id: activeGroup.id,
          name: name,
          memberIds: ids,
          order: activeGroup.order
        });
        if (!r.ok) { flash(r.why); return; }
        activeGroup = null;
        paintGroupChips();
        paintGroupHint();
        flash("已更新「" + name + "」，共 " + ids.length + " 人");
      });
      saveRow.appendChild(modifyBtn);

      /* 永远从空白名字框新建，避免误以为在改旧组。 */
      var saveGroupBtn = h("button", "ep-mini ep-group-save-btn", "另存为新组");
      saveGroupBtn.addEventListener("click", function () {
        if (!selected.length) { flash("先选人"); return; }
        var name = (nameInput.value || "").trim();
        if (!name) { flash("先给这组起个名字"); return; }
        if (S.peopleGroups().some(function (g) { return g.name === name; })) {
          flash("已有同名组「" + name + "」，要改它请用「保存修改」");
          return;
        }
        var ids = pickedIds();
        if (!ids.length) { flash("名单里找不到这些人"); return; }
        var r = S.saveGroup({
          id: "g" + Date.now(),
          name: name,
          memberIds: ids,
          order: S.peopleGroups().length
        });
        if (!r.ok) { flash(r.why); return; }
        nameInput.value = "";
        activeGroup = null;
        paintGroupChips();
        paintGroupHint();
        flash("已存成新组「" + name + "」");
      });
      saveRow.appendChild(saveGroupBtn);
      wrap.appendChild(saveRow);
      paintGroupHint();
    }

    var row = h("div", "ep-actrow");
    if (multi) {
      saveBtn = h("button", "ep-primary", "确定");
      saveBtn.addEventListener("click", function () {
        if (!selected.length) { flash("先选人"); return; }
        commit(selected);
      });
      row.appendChild(saveBtn);
    }
    var clear = h("button", "ep-ghost", "恢复原样");
    clear.addEventListener("click", function () {
      var roles = (S.getDayOverride(key) || {}).roles || {};
      delete roles[role.id];
      S.patchDayOverride(key, { roles: roles });
      wrap.remove();
      renderBody(role.id);
    });
    row.appendChild(clear);
    wrap.appendChild(row);

    panelEl.appendChild(mask);
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
