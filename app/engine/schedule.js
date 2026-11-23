/* 节律引擎：把「作息 + 课表 + 岗位 + 名单 + 校历」算成某一天的时间线。
 *
 * 这是 tools/build_day.py 的前端移植，目标是逐字段一致（tools/test_engine.js 对拍）。
 * 区别只有一处：Python 版读文件、一次编多天；这里吃一个配置对象、只算要的那天。
 *
 * 三条老规矩没变：
 *   · 课表不含时间，时间只来自作息
 *   · 午间是槽位，不是常量；大扫除是午餐与午间之间插入的动作
 *   · 表上没写的东西输出 unknown / unset，不猜
 *
 * 用法：
 *   Schedule.buildDay(config, "2026-11-05")
 *   config = { timetable, schedule, content, roles, noon, calendar }
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Schedule = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var WEEKDAY_CN = "一二三四五六日";
  var DUTY_WINDOW = 16; // 触发后显示 16 分钟，过点不追

  // ---------- 基础工具 ----------

  function t2m(text) {
    var p = String(text).split(":");
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function m2t(minutes) {
    return pad(Math.floor(minutes / 60)) + ":" + pad(minutes % 60);
  }

  /* 一律用 UTC 算日期：浏览器在哪个时区都不该改变「今天是周几」。 */
  function parseDate(text) {
    var p = String(text).split("-");
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  }

  function iso(date) {
    return date.toISOString().slice(0, 10);
  }

  function isoWeekday(date) {
    var w = date.getUTCDay();
    return w === 0 ? 7 : w;
  }

  function addDays(date, n) {
    return new Date(date.getTime() + n * 86400000);
  }

  function mondayOf(date) {
    return addDays(date, -(isoWeekday(date) - 1));
  }

  // ---------- 周次 ----------

  /* 返回 { weekNo, parity }。termStart 所在周的周一算第 1 周。 */
  function weekInfo(date, termStart) {
    var monday = mondayOf(termStart);
    var weekNo = Math.floor((date.getTime() - monday.getTime()) / 86400000 / 7) + 1;
    return { weekNo: weekNo, parity: weekNo % 2 ? "odd" : "even" };
  }

  // ---------- 校历 ----------

  function calEntry(cal, date) {
    var days = (cal && cal.days) || {};
    var e = days[iso(date)];
    return e && typeof e === "object" ? e : null;
  }

  function defaultKind(date) {
    return isoWeekday(date) <= 5 ? "school" : "holiday";
  }

  function resolveDay(cal, date) {
    var e = calEntry(cal, date);
    var kind = (e && e.kind) || defaultKind(date);
    if (kind === "school") {
      return {
        inSchool: true,
        reason: defaultKind(date) === "school" ? "school" : "makeup",
        label: e ? e.name || null : null,
        asWeekday: e ? e.asWeekday || null : null,
      };
    }
    return {
      inSchool: false,
      reason: e ? "holiday" : "weekend",
      label: e ? e.name || null : null,
      asWeekday: null,
    };
  }

  var WEEK_MS = 7 * 86400000;

  function weekHasSchool(cal, monday) {
    for (var i = 0; i < 7; i += 1) {
      if (resolveDay(cal, addDays(monday, i)).inSchool) return true;
    }
    return false;
  }

  /* anchor 所在周算第 0 周，只数有课的周。早于 anchor 返回 null（不往回推）。 */
  function schoolWeekIndex(cal, anchor, date) {
    var start = mondayOf(anchor);
    var end = mondayOf(date);
    if (end < start) return null;
    var n = 0;
    var cur = start;
    while (cur < end) {
      if (weekHasSchool(cal, cur)) n += 1;
      cur = new Date(cur.getTime() + WEEK_MS);
    }
    return n;
  }

  function groupFor(cal, cycle, date) {
    if (!cycle || cycle.status !== "confirmed") return [null, "cycle-unconfirmed"];
    var anchorRaw = cycle.anchor;
    var groups = cycle.groups || [];
    var anchorGroup = cycle.anchorGroup;
    if (!anchorRaw || !groups.length || groups.indexOf(anchorGroup) < 0) {
      return [null, "cycle-anchor-missing"];
    }
    var idx = schoolWeekIndex(cal, parseDate(anchorRaw), date);
    if (idx === null) return [null, "before-anchor"];
    var start = groups.indexOf(anchorGroup);
    return [groups[(start + idx) % groups.length], null];
  }

  // ---------- 课表 ----------

  function lessonAt(schedule, weekday, periodNo, parity) {
    var hits = (schedule.entries || []).filter(function (e) {
      var rule = e.weekRule === undefined ? parity : e.weekRule;
      return e.weekday === weekday && e.periodNo === periodNo && rule === parity;
    });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error("周" + weekday + "第" + periodNo + "节匹配到多条");
    return null;
  }

  /* content 是 content.json 里的 subjects 数组（不是整个文件）。
     只认数组：别处传整个对象就会静默拿不到准备清单。 */
  function contentFor(content, subject) {
    if (!subject) return null;
    var list = content || [];
    for (var i = 0; i < list.length; i += 1) {
      var s = list[i];
      if ((s.labels || []).indexOf(subject) >= 0) {
        return {
          key: s.key,
          level: s.level,
          items: s.items,
          place: s.place === undefined ? null : s.place,
        };
      }
    }
    return null;
  }

  // ---------- 午间 ----------

  function resolveNoon(noonRule, weekday, override) {
    var presetKey =
      (override && override.preset) ||
      (noonRule.weekRule || {})[String(weekday)] ||
      noonRule.defaultPreset;
    var preset = noonRule.presets[presetKey];
    var out = { preset: presetKey };
    for (var k in preset) if (Object.prototype.hasOwnProperty.call(preset, k)) out[k] = preset[k];
    out.source = "week-rule";
    return out;
  }

  /* 把 noon 槽位展开成实际块；大扫除日在午餐与午间之间插入 pre 动作。 */
  function buildDayBlocks(timetable, noon) {
    var band = timetable.noonBand;
    var lunchEnd = t2m(band.lunchEnd);
    var bell = t2m(band.bell);
    var noonEnd = t2m(band.noonEnd);

    var out = [];
    (timetable.blocks || []).forEach(function (b) {
      // 认 type 不认 seq：seq 是这所学校的编号习惯，别的学校节次一多就会串块。
      if (b.type === "meal") {
        var copy = {};
        for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) copy[k] = b[k];
        copy.end = m2t(noon.pre ? lunchEnd : bell);
        out.push(copy);
        return;
      }

      if (b.type === "noon") {
        if (noon.pre && lunchEnd < bell) {
          out.push({
            seq: "9a",
            start: m2t(lunchEnd),
            end: m2t(bell),
            type: "action",
            name: noon.pre.title,
            tip: noon.pre.tip || "",
            items: noon.pre.items || [],
          });
        }
        out.push({
          seq: b.seq === undefined ? "9b" : b.seq,
          start: m2t(bell),
          end: m2t(noonEnd),
          type: "noon",
          name: noon.title,
          tip: noon.tip || "",
          items: noon.items || [],
        });
        return;
      }

      var copy = {};
      for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) copy[k] = b[k];
      out.push(copy);
    });

    /* noonBand 会把 meal/noon 块的起止重写掉；老师配置里三个分界点若
       与块表错位（比如午间结束被拖到第一节课结束之后），重写出的午间
       就会盖住正课——屏面 12:52 还在「午间休息、剩 48 分」就是这种
       （真机 2026-11-20）。输出后按开始时间排序，把前块的结束夹到
       后块的开始：宁可截短午间，也不能让正课被遮住。
       拷贝再改，别污染老师的原配置对象。 */
    out.sort(function (a, b) { return t2m(a.start) - t2m(b.start); });
    for (var i = 0; i < out.length - 1; i += 1) {
      /* 倒挂块（开始晚于结束）本身是非法脏数据，编辑面板/导入都会拦；
         这里跳过它，别拿它的边界去截合法块。 */
      if (t2m(out[i].end) <= t2m(out[i].start)) continue;
      if (t2m(out[i + 1].end) <= t2m(out[i + 1].start)) continue;
      var curEnd = t2m(out[i].end);
      var nextStart = t2m(out[i + 1].start);
      if (curEnd > nextStart) {
        out[i] = Object.assign({}, out[i], { end: m2t(nextStart) });
      }
    }

    return out;
  }

  // ---------- 岗位 ----------

  /* 一个人名的各种历史写法：字符串、{name}、{label}、数组。
     取不出来就当空，绝不让 [object Object] 混进屏面。 */
  function nameOf(v, depth) {
    if (v == null) return "";
    if (typeof v === "string") return v.trim();
    if (typeof v === "number") return String(v);
    if (typeof v === "object") {
      if ((depth || 0) >= 3) return "";
      var inner = v.name != null ? v.name : (v.label != null ? v.label : (v.student != null ? v.student : ""));
      return nameOf(inner, (depth || 0) + 1);
    }
    return "";
  }

  /* 名单统一成「去重、去空的姓名数组」。
     顺手按分隔符拆开：配置里常见 people: ["张三、李四"]，
     以前原样上屏碰巧没错，但按 id 核对时就对不上。人名里不会出现这些符号。 */
  function nameList(v) {
    if (v == null) return [];
    var arr = Array.isArray(v) ? v : [v];
    var out = [];
    arr.forEach(function (x) {
      var n = nameOf(x, 0);
      if (!n || n === "[object Object]") return;
      n.split(/[、\/／,，;；|｜]+/).forEach(function (part) {
        var p = part.trim();
        if (p && p !== "[object Object]" && out.indexOf(p) < 0) out.push(p);
      });
    });
    return out;
  }

  /* 「这个岗位今天归谁」只有一个入口。
     旧写法是三段 if：有 groups 就只看组、有 rotation 就只看星期表，
     people 永远排在最后——老师在面板里亲手指定了人，只要配置里还留着
     轮换的元数据，屏上照样「待定」。而且 rotation.status 没确认时，
     就算 peopleMap 里明明写了今天是谁，也一律判成未知。
     现在改成候选源列表，按「越具体越优先」排：老师指定 > 轮换到的那组 >
     按星期表；空数组算「没指定」，继续往下找。返回 [名单, 原因, 来源]，
     前两项的契约没变，来源只用来让面板解释「这次听谁的」。 */
  function resolvePeople(role, group, groupReason, weekday) {
    var cycle = role.cycle || {};
    var chosen = group || cycle.current;
    var candidates = [
      { key: "people", names: role.people },
      { key: "group", names: role.groups && chosen ? role.groups[chosen] : null, group: chosen },
      { key: "weekday", names: role.peopleMap ? role.peopleMap[String(weekday)] : null }
    ];

    for (var i = 0; i < candidates.length; i++) {
      var names = nameList(candidates[i].names);
      if (names.length) return [names, null, candidates[i].key];
    }

    /* 一个都没排：原因要分得清，面板才能告诉老师下一步该点哪儿 */
    if (role.groups) {
      return [null, groupReason || (chosen ? "group-empty" : "cycle-group-unconfirmed"), "none"];
    }
    if (role.peopleMap || role.rotation) return [null, "weekday-not-mapped", "none"];
    return [null, "no-people", "none"];
  }

  function roleTriggers(role, blocks, noon, weekday, presents) {
    var freq = role.freq || {};
    var kind = freq.kind;
    var out = [];

    /* 时段常驻（0.3.23）：老师在编辑面板里把岗位选进「晨间自主管理 /
       课间 / 午间」任一时段后，这个岗位的触发完全由时段呈现决定
       （整段都挂在值日条上），freq 不再另算——一个岗位一种呈现方式，
       不叠加。freq=unset 的岗位也能被选进来。 */
    if (presents) {
      var mine = false;
      ["reading", "break", "noon"].forEach(function (k) {
        if ((presents[k] || []).indexOf(role.id) >= 0) mine = true;
      });
      if (mine) {
        blocks.forEach(function (b) {
          var k = b.type;
          if (k !== "reading" && k !== "break" && k !== "noon") return;
          if ((presents[k] || []).indexOf(role.id) < 0) return;
          out.push({ at: b.start, end: b.end, block: b.seq, freqKind: "present" });
        });
        return out;
      }
    }

    if (kind === "unset") return out;

    if (kind === "each") {
      blocks.forEach(function (b) {
        if (b.type === "break") out.push({ at: b.start, end: b.end, block: b.seq });
      });
      return out;
    }

    if (kind === "task") {
      if (noon.pre && noon.pre.title === freq.task) {
        blocks.forEach(function (b) {
          if (b.type === "action" && b.name === freq.task) {
            out.push({ at: b.start, end: b.end, block: b.seq });
          }
        });
      }
      return out;
    }

    if (kind === "weekly" && (freq.weekdays || []).indexOf(weekday) < 0) return out;

    (freq.times || []).forEach(function (t) {
      var start = t2m(t);
      out.push({ at: t, end: m2t(start + DUTY_WINDOW), block: null });
    });

    return out;
  }

  function buildDuties(roles, blocks, noon, weekday, group, groupReason, presents) {
    var duties = [];
    var unset = [];
    var unknown = [];

    (roles.roles || []).forEach(function (role) {
      /* 时段常驻可以徃 unset 的岗位也挂上屏：被选中的 unset 岗位不跳过 */
      var isPresent = presents && ["reading", "break", "noon"].some(function (k) {
        return (presents[k] || []).indexOf(role.id) >= 0;
      });
      if ((!role.freq || role.freq.kind === "unset") && !isPresent) {
        unset.push(role.id);
        return;
      }

      var res = resolvePeople(role, group, groupReason, weekday);
      var people = res[0];
      var reason = res[1];
      var from = res[2] || "none";
      var triggers = roleTriggers(role, blocks, noon, weekday, presents);
      if (!triggers.length) return;

      if (people === null) {
        unknown.push({ roleId: role.id, name: role.name, reason: reason });
      }

      triggers.forEach(function (t) {
        duties.push({
          roleId: role.id,
          name: role.name,
          at: t.at,
          end: t.end,
          block: t.block,
          people: people,
          /* peopleFrom：这次的人是从哪儿来的（people/group/weekday）。
             面板据此说「这人是固定指定的」还是「今天轮到 A 组」。 */
          peopleFrom: from,
          substitute: role.substitute || [],
          status: people !== null ? "ok" : "unknown",
          reason: reason,
          freqKind: t.freqKind || role.freq.kind,
          order: role.order === undefined ? 0 : role.order,
          grp: role.grp === undefined ? null : role.grp,
          assign: role.assign === undefined ? "fixed" : role.assign,
        });
      });
    });

    duties.sort(function (a, b) {
      var d = t2m(a.at) - t2m(b.at);
      return d !== 0 ? d : a.order - b.order;
    });

    return { duties: duties, unknown: unknown, unset: unset };
  }

  // ---------- 主流程 ----------

  function buildDay(config, dateStr, opts) {
    opts = opts || {};
    var timetable = config.timetable;
    var schedule = config.schedule;
    var content = config.content;
    var roles = config.roles;
    var noonRule = config.noon;
    var cal = config.calendar || { days: {} };

    var date = parseDate(dateStr);
    var info = resolveDay(cal, date);

    if (!info.inSchool) {
      return {
        date: dateStr,
        weekday: isoWeekday(date),
        weekdayName: "周" + WEEKDAY_CN[isoWeekday(date) - 1],
        inSchool: false,
        reason: info.reason,
        label: info.label,
        warnings: [],
      };
    }

    var weekday = info.asWeekday || isoWeekday(date);
    var winfo = weekInfo(date, parseDate(schedule.termStart));
    var weekNo = winfo.weekNo;
    var parity = opts.parity || winfo.parity;

    var warnings = [];

    var group = opts.group === undefined || opts.group === null ? null : opts.group;
    var groupReason = null;
    if (group === null) {
      var gf = groupFor(cal, roles.dutyCycle || {}, date);
      group = gf[0];
      groupReason = gf[1];
    }

    var noon = resolveNoon(noonRule, weekday, null);
    var blocks = buildDayBlocks(timetable, noon);

    var timeline = [];
    blocks.forEach(function (b) {
      var item = {};
      ["seq", "start", "end", "type"].forEach(function (k) {
        if (k in b) item[k] = b[k];
      });
      ["name", "tip", "items", "periodNo"].forEach(function (k) {
        if (k in b) item[k] = b[k];
      });

      if (b.type === "class") {
        var lesson = lessonAt(schedule, weekday, b.periodNo, parity);
        if (lesson === null) {
          item.subject = null;
          item.teacher = null;
          item.status = "unknown";
          warnings.push({
            code: "LESSON_MISSING",
            message: "周" + weekday + "第" + b.periodNo + "节在课表里找不到",
          });
        } else {
          item.subject = lesson.subject;
          item.teacher = lesson.teacher;
          item.place = lesson.place === undefined ? null : lesson.place;
          item.prep = contentFor(content, lesson.subject);
          item.weekRule = lesson.weekRule === undefined ? null : lesson.weekRule;
        }
      }

      timeline.push(item);
    });

    var dutyResult = buildDuties(roles, blocks, noon, weekday, group, groupReason,
                                 config.dutyPresents || null);
    var duties = dutyResult.duties;
    var unknown = dutyResult.unknown;
    var unset = dutyResult.unset;

    (timetable.marks || []).forEach(function (mark) {
      if (mark.status === "CONFLICT" || mark.status === "ASSUMED") {
        warnings.push({
          code: "MARK_" + mark.status,
          message: mark.at + " " + mark.kind + "：" + (mark.note || ""),
        });
      }
    });

    if (unknown.length) {
      warnings.push({
        code: "DUTY_PEOPLE_UNKNOWN",
        message: "以下岗位成员无法确定，未编造人名",
        roles: unknown,
      });
    }

    var assumed = (roles.roles || [])
      .filter(function (r) {
        return (r.freq || {}).timesStatus === "ASSUMED";
      })
      .map(function (r) {
        return r.id;
      });
    if (assumed.length) {
      warnings.push({
        code: "DUTY_TIME_ASSUMED",
        message: "以下岗位的触发时刻是按常理排的，需老师核对",
        roles: assumed,
      });
    }

    return {
      date: dateStr,
      weekday: weekday,
      weekdayName: "周" + WEEKDAY_CN[weekday - 1],
      weekNo: weekNo,
      weekRule: parity,
      inSchool: true,
      calendar: { label: info.label, makeup: info.reason === "makeup" },
      group: group,
      class: schedule.class,
      noon: {
        preset: noon.preset,
        label: noon.label,
        title: noon.title,
        tip: noon.tip || "",
        items: noon.items || [],
        pre: noon.pre === undefined ? null : noon.pre,
        band: timetable.noonBand,
      },
      timeline: timeline,
      duties: duties,
      marks: (timetable.marks || []).filter(function (m) {
        return m.kind === "arrive" || m.kind === "dismiss";
      }),
      unknown: unknown,
      unset: unset,
      warnings: warnings,
    };
  }

  return {
    buildDay: buildDay,
    weekInfo: weekInfo,
    groupFor: groupFor,
    resolveDay: resolveDay,
    /* 「今天这个岗位归谁」只有一个答案，就是这个函数。编辑面板也调它，
       不再自己按 people / peopleMap / groups 另算一套——那样两处的
       优先级顺序迟早不一样（曾经就是：面板先看 peopleMap，引擎先看
       groups，同一个岗位两处显示不同的人）。 */
    resolvePeople: resolvePeople,
    nameList: nameList,
    t2m: t2m,
    m2t: m2t,
    parseDate: parseDate,
    isoWeekday: isoWeekday,
  };
});
