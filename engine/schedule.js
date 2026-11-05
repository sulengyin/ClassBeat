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

  function contentFor(content, subject) {
    if (!subject) return null;
    var list = (content && content.subjects) || [];
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

      out.push(b);
    });

    return out;
  }

  // ---------- 岗位 ----------

  function resolvePeople(role, group, groupReason, weekday) {
    if (role.groups) {
      var chosen = group || (role.cycle || {}).current;
      if (!chosen) return [null, groupReason || "cycle-group-unconfirmed"];
      return [role.groups[chosen] || [], null];
    }

    var rot = role.rotation;
    if (rot) {
      if (rot.status !== "confirmed") return [null, "rotation-unconfirmed"];
      if (rot.kind === "weekday-map") {
        var person = (role.peopleMap || {})[String(weekday)];
        if (!person) return [null, "weekday-not-mapped"];
        return [[person], null];
      }
    }

    return [role.people || [], null];
  }

  function roleTriggers(role, blocks, noon, weekday) {
    var freq = role.freq || {};
    var kind = freq.kind;
    var out = [];

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

  function buildDuties(roles, blocks, noon, weekday, group, groupReason) {
    var duties = [];
    var unset = [];
    var unknown = [];

    (roles.roles || []).forEach(function (role) {
      if (!role.freq || role.freq.kind === "unset") {
        unset.push(role.id);
        return;
      }

      var res = resolvePeople(role, group, groupReason, weekday);
      var people = res[0];
      var reason = res[1];
      var triggers = roleTriggers(role, blocks, noon, weekday);
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
          substitute: role.substitute || [],
          status: people !== null ? "ok" : "unknown",
          reason: reason,
          freqKind: role.freq.kind,
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

    var dutyResult = buildDuties(roles, blocks, noon, weekday, group, groupReason);
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
    t2m: t2m,
    m2t: m2t,
    parseDate: parseDate,
    isoWeekday: isoWeekday,
  };
});
