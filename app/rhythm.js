/* 节律计算：只依赖「某一天」的对象（运行时由 Runtime.day 现算），不碰 DOM。
   stateAt(day, 分钟) → 屏上该显示什么；dutiesAt(day, 分钟) → 值日条。

   两层：
   coreStateAt  只算"这是什么时段、说什么"
   stateAt      在 core 之上补视觉焦点（tone / focus / hints / timer）
   —— 拆两层是因为测试断言的是 core 的文案，视觉调整不该动文案。 */
(function (root) {
  "use strict";

  var CD = {
    class:  { mode: "off" },
    ritual: { mode: "off" },
    reading: { mode: "off" },
    break:  { mode: "untilNext", showFrom: 10 },
    meal:   { mode: "untilEnd",  showFrom: 5 },
    noon:   { mode: "untilEnd",  showFrom: 10 },
    after:  { mode: "off" },
    action: { mode: "untilEnd",  showFrom: 5 },
    before: { mode: "untilEnd",  showFrom: 30 }
  };

  /* 四色语义：绿=可以动，蓝=专注，琥珀=准备，红=立刻停。
     红不在这里产生——红色只由老师手动发出的紧急通知触发，见 PLAN 2.20。 */
  var TONE = {
    class: "blue", ritual: "blue", reading: "blue",
    break: "green", meal: "green", noon: "green", after: "green",
    before: "green", closed: "green",
    action: "amber", holiday: "neutral"
  };

  /* 收尾阈值：进入这段倒计时，焦点从"现在是什么"切到"还剩多久"。
     眼保健操不在此列——闭着眼做操，屏上跳数字只会让人偷看。 */
  var CLOSING = { break: 2, ritual: 3, noon: 3, meal: 5, action: 5 };

  /* 动作提示只在刚下课的头 2 分钟出现。挂一整天等于没有提示。
     课间例外：整段都留着"喝水 / 上厕所"，因为这两件事贯穿整个课间。 */
  var HINTS = {
    meal:  ["排队打饭", "安静吃饭"],
    noon:  ["闭眼休息", "不说话"],
    closed: ["整理书包", "排队", "路上注意安全"]
  };

  var DEFAULT_BREAK_ACTIONS = ["喝水", "上厕所"];

  function t2m(s) {
    var p = s.split(":");
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  function m2t(m) {
    var h = Math.floor(m / 60), mm = Math.floor(m % 60);
    return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
  }

  function mmss(min) {
    var s = Math.max(0, Math.ceil(min * 60));
    var m = Math.floor(s / 60), ss = s % 60;
    return m + ":" + (ss < 10 ? "0" : "") + ss;
  }

  function human(minutes) {
    var m = Math.ceil(minutes);
    if (m <= 0) return "马上";
    if (m < 60) return m + " 分钟";
    var h = Math.floor(m / 60), r = m % 60;
    return h + " 小时" + (r ? " " + r + " 分" : "");
  }

  function blockIndexAt(day, m) {
    var t = day.timeline;
    for (var i = 0; i < t.length; i++) {
      if (m >= t2m(t[i].start) && m < t2m(t[i].end)) return i;
    }
    return -1;
  }

  function nextOfType(day, from, type) {
    for (var i = from + 1; i < day.timeline.length; i++) {
      if (day.timeline[i].type === type) return day.timeline[i];
    }
    return null;
  }

  /* 早读不出准备清单——课前那点时间，列书单没用。
     老师要的是一句"今天读什么"，所以改成一条建议。
     准备清单只在紧邻上课的课间出现，见下面 break 分支。 */

  function hasReadingBlock(timeline) {
    for (var i = 0; i < timeline.length; i += 1) {
      if (timeline[i].type === "reading") return true;
    }
    return false;
  }

  /* 「提醒事项」按星期配；没配这一天就用「每天」那条。
     它比早读建议更重要，所以单独一块、单独上色，不和普通清单混在一起。 */
  /* 比较两句话是不是同一句：标点和空白不算区别。
     到校一句话和提醒事项默认就是同一句，别在屏上贴两遍。 */
  function bare(t) {
    return String(t == null ? "" : t)
      .replace(/\s+/g, "")
      .replace(/[。！？!?，,；;、.]+$/, "");
  }

  function reminderFor(opts, day) {
    var R = opts && opts.texts && opts.texts.reminders;
    if (!R) return "";
    var v = R[String(day.weekday)];
    if (v == null || String(v).trim() === "") v = R["default"];
    return (v == null ? "" : String(v)).trim();
  }

  function countdownFor(kind, remainMin, mode) {
    var conf = CD[kind] || { mode: "off" };
    if (mode === "off") return { visible: false };
    if (mode === "all") conf = { mode: conf.mode === "off" ? "untilEnd" : conf.mode, showFrom: Infinity };
    if (conf.mode === "off") return { visible: false };
    var visible = remainMin <= (conf.showFrom || 0) && remainMin > -0.5;
    return {
      visible: visible,
      mode: conf.mode,
      showFrom: conf.showFrom || 0,
      remainMin: remainMin,
      text: conf.mode === "untilNext" ? "还有 " + human(remainMin) : "还剩 " + human(remainMin)
    };
  }

  /* 「到校前 / 放学后 / 休息日」不是作息表里的块，是两头。
     它们的话也只由老师定，所以同样要能被 texts 覆盖。 */
  function stageText(opts, kind, field, fallback) {
    var st = opts && opts.texts && opts.texts.stage;
    var v = st && st[kind] ? st[kind][field] : null;
    return (v != null && v !== "") ? v : fallback;
  }

  /* 到校时刻来自作息表的 marks，不写死。07:40 之前和之后说的话不一样：
     之前是"还没到校"，之后人已经在教室里了，标签不能还写"还没到校"。 */
  function arriveOf(day) {
    var m = (day.marks || []).filter(function (x) { return x.kind === "arrive"; })[0];
    return m ? t2m(m.at) : null;
  }

  /* 早读读什么，按星期配，老师自己填；没填不猜科目。
     时间在作息表里是一段真实的块（reading），不再从"到校后到第 1 节"推算——
     这样老师才能把结束时间定在 8:10，8:10 之后交给准备课间。 */
  function readingFor(opts, day, arrived) {
    if (!arrived || !day) return null;
    var r = opts && opts.texts && opts.texts.reading;
    if (!r) return null;
    var x = r[String(day.weekday)];
    if (!x || !(x.subject || "").trim()) return null;
    return x;
  }

  function coreStateAt(day, minutes, opts) {
    opts = opts || {};
    var mode = opts.countdownMode || "auto";

    if (!day || day.inSchool === false) {
      return {
        kind: "holiday",
        title: stageText(opts, "holiday", "title", "今天不上学"),
        sub: "",
        note: stageText(opts, "holiday", "note", "好好休息，明天见"),
        meta: [], items: [], countdown: { visible: false }, clock: m2t(minutes)
      };
    }

    var t = day.timeline;
    var first = t2m(t[0].start), last = t2m(t[t.length - 1].end);
    var i = blockIndexAt(day, minutes);

    if (i < 0) {
      if (minutes < first) {
        var c0 = t.filter(function (b) { return b.type === "class"; })[0];
        var arr = arriveOf(day);
        var arrived = arr != null && minutes >= arr;
        /* 作息表里已经有早读块时，不再把"到校后到第 1 节"整段算成早读，
           否则 7:45 就会提前上早读，把真正的到校时间吞掉。 */
        var rd = hasReadingBlock(t) ? null : readingFor(opts, day, arrived);

        if (rd) {
          var advice = (rd.task || "").trim();
          var remBefore = reminderFor(opts, day);
          var noteBefore = stageText(opts, "before", "note", "");
          return {
            kind: "before",
            title: rd.subject + "学习建议",
            sub: c0 ? "第 1 节 " + c0.subject : "",
            note: noteBefore,
            arrived: true,
            reading: true,
            meta: [],
            items: [],
            advice: advice,
            /* 旧作息没有 reading 块，到校后这一整段就是早读时间，
               提醒事项在这里同样要出现，否则改了小标题却丢了提醒。 */
            lines: remBefore && bare(remBefore) !== bare(noteBefore)
              ? [{ kind: "reminder", label: "提醒事项", items: [remBefore] }]
              : [],
            countdown: countdownFor("before", first - minutes, mode),
            clock: m2t(minutes),
            _ctx: { type: "before", remain: first - minutes, dur: 40 }
          };
        }

        return {
          kind: "before",
          title: stageText(opts, "before", "title", "早上好"),
          sub: c0 ? "今天第 1 节 " + c0.subject : "",
          note: stageText(opts, "before", "note", "到校后先交作业、整理书包"),
          arrived: arrived,
          meta: c0 && c0.teacher ? [{ label: "任课", value: c0.teacher }] : [],
          items: c0 && c0.prep ? c0.prep.items : [],
          countdown: countdownFor("before", first - minutes, mode),
          clock: m2t(minutes),
          _ctx: { type: "before", remain: first - minutes, dur: 40 }
        };
      }
      return {
        kind: "closed",
        title: stageText(opts, "closed", "title", "放学了"),
        sub: "",
        note: stageText(opts, "closed", "note", "整理好书包，路上注意安全"),
        meta: [], items: [], countdown: { visible: false }, clock: m2t(minutes),
        _ctx: { type: "closed", remain: 0, dur: 0 }
      };
    }

    var b = t[i];
    var remain = t2m(b.end) - minutes;
    var card = { kind: b.type, title: b.name || "", sub: "", note: b.tip || "",
                 meta: [], items: b.items || [], countdown: countdownFor(b.type, remain, mode),
                 clock: m2t(minutes), range: b.start + "–" + b.end,
                 _ctx: { type: b.type, remain: remain, dur: t2m(b.end) - t2m(b.start),
                         start: b.start, end: b.end, index: i,
                         next: t[i + 1] ? { type: t[i + 1].type, name: t[i + 1].name } : null } };

    if (b.type === "reading") {
      var firstClass = t.filter(function (x) { return x.type === "class"; })[0];
      var rdToday = readingFor(opts, day, true);
      var rem = reminderFor(opts, day);
      var tip = rdToday && (rdToday.task || "").trim();
      card.title = (rdToday && rdToday.subject ? rdToday.subject + "学习建议" : (b.name || "早读"));
      card.sub = firstClass && firstClass.subject ? "第 1 节 " + firstClass.subject : "";
      /* 早读也是「打铃前」，到校那句一句话跟到 08:10：
         学生边读边把红领巾、个人卫生这些事再看一眼。 */
      card.note = stageText(opts, "before", "note", "");
      card.items = [];
      card.reading = true;
      card.lines = [];
      /* 老师填的那条建议不再挤成小字清单，改成标题下面的一整行大字，
         和标题同字号——早读就一件事，学生从最后一排也要看得清。 */
      card.advice = tip || "";
      /* 提醒事项排在建议前面：它是今天必须记住的那一件，
         不能埋在"读第几课"下面。和上面那句完全一样就不再贴一遍，
         同一句话在屏上出现两次，学生反而以为是两件事。 */
      if (rem && bare(rem) !== bare(card.note)) {
        card.lines.push({ kind: "reminder", label: "提醒事项", items: [rem] });
      }
    }

    if (b.type === "class") {
      card.title = "第 " + b.periodNo + " 节 · " + (b.subject || "—");
      card.sub = b.teacher || "";
      card.note = "";
      if (b.place) card.meta.push({ label: "地点", value: b.place });
    }

    if (b.type === "break") {
      var nc = nextOfType(day, i, "class");
      card.title = (opts.texts && opts.texts.breakTitle) || "课间";
      card.sub = nc ? "下一节 " + (nc.subject || "") : "";
      card.note = "喝水、如厕，回来准备下节课";
      if (nc) {
        if (nc.teacher) card.meta.push({ label: "任课", value: nc.teacher });
        if (nc.place) card.meta.push({ label: "地点", value: nc.place });
        /* 上课铃响之前这一段，才是准备用品的时间。从课间第一秒就列出来，
           不再分 level、也不再等最后 2 分钟——学生要有整段课间去拿东西。 */
        if (nc.prep && nc.prep.items && nc.prep.items.length) {
          card.items = nc.prep.items;
          card.note = "下节课要用，现在就摆好";
        }
      }
      card._next = nc ? { subject: nc.subject, teacher: nc.teacher, periodNo: nc.periodNo } : null;
    }

    if (b.type === "noon") {
      var na = nextOfType(day, i, "class");
      card.title = b.name || "午间";
      card.note = b.tip || "";
      if (na && na.prep && na.prep.level >= 2 && na.prep.items.length) {
        card.meta.push({ label: "下午第一节", value: na.subject + " · " + na.prep.items.join("、") });
      }
    }

    if (b.type === "action") {
      card.note = b.tip || "";
    }

    return card;
  }

  /* 倒计时后面接的是什么，文案要说对：
     "还有 3 分钟" 后面可能是上课，也可能是课间（午间之后就是课间）。 */
  function nextLabelOf(n) {
    if (!n) return "";
    if (n.type === "class") return "后上课";
    if (n.type === "break") return "后课间";
    if (n.type === "meal") return "后午餐";
    if (n.type === "after") return "后课后服务";
    return "后" + (n.name || "");
  }

  function isEyeExercise(card) {
    return card.kind === "ritual" && /眼保健操/.test(card.title || "");
  }

  /* 视觉焦点：同一段内容，随时间推移换主角。
     课间前段主角是"现在是什么"，最后 2 分钟主角变成"还剩多久"。 */
  function stateAt(day, minutes, opts) {
    var card = coreStateAt(day, minutes, opts);
    var ctx = card._ctx;
    var kind = card.kind;
    var mode = (opts && opts.countdownMode) || "auto";

    card.tone = TONE[kind] || "green";
    card.focus = "status";
    card.hints = [];
    card.timer = "";
    card.nextLabel = "";

    if (!ctx || kind === "holiday") {
      delete card._ctx;
      return card;
    }

    var remain = ctx.remain || 0;
    var closing = isEyeExercise(card) ? 0 : (CLOSING[kind] || 0);

    /* 三档全局开关：关掉就一律不切；全开就从进入这一段就开始倒计时 */
    if (mode === "off") closing = 0;
    if (mode === "all" && closing) closing = ctx.dur;

    if (closing && remain <= closing) {
      card.focus = "countdown";
      card.timer = mmss(remain);
      card.nextLabel = nextLabelOf(ctx.next);
      /* 收尾只用琥珀，不用红——红留给老师手动发的紧急通知 */
      if (card.tone === "green") card.tone = "amber";
      card.hints = [];
    } else if (kind === "break") {
      /* 课间整段都留这两件事，不闪 */
      card.hints = (opts && opts.texts && opts.texts.breakActions) || DEFAULT_BREAK_ACTIONS;
    } else if (kind === "meal") {
      var elapsed = (ctx.dur || 0) - remain;
      if (elapsed <= 2) card.hints = HINTS[kind] || [];
    } else if (kind === "closed") {
      card.hints = HINTS.closed;
    }

    card.lines = linesFor(card, kind, opts);
    delete card._ctx;
    return card;
  }

  /* 两行：先"现在去做什么"，再"带什么"。
     任务类（大扫除、午间作业）的条目本身是动作，不要套"准备好："。 */
  var TASK_KIND = { noon: 1, action: 1, meal: 1 };

  function linesFor(card, kind, opts) {
    /* 早读的行是 coreStateAt 里直接给的（建议 + 提醒），别再拼一遍 */
    if (card.reading) return card.lines || [];
    var T = (opts && opts.texts) || {};
    var label = T.prepLabel || "准备好";
    var out = [];
    var items = card.items || [];

    if (items.length) {
      if (TASK_KIND[kind]) out.push({ kind: "action", items: items });
      else out.push({ kind: "prep", label: label, items: items });
    }

    if (card.hints && card.hints.length) out.unshift({ kind: "action", items: card.hints });
    return out;
  }

  /* 值日条：同组合并 → 按 order → 最多 3 条；有临时任务时日常岗位让位 */
  function dutiesAt(day, minutes) {
    if (!day || day.inSchool === false) return { items: [], overflow: 0 };

    var active = day.duties.filter(function (d) {
      return minutes >= t2m(d.at) && minutes < t2m(d.end);
    });

    var merged = [], byKey = {}, each = [];

    active.forEach(function (d) {
      if (d.grp) {
        if (!byKey[d.grp]) {
          byKey[d.grp] = { key: d.grp, name: d.grp, tasks: [], people: [], order: d.order,
                           assign: d.assign, unknown: false };
          merged.push(byKey[d.grp]);
        }
        var g = byKey[d.grp];
        if (g.tasks.indexOf(d.name) < 0) g.tasks.push(d.name);
        (d.people || []).forEach(function (p) {
          if (g.people.indexOf(p) < 0) g.people.push(p);
        });
        if (d.status !== "ok") g.unknown = true;
        g.order = Math.min(g.order, d.order);
        g.assign = d.assign === "self-organize" ? "self-organize" : g.assign;
        return;
      }
      if (d.freqKind === "each") {
        each.push({ key: d.roleId, name: d.name, tasks: [], people: d.people || [],
                    order: d.order, assign: d.assign, unknown: d.status !== "ok", quiet: true });
        return;
      }
      merged.push({ key: d.roleId, name: d.name, tasks: [], people: d.people || [],
                    order: d.order, assign: d.assign, unknown: d.status !== "ok" });
    });

    /* 日常岗位永远给临时任务让位，不抢同一行 */
    var items = merged.length ? merged : each;
    items.sort(function (a, b) { return a.order - b.order; });

    var overflow = Math.max(0, items.length - 3);
    return { items: items.slice(0, 3), overflow: overflow, quiet: !merged.length };
  }

  var api = { t2m: t2m, m2t: m2t, mmss: mmss, human: human,
              stateAt: stateAt, dutiesAt: dutiesAt, CD: CD, TONE: TONE, HINTS: HINTS };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Rhythm = api;
})(typeof window !== "undefined" ? window : globalThis);
