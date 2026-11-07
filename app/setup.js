/* 配置向导（P5）。
 *
 * 解决的不是"改一个时间"（作息页早就能改），是"从空白到这个班的屏"：
 * 别的老师拿到包，屏上是别人的班、别人的作息、别人的课表。
 *
 * 四步：班级 → 作息 → 课表 → 确认。每一步都能跳过，改完立刻生效，
 * 不用重新打包、不用命令行。产出仍是 localStorage 里的本机配置，
 * 换电脑时用「导出设置」把整份带走。
 *
 * 为什么不在这里生成 zip：file:// 页面没有写磁盘的权限，硬做只能把
 * 整个 server/ 当字符串塞进网页再用 JSZip 拼包，体积和维护都不划算。
 */
(function (root) {
  "use strict";

  var KEY = "rhythm.setup.draft.v1";
  var DRAFT_DAYS = 7;
  var STEP_NAMES = ["班级", "作息", "课表", "确认"];

  var state = null;
  var box = null;

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function cfg() {
    return (root.Runtime && root.Runtime.config) ? (root.Runtime.config() || {}) : {};
  }

  /* ---------- 草稿：中途关掉不用重填 ---------- */
  function saveDraft() {
    if (!state) return;
    state.ts = Date.now();
    try { root.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function readDraft() {
    try {
      var d = JSON.parse(root.localStorage.getItem(KEY) || "null");
      if (!d || !d.blocks || !d.blocks.length) return null;
      if (Date.now() - (d.ts || 0) > DRAFT_DAYS * 864e5) return null;
      return d;
    } catch (e) { return null; }
  }

  function clearDraft() {
    try { root.localStorage.removeItem(KEY); } catch (e) {}
  }

  /* ---------- 从当前生效配置起步 ---------- */
  function loadCurrent() {
    var c = cfg();
    var m = c.meta || {};
    var tt = c.timetable || {};
    var sc = c.schedule || {};
    return {
      step: 0,
      school: m.school || tt.school || sc.school || "",
      klass: m.klass || sc.class || "",
      head: m.headTeacher || sc.headTeacher || "",
      term: sc.termStart || "",
      tplId: "",
      blocks: clone(tt.blocks || []),
      noonBand: clone(tt.noonBand || null),
      marks: clone(tt.marks || []),
      entries: clone(sc.entries || []),
      applied: false
    };
  }

  function periodCount() {
    var n = 0;
    (state.blocks || []).forEach(function (b) {
      if (b.type === "class" && +b.periodNo > n) n = +b.periodNo;
    });
    return Math.max(n, 7);
  }

  /* ---------- 校验 ---------- */
  /* 首尾必须相接：留缝会在屏上变成"没有安排的时段"，
     引擎只能跳过，老师却以为那段时间还在上课。 */
  function blockErrors(blocks) {
    var bad = {};
    var prev = null;
    (blocks || state.blocks || []).forEach(function (b, i) {
      if (!b.start || !b.end || b.start >= b.end) bad[i] = "结束要晚于开始";
      else if (prev && b.start !== prev) bad[i] = "和上一段之间有空隙或重叠";
      prev = b.end;
    });
    return bad;
  }

  /* ---------- 渲染 ---------- */
  function render() {
    if (!box) return;
    box.innerHTML = "";
    var panel = el("div", "setup-panel");

    var head = el("div", "setup-head");
    head.appendChild(el("div", "setup-title", "配置这个班"));
    head.appendChild(el("div", "setup-sub", "四步，随时可以关掉，下次接着填"));
    var x = el("button", "setup-x", "×");
    x.type = "button";
    x.setAttribute("aria-label", "关闭");
    x.addEventListener("click", close);
    head.appendChild(x);
    panel.appendChild(head);

    panel.appendChild(steps());

    var body = el("div", "setup-body");
    body.appendChild(state.step === 0 ? pageClass()
      : state.step === 1 ? pageTime()
      : state.step === 2 ? pageGrid()
      : pageDone());
    panel.appendChild(body);

    panel.appendChild(foot());
    box.appendChild(panel);
  }

  function steps() {
    var wrap = el("div", "setup-steps");
    STEP_NAMES.forEach(function (name, i) {
      if (i) wrap.appendChild(el("i"));
      var s = el("div", "setup-step" + (i === state.step ? " on" : (i < state.step ? " done" : "")));
      s.appendChild(el("b", null, String(i + 1)));
      s.appendChild(el("span", null, name));
      wrap.appendChild(s);
    });
    return wrap;
  }

  function field(label, value, onInput, type, placeholder) {
    var row = el("div", "setup-field");
    row.appendChild(el("label", null, label));
    var input = el("input");
    input.type = type || "text";
    input.value = value || "";
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener("input", function () { onInput(input.value.trim()); saveDraft(); });
    row.appendChild(input);
    return row;
  }

  function pageClass() {
    var p = el("div", "setup-page on");
    p.appendChild(el("h3", "setup-h", "先告诉屏，这是哪个班"));
    p.appendChild(el("p", "setup-p", "这两行会出现在左上角、页面标题和消息服务里。以后想改，从「⋯ → 配置班级」再进来。"));
    p.appendChild(field("学校", state.school, function (v) { state.school = v; }, "text", "例如：春江中心小学"));
    p.appendChild(field("班级", state.klass, function (v) { state.klass = v; }, "text", "例如：五（5）班"));
    p.appendChild(field("班主任", state.head, function (v) { state.head = v; }, "text", "可以不填"));
    p.appendChild(field("开学日", state.term, function (v) { state.term = v; }, "date"));
    p.appendChild(el("p", "setup-p", "开学日用来算单双周和值日轮次；填错了只影响单双周课程，不影响作息。"));
    return p;
  }

  function pageTime() {
    var p = el("div", "setup-page on");
    p.appendChild(el("h3", "setup-h", "作息：先套一套相近的，再改不一样的地方"));
    p.appendChild(el("p", "setup-p", "下面每一段的开始和结束都能改。相邻两段必须首尾相接，中间不能留空。"));

    var tpls = el("div", "setup-tpls");
    (root.RHYTHM_TEMPLATES || []).forEach(function (t) {
      var b = el("button", "setup-tpl" + (state.tplId === t.id ? " on" : ""));
      b.type = "button";
      b.appendChild(el("b", null, t.label));
      b.appendChild(el("span", null, t.note));
      b.addEventListener("click", function () {
        if (!root.confirm || root.confirm("套用「" + t.label + "」会覆盖下面已经改过的时间，继续？")) {
          state.tplId = t.id;
          state.blocks = clone(t.blocks);
          state.noonBand = clone(t.noonBand);
          state.marks = clone(t.marks);
          saveDraft();
          render();
        }
      });
      tpls.appendChild(b);
    });
    p.appendChild(tpls);

    var bad = blockErrors();
    var list = el("div", "setup-blocks");
    var head = el("div", "setup-row head");
    ["段", "内容", "开始", "结束"].forEach(function (t) { head.appendChild(el("span", null, t)); });
    list.appendChild(head);

    state.blocks.forEach(function (b, i) {
      var row = el("div", "setup-row" + (bad[i] ? " bad" : ""));
      row.appendChild(el("span", "k", String(i + 1)));

      var name = b.type === "class" ? ("第 " + b.periodNo + " 节")
        : (b.name || b.type);
      row.appendChild(el("span", null, name));

      ["start", "end"].forEach(function (k) {
        var cell = el("span", "t");
        var inp = el("input");
        inp.type = "time";
        inp.value = b[k] || "";
        inp.addEventListener("change", function () {
          b[k] = inp.value;
          saveDraft();
          render();
        });
        cell.appendChild(inp);
        row.appendChild(cell);
      });
      list.appendChild(row);
    });
    p.appendChild(list);

    if (Object.keys(bad).length) {
      p.appendChild(el("p", "setup-msg", "有 " + Object.keys(bad).length + " 段时间不对，红色那几行改好才能继续。"));
    }
    return p;
  }

  function pageGrid() {
    var p = el("div", "setup-page on");
    p.appendChild(el("h3", "setup-h", "课表：5 天 × " + periodCount() + " 节"));
    p.appendChild(el("p", "setup-p", "只填科目就行，任课老师可以以后再说。空着的格子屏上显示「—」，不会报错。"));

    var subjects = {};
    var content = cfg().content;
    ((content && content.subjects) || []).forEach(function (s) {
      (s.labels || [s.key]).forEach(function (l) { subjects[l] = 1; });
    });
    ["语文", "数学", "英语", "体育", "音乐", "美术", "科学", "信息", "书法", "劳综"].forEach(function (s) { subjects[s] = 1; });

    var dl = el("datalist");
    dl.id = "setup-subjects";
    Object.keys(subjects).forEach(function (s) {
      var o = el("option"); o.value = s; dl.appendChild(o);
    });
    p.appendChild(dl);

    var grid = el("div", "setup-grid");
    var head = el("div", "setup-grid-row head");
    head.appendChild(el("span", null, "节"));
    ["周一", "周二", "周三", "周四", "周五"].forEach(function (d) {
      head.appendChild(el("span", null, d));
    });
    grid.appendChild(head);

    for (var n = 1; n <= periodCount(); n++) {
      var row = el("div", "setup-grid-row");
      row.appendChild(el("span", "no", String(n)));
      for (var w = 1; w <= 5; w++) {
        (function (w, n) {
          var cell = el("span");
          var inp = el("input");
          inp.type = "text";
          inp.setAttribute("list", "setup-subjects");
          var hit = state.entries.filter(function (e) {
            return +e.weekday === w && +e.periodNo === n;
          })[0];
          inp.value = (hit && hit.subject) || "";
          inp.addEventListener("input", function () {
            setEntry(w, n, inp.value.trim());
            saveDraft();
          });
          cell.appendChild(inp);
          row.appendChild(cell);
        })(w, n);
      }
      grid.appendChild(row);
    }
    p.appendChild(grid);

    if (!state.blocks.length) {
      p.appendChild(el("p", "setup-msg", "还没套用作息模板，课表排不进时间。先回上一步。"));
    }
    return p;
  }

  function setEntry(w, n, subject) {
    var hit = null;
    state.entries.forEach(function (e) {
      if (+e.weekday === w && +e.periodNo === n) hit = e;
    });
    if (!subject) {
      if (hit) state.entries = state.entries.filter(function (e) { return e !== hit; });
      return;
    }
    if (hit) hit.subject = subject;
    else state.entries.push({ weekday: w, periodNo: n, subject: subject });
  }

  function pageDone() {
    var p = el("div", "setup-page on");
    var filled = state.entries.filter(function (e) { return e.subject; }).length;
    var classes = state.blocks.filter(function (b) { return b.type === "class"; }).length;

    if (state.applied) {
      p.appendChild(el("h3", "setup-h", "已经生效"));
      p.appendChild(el("p", "setup-p", "屏上现在就是新班级、新作息、新课表。不用刷新，也不用重新打包。"));
    } else {
      p.appendChild(el("h3", "setup-h", "确认一下"));
      p.appendChild(el("p", "setup-p", "点「应用到这台机器」之前，改的都还只是草稿，屏上不会变。"));
    }

    var sum = el("div", "setup-sum");
    sum.appendChild(el("div", null, "班级：" + (state.klass || "我的班") + (state.school ? "　·　" + state.school : "")));
    sum.appendChild(el("div", null, "班主任：" + (state.head || "未填")));
    sum.appendChild(el("div", null, "作息：" + classes + " 节正课，" + state.blocks.length + " 段"));
    if (state.blocks.length) {
      sum.appendChild(el("div", null, "从 " + state.blocks[0].start + " 到 " + state.blocks[state.blocks.length - 1].end));
    }
    sum.appendChild(el("div", null, "课表：已填 " + filled + " 格 / " + (periodCount() * 5) + " 格"));
    p.appendChild(sum);

    var acts = el("div", "setup-actions");
    var apply = el("button", "setup-btn primary", state.applied ? "重新应用" : "应用到这台机器");
    apply.type = "button";
    apply.addEventListener("click", applyAll);
    acts.appendChild(apply);

    var out = el("button", "setup-btn", "导出设置 JSON");
    out.type = "button";
    out.addEventListener("click", exportAll);
    acts.appendChild(out);
    p.appendChild(acts);

    p.appendChild(el("p", "setup-p", "导出的是整份设置（含文案和本机偏好），换电脑后在编辑面板里导入就能搬过去。"));

    if (root.Runtime && root.Runtime.ready && !root.Runtime.ready()) {
      p.appendChild(el("p", "setup-msg", "提醒：这个包本身缺配置，应用后仍可能算不出全天。"));
    }
    return p;
  }

  function foot() {
    var f = el("div", "setup-foot");
    var back = el("button", "setup-btn ghost", "上一步");
    back.type = "button";
    back.disabled = state.step === 0;
    back.addEventListener("click", function () { state.step--; saveDraft(); render(); });
    f.appendChild(back);
    f.appendChild(el("span", "grow"));

    if (state.step < 3) {
      var next = el("button", "setup-btn primary", "下一步");
      next.type = "button";
      next.addEventListener("click", function () {
        if (state.step === 0 && !state.klass) {
          alertBox("先填班级名。「我的班」这种占位名屏上也能用，但家长会看到。");
          return;
        }
        if (state.step === 1) {
          var bad = blockErrors();
          if (Object.keys(bad).length) {
            alertBox("作息里有 " + Object.keys(bad).length + " 段时间不对，红色那几行先改好。");
            return;
          }
        }
        state.step++;
        saveDraft();
        render();
      });
      f.appendChild(next);
    } else {
      var done = el("button", "setup-btn primary", "完成");
      done.type = "button";
      done.addEventListener("click", close);
      f.appendChild(done);
    }
    return f;
  }

  function alertBox(msg) {
    var p = box.querySelector(".setup-msg");
    if (p) { p.textContent = msg; return; }
    var body = box.querySelector(".setup-body");
    if (body) body.appendChild(el("p", "setup-msg", msg));
  }

  function applyAll() {
    if (!root.Runtime || !root.Runtime.patch) return;
    var c = cfg();
    var timetable = clone(c.timetable || {});
    timetable.school = state.school;
    timetable.blocks = clone(state.blocks);
    if (state.noonBand) timetable.noonBand = clone(state.noonBand);
    if (state.marks && state.marks.length) timetable.marks = clone(state.marks);

    var schedule = clone(c.schedule || {});
    schedule.school = state.school;
    schedule.class = state.klass;
    schedule.headTeacher = state.head;
    if (state.term) schedule.termStart = state.term;
    schedule.entries = clone(state.entries).filter(function (e) { return e.subject; });

    root.Runtime.patch({
      meta: { school: state.school, klass: state.klass, headTeacher: state.head },
      timetable: timetable,
      schedule: schedule
    });

    state.applied = true;
    clearDraft();
    render();
  }

  function exportAll() {
    if (!root.Store || !root.Store.exportAll) return;
    var data = root.Store.exportAll();
    var text = JSON.stringify(data, null, 2);
    try {
      var blob = new Blob([text], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = ((root.CFG && root.CFG.fileSlug()) || "我的班") + "-设置.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    } catch (e) {
      alertBox("这个浏览器不支持下载文件，可以先在电脑上打开再导出。");
    }
  }

  /* ---------- 开关 ---------- */
  function open() {
    if (!box) return;
    state = readDraft() || loadCurrent();
    if (state.applied) state.applied = false;
    box.classList.add("open");
    box.setAttribute("aria-hidden", "false");
    render();
  }

  function close() {
    saveDraft();
    if (box) {
      box.classList.remove("open");
      box.setAttribute("aria-hidden", "true");
    }
  }

  function boot() {
    box = document.getElementById("setup");
    if (!box) return;
    var btn = document.getElementById("btn-setup");
    if (btn) btn.addEventListener("click", open);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && box.classList.contains("open")) close();
    });
  }

  root.Setup = {
    open: open, close: close,
    _errors: function (blocks) { return blockErrors(blocks); }
  };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})(typeof window !== "undefined" ? window : globalThis);
