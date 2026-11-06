/* 班级信息只有一个来源：data.js 里的 meta。
 *
 * 页面、标题、导出文件名都从这里取，不在别处写死某个具体班名——
 * 别人 clone 下来换一份数据，整套东西就变成他自己的班。
 *
 * meta 由 tools/bundle.py 从 data/schedule.json 与 data/timetable.json 生成。
 * 数据里没有就退回中性默认值，不报错：缺班级名不该让大屏打不开。
 */
(function (root) {
  "use strict";

  /* meta 可能被本机设置改过（班名、校名），所以先问 Runtime；
     Runtime 还没起来（脚本顺序变了）就退回 data.js 里的出厂值。 */
  function meta() {
    var r = root.Runtime;
    if (r && r.config) {
      var c = r.config();
      if (c && c.meta) return c.meta;
    }
    var d = root.RHYTHM_DATA;
    return (d && d.meta) || {};
  }

  var CFG = {
    school: function () { return meta().school || ""; },

    /* 「我的班」不是占位符，是明确告诉老师：这个名字还没填 */
    klass: function () { return meta().klass || "我的班"; },

    head: function () { return meta().headTeacher || ""; },

    /* 页面标题：紧急通知优先，其次当前时段 */
    title: function (state) {
      var head = (state && state.urgent) ? "紧急通知"
        : (state && state.title) || "今日";
      return head + " · " + CFG.klass();
    },

    /* 设置面板抬头用：「班名 · 设置」 */
    label: function (suffix) {
      return CFG.klass() + (suffix ? " · " + suffix : "");
    },

    /* 导出的文件名，去掉 Windows 不允许的字符 */
    fileSlug: function () {
      return CFG.klass().replace(/[\\/:*?"<>|]/g, "");
    }
  };

  root.CFG = CFG;
})(window);
