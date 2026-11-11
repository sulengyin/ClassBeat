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

  /* 课前准备提前量：距下一节正式上课还有这么多分钟，就把下一节和要带的东西
     放上屏。普通课间、大课间、眼保健操、大扫除都适用；
     午餐/午间/放学不提示（见 PREVIEW_KINDS）。 */
  var PREP_LEAD = 10;
  var PREVIEW_KINDS = { break: 1, ritual: 1, action: 1 };

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

  /* 提前量可配：opts.prepLead 来自本机偏好，没给就用默认 10 分钟。
     小于 0 视为不启用。 */
  function prepLeadOf(opts) {
    var v = opts && opts.prepLead;
    v = (v == null || v === "") ? NaN : Number(v);
    return isFinite(v) && v >= 0 ? v : PREP_LEAD;
  }

  /* 界面输入的归一处：空 = 恢复默认；0、负数、非数字都不接受（返回 null，
     由调用方保持原值并提示）；超过 30 夹到 30；小数取整。 */
  function normalizePrepLead(v) {
    if (v == null || (typeof v === "string" && v.trim() === "")) return PREP_LEAD;
    var n = Number(v);
    if (!isFinite(n) || n < 1) return null;
    return Math.min(30, Math.round(n));
  }

  /* 距下一节正课开始 lead 分钟内，这段休息/活动要把下一节露出来；
     没有后续课程、或还早，就返回 null。
     午餐、午间不在此列：那两段要留给吃饭和休息，不挂"下一节"。 */
  function previewClass(day, i, minutes, lead) {
    var b = day.timeline[i];
    if (!PREVIEW_KINDS[b.type]) return null;
    var nc = nextOfType(day, i, "class");
    if (!nc) return null;
    return (t2m(nc.start) - minutes) <= lead ? nc : null;
  }

  function prepNext(nc) {
    return { subject: nc.subject, teacher: nc.teacher, periodNo: nc.periodNo };
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

  /* 「早读」自 0.2.1 起改叫「晨间自主管理」。旧配置里块名存的还是「早读」，
     只在读取时换成新名显示；老师本地的数据一个字都不动，导出仍是原样。 */
  var READING_NAME = "晨间自主管理";
  function blockName(b) {
    if (!b) return "";
    if (b.type === "reading" && (!b.name || b.name === "早读")) return READING_NAME;
    return b.name || "";
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
          var remBefore = reminderFor(opts, day);
          var noteBefore = stageText(opts, "before", "note", "");
          /* 旧作息没有 reading 块，到校后这一整段就是早读时间。
             提醒事项一定要出现，而且优先用黄色便签承载；
             和正文那句重复时，正文让位，避免同一句话出现两次。
             学习建议自 0.2.1 起不再上屏；大字改取「到校 · 大字」。 */
          var sameBefore = !!remBefore && bare(remBefore) === bare(noteBefore);
          var bigBefore = stageText(opts, "before", "title", "");
          return {
            kind: "before",
            title: String(bigBefore == null ? "" : bigBefore).trim() || READING_NAME,
            sub: c0 ? "第 1 节 " + c0.subject : "",
            note: sameBefore ? "" : noteBefore,
            arrived: true,
            reading: true,
            meta: [],
            items: [],
            lines: remBefore
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
    var lead = prepLeadOf(opts);
    var card = { kind: b.type, title: blockName(b), sub: "", note: b.tip || "",
                 meta: [], items: b.items || [], countdown: countdownFor(b.type, remain, mode),
                 clock: m2t(minutes), range: b.start + "–" + b.end,
                 _ctx: { type: b.type, remain: remain, dur: t2m(b.end) - t2m(b.start),
                         start: b.start, end: b.end, index: i,
                         next: t[i + 1] ? { type: t[i + 1].type, name: t[i + 1].name } : null } };

    if (b.type === "reading") {
      var firstClass = t.filter(function (x) { return x.type === "class"; })[0];
      var rem = reminderFor(opts, day);
      /* 晨间大字用「到校（第一节课打铃前）」下面那个「大字」框；
         没填或只有空白就回退块名（默认就是「晨间自主管理」）。
         学习建议仍不上屏，旧数据原样留在存储里。 */
      var big = stageText(opts, "before", "title", "");
      card.title = String(big == null ? "" : big).trim() || blockName(b);
      card.sub = firstClass && firstClass.subject ? "第 1 节 " + firstClass.subject : "";
      /* 早读也是「第一节课打铃前」，到校那句一句话跟到 08:10：
         学生边读边把红领巾、个人卫生这些事再看一眼。 */
      card.note = stageText(opts, "before", "note", "");
      card.items = [];
      card.reading = true;
      card.lines = [];
      /* 提醒事项是这一段唯一要贴出来的东西；
         这句话和到校那句一样时，仍然要贴黄色便签——纯文字不够醒目，
         重复的那行正文就不再显示，避免同一句出现两次。 */
      if (rem) {
        card.lines.push({ kind: "reminder", label: "提醒事项", items: [rem] });
        if (bare(rem) === bare(card.note)) card.note = "";
      }
    }

    if (b.type === "class") {
      card.title = "第 " + b.periodNo + " 节 · " + (b.subject || "—");
      card.sub = b.teacher || "";
      card.note = "";
      if (b.place) card.meta.push({ label: "地点", value: b.place });
    }

    if (b.type === "break") {
      var nc = previewClass(day, i, minutes, lead);
      card.title = (opts.texts && opts.texts.breakTitle) || "课间";
      card.sub = nc ? "下一节 " + (nc.subject || "") : "";
      card.note = "喝水、如厕，回来准备下节课";
      if (nc) {
        if (nc.teacher) card.meta.push({ label: "任课", value: nc.teacher });
        if (nc.place) card.meta.push({ label: "地点", value: nc.place });
        /* 距上课 10 分钟内才把用品提上来：够拿东西，又不至于整个长课间都在搬家。 */
        if (nc.prep && nc.prep.items && nc.prep.items.length) {
          card.items = nc.prep.items;
          card.note = "下节课要用，现在就摆好";
        }
      }
      card._next = nc ? prepNext(nc) : null;
    }

    /* 大课间、眼保健操、大扫除：先保留活动本身（标题、安全提示、任务），
       最后 10 分钟再把下一节和要带的东西接在下面，互不覆盖。 */
    if (b.type === "ritual" || b.type === "action") {
      var na = previewClass(day, i, minutes, lead);
      if (na) {
        card.sub = "下一节 " + (na.subject || "");
        card._next = prepNext(na);
        if (na.prep && na.prep.items && na.prep.items.length) card.prepItems = na.prep.items;
      }
    }

    if (b.type === "noon") {
      var ncNoon = nextOfType(day, i, "class");
      card.title = b.name || "午间";
      card.note = b.tip || "";
      if (ncNoon && ncNoon.prep && ncNoon.prep.level >= 2 && ncNoon.prep.items.length) {
        card.meta.push({ label: "下午第一节", value: ncNoon.subject + " · " + ncNoon.prep.items.join("、") });
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

    /* 活动类（大课间/大扫除）自己的任务不动，下一节的用品单独起一行 */
    var prep = card.prepItems || [];
    if (prep.length) out.push({ kind: "prep", label: label, items: prep });

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
              stateAt: stateAt, dutiesAt: dutiesAt, CD: CD, TONE: TONE, HINTS: HINTS,
              PREP_LEAD: PREP_LEAD, normalizePrepLead: normalizePrepLead,
              READING_NAME: READING_NAME, blockName: blockName };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Rhythm = api;
})(typeof window !== "undefined" ? window : globalThis);
