/* 配置向导（P5）。
 *
 * 解决的不是"改一个时间"（作息页早就能改），是"从空白到这个班的屏"：
 * 别的老师拿到包，屏上是别人的班、别人的作息、别人的课表。
 *
 * 四步：班级 → 作息 → 课表 → 岗位 / 文案。每一步都能跳过，改完立刻生效，
 * 不用重新打包、不用命令行。产出仍是 localStorage 里的本机配置，
 * 换电脑时用「导出设置」把整份带走。
 *
 * 第四步只做最小编辑：岗位能改名称和职责，文案能改常用的那几组。
 * 人员名单、执行频率、轮换规则一律原样保留——那些不是改字能解决的，
 * 硬改只会让屏上出现一半新一半旧的岗位。不导入岗位表，也不新增岗位。
 *
 * 为什么不在这里生成 zip：file:// 页面没有写磁盘的权限，硬做只能把
 * 整个 server/ 当字符串塞进网页再用 JSZip 拼包，体积和维护都不划算。
 */
(function (root) {
  "use strict";

  var KEY = "rhythm.setup.draft.v1";
  var DRAFT_DAYS = 7;
  var STEP_NAMES = ["班级", "作息", "课表", "岗位 / 文案"];

  /* 文案字段与 edit.js 完全同一套键：不新建存储，也不另造一套命名。 */
  var STAGES = [
    { key: "before",  label: "到校（打铃前）", title: "早上好",     note: "到校后先交作业、整理书包" },
    { key: "closed",  label: "放学以后",       title: "放学了",     note: "整理好书包，路上注意安全" },
    { key: "holiday", label: "休息日",         title: "今天不上学", note: "好好休息，明天见" }
  ];
  var WEEKDAYS = [
    { n: 1, label: "周一" }, { n: 2, label: "周二" }, { n: 3, label: "周三" },
    { n: 4, label: "周四" }, { n: 5, label: "周五" }
  ];
  var TEXT_GROUPS = ["stage", "reminders", "reading", "prep", "tips"];

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

  function localStore() { return root.Store || {}; }

  /* 当前生效文案（包内默认 + 本机改动）。第四步改的就是这一份。 */
  function effectiveTexts() {
    return localStore().texts ? (localStore().texts() || {}) : ((root.RHYTHM_DATA && root.RHYTHM_DATA.texts) || {});
  }

  function same(a, b) { return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); }

  /* 文案按“组”比较：edit.js 存的就是这些顶层键，没有更细的补丁接口。 */
  function buildTextPatch(cur, base) {
    cur = cur || {};
    base = base || {};
    var patch = {};
    TEXT_GROUPS.forEach(function (g) {
      if (same(cur[g], base[g])) return;
      patch[g] = (cur[g] && Object.keys(cur[g]).length) ? clone(cur[g]) : null;
    });
    ["breakTitle", "prepLabel"].forEach(function (k) {
      if ((cur[k] || "") === (base[k] || "")) return;
      patch[k] = (cur[k] && String(cur[k]).trim()) ? cur[k] : null;
    });
    if (!same(cur.breakActions, base.breakActions)) {
      patch.breakActions = (cur.breakActions && cur.breakActions.length) ? cur.breakActions.slice() : null;
    }
    return patch;
  }

  /* 岗位只改 name / duty，按 id 定位，其余字段整对象保留。 */
  function editRole(set, id, field, value) {
    var out = clone(set);
    (out && out.roles || []).forEach(function (r) {
      if (r.id === id) r[field] = value;
    });
    return out;
  }

  function freqText(freq) {
    if (!freq || freq.kind === "unset") return "尚未设置执行频率，不产生提醒。";
    if (freq.kind === "daily") {
      return "每天" + (freq.times && freq.times.length ? " " + freq.times.join("、") : "");
    }
    if (freq.kind === "event") return "事件：" + (freq.event || "未写");
    if (freq.kind === "each") return "每节课";
    if (freq.kind === "task") return "跟着「" + (freq.task || "任务") + "」";
    if (freq.kind === "cycle") {
      return "按 A/B 组轮换" + (freq.times && freq.times.length ? " " + freq.times.join("、") : "");
    }
    return "时间安排未识别";
  }

  function roleChangedCount(cur, base) {
    var n = 0;
    var byId = {};
    ((base && base.roles) || []).forEach(function (r) { byId[r.id] = r; });
    ((cur && cur.roles) || []).forEach(function (r) {
      var b = byId[r.id];
      if (!b) return;
      if (b.name !== r.name) n++;
      if (b.duty !== r.duty) n++;
    });
    return n;
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
    var roles = clone(c.roles || null);
    var texts = clone(effectiveTexts());
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
      roles: roles,
      rolesBase: clone(roles),
      texts: texts,
      textsBase: clone(texts),
      applied: false
    };
  }

  /* 旧草稿是 B4 之前存的，没有 roles / texts。补上当前生效值，
     不要把 undefined 当成“老师清空了岗位和文案”。 */
  function fillState(s) {
    if (!s) return s;
    if (!("roles" in s)) s.roles = clone(cfg().roles || null);
    if (!("rolesBase" in s)) s.rolesBase = clone(s.roles);
    if (!("texts" in s)) s.texts = clone(effectiveTexts());
    if (!("textsBase" in s)) s.textsBase = clone(s.texts);
    return s;
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

  /* ---------- 第四步：岗位 / 文案 ---------- */
  /* 只列课表里已经用到的科目：没排课的科目写了准备清单也不会出现在屏上。 */
  function usedSubjects() {
    var used = {}, out = [];
    (state.entries || []).forEach(function (e) { if (e.subject) used[e.subject] = 1; });
    ((cfg().content || {}).subjects || []).forEach(function (s) {
      (s.labels || [s.key]).forEach(function (l) {
        if (used[l] && out.indexOf(s.key) < 0) out.push(s.key);
      });
    });
    Object.keys(used).forEach(function (u) { if (out.indexOf(u) < 0) out.push(u); });
    return out;
  }

  /* 提示语只做作息里真有名字的时段；正课的名字来自课表，不在这里改。 */
  function tipBlocks() {
    var seen = {}, out = [];
    (state.blocks || []).forEach(function (b) {
      if (b.type === "class" || !b.name || seen[b.name]) return;
      seen[b.name] = 1;
      out.push({ name: b.name, tip: b.tip || "" });
    });
    return out;
  }

  function textAt(keys) {
    var n = state.texts || {};
    for (var i = 0; i < keys.length; i++) {
      if (n == null) return "";
      n = n[keys[i]];
    }
    return n == null ? "" : n;
  }

  function setText(keys, value) {
    if (!state.texts) state.texts = {};
    var parents = [state.texts];
    var n = state.texts;
    for (var i = 0; i < keys.length - 1; i++) {
      if (!n[keys[i]] || typeof n[keys[i]] !== "object") n[keys[i]] = {};
      n = n[keys[i]];
      parents.push(n);
    }
    var last = keys[keys.length - 1];
    var v = value == null ? "" : String(value).trim();
    if (v) n[last] = v;
    else delete n[last];
    /* 空父节点一起删：补丁里留空对象会分不清“没改”和“清空”。 */
    for (var j = keys.length - 2; j >= 0; j--) {
      if (parents[j][keys[j]] && Object.keys(parents[j][keys[j]]).length) break;
      delete parents[j][keys[j]];
    }
  }

  function setBreakActions(body) {
    if (!state.texts) state.texts = {};
    var list = String(body || "").split(/[,，、;；\s]+/)
      .map(function (s) { return s.trim(); }).filter(Boolean);
    if (list.length) state.texts.breakActions = list;
    else delete state.texts.breakActions;
  }

  function textSection(title, hint, rows, open) {
    var d = el("details", "setup-text-sec");
    if (open) d.setAttribute("open", "");
    var s = el("summary", "setup-text-head");
    s.appendChild(el("span", "setup-text-title", title));
    s.appendChild(el("span", "setup-text-hint", hint || ""));
    d.appendChild(s);
    rows.forEach(function (r) { d.appendChild(r); });
    return d;
  }

  function roleSection(p) {
    var rs = state.roles;
    if (!rs || !Array.isArray(rs.roles) || !rs.roles.length) {
      p.appendChild(el("p", "setup-p", "这个包没有岗位表。跳过这一步也不影响前面三步。"));
      return;
    }

    var src = el("div", "setup-src");
    if (rs.class && rs.class !== state.klass) {
      src.classList.add("warn");
      src.appendChild(el("b", null, "这些岗位来自打包来源班「" + rs.class + "」"));
      src.appendChild(el("span", null, "现在配的是「" + (state.klass || "未填") + "」。"
        + "可以只改名称和职责；人员、执行频率、轮换规则都原样保留。"
        + "不想用就跳过这一步——屏上不会写入任何岗位。"));
    } else {
      src.appendChild(el("b", null, "岗位清单：共 " + rs.roles.length + " 个"
        + (rs.class ? "（来源班「" + rs.class + "」）" : "")));
      src.appendChild(el("span", null, "只改名称和职责，人员、执行频率、轮换规则原样保留。"));
    }
    p.appendChild(src);

    var list = el("div", "setup-roles");
    rs.roles.forEach(function (r) {
      var card = el("div", "setup-role");

      var head = el("div", "setup-role-head");
      var f = r.freq || {};
      head.appendChild(el("span", "setup-role-id", r.id));
      head.appendChild(el("span", "setup-role-freq" + (f.kind === "unset" ? " unset" : ""), freqText(f)));
      card.appendChild(head);

      card.appendChild(field("名称", r.name, function (v) {
        state.roles = editRole(state.roles, r.id, "name", v);
      }));
      card.appendChild(field("职责", r.duty || "", function (v) {
        state.roles = editRole(state.roles, r.id, "duty", v);
      }, "text", "一句话写清要做什么"));

      list.appendChild(card);
    });
    p.appendChild(list);
  }

  function textSectionList(p) {
    var T = state.texts || {};

    var d1 = textSection("每天提醒", "早读时黄色贴纸上的那句话", [
      field("每天提醒", textAt(["reminders", "default"]),
        function (v) { setText(["reminders", "default"], v); },
        "text", "带齐今天要用的书和作业，课前摆好。")
    ], true);
    p.appendChild(d1);

    var stageRows = [];
    STAGES.forEach(function (st) {
      stageRows.push(field(st.label + " · 大字",
        textAt(["stage", st.key, "title"]),
        function (v) { setText(["stage", st.key, "title"], v); },
        "text", st.title));
      stageRows.push(field(st.label + " · 一句话",
        textAt(["stage", st.key, "note"]),
        function (v) { setText(["stage", st.key, "note"], v); },
        "text", st.note));
    });
    p.appendChild(textSection("到校 · 放学 · 休息日", "这三句话不在作息里，是每天的两头", stageRows));

    var brRows = [
      field("课间 · 大字", textAt(["breakTitle"]),
        function (v) { setText(["breakTitle"], v); }, "text", "课间"),
      field("课间 · 第一行", (T.breakActions || []).join("，"),
        function (v) { setBreakActions(v); }, "text", "喝水，上厕所"),
      field("课间 · 第二行开头", textAt(["prepLabel"]),
        function (v) { setText(["prepLabel"], v); }, "text", "准备好")
    ];
    p.appendChild(textSection("课间这一屏", "大字一行，下面两行：先做什么、带什么", brRows));

    var readRows = [];
    WEEKDAYS.forEach(function (w) {
      var key = String(w.n);
      readRows.push(field(w.label + " · 科目", textAt(["reading", key, "subject"]),
        function (v) { setText(["reading", key, "subject"], v); }, "text", "语文"));
      readRows.push(field(w.label + " · 早读建议", textAt(["reading", key, "task"]),
        function (v) { setText(["reading", key, "task"], v); },
        "text", "今天读第 5 课，背《古诗三首》"));
    });
    p.appendChild(textSection("早读 5 天建议", "科目空着这一天就只显示「早读」，不猜", readRows));

    var prepRows = [];
    var subs = (cfg().content || {}).subjects || [];
    usedSubjects().forEach(function (key) {
      var s = subs.filter(function (x) { return x.key === key; })[0];
      prepRows.push(field(key + " · 要带什么", (textAt(["prep", key]) || []).join("，"),
        function (v) {
          if (!state.texts) state.texts = {};
          var list = String(v || "").split(/[,，、;；\s]+/)
            .map(function (x) { return x.trim(); }).filter(Boolean);
          if (!state.texts.prep) state.texts.prep = {};
          if (list.length) state.texts.prep[key] = list;
          else {
            delete state.texts.prep[key];
            if (!Object.keys(state.texts.prep).length) delete state.texts.prep;
          }
        },
        "text", s ? (s.items || []).join("，") : "用逗号隔开"));
    });
    if (prepRows.length) {
      p.appendChild(textSection("每科要带什么", "只列课表里已经排到的科目", prepRows));
    }

    var tipRows = [];
    tipBlocks().forEach(function (b) {
      tipRows.push(field(b.name, textAt(["tips", b.name]),
        function (v) { setText(["tips", b.name], v); },
        "text", b.tip || "（这一时段没有提示语）"));
    });
    if (tipRows.length) {
      p.appendChild(textSection("各时段的提示语", "只列有名字的时段；留空就是原来的话", tipRows));
    }
  }

  function pageDone() {
    var p = el("div", "setup-page on");
    var filled = state.entries.filter(function (e) { return e.subject; }).length;
    var classes = state.blocks.filter(function (b) { return b.type === "class"; }).length;

    if (state.applied) {
      p.appendChild(el("h3", "setup-h", "已经生效"));
      p.appendChild(el("p", "setup-p", "屏上现在就是新班级、新作息、新课表，岗位和文案也换成了这里填的。"));
    } else {
      p.appendChild(el("h3", "setup-h", "确认一下：岗位和文案也能在这里改"));
      p.appendChild(el("p", "setup-p", "点「应用到这台机器」之前，改的都还只是草稿，屏上不会变。岗位和文案不改也能直接应用。"));
    }
    if (state.flash) p.appendChild(el("p", "setup-msg ok", state.flash));

    var sum = el("div", "setup-sum");
    sum.appendChild(el("div", null, "班级：" + (state.klass || "我的班") + (state.school ? "　·　" + state.school : "")));
    sum.appendChild(el("div", null, "班主任：" + (state.head || "未填")));
    sum.appendChild(el("div", null, "作息：" + classes + " 节正课，" + state.blocks.length + " 段"));
    if (state.blocks.length) {
      sum.appendChild(el("div", null, "从 " + state.blocks[0].start + " 到 " + state.blocks[state.blocks.length - 1].end));
    }
    sum.appendChild(el("div", null, "课表：已填 " + filled + " 格 / " + (periodCount() * 5) + " 格"));
    p.appendChild(sum);

    roleSection(p);
    textSectionList(p);
    p.appendChild(el("p", "setup-p", "文案留空就是回到系统原来那句话。改动只存在这台机器上，不影响别人的班。"));

    var acts = el("div", "setup-actions");
    var apply = el("button", "setup-btn primary", state.applied ? "重新应用" : "应用到这台机器");
    apply.type = "button";
    apply.addEventListener("click", applyAll);
    acts.appendChild(apply);

    var snap = localStore().setupSnapshot ? localStore().setupSnapshot() : null;
    var restore = el("button", "setup-btn ghost", "恢复至修改前");
    restore.type = "button";
    restore.disabled = !snap;
    restore.addEventListener("click", restoreAll);
    acts.appendChild(restore);

    var discard = el("button", "setup-btn ghost", "放弃岗位 / 文案的修改");
    discard.type = "button";
    discard.addEventListener("click", function () {
      state.roles = clone(state.rolesBase);
      state.texts = clone(state.textsBase);
      saveDraft();
      render();
    });
    acts.appendChild(discard);

    var out = el("button", "setup-btn", "导出设置 JSON");
    out.type = "button";
    out.addEventListener("click", exportAll);
    acts.appendChild(out);

    var inp = el("button", "setup-btn", "导入设置 JSON");
    inp.type = "button";
    inp.addEventListener("click", pickImport);
    acts.appendChild(inp);
    p.appendChild(acts);

    p.appendChild(el("p", "setup-p", "导出的是整份设置（含岗位、文案和本机偏好）。换电脑后点「导入设置 JSON」，选对方给的这份文件，班级、作息、课表、岗位、文案一起搬过来。"));

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

  /* ---------- 保存 / 快照 / 恢复 ----------
     岗位和文案是本机配置的一部分，改坏了屏上会立刻多出别人的岗位。
     所以写之前先记一份原始快照，写完回读校验，对不上就自己退回去。 */
  function makeSnapshot() {
    var raw = (localStore().config && localStore().config()) || {};
    return {
      savedAt: new Date().toISOString(),
      roles: raw.roles !== undefined ? clone(raw.roles) : null,
      texts: (localStore().textsLocal && localStore().textsLocal()) || null
    };
  }

  function rollback(snap) {
    if (!snap) return;
    if (localStore().patchConfig) {
      localStore().patchConfig({ roles: snap.roles == null ? null : clone(snap.roles) });
    }
    if (localStore().setTextsLocal) {
      localStore().setTextsLocal(snap.texts ? clone(snap.texts) : {});
    }
    if (root.Runtime && root.Runtime.reload) root.Runtime.reload();
  }

  function verifyWrite(rolesNow, textPatch) {
    if (rolesNow) {
      var c = (localStore().config && localStore().config()) || {};
      if (!same(c.roles, rolesNow)) return false;
    }
    if (textPatch && Object.keys(textPatch).length) {
      var local = (localStore().textsLocal && localStore().textsLocal()) || {};
      var eff = effectiveTexts() || {};
      var bad = Object.keys(textPatch).some(function (k) {
        if (textPatch[k] == null) return k in local;
        return !same(eff[k], textPatch[k]);
      });
      if (bad) return false;
    }
    return true;
  }

  function confirmLayer(lines, onOk) {
    var layer = el("div", "setup-confirm");
    var card = el("div", "setup-confirm-card");
    card.appendChild(el("h4", "setup-confirm-h", "保存前确认"));
    lines.forEach(function (t) { card.appendChild(el("div", "setup-confirm-line", t)); });

    var acts = el("div", "setup-confirm-acts");
    var back = el("button", "setup-btn ghost", "返回修改");
    back.type = "button";
    back.addEventListener("click", function () { layer.remove(); });
    acts.appendChild(back);

    var ok = el("button", "setup-btn primary", "确认保存");
    ok.type = "button";
    ok.addEventListener("click", function () {
      layer.remove();
      onOk();
    });
    acts.appendChild(ok);
    card.appendChild(acts);

    layer.appendChild(card);
    box.appendChild(layer);
  }

  function applyAll() {
    if (!root.Runtime || !root.Runtime.patch) return;
    var rolesNow = (!same(state.roles, state.rolesBase) && state.roles) ? state.roles : null;
    var textPatch = buildTextPatch(state.texts, state.textsBase);
    var rc = roleChangedCount(state.roles, state.rolesBase);
    var tk = Object.keys(textPatch).length;

    var lines = [
      "班级 / 作息 / 课表：按前面三步的填写一起写入。",
      "岗位：" + (rc ? "改了 " + rc + " 处名称或职责，会写入。" : "没有改动，不会写入。"),
      "文案：" + (tk ? "改了 " + tk + " 组，会写入。" : "没有改动，不会写入。"),
      "写入前会自动记一份快照，改坏了可以点「恢复至修改前」。"
    ];
    confirmLayer(lines, function () { doApply(rolesNow, textPatch); });
  }

  /* 岗位和文案的写入本体：先快照，写后回读，失败就还原。
     不碰 DOM，便于 node 里模拟写入失败。 */
  function commitRolesTexts(rolesNow, textPatch) {
    var snap = makeSnapshot();
    if (localStore().setupSnapshot) localStore().setupSnapshot(snap);

    var broke = false;
    try {
      if (rolesNow) root.Runtime.patch({ roles: clone(rolesNow) });
      if (textPatch && Object.keys(textPatch).length) localStore().patchTexts(textPatch);
    } catch (e) { broke = true; }

    if (broke || !verifyWrite(rolesNow, textPatch)) {
      rollback(snap);
      return false;
    }
    return true;
  }

  function doApply(rolesNow, textPatch) {
    if (!root.Runtime || !root.Runtime.patch) return;
    if (!commitRolesTexts(rolesNow, textPatch)) {
      state.applied = false;
      render();
      alertBox("写入没有成功，已还原修改前的岗位和文案。可能是这台机器存储空间满了。");
      return;
    }

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

    state.rolesBase = clone(state.roles);
    state.textsBase = clone(state.texts);
    state.applied = true;
    state.flash = "已保存。屏上已经是这个班的岗位和文案了。";
    clearDraft();
    render();
  }

  function restoreAll() {
    var snap = localStore().setupSnapshot ? localStore().setupSnapshot() : null;
    if (!snap) {
      alertBox("还没有保存过，没有可恢复的快照。");
      return;
    }
    if (root.confirm && !root.confirm("只恢复岗位和文案，不改班级、作息、课表。继续？")) return;

    if (localStore().patchConfig) {
      localStore().patchConfig({ roles: snap.roles == null ? null : clone(snap.roles) });
    }
    if (localStore().setTextsLocal) {
      localStore().setTextsLocal(snap.texts ? clone(snap.texts) : {});
    }
    if (root.Runtime && root.Runtime.reload) root.Runtime.reload();
    if (root.Screen && root.Screen.render) root.Screen.render();

    state.roles = clone(cfg().roles || null);
    state.rolesBase = clone(state.roles);
    state.texts = clone(effectiveTexts());
    state.textsBase = clone(state.texts);
    state.flash = "已恢复到这轮修改前（只动了岗位和文案）。";
    saveDraft();
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

  /* ---------- 导入 ----------
     老师之间传的是一个 JSON，不是一个 zip：文件更小，也不会带进
     别人包里的旧脚本。选完立刻生效，失败一个字都不改。 */
  function pickImport() {
    if (!root.Store || !root.Store.importAll) return;
    var file = document.createElement("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.style.cssText = "position:fixed;left:-200px;top:0;width:1px;height:1px;opacity:0";
    document.body.appendChild(file);

    function drop() {
      if (file.parentNode) file.parentNode.removeChild(file);
    }

    file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      if (!f) { drop(); return; }
      if (f.size > 2 * 1024 * 1024) {
        alertBox("这个文件有 " + Math.round(f.size / 1024) + " KB，不像设置文件。");
        drop();
        return;
      }
      if (typeof root.FileReader === "undefined") {
        alertBox("这个浏览器不支持选文件，请在电脑上导入。");
        drop();
        return;
      }
      var fr = new root.FileReader();
      fr.onerror = function () {
        alertBox("文件读不出来，换一个再试。原有设置没有改动。");
        drop();
      };
      fr.onload = function () {
        drop();
        var obj = null;
        try { obj = JSON.parse(String(fr.result)); }
        catch (e) {
          alertBox("这个文件不是 JSON，可能选错了。原有设置没有改动。");
          return;
        }
        var r = root.Store.importAll(obj);
        if (!r.ok) {
          alertBox("导入失败：" + r.why + "。原有设置没有改动。");
          return;
        }
        state = fillState(loadCurrent());
        state.applied = true;
        state.flash = "已导入" + (r.klass ? "「" + r.klass + "」的" : "") + "整份设置，屏上已经换过来。";
        clearDraft();
        render();
      };
      fr.readAsText(f, "utf-8");
    });
    file.click();
  }

  /* ---------- 开关 ---------- */
  function open() {
    if (!box) return;
    state = fillState(readDraft() || loadCurrent());
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
    _errors: function (blocks) { return blockErrors(blocks); },
    /* 纯函数给 node 测试用：不碰 DOM，也不读写 localStorage */
    _freqText: freqText,
    _editRole: editRole,
    _textPatch: buildTextPatch,
    _roleChangedCount: roleChangedCount,
    _commit: commitRolesTexts
  };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})(typeof window !== "undefined" ? window : globalThis);
