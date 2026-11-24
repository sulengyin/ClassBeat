/* P3 编辑面板。原则：
   1. 进编辑先盖住大屏（面板不是浮层，是整屏），输入过程不上屏
   2. 一次只改一件事，不重填整张表
   3. 凡是靠猜的都要求确认一次（时间词、替换的人） */
(function (root) {
  "use strict";

  var S = root.Store;
  var SCH = root.Schedule;
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

  /* 科目词典在 app/subjects.js：向导识别课表、这里选课务、准备清单挂物品
     用的是同一份，三处不再各记一套名字。 */
  var Sub = root.Subjects || { list: function () { return []; }, key: function (s) { return String(s || ""); } };
  function subjectChoices() { return Sub.list(); }

  /* 老师名上屏/进输入框前一律过这里。课表里的 teacher 可能是对象，
     而 `textContent = 对象` 会得到 "[object Object]"、`input.value = 对象`
     也一样——然后老师一按保存，它就被腌成合法数据。
     [object Object] 是没有信息量的残留，宁可不显示。 */
  function teacherText(v) {
    var t = S.personNameOf ? S.personNameOf(v) : (typeof v === "string" ? v : "");
    return t === "[object Object]" ? "" : t;
  }

  /* 科目 → 任课老师：从整张课表聚合（真机反馈 2026-11-20：五年级学生
     打字找字麻烦，改课时不要手输老师名字）。同一科由两位老师执教
     （如心理/班队）就并列「张老师/李老师」，改课时自动带出。 */
  function subjectTeachers() {
    var map = {};
    if (RT && RT.config) {
      ((RT.config().schedule || {}).entries || []).forEach(function (e) {
        if (!e.subject) return;
        /* 课表里的 teacher 可能是对象（别人做的设置文件、手工改过的
           班级数据）。以前这里直接 .trim()，对象没有 trim，一进门就抛
           TypeError——整个「改课务」面板打不开，下拉和老师都带不出来。 */
        var t = teacherText(e.teacher);
        var list = map[e.subject] || (map[e.subject] = []);
        if (t && list.indexOf(t) < 0) list.push(t);
      });
    }
    return map;
  }

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* 一个「?」：点一下在下面展开一句解释，再点收起。
     触摸屏没有 hover，所以不能用 title 悬停提示——一体机上根本看不到。
     用法约定：界面本身（按钮文字、状态、图标）能说清的就别写句子；
     说不清的那部分收进这里。说明越长，老师越会跳过，然后照样做错。 */
  function helpNote(text) {
    var wrap = h("span", "ep-helpw");
    var b = h("button", "ep-help", "?");
    b.type = "button";
    b.setAttribute("aria-label", "看说明");
    var tip = h("span", "ep-helptip", text);
    b.addEventListener("click", function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      wrap.classList.toggle("open");
    });
    wrap.appendChild(b);
    wrap.appendChild(tip);
    return wrap;
  }

  /* ---------- 打开 / 关闭 ---------- */
  function open() {
    ensureDom();
    rootEl.classList.add("show");
    document.body.classList.add("editing");
    hoursUnlocked = false;   /* 每次进来默认锁定：正课/眼操/课间的时间要特意解锁才能改 */
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
        row.appendChild(h("span", "t", teacherText(b.teacher)));
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
    var day = (RT && RT.day) ? RT.day(key) : null;
    var weekday = day && day.weekday;
    var wrap = h("div", "ep-dialog");
    wrap.appendChild(h("div", "ep-dialog-title",
      "第 " + b.periodNo + " 节" + (weekday ? " · 周" + "一二三四五六日".charAt(weekday - 1) : "")));

    var bind = subjectTeachers();

    /* 学科下拉：课表里真实出现过的科目排前面（它们才带着任课老师），
       同义的写法只留一个（课表用的那个），常用科目兜底补齐。 */
    var opts = [], seen = {};
    function putSubject(s) {
      var k = Sub.key(s);
      if (!k || seen[k]) return;
      seen[k] = 1;
      opts.push(String(s).trim());
    }
    Object.keys(bind).forEach(putSubject);
    if (b.subject) putSubject(b.subject);
    subjectChoices().forEach(putSubject);

    var sub = document.createElement("select");
    sub.className = "ep-input ep-select";
    opts.forEach(function (s) {
      var o = document.createElement("option");
      o.value = s;
      o.textContent = s;
      sub.appendChild(o);
    });
    /* 当前科目按「同一科」找对应项：今天是「道德与法治」而课表写「道法」，
       就选中「道法」，否则一打开就没老师。 */
    var curKey = Sub.key(b.subject);
    var curPick = opts.filter(function (s) { return Sub.key(s) === curKey; })[0];
    sub.value = curPick || opts[0] || "";
    wrap.appendChild(sub);

    /* 这一科在课表里由谁上。同一科多位老师（心理/班队）就并列成可点的按钮，
       点一下填进输入框；填空仍然可编辑，代课直接改字。 */
    function teachersOf(subject) {
      var k = Sub.key(subject);
      var list = [];
      Object.keys(bind).forEach(function (s) {
        if (Sub.key(s) !== k) return;
        (bind[s] || []).forEach(function (t) {
          if (t && list.indexOf(t) < 0) list.push(t);
        });
      });
      return list;
    }

    var tea = document.createElement("input");
    tea.className = "ep-input ep-tea";
    tea.placeholder = "任课老师（可留空）";
    tea.title = "老师和科目按课表自动对应；代课等特殊情况可以直接改这几个字";
    wrap.appendChild(tea);

    var teaPick = h("div", "ep-teachers");
    wrap.appendChild(teaPick);

    function paintTeachers(keepTyped) {
      var list = teachersOf(sub.value);
      teaPick.innerHTML = "";
      if (!list.length) {
        teaPick.appendChild(h("span", "ep-teachers-tip", "课表里还没有这一科的老师，直接手填就行"));
        if (!keepTyped) tea.value = "";
        return;
      }
      teaPick.appendChild(h("span", "ep-teachers-tip", "点一下填上："));
      list.forEach(function (t) {
        var btn = h("button", "ep-teacher-chip", t);
        btn.type = "button";
        btn.addEventListener("click", function () {
          tea.value = t;
        });
        teaPick.appendChild(btn);
      });
      if (!keepTyped) tea.value = list.join("/");
    }

    /* 打开时优先用今天课表上实际的人（可能已被代课改过），
       没有才用课表聚合出来的默认值。
       赋进输入框之前必须归一到人名字符串：以前直接把对象赋上去，
       输入框里就显示 "[object Object]"，老师一点「只改今天」，
       这四个字就从显示故障变成了落库的合法值，从此再也洗不掉。 */
    paintTeachers(true);
    var curTeacher = S.personNameOf ? S.personNameOf(b.teacher) : (b.teacher || "");
    if (curTeacher && curTeacher !== "[object Object]") tea.value = curTeacher;
    sub.addEventListener("change", function () { paintTeachers(false); });

    wrap.appendChild(h("p", "ep-note",
      "科目决定带哪些东西；老师按课表自动带出，不用打字，代课直接改。"));

    var row = h("div", "ep-actrow");
    var saveToday = h("button", "ep-primary ep-lesson-save", "只改今天");
    saveToday.title = "只影响这一天，课表本身不动";
    saveToday.addEventListener("click", function () {
      var lessons = (S.getDayOverride(key) || {}).lessons || {};
      lessons[b.periodNo] = { subject: sub.value.trim(), teacher: tea.value.trim() };
      S.patchDayOverride(key, { lessons: lessons });
      wrap.remove();
      flash("第 " + b.periodNo + " 节今天改成" + sub.value.trim());
      renderBody();
    });

    /* 「以后都改」写课表本身：同一个星期几的同一节，以后每周都按这个来。
       同时把今天那条临时覆盖删掉，不然它还会盖住刚写进去的课表。 */
    var saveAlways = h("button", "ep-ghost ep-lesson-always", "以后都改");
    saveAlways.title = weekday
      ? "把这周" + "一二三四五六日".charAt(weekday - 1) + "第 " + b.periodNo + " 节写进课表，以后每周都这样"
      : "写进课表，以后每周都这样";
    saveAlways.addEventListener("click", function () {
      if (!weekday) { flash("算不出今天是星期几，先用「只改今天」"); return; }
      var sc = JSON.parse(JSON.stringify((RT.config() || {}).schedule || {}));
      sc.entries = sc.entries || [];
      var hit = sc.entries.filter(function (e) {
        return +e.weekday === +weekday && +e.periodNo === +b.periodNo;
      });
      var subject = sub.value.trim(), teacher = tea.value.trim();
      if (!hit.length) {
        hit = [{ weekday: weekday, periodNo: b.periodNo, subject: subject }];
        sc.entries.push(hit[0]);
      }
      hit.forEach(function (e) {
        e.subject = subject;
        if (teacher) e.teacher = teacher;
        else delete e.teacher;
      });
      var lessons = (S.getDayOverride(key) || {}).lessons || {};
      delete lessons[b.periodNo];
      S.patchDayOverride(key, { lessons: lessons });
      S.patchConfig({ schedule: sc });
      wrap.remove();
      flash("课表已改：周" + "一二三四五六日".charAt(weekday - 1)
        + "第 " + b.periodNo + " 节以后都是" + subject);
      renderBody();
    });

    var cancel = h("button", "ep-ghost", "取消");
    cancel.addEventListener("click", function () { wrap.remove(); });
    row.appendChild(saveToday);
    row.appendChild(saveAlways);
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
        out.push({ name: b.name, label: R.blockName(b), tip: b.tip || "",
                 reading: b.type === "reading" });
      });
    });
    return out;
  }

  /* 晨间自主管理 / 放学后 / 休息日：晨间跟着作息走，另外两个是每天的两头 */
  var STAGES = [
    { key: "before",  label: "晨间自主管理", title: "晨间自主管理", note: "先交作业、整理书包" },
    { key: "closed",  label: "放学以后",       title: "放学了",   note: "整理好书包，路上注意安全" },
    { key: "holiday", label: "休息日",         title: "今天不上学", note: "好好休息，明天见" }
  ];

  /* 提醒事项按星期排：空着就等于这天没安排，屏上不显示，不去猜。 */
  var WEEKDAYS = [
    { n: 1, label: "周一" }, { n: 2, label: "周二" }, { n: 3, label: "周三" },
    { n: 4, label: "周四" }, { n: 5, label: "周五" }
  ];

  /* 时段提示条目（真机反馈 2026-11-20 ③）：默认一句、每天显示；
   可点掉哪几天（days）、也可某几天写不同的话（按星期覆盖，留空=用默认）。
   存储形状：字符串（旧，每天这句）或 {default, days?, [星期几]: 文字}。
   晨间自主管理那一格就是屏上的黄色贴纸，旧 reminders 数据回退兼容。 */
  function tipEntryOf(name) {
    var t = (S.texts().tips || {})[name];
    if (t == null) return {};
    if (typeof t === "string") return { "default": t };
    return Object.assign({}, t);
  }

  function setTipEntry(name, patch) {
    var tips = Object.assign({}, S.texts().tips);
    var e = Object.assign(tipEntryOf(name), patch);
    Object.keys(e).forEach(function (k) {
      if (k === "days") return;
      if (e[k] != null && !String(e[k]).trim()) delete e[k];
    });
    if (e.days && (!e.days.length || e.days.length === WEEKDAYS.length)) delete e.days;
    if (Object.keys(e).length) tips[name] = e; else delete tips[name];
    S.patchTexts({ tips: tips });
  }

  function tipDaysRow(name, daysSel) {
    var row = h("div", "ep-rem-days");
    row.appendChild(h("span", "ep-flabel", "哪几天显示"));
    WEEKDAYS.forEach(function (w) {
      var b = h("button", "ep-daybtn" + (daysSel.indexOf(w.n) >= 0 ? " on" : ""), w.label);
      b.type = "button";
      b.addEventListener("click", function () {
        var i = daysSel.indexOf(w.n);
        if (i >= 0) daysSel.splice(i, 1); else daysSel.push(w.n);
        b.classList.toggle("on", daysSel.indexOf(w.n) >= 0);
        setTipEntry(name, { days: daysSel.slice() });
        flash("已保存，大屏已经换了");
        if (root.Screen) root.Screen.render();
      });
      row.appendChild(b);
    });
    return row;
  }

  function tipSeg(seg) {
    var isMorning = !!seg.reading;
    var e0 = tipEntryOf(seg.name);
    var daysSel = (e0.days && e0.days.length) ? e0.days.slice()
      : WEEKDAYS.map(function (w) { return w.n; });
    /* 晨间那格默认值兼容旧数据：没写过提示语时显示旧贴纸那句 */
    var initVal = e0["default"] || "";
    if (isMorning && !initVal) {
      var rems = S.texts().reminders || {};
      initVal = rems["default"] || "";
    }

    var wrap = h("div", "ep-tipseg");
    wrap.appendChild(field(
      isMorning ? seg.label + " · 提醒文字（屏上是黄色贴纸）" : seg.label,
      seg.tip || "（这一时段没有提示语）", initVal,
      function (v) { setTipEntry(seg.name, { "default": v }); }));
    wrap.appendChild(tipDaysRow(seg.name, daysSel));

    var wdWrap = h("div", "ep-wdrow");
    wdWrap.hidden = true;
    WEEKDAYS.forEach(function (w) {
      wdWrap.appendChild(field(w.label + " · 不同的话（留空 = 用上面那句）", "",
        e0[String(w.n)] || "",
        function (v) { var p = {}; p[String(w.n)] = v; setTipEntry(seg.name, p); }));
    });
    var toggle = h("button", "ep-ghost ep-wdtoggle", "其中几天要写不同的话");
    toggle.type = "button";
    toggle.addEventListener("click", function () {
      wdWrap.hidden = !wdWrap.hidden;
      toggle.textContent = wdWrap.hidden ? "其中几天要写不同的话" : "收起按星期设置";
    });
    wrap.appendChild(toggle);
    wrap.appendChild(wdWrap);
    return wrap;
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

  function setStage(key, field, v) {
    var stage = Object.assign({}, S.texts().stage);
    var cur = Object.assign({}, stage[key]);
    if (v.trim()) cur[field] = v.trim();
    else delete cur[field];
    if (Object.keys(cur).length) stage[key] = cur;
    else delete stage[key];
    S.patchTexts({ stage: Object.keys(stage).length ? stage : null });
  }

  /* 课前准备提前量：分钟数输入框配 −/+ 步进，一体机上不用调出键盘。
     只有 change（离开输入框 / 点步进）才落盘，中途打字不写。
     空 = 恢复默认；0、负数、非数字一律不写，改成提示。 */
  function prepLeadRow() {
    var cur = S.prefs().prepLead;
    cur = R.normalizePrepLead(cur);
    if (cur == null) cur = R.PREP_LEAD;

    var row = h("div", "ep-step");
    row.appendChild(h("span", "ep-flabel", "提前量"));

    var minus = h("button", "ep-stepbtn", "−");
    minus.type = "button";
    minus.setAttribute("aria-label", "减少一分钟");
    var inp = document.createElement("input");
    inp.className = "ep-input ep-stepnum";
    inp.type = "text";
    inp.inputMode = "numeric";
    inp.value = String(cur);
    var plus = h("button", "ep-stepbtn", "＋");
    plus.type = "button";
    plus.setAttribute("aria-label", "增加一分钟");
    row.appendChild(minus);
    row.appendChild(inp);
    row.appendChild(plus);
    row.appendChild(h("span", "ep-steptag", "分钟"));

    function apply(raw) {
      var n = R.normalizePrepLead(raw);
      if (n == null) {
        flash("提前量是 1–30 分钟的数，请重填");
        return;
      }
      if (String(n) !== String(raw).trim()) flash("已按 " + n + " 分钟算");
      cur = n;
      inp.value = String(n);
      S.setPref("prepLead", n);
      if (root.Screen) root.Screen.render();
    }
    minus.addEventListener("click", function () { apply(cur - 1); });
    plus.addEventListener("click", function () { apply(cur + 1); });
    inp.addEventListener("change", function () { apply(inp.value); });
    return row;
  }

  function renderText() {
    var T = S.texts();

    var sec0 = h("section", "ep-sec wide");
    sec0.appendChild(h("h3", null, "晨间自主管理 · 放学 · 休息日"));
    sec0.appendChild(h("p", "ep-note",
      "晨间这两句跟着作息里的晨间段时间走；放学和休息日不在作息表里。留空就是原来的话。"));
    STAGES.forEach(function (st) {
      var cur = (T.stage || {})[st.key] || {};
      if (st.key === "before") {
        /* 晨间大字和第二行仍写进 stage.before 的两个字段，键不变、数据不动 */
        sec0.appendChild(field("晨间自主管理 · 大字", st.title, cur.title || "",
          function (v) { setStage(st.key, "title", v); }));
        sec0.appendChild(field("晨间自主管理 · 第二行", st.note, cur.note || "",
          function (v) { setStage(st.key, "note", v); }));
        return;
      }
      sec0.appendChild(field(st.label + " · 大字", st.title, cur.title || "",
        function (v) { setStage(st.key, "title", v); }));
      sec0.appendChild(field(st.label + " · 一句话", st.note, cur.note || "",
        function (v) { setStage(st.key, "note", v); }));
    });
    bodyEl.appendChild(sec0);

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
    sec1.appendChild(prepLeadRow());
    sec1.appendChild(h("p", "ep-note",
      "下课前多少分钟开始提示下一节要带什么。默认 10 分钟，1–30 分钟都可以；"
      + "清空输入框就回到默认。普通课间、大课间都按这个提前量，改完大屏立刻跟着变。"));
    bodyEl.appendChild(sec1);

    var sec2 = h("section", "ep-sec wide");
    sec2.appendChild(h("h3", null, "各时段的提示语"));
    sec2.appendChild(h("p", "ep-note",
      "每段默认每天显示同一句；哪天有特别安排就点掉星期、或展开写不同的话。"
      + "晨间自主管理那一格就是屏上的黄色贴纸。留空就是原来的话。"));
    blockNames().forEach(function (seg) {
      sec2.appendChild(tipSeg(seg));
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
    { key: "reading",label: "晨间自主管理" },
    { key: "ritual", label: "集会 / 眼操" },
    { key: "meal",   label: "午餐", locked: true },
    { key: "noon",   label: "午间", locked: true },
    { key: "action", label: "活动" },
    { key: "after",  label: "课后服务" }
  ];

  /* 作息保护（真机反馈 2026-11-20：正课/眼操/课间的时间来自老师上传的
     作息表，不该随手能改）：这三类段的时间在面板里默认锁住，点「解锁」
     才能动，退出面板自动恢复锁定。午间、课后服务等其余段落照旧自由改。
     集会不算眼操，不在锁定范围。 */
  var hoursUnlocked = false;
  function timeLocked(b) {
    return b.type === "class" || b.type === "break"
      || (b.type === "ritual" && /眼保健操/.test(b.name || ""));
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function toMin(t) { var p = String(t).split(":"); return (+p[0]) * 60 + (+p[1]); }
  function toTime(m) { return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60); }

  function timetableNow() {
    var c = RT ? RT.config() : {};
    return c.timetable ? JSON.parse(JSON.stringify(c.timetable)) : null;
  }

  /* 首尾相接才算一张完整的作息表：中间留空，屏上那段时间就没有状态。
     比较「分钟数」而不是字符串——"9:50" 和 "09:50" 是同一个时间，
     字符串比会误报接不上（2026-11-19 真机反馈 ②）。报错把两段的
     时间都带上，老师一眼看到差在哪。 */
  function hoursProblem(blocks) {
    for (var i = 0; i < blocks.length; i += 1) {
      var b = blocks[i];
      if (!b.start || !b.end) return "第 " + (i + 1) + " 段还没填时间";
      if (toMin(b.start) >= toMin(b.end)) return "第 " + (i + 1) + " 段：开始时间要早于结束时间";
      if (i && toMin(blocks[i - 1].end) !== toMin(b.start)) {
        return "第 " + i + " 段（" + blocks[i - 1].start + "—" + blocks[i - 1].end +
          "）和第 " + (i + 1) + " 段（" + b.start + "—" + b.end + "）没接上：上一段到 " +
          blocks[i - 1].end + "，这一段从 " + b.start + " 开始";
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

    /* 作息保护开关：默认锁住正课/眼操/课间的时间，解锁只对本次编辑有效 */
    var guard = h("div", "tt-guard");
    var unlockBtn = h("button", "ep-ghost tt-unlock",
      hoursUnlocked ? "已解锁——退出面板自动恢复保护"
                    : "正课 / 眼保健操 / 课间已按作息表锁住，点此解锁");
    unlockBtn.addEventListener("click", function () {
      hoursUnlocked = !hoursUnlocked;
      flash(hoursUnlocked ? "已解锁：现在可以改这三类段的时间了"
                          : "已恢复锁定");
      renderBody();
    });
    guard.appendChild(unlockBtn);
    guard.appendChild(h("span", "tt-guard-note",
      hoursUnlocked ? "改完请核对首尾相接，屏上立刻生效。"
                    : "这些时间来自老师上传的作息表；午间、课后服务等其余段落随时可改。"));
    sec.appendChild(guard);

    blocks.forEach(function (b, idx) {
      var row = h("div", "tt-row");
      var st = document.createElement("input");
      st.type = "time"; st.className = "tt-time"; st.value = b.start || "";
      var en = document.createElement("input");
      en.type = "time"; en.className = "tt-time"; en.value = b.end || "";

      var meta = TT_TYPES.filter(function (t) { return t.key === b.type; })[0];
      var locked = !hoursUnlocked && timeLocked(b);
      var name = document.createElement("input");
      name.type = "text"; name.className = "tt-name";
      /* 旧配置里这一段还叫「早读」，输入框先显示新名；没真改名字就不回写。 */
      var shownName = R.blockName(b) || (meta ? meta.label : "");
      name.value = shownName;
      name.placeholder = "名称";

      row.appendChild(st);
      row.appendChild(h("span", "tt-dash", "—"));
      row.appendChild(en);

      if (locked) {
        st.readOnly = true;
        en.readOnly = true;
        st.classList.add("tt-locked");
        en.classList.add("tt-locked");
        st.title = en.title = "这一段时间来自作息表，点上方「解锁」才能改";
      }

      /* 正课 / 午餐 / 午间跟课表绑着，类型不能动；
         锁定中的课间/眼操也换成标签——先改类型再改时间就绕过锁了。
         其余段落让老师自己选，作息里多一段早读就能直接改出来。 */
      var curType = b.type;
      var curLabel = meta ? meta.label : "";
      if ((meta && meta.locked) || locked) {
        row.appendChild(h("span", "tt-tag", meta ? meta.label : ""));
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

      /* 只改时间时不重绘整块，否则输入框会失焦。
         边界联动：老师改某段的开始时间，上一段的结束自动跟过来；
         改结束时间，下一段的开始自动跟过来。老师的意图就是挪边界，
         以前要两段各改一次、中间还会弹一次"断档或重叠"的报错
         （2026-11-19 真机反馈 ②③），现在一步到位。 */
      function commit() {
        row.classList.remove("bad");
        var cur = blocks[idx] || {};
        var stChanged = !!(st.value && st.value !== cur.start);
        var enChanged = !!(en.value && en.value !== cur.end);
        var oldName = cur.name || "";
        var typed = name.value.trim();
        var newName = (typed && typed !== shownName) ? typed : (cur.name || "");
        var next = blocks.map(function (x, i) {
          if (i !== idx) {
            /* 联动边界时不许越界去改锁定段（未解锁时）：改了就报
               「没接上」，老师看到提示要么改回，要么点解锁。 */
            if (stChanged && i === idx - 1 && x.end !== st.value
                && (hoursUnlocked || !timeLocked(x))) {
              return Object.assign({}, x, { end: st.value });
            }
            if (enChanged && i === idx + 1 && x.start !== en.value
                && (hoursUnlocked || !timeLocked(x))) {
              return Object.assign({}, x, { start: en.value });
            }
            return x;
          }
          return Object.assign({}, x, {
            start: st.value, end: en.value,
            name: newName || x.name,
            type: curType
          });
        });
        var bad = hoursProblem(next);
        if (bad) { row.classList.add("bad"); flash(bad); return; }
        blocks = next;
        saveHours(blocks);
        /* 联动改了相邻段的边界，把它们的输入框就地同步（不重绘整块，
           免得老师正在用的输入框失焦），否则数据新了、显示还是旧的。 */
        if (stChanged || enChanged) {
          Array.prototype.forEach.call(rows.children, function (r, i) {
            var ins = r.querySelectorAll(".tt-time");
            if (ins.length === 2 && blocks[i]) {
              if (ins[0].value !== blocks[i].start) ins[0].value = blocks[i].start;
              if (ins[1].value !== blocks[i].end) ins[1].value = blocks[i].end;
            }
          });
        }
        /* 时段改名后，旧时段名下的提示语复制给新名：文字页的新时段
           一出来就带着原来的提示语（真机反馈 2026-11-19 ③），屏上也
           不断档。旧名保留原提示语——同名段（两张课间）和别的课还
           在用，不动它；老师不想要就到文字页清空。 */
        if (oldName && newName && oldName !== newName) {
          var tips = S.texts().tips || {};
          if (tips[oldName] && !tips[newName]) {
            var moved = Object.assign({}, tips);
            moved[newName] = moved[oldName];
            S.patchTexts({ tips: moved });
          }
        }
        flash("已保存，大屏已经换了");
      }
      st.addEventListener("change", commit);
      en.addEventListener("change", commit);
      name.addEventListener("change", commit);

      var ins = h("button", "tt-mini", "＋");
      ins.title = "在后面插一段 10 分钟的课间";
      if (!hoursUnlocked) {
        ins.disabled = true;
        ins.classList.add("off");
        ins.title = "插入会让后面的正课整体后移，请先点上方「解锁」";
      } else {
        ins.addEventListener("click", function () {
        var next = insertAfter(blocks, idx, 10);
        var bad = hoursProblem(next);
        if (bad) { flash(bad); return; }
        saveHours(next);
        flash("插了一段课间，后面整体后移 10 分钟");
        renderBody();
        });
      }
      row.appendChild(ins);

      var del = h("button", "tt-mini", "删");
      if (meta && meta.locked) {
        del.disabled = true;
        del.title = "这一段跟课表绑着，不能删";
        del.classList.add("off");
      } else if (!hoursUnlocked) {
        del.disabled = true;
        del.title = "删除会让后面的正课整体前移，请先点上方「解锁」";
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
    if (!hoursUnlocked) {
      reset.disabled = true;
      reset.title = "恢复出厂会重排全部时间，请先点上方「解锁」";
      reset.classList.add("off");
    }
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

  /* 「这个岗位今天是谁」——只有引擎一个答案。
     两段与覆盖层的语义一致：今天的临时换人（override）在外层，没换人
     才看岗位配置里的轮换规则。
     以前这里自己按 people → peopleMap → groups 算一遍，而引擎是
     people → groups → peopleMap：同一个岗位，面板说「按星期的那个人」，
     大屏说「A 组的那个人」。老师看到的就是「我明明选了人，屏上却是别人」。
     groups 全组的总人数由 roleGroupSize 单独给，不混进「今天是谁」。 */
  function rolePeopleNow(role, key) {
    var ovr = ((S.getDayOverride(key) || {}).roles || {})[role.id];
    /* 老师今天明确设过（包括清空）就以今天为准 */
    if (ovr && "people" in ovr) return S.peopleList(ovr.people);

    if (!SCH || !SCH.resolvePeople) return S.peopleList(role.people);
    var day = (RT && RT.day) ? RT.day(key) : null;
    var res = SCH.resolvePeople(role, day ? day.group : null, null, day ? day.weekday : 1);
    return (res && res[0]) || [];
  }

  /* 轮换岗位的总人数（只是给面板说「A/B 组（8 人）」用，不参与「今天是谁」） */
  function roleRosterSize(role) {
    var n = 0;
    var seen = {};
    function add(v) {
      S.peopleList(v).forEach(function (x) { if (!seen[x]) { seen[x] = 1; n++; } });
    }
    add(role.people);
    if (role.peopleMap) Object.keys(role.peopleMap).forEach(function (k) { add(role.peopleMap[k]); });
    if (role.groups) Object.keys(role.groups).forEach(function (k) { add(role.groups[k]); });
    return n;
  }

  function renderDuty(ov, key) {
    var sec = h("section", "ep-sec");
    sec.appendChild(h("h3", null, "点岗位换人"));

    var doc = roleDoc();
    var roles = (doc.roles || []).slice().sort(function (a, b) {
      return (typeof a.order === "number" ? a.order : 0) - (typeof b.order === "number" ? b.order : 0);
    });
    var list = h("div", "ep-rows");
    roles.forEach(function (r, i) {
      var changed = ov.roles && ov.roles[r.id];
      var line = h("div", "ep-rowline");
      line.dataset.roleId = r.id;

      /* 一行 = 岗位名 + 出人方式 + 人名（每个名字自己是一个按钮）+ ▲▼。
         人名单独成按钮，老师点谁就直接改谁；点岗位名进整个面板。 */
      var row = h("div", "ep-row" + (changed ? " changed" : ""));
      row.dataset.roleId = r.id;
      row.appendChild(h("span", "p", r.name));
      row.appendChild(modeBadge(r, key));

      var names = rolePeopleNow(r, key);
      var who = h("div", "ep-who");
      if (!names.length) {
        who.appendChild(h("span", "ep-who-empty", emptyWho(r, key)));
      }
      names.forEach(function (n) {
        var chip = h("button", "ep-namechip", n);
        chip.addEventListener("click", function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          openPicker(r, key, { focus: n });
        });
        who.appendChild(chip);
      });
      row.appendChild(who);
      if (changed) row.appendChild(h("span", "x", "今天"));

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
    renderDutyPresents(doc, key);
    bodyEl.appendChild(sec);
  }

  /* 出人方式的徽标：老师扫一眼就知道这个岗位明天会不会换人 */
  var MODE_TEXT = { fixed: "固定", ab: "A/B 组", weekday: "按星期" };
  function modeBadge(role, key) {
    var mode = S.roleModeOf ? S.roleModeOf(role) : "fixed";
    var text = MODE_TEXT[mode] || "固定";
    if (mode === "ab") {
      var d = RT && RT.day ? RT.day(key) : null;
      if (d && d.group) text += " · 今天 " + d.group;
    }
    if (role.assign === "self-organize") text += " · 自主";
    var b = h("span", "ep-modebadge" + (mode === "fixed" ? "" : " on"), text);
    return b;
  }

  function emptyWho(role, key) {
    var mode = S.roleModeOf ? S.roleModeOf(role) : "fixed";
    if (mode === "weekday") {
      var d = RT && RT.day ? RT.day(key) : null;
      var w = d ? (WEEKDAYS.filter(function (x) { return x.n === d.weekday; })[0] || {}) : {};
      return (w.label || "这一天") + "还没排人";
    }
    if (mode === "ab") return roleRosterSize(role) ? "今天这组还没人" : "还没分 A/B 组";
    return "还没排人";
  }

  /* 时段常驻（0.3.23）：课间 / 晨间自主管理 / 午间各配哪些岗位整段挂在
     值日条上，自由多选。选进来的岗位不再按各自设的触发方式另算
     （一个岗位一种呈现方式）；没选的岗位照旧。 */
  function renderDutyPresents(doc, key) {
    var roles = (doc.roles || []).slice().sort(function (a, b) {
      return (typeof a.order === "number" ? a.order : 0) - (typeof b.order === "number" ? b.order : 0);
    });
    if (!roles.length) return;
    var presSec = h("section", "ep-sec");
    presSec.appendChild(h("h3", null, "哪些岗位整段常驻"));
    /* 原来是 100 字的一段话，老师不会读。标题说结论，细节收进「?」。 */
    var presNote = h("p", "ep-note");
    presNote.appendChild(h("span", null, "勾上的岗位整段挂在值日条上"));
    presNote.appendChild(helpNote(
      "勾了哪个时段，这个岗位就在那一整段都挂在值日条上；岗位多到一行放不下会自动滚动。"
      + "没勾的岗位按各自设的触发方式出现，互不影响。"
      + "还没选人的岗位挂上大屏会显示「待定」，先在「值日」页点岗位把人选好。"
    ));
    presSec.appendChild(presNote);

    var pres = (RT && RT.config) ? (RT.config().dutyPresents || {}) : {};
    [
      { key: "reading", label: "晨间自主管理" },
      { key: "break", label: "课间" },
      { key: "noon", label: "午间" }
    ].forEach(function (slot) {
      /* 每时段一个带标题的子块 + 分隔线：三行岗位列表长得一样，
         不分隔老师只能靠找重复来判断哪段是谁的（真机反馈 2026-11-20 ②） */
      var slotBox = h("div", "ep-slot");
      slotBox.appendChild(h("div", "ep-slot-title", slot.label));
      var opts = h("div", "ep-opts");
      roles.forEach(function (r) {
        var on = (pres[slot.key] || []).indexOf(r.id) >= 0;
        /* 人员状态直接标在选项上：没选人的岗位勾了常驻，
           大屏只会显示「待定」，当场告诉老师先去选人 */
        var empty = !rolePeopleNow(r, key).length;
        var b = h("button", "ep-opt" + (on ? " on" : "") + (empty ? " ep-opt-warn" : ""),
          r.name + (empty ? "（还没选人）" : ""));
        b.addEventListener("click", function () {
          var cur = ((RT.config().dutyPresents || {})[slot.key] || []).slice();
          var at = cur.indexOf(r.id);
          if (at >= 0) cur.splice(at, 1); else cur.push(r.id);
          var next = Object.assign({}, RT.config().dutyPresents || {});
          next[slot.key] = cur;
          S.patchConfig({ dutyPresents: next });
          b.classList.toggle("on");
          flash(slot.label + "常驻岗位已更新");
        });
        opts.appendChild(b);
      });
      slotBox.appendChild(opts);
      presSec.appendChild(slotBox);
    });
    bodyEl.appendChild(presSec);
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

  /* 一组「人员」可能是名字、学号、也可能是对象（手工改过的配置）。
     拼到界面上之前一律取名字、丢掉取不出来的，别让 [object Object] 露脸。 */

  /* 换人时候选的排序依据：这个岗位原本是谁，就先出谁。
     岗位的人可能在 people、peopleMap、groups、substitute 四处，
     四处都要算进来；归一化统一交给 Store.peopleList，
     别在这里再写一套「取名字、挡 [object Object]」。 */
  function relatedNames(role) {
    var out = S.peopleList(role.people);
    function addAll(v) {
      S.peopleList(v).forEach(function (n) { if (out.indexOf(n) < 0) out.push(n); });
    }
    if (role.peopleMap) Object.keys(role.peopleMap).forEach(function (k) { addAll(role.peopleMap[k]); });
    if (role.groups) Object.keys(role.groups).forEach(function (k) { addAll(role.groups[k]); });
    (Array.isArray(role.substitute) ? role.substitute : []).forEach(function (x) {
      addAll(x && typeof x === "object" ? x.name : x);
    });
    return out;
  }

  /* ---------- 人群组：点组带出（PLAN 2.18） ---------- */
  /* 名单只认本机配置（向导补录过的那份）：没录入就是没有，
     绝不拿包里的样例名单冒充本班学生（2026-11-19 真机反馈②：
     值日表名字对，换人候选却出现别班名字）。 */
  function rosterStudents() {
    var cfg = S.config ? S.config() : null;
    var d = cfg ? cfg.students : null;
    /* 归一化收口在 Store：纯字符串名单、name 是对象的老数据都会变成
       `{id, name, active}`。少了这一步，后面按姓名字符串比对的代码
       会在 `s.name.indexOf` 上抛错，换人面板整块空掉。 */
    if (S.normStudents) return S.normStudents(d);
    return Array.isArray(d) ? d : [];
  }

  function rosterNameIndex(roster) {
    var byId = {};
    roster.forEach(function (s) {
      if (!s || !s.name || s.active === false) return;
      if (s.id) byId[s.id] = s.name;
      byId["name:" + s.name] = s.name;
      /* 手工写的配置里组员可能只存了姓名，没有编号前缀 */
      byId[s.name] = s.name;
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
    /* 名单没录入时不过滤（keep=null）：值日条上的名字来自岗位配置，
       是对的；不能因为名单空了把组也带不出来。 */
    var keep = null;
    if (roster.length) {
      keep = {};
      roster.forEach(function (s) {
        if (s && s.name && s.active !== false) keep[s.name] = 1;
      });
    }

    if (role && role.grp) {
      var names = [];
      var dropped = 0;          /* 组里有人不在当前名单上 */
      function add(x) {
        S.peopleList(x).forEach(function (n) {
          if (keep !== null && !keep[n]) { dropped++; return; }
          if (names.indexOf(n) < 0) names.push(n);
        });
      }
      if (day) {
        (S.applyOverrides(day, S.getDayOverride(key)).duties || []).forEach(function (d) {
          if (d.grp !== role.grp) return;
          (d.people || []).forEach(add);
        });
      }
      (roleDoc().roles || []).forEach(function (r) {
        if (r.grp !== role.grp) return;
        /* 同组其他岗位今天是谁：问同一个入口，别在这儿再算一遍 */
        rolePeopleNow(r, key).forEach(add);
      });
      /* 和手工分的组一样：人全不在名单里时也不能把组藏掉。
         以前名单一换（新学年、新班），这排「值日组」就无声消失，
         老师看到的就是「我分好的组丢了」——数据其实一直在岗位配置里。 */
      if (names.length || dropped) {
        out.push({ id: "role:" + role.grp, name: role.grp, source: "role",
                   names: names, missing: dropped });
      }
    }
    var byId = rosterNameIndex(roster);
    (S.peopleGroups ? S.peopleGroups() : []).forEach(function (g) {
      /* 组永远显示：就算成员 id 跟名单对不上了（名单重录、学生 id 变更），
         也不能把老师分好的组整个藏起来——数据还在，藏了像「丢了」。 */
      var names = [], missing = 0;
      (g.memberIds || []).forEach(function (id) {
        var n = byId[id];
        if (n) { if (names.indexOf(n) < 0) names.push(n); }
        else missing++;
      });
      if (names.length || missing) {
        out.push({ id: g.id, name: g.name, source: "manual", names: names, missing: missing });
      }
    });
    return out;
  }

  /* 一个岗位通常就一个人：点谁就是谁。多人在一起干的（擦窗户、按组轮换的
     值日组）才需要加减。这个判断现在收在面板里按「当前方式」算，
     不再从配置里推——配置里留着旧的分组数据，会把固定岗位错认成多人。 */

  /* ---------- 换人面板 ----------
     一屏里把四件事做完，不再一层层点：
       1. 候选名单放在最上面，打姓或名的汉字/拼音都能出人（Store.rankStudents）；
       2. 这个岗位现在是谁，紧贴候选列出来，点一下就去掉；
       3. 「固定 / A/B 轮流 / 按星期」当场互切——以前固定岗位想改成轮流
          根本没有入口，反向的「改为固定人员」却是有的；
       4. 「保存」写进岗位配置（以后都这样），「只改今天」留成次按钮。
     说明文字全删了，改由按钮的按下态、已选人数、槽位上的「缺 N」这些
     看得见的东西表达。 */
  function openPicker(role, key, opts) {
    closePicker();
    opts = opts || {};

    /* 岗位历史上是不是「一岗多人」。单选岗位（班牌）点人 = 换掉，
       多选岗位点人 = 加/减一个人。从配置派生，不另存一个开关。 */
    /* 这一个槽位是「一个人干」还是「几个人一起干」。
       以前靠 roleIsMulti 从配置推，结果把「以前分过组」也当成多人：
       一个岗位从 A/B 切回固定后，分组数据还在，点个人就变成了追加。
       现在按当前方式判：固定看实际人数（并给老师一个显式开关），
       轮流方式的每格都允许多人。 */
    var related = relatedNames(role);
    var draft = JSON.parse(JSON.stringify(role));
    var mode = S.roleModeOf ? S.roleModeOf(draft) : "fixed";
    var oneSeat = mode === "fixed" && S.peopleList(draft.people).length <= 1;
    var SLOTS = { fixed: [null], ab: ["A", "B"], weekday: ["1", "2", "3", "4", "5"] };
    /* 当前正在编辑哪一个槽位。固定方式只有一个槽，下面会按首个人人所在的槽纠正。 */
    var slot = null;
    var focusName = opts.focus || "";

    function slotList() { return SLOTS[mode] || [null]; }

    function slotNames(which) {
      var s = which === undefined ? slot : which;
      if (mode === "fixed") return S.peopleList(draft.people);
      if (mode === "ab") return draft.groups ? S.peopleList(draft.groups[s]) : [];
      return draft.peopleMap ? S.peopleList(draft.peopleMap[s]) : [];
    }

    function writeSlot(names, which) {
      var s = which === undefined ? slot : which;
      if (mode === "fixed") { draft.people = names.slice(); return; }
      if (mode === "ab") {
        draft.groups = draft.groups || {};
        draft.groups[s] = names.slice();
        return;
      }
      draft.peopleMap = draft.peopleMap || {};
      draft.peopleMap[s] = names.slice();
    }

    function firstFilledSlot() {
      var ls = slotList();
      for (var i = 0; i < ls.length; i++) if (slotNames(ls[i]).length) return ls[i];
      return ls[0];
    }

    slot = mode === "fixed" ? null : firstFilledSlot();

    function seatLabel(s) {
      if (s == null) return "固定";
      if (mode === "ab") return s + " 组";
      var w = WEEKDAYS.filter(function (x) { return String(x.n) === String(s); })[0];
      return w ? w.label : "周" + s;
    }

    var wrap = h("div", "ep-dialog picker");
    var head = h("div", "ep-dialog-head");
    head.appendChild(h("div", "ep-dialog-title", role.name));
    var shut = h("button", "ep-dialog-close", "关闭");
    shut.title = "关闭，这次的选择不保存";
    shut.addEventListener("click", function () { closePicker(); });
    head.appendChild(shut);
    wrap.appendChild(head);

    var mask = h("div", "ep-picker-mask");
    mask.addEventListener("click", function () { closePicker(); });

    /* 先搜索、先出候选：老师打开面板十次有九次是来找人的 */
    var q = document.createElement("input");
    q.className = "ep-input";
    q.placeholder = "打姓或名：汉字或拼音（zhou / z / 周）";
    wrap.appendChild(q);

    var grid = h("div", "ep-people");
    wrap.appendChild(grid);

    /* 已选：这个岗位现在是谁，和候选人贴在一起，点一下就摘掉 */
    var pickedBox = h("div", "ep-picked");
    var pickedHead = h("div", "ep-picked-head");
    var pickedTitle = h("span", "ep-picked-t", "");
    pickedHead.appendChild(pickedTitle);
    var clearBtn = h("button", "ep-picked-clear", "清空");
    clearBtn.addEventListener("click", function () {
      if (!slotNames().length) return;
      writeSlot([]);
      paintAll();
    });
    pickedHead.appendChild(clearBtn);
    /* 一个人干 / 多人一起干：显式开关，不靠猜配置。
       单人（班牌、路队长这种）点人就是换人；多人点人是加人。 */
    var mixBox = h("span", "ep-seatmix");
    pickedHead.appendChild(mixBox);
    pickedBox.appendChild(pickedHead);

    var seatsRow = h("div", "ep-seats");
    pickedBox.appendChild(seatsRow);
    var chips = h("div", "ep-pickchips");
    pickedBox.appendChild(chips);
    wrap.appendChild(pickedBox);

    /* 出人方式：一行三个按钮，当前的那种按下去 */
    var modeRow = h("div", "ep-modeseg");
    wrap.appendChild(modeRow);

    /* 常用组：点一下就整组带进当前槽位 */
    var groupBox = h("div", "ep-groups");
    wrap.appendChild(groupBox);

    var foot = h("div", "ep-actrow");
    wrap.appendChild(foot);

    function pickerPool() {
      var list = rosterStudents().slice();
      var have = {};
      list.forEach(function (s) { if (s && s.name) have[s.name] = 1; });
      related.forEach(function (n) {
        if (n && !have[n]) { list.push({ name: n }); have[n] = 1; }
      });
      /* 草稿里已经排上、但名单里没有的人也要能看见（组里留着的旧姓名） */
      slotList().forEach(function (s) {
        slotNames(s).forEach(function (n) {
          if (n && !have[n]) { list.push({ name: n }); have[n] = 1; }
        });
      });
      return list;
    }

    function tap(name) {
      var cur = slotNames().slice();
      var at = cur.indexOf(name);
      if (at >= 0) {
        cur.splice(at, 1);
      } else if (oneSeat && cur.length >= 1) {
        cur = [name];                 /* 一个人干的岗位：点谁就是换谁 */
      } else {
        cur.push(name);
      }
      writeSlot(cur);
      S.markPicked(name);
      paintAll();
    }

    function paintGrid() {
      grid.innerHTML = "";
      var qs = String(q.value || "").trim();
      var rows = S.rankStudents(pickerPool(), qs, related, qs ? 24 : 16);
      var cur = slotNames();

      if (!rows.length) {
        if (qs) {
          var add = h("button", "ep-addperson", "把「" + qs + "」加进名单");
          add.addEventListener("click", function () {
            var r = S.addStudent(qs);
            if (!r.ok) { flash(r.why); return; }
            flash(r.existed ? "名单里本来就有「" + qs + "」" : "已加进名单：" + qs);
            paintAll();
          });
          grid.appendChild(add);
        } else {
          grid.appendChild(h("span", "ep-person-none", "还没选人：上面点人，或点一组带出"));
        }
        return;
      }

      rows.forEach(function (s) {
        var on = cur.indexOf(s.name) >= 0;
        var b = h("button", "ep-person" + (on ? " on" : ""), s.name);
        b.addEventListener("click", function () { tap(s.name); });
        grid.appendChild(b);
      });
    }

    function paintSeats() {
      seatsRow.innerHTML = "";
      seatsRow.hidden = mode === "fixed";
      if (mode === "fixed") return;
      slotList().forEach(function (s) {
        var n = slotNames(s).length;
        var b = h("button", "ep-seat" + (s === slot ? " on" : ""), seatLabel(s) + (n ? " · " + n : ""));
        b.addEventListener("click", function () { slot = s; paintAll(); });
        seatsRow.appendChild(b);
      });
    }

    function paintChips() {
      chips.innerHTML = "";
      mixBox.innerHTML = "";
      if (mode === "fixed") {
        [["one", "1 人"], ["many", "多人"]].forEach(function (x) {
          var on = (x[0] === "one") === oneSeat;
          var b = h("button", "ep-seatmix-btn" + (on ? " on" : ""), x[1]);
          b.addEventListener("click", function () {
            oneSeat = x[0] === "one";
            paintAll();
          });
          mixBox.appendChild(b);
        });
      }
      var names = slotNames();
      if (!names.length) {
        chips.appendChild(h("span", "ep-picked-empty", "还没人"));
      }
      names.forEach(function (n) {
        var c = h("button", "ep-pickchip", n + "  ×");
        c.title = "点一下从这一" + (mode === "fixed" ? "岗" : "槽") + "去掉";
        if (n === focusName) c.classList.add("focus");
        c.addEventListener("click", function () {
          var cur = slotNames().slice();
          var at = cur.indexOf(n);
          if (at >= 0) cur.splice(at, 1);
          writeSlot(cur);
          paintAll();
        });
        chips.appendChild(c);
      });
      /* 组里留着、名单里已经没有的姓名：数量写在屏上（一体机没有悬停） */
      var roster = rosterStudents();
      if (roster.length) {
        var have = {};
        roster.forEach(function (s) { if (s && s.name) have[s.name] = 1; });
        var miss = names.filter(function (n) { return !have[n]; });
        if (miss.length) {
          chips.appendChild(h("span", "ep-picked-warn", "另有 " + miss.length + " 人不在名单里"));
        }
      }
      pickedTitle.textContent = (mode === "fixed" ? "已选" : seatLabel(slot)) + " · " + names.length + " 人";
      if (mode !== "fixed" && !names.length) {
        pickedTitle.textContent = seatLabel(slot) + " · 还没排人";
      }
    }

    function paintModes() {
      modeRow.innerHTML = "";
      [["fixed", "固定"], ["ab", "A/B 轮流"], ["weekday", "按星期"]].forEach(function (m) {
        var b = h("button", "ep-modebtn" + (m[0] === mode ? " on" : ""), m[1]);
        b.addEventListener("click", function () { switchMode(m[0]); });
        modeRow.appendChild(b);
      });
    }

    var saveGroupOpen = false;

    function paintGroups() {
      groupBox.innerHTML = "";
      var defs = groupDefs(role, key);
      if (defs.length) {
        groupBox.appendChild(h("span", "ep-groups-label", "常用组"));
        defs.forEach(function (g) {
          var box = h("span", "ep-group");
          var label = g.name + (g.names.length ? " · " + g.names.length : "");
          if (g.missing) label += " · 缺" + g.missing;
          var b = h("button", "ep-group-chip" + (g.missing ? " ep-group-warn" : ""), label);
          b.addEventListener("click", function () {
            writeSlot(g.names.slice());
            g.names.forEach(function (n) { S.markPicked(n); });
            paintAll();
            flash("已带入「" + g.name + "」");
          });
          box.appendChild(b);
          if (g.source === "manual") {
            var x = h("button", "ep-group-del", "×");
            x.title = "删除这个组";
            x.addEventListener("click", function () {
              S.deleteGroup(g.id);
              paintGroups();
              flash("已删除「" + g.name + "」");
            });
            box.appendChild(x);
          }
          groupBox.appendChild(box);
        });
      }

      if (!saveGroupOpen) {
        var save = h("button", "ep-group-chip ep-group-new", "＋ 存为组");
        save.addEventListener("click", function () {
          if (!slotNames().length) { flash("先选人"); return; }
          saveGroupOpen = true;
          paintGroups();
        });
        groupBox.appendChild(save);
        return;
      }

      var nameInput = document.createElement("input");
      nameInput.className = "ep-input ep-group-name";
      nameInput.placeholder = "这组叫什么";
      var ok = h("button", "ep-mini", "存");
      ok.addEventListener("click", function () {
        var names = slotNames();
        if (!names.length) { flash("先选人"); return; }
        var name = String(nameInput.value || "").trim();
        if (!name) { flash("先给这组起个名字"); return; }
        if (S.peopleGroups().some(function (g) { return g.name === name; })) {
          flash("已有同名组「" + name + "」");
          return;
        }
        var roster = rosterStudents();
        var ids = names.map(function (n) {
          var hit = roster.filter(function (s) { return s && s.name === n; })[0];
          return hit ? (hit.id ? String(hit.id) : "name:" + n) : "name:" + n;
        });
        var r = S.saveGroup({ id: "g" + Date.now(), name: name, memberIds: ids, order: S.peopleGroups().length });
        if (!r.ok) { flash(r.why); return; }
        saveGroupOpen = false;
        paintGroups();
        flash("已存成「" + name + "」");
      });
      var no = h("button", "ep-mini", "取消");
      no.addEventListener("click", function () { saveGroupOpen = false; paintGroups(); });
      groupBox.appendChild(nameInput);
      groupBox.appendChild(ok);
      groupBox.appendChild(no);
    }

    function paintFoot() {
      foot.innerHTML = "";
      var saveBtn = h("button", "ep-primary", "保存");
      saveBtn.title = "写进岗位配置，以后每天都按这个来";
      saveBtn.addEventListener("click", saveLong);
      foot.appendChild(saveBtn);

      var todayBtn = h("button", "ep-ghost ep-todayonly", "只改今天");
      todayBtn.title = "只动今天这一天的值日条，不改岗位配置";
      todayBtn.addEventListener("click", saveToday);
      foot.appendChild(todayBtn);
    }

    function paintAll() {
      paintModes();
      paintSeats();
      paintChips();
      paintGrid();
      paintGroups();
      paintFoot();
    }

    function switchMode(k) {
      if (k === mode) return;
      var seed = slotNames().slice();
      var r = S.setRoleMode ? S.setRoleMode(draft, k, { seed: seed }) : null;
      if (r && r.role) draft = r.role;
      else { draft.mode = k; }
      mode = k;
      slot = mode === "fixed" ? null : firstFilledSlot();
      focusName = "";
      paintAll();
      /* 人已经坐在「已选」里了，这句话只是确认「切成功了」，
         不再解释搬到哪儿——解释交给眼睛。 */
      if (seed.length) {
        flash("已切到" + (k === "fixed" ? "固定" : k === "ab" ? "A/B 轮流" : "按星期")
          + " · " + slotNames().length + " 人");
      }
    }

    /* 保存 = 写进岗位配置（长期）。写之前先把今天的临时覆盖清掉，
       否则屏上还是旧人，老师会以为没保存上。 */
    function saveLong() {
      var doc = JSON.parse(JSON.stringify(roleDoc()));
      var list = doc.roles || [];
      var at = -1;
      list.forEach(function (x, i) { if (x && x.id === role.id) at = i; });
      if (at < 0) { flash("找不到岗位配置"); return; }
      list[at] = draft;
      S.patchConfig({ roles: doc });
      var ovr = (S.getDayOverride(key) || {}).roles || {};
      if (ovr[role.id]) {
        delete ovr[role.id];
        S.patchDayOverride(key, { roles: ovr });
      }
      closePicker();
      var saved = slotNames();
      flash(role.name + " 已保存"
        + (saved.length ? "：" + (saved.length > 3 ? saved.length + " 人" : saved.join("、")) : ""));
      renderBody(role.id);
    }

    /* 只改今天：写当天的临时覆盖，岗位配置一个字都不动 */
    function saveToday() {
      var names = slotNames().slice();
      var ovr = (S.getDayOverride(key) || {}).roles || {};
      if (names.length) ovr[role.id] = { people: names };
      else delete ovr[role.id];
      S.patchDayOverride(key, { roles: ovr });
      closePicker();
      flash(names.length
        ? role.name + " 今天换成 " + (names.length > 3 ? names.length + " 人" : names.join("、"))
        : role.name + " 今天恢复原样");
      renderBody(role.id);
    }

    q.addEventListener("input", paintGrid);

    /* 从值日行点某个人名进来：直接落到他所在的那个槽位 */
    if (focusName) {
      var found = null;
      slotList().forEach(function (s) {
        if (found === null && slotNames(s).indexOf(focusName) >= 0) found = s;
      });
      if (found !== null) slot = found;
    }

    paintAll();
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

  /* 数据体检：形状坏掉的由 Store 的写闸门自动修；这里列的是
     「形状没问题、只是这个人不在名单里了」——组还在、点开却是空的，
     老师最容易把这一类当成「功能丢了」。不自动认领（可能认错同名），
     只把清单摆出来，能修的给一个按钮。 */
  function renderAudit(sec) {
    var box = h("div", "ep-audit");
    box.appendChild(h("div", "ep-slot-title", "名单与分组对得上吗"));

    var a = S.auditPeople ? S.auditPeople() : { ok: true, hasRoster: false, items: [] };
    if (!a.hasRoster) {
      box.appendChild(h("p", "ep-note",
        "还没录入班级名单，先不检查。到向导里补上名单后，这里会告诉你哪些人对不上。"));
      sec.appendChild(box);
      return;
    }
    if (a.ok) {
      box.appendChild(h("p", "ep-note", "都对得上：分组和岗位里的人都在当前名单里。"));
      sec.appendChild(box);
      return;
    }

    box.appendChild(h("p", "ep-note",
      "下面这些名字写在配置里，但不在当前名单里——多半是名单重录过，或者当初手打错了。"
      + "组和人不会因为这条提示消失，改一下名单或点下面的按钮就行。"));
    var list = h("div", "ep-rows");
    a.items.forEach(function (it) {
      var row = h("div", "ep-row static");
      row.appendChild(h("span", "p", (it.kind === "group" ? "分组 · " : "岗位 · ") + it.name));
      row.appendChild(h("span", "s", it.detail));
      list.appendChild(row);
    });
    box.appendChild(list);

    var fix = h("button", "ep-mini ep-audit-fix", "修一遍能修的");
    fix.title = "把组员里旧的学生编号（s01）换成姓名，换名单也不会整片丢人；认不出的不动";
    fix.addEventListener("click", function () {
      var r = S.fixGroupKeys ? S.fixGroupKeys() : { fixed: 0 };
      flash(r.fixed
        ? "已把 " + r.fixed + " 个旧编号换成姓名"
        : "没有能自动修的，剩下的请对照名单手动改");
      renderBody();
    });
    box.appendChild(fix);
    sec.appendChild(box);
  }

  /* ---------- 备份 / 迁移 ---------- */
  /* 老师改的文字只在这台机器的浏览器里。想换机器、或者请人重新打包，
     得先把它导出来——不然对面拿到的永远是出厂文案。 */
  function renderBackup() {
    var sec = h("section", "ep-sec wide");
    sec.appendChild(h("h3", null, "本机备份与恢复"));
    sec.appendChild(h("p", "ep-note",
      "班级、名单、课表都存在这台电脑上，大屏开着时每天自动存一份快照。"
      + "改坏了、误删了，点下面的「恢复」回到那一天就行——更新版本也不需要做任何事。"));

    /* 先给「恢复」：大多数时候老师要的是把配置找回来，不是搬去别处。 */
    renderAutoBackup(sec);

    sec.appendChild(h("h3", null, "换电脑时用"));
    sec.appendChild(h("p", "ep-note",
      "要把配置带到另一台电脑（或换一体机），才用下面这两种方式。"
      + "同一台电脑上升级，数据会自己留着，不用导文件。"));

    var text = JSON.stringify(S.exportAll(), null, 2);

    var row = h("div", "ep-backup");
    var out = h("button", "ep-mini", "导出成文件");
    out.addEventListener("click", function () { doExport(text); });
    row.appendChild(out);

    var file = h("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.style.display = "none";
    file.addEventListener("change", function () { doImport(file); });
    var inp = h("button", "ep-mini", "从文件导入");
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
    renderAudit(sec);
  }

  /* 本机自动备份：大屏开着就每天存一份，这里只负责「看有哪些、点一下恢复」。
     backups/config 里有学生名册，所以必须提醒一句别连文件夹一起转出去。 */
  function renderAutoBackup(sec) {
    if (!root.Backup) return;
    sec.appendChild(h("h3", null, "本机自动备份"));
    var box = h("div", "ep-auto");
    sec.appendChild(box);

    function done(label) {
      return function (r) {
        if (r && r.ok) {
          flash("已按 " + label + " 恢复，马上刷新");
          setTimeout(function () { location.reload(); }, 700);
        } else {
          flash((r && r.why) || "这份备份打不开");
        }
      };
    }

    if (root.Backup.mode() !== "http") {
      var saved = root.Backup.local();
      if (saved) {
        var when = String(saved.savedAt || "").slice(0, 16).replace("T", " ");
        var b = h("button", "ep-mini", "恢复浏览器副本（" + when + "）");
        b.addEventListener("click", function () {
          root.Backup.restoreLocal(done("浏览器副本"));
        });
        var row = h("div", "ep-backup");
        row.appendChild(b);
        box.appendChild(row);
      }
      /* 双击打开时 localStorage 就是唯一副本，换目录就没了：
         一个月没导出（或从没导出过）就在面板里催一次，不弹窗、不挡屏。 */
      if (root.Backup.staleExport()) {
        var warn = h("div", "ep-warn");
        var last = root.Backup.lastExport();
        warn.appendChild(h("p", null, last
          ? "上次导出设置是 " + Math.floor((Date.now() - last) / 86400000)
            + " 天前。双击打开时配置只在这个浏览器里，换目录或清缓存就会清零。"
          : "还没导出过设置。双击打开时配置只在这个浏览器里，"
            + "换目录、清缓存或换电脑就会清零。"));
        var exp = h("button", "ep-mini", "现在导出一份");
        exp.addEventListener("click", function () {
          doExport(JSON.stringify(S.exportAll(), null, 2));
        });
        warn.appendChild(exp);
        box.appendChild(warn);
      }
      box.appendChild(h("p", "ep-note",
        "当前是双击文件打开的，写不进磁盘。用桌面版（桌面上的 ClassBeat 图标）"
        + "打开才有每日备份；这里最多留一格浏览器副本。"));
      return;
    }

    box.appendChild(h("p", "ep-note", "正在读本机备份…"));
    root.Backup.list(function (items) {
      box.textContent = "";
      if (!items.length) {
        box.appendChild(h("p", "ep-note",
          "还没有备份。大屏开着就会每天自动存一份，留最近 14 天。"));
      } else {
        items.forEach(function (it) {
          var row = h("div", "ep-backup");
          row.appendChild(h("span", "ep-steptag",
            it.day + " · " + (it.klass || "未命名班") + " · "
            + Math.max(1, Math.round((it.size || 0) / 1024)) + " KB"));
          var btn = h("button", "ep-mini", "恢复");
          btn.addEventListener("click", function () {
            root.Backup.restore(it.day, done(it.day));
          });
          row.appendChild(btn);
          box.appendChild(row);
        });
      }
      box.appendChild(h("p", "ep-note",
        "备份在电脑上的 backups/config 里，含学生名册：别把这个文件夹转给别人，"
        + "要分享请发原始安装包。"));
    });
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
    if (ok && root.Backup) root.Backup.noteExport();
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

  root.Edit = {
    open: open, close: close,
    /* 测试钩子（同 setup.js 的 _parseTimeRows 先例）：作息校验是纯函数，
       单测直接喂块数组，不用真开面板 */
    _hoursProblem: hoursProblem
  };
})(window);
