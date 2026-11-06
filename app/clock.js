/* 唯一的「现在几点」来源。
 *
 * 教室一体机的系统时区经常不是 +08:00（出厂默认 UTC、或者被改成别的城市），
 * 这时候 new Date().getHours() 会整体偏 8 小时，课表全错。所以这里不读本地
 * 时区，一律把时间戳换算成 UTC+8：北京时间没有夏令时，是一个固定偏移。
 *
 * 设备时钟本身也可能走偏。局域网消息服务可达时，用它的时间校准一次
 * （/api/time）；服务不在就用系统时钟，绝不因为校时失败挡住大屏。
 *
 * 注入点（演示、测试）：
 *   __rhythmTime  分钟数，设了就不看真实时间
 *   __rhythmDate  日期字符串，设了就不算今天
 *   ?t=HH:MM&date=YYYY-MM-DD  同上的 URL 版本
 */
(function (root) {
  "use strict";

  var OFFSET_MIN = 8 * 60;            /* 北京时间 = UTC+8 */
  var MAX_SKEW = 12 * 60 * 60 * 1000; /* 超过 12 小时的"校准"一定是坏数据 */

  var skew = 0;                       /* 服务端时间 - 本机时间 */
  var syncedAt = 0;

  var q = null;
  try {
    q = new root.URLSearchParams((root.location && root.location.search) || "");
  } catch (e) {
    q = { get: function () { return null; } };
  }
  var fixedTime = q.get("t");
  var fixedDate = q.get("date");

  function shifted(ms) {
    return new Date(ms + OFFSET_MIN * 60000);
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /* 任意时间戳 → 北京时间的年月日时分秒 */
  function partsAt(ms) {
    var d = shifted(ms);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds()
    };
  }

  function minutesAt(ms) {
    var d = shifted(ms);
    return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  }

  function dayKeyAt(ms) {
    var p = partsAt(ms);
    return p.year + "-" + pad(p.month) + "-" + pad(p.day);
  }

  function nowMs() {
    return Date.now() + skew;
  }

  function minutes() {
    if (root.__rhythmTime != null) return root.__rhythmTime;
    if (fixedTime) {
      var p = String(fixedTime).split(":");
      return (+p[0]) * 60 + (+p[1]) + (+(p[2] || 0)) / 60;
    }
    return minutesAt(nowMs());
  }

  function dayKey() {
    if (root.__rhythmDate) return root.__rhythmDate;
    if (fixedDate) return fixedDate;
    return dayKeyAt(nowMs());
  }

  /* 用服务端时间校准。返回是否采纳。
     测试把浏览器时钟钉死时加 ?nosync=1，否则会被服务端时间拉回真实时刻。 */
  function sync(serverMs) {
    if (q.get("nosync") === "1") return false;
    var n = Number(serverMs);
    if (!isFinite(n) || n <= 0) return false;
    if (n < 1e12) n *= 1000;          /* 有的服务只给到秒 */
    var delta = n - Date.now();
    if (Math.abs(delta) > MAX_SKEW) return false;
    skew = delta;
    syncedAt = Date.now();
    return true;
  }

  root.Clock = {
    minutes: minutes,
    dayKey: dayKey,
    nowMs: nowMs,
    minutesAt: minutesAt,
    dayKeyAt: dayKeyAt,
    partsAt: partsAt,
    sync: sync,
    skewMs: function () { return skew; },
    syncedAt: function () { return syncedAt; },
    offsetMinutes: OFFSET_MIN
  };
})(typeof window !== "undefined" ? window : globalThis);
