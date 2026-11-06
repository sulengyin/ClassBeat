/* 运行时：配置 → 某一天。
 *
 * 以前 data.js 里塞着 35 天编译好的结果（275 KB），过期就得重新打包。
 * 现在 data.js 只装配置（几十 KB），当天的课表由 engine/schedule.js 现算：
 * 改一条作息不用重新打包，下一次重绘就是新时间。
 *
 * 只缓存最后算过的那一天——每秒重绘一次，没必要反复算；
 * 但换了日期或改了配置就必须重算，所以缓存带版本号。
 */
(function (root) {
  "use strict";

  var Engine = root.Schedule;
  var rev = 0;
  var lastKey = null, lastRev = -1, lastDay = null;

  function data() { return root.RHYTHM_DATA || {}; }
  function local() {
    return (root.Store && root.Store.config) ? root.Store.config() : {};
  }

  /* 出厂配置（data.js）+ 本机改动（localStorage），本机优先。
     meta 逐字段合并：改了班名不该把学校名一起抹掉。 */
  function config() {
    var d = data(), o = local();
    function pick(k) { return o[k] !== undefined ? o[k] : d[k]; }
    return {
      meta: Object.assign({}, d.meta || {}, o.meta || {}),
      timetable: pick("timetable"),
      schedule: pick("schedule"),
      content: pick("content"),
      roles: pick("roles"),
      noon: pick("noon"),
      calendar: pick("calendar") || { days: {} }
    };
  }

  /* 配置齐不齐。缺了不是"今天没数据"，是包本身没生成对。 */
  function ready() {
    var c = config();
    return !!(Engine && c.timetable && c.schedule && c.roles && c.content && c.noon);
  }

  function day(key) {
    if (!ready()) return null;
    if (key === lastKey && rev === lastRev) return lastDay;
    try {
      lastDay = Engine.buildDay(config(), key);
    } catch (e) {
      /* 配置写坏了不该让整块屏白掉：记下来，上层显示提示 */
      if (root.console && root.console.error) root.console.error("算不出 " + key, e);
      lastDay = null;
    }
    lastKey = key;
    lastRev = rev;
    return lastDay;
  }

  /* 改了作息 / 课表 / 岗位之后调用。写进本机配置，下一次重绘就是新时间。
     大屏每秒重绘一次，所以最迟一秒就会变，不需要刷新，也不需要重新打包。 */
  function patch(part) {
    if (root.Store && root.Store.patchConfig) {
      root.Store.patchConfig(part);
      return;
    }
    var d = data();
    Object.keys(part || {}).forEach(function (k) { d[k] = part[k]; });
    rev++;
    if (root.Screen && root.Screen.render) root.Screen.render();
  }

  /* 配置被别处（导入、撤销）改过：让下一次 day() 重算 */
  function reload() {
    rev++;
    if (root.Screen && root.Screen.render) root.Screen.render();
  }

  /* 编辑面板要列出"一天里出现过的时段名"，算这一周就够了。
     周一为起点；周末不上学，不用算。 */
  function weekKeys(key) {
    var p = String(key).split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    var back = (d.getUTCDay() + 6) % 7;  /* 周一=0 */
    d.setUTCDate(d.getUTCDate() - back);
    var out = [];
    for (var i = 0; i < 5; i++) {
      out.push(d.getUTCFullYear() + "-" +
        (d.getUTCMonth() < 9 ? "0" : "") + (d.getUTCMonth() + 1) + "-" +
        (d.getUTCDate() < 10 ? "0" : "") + d.getUTCDate());
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }

  root.Runtime = {
    day: day,
    config: config,
    ready: ready,
    patch: patch,
    reload: reload,
    weekKeys: weekKeys,
    rev: function () { return rev; }
  };
})(window);
