/* 三套作息模板（P5 配置向导的数据层）。
 *
 * 为什么是"整份作息"而不是几个参数：二十几个块的先后和类型是学校的
 * 真实结构，参数化到最后还是得把这些块拼一遍，不如直接给一份能算的
 * 骨架，老师在向导里只改起止时间。模板之间只差每节课的长度。
 *
 * 时间一律顺序推导，不锚定 11:40 这类绝对时刻——不同课时长的学校，
 * 上午结束时间本来就不同，写死会撞车。
 */
(function (root) {
  "use strict";

  function hm(m) {
    var h = Math.floor(m / 60), mm = m % 60;
    return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
  }

  function make(lesson, label, note) {
    var t = 7 * 60 + 30;
    var blocks = [];
    var seq = 0;

    function push(type, minutes, extra) {
      seq++;
      var b = { seq: seq, start: hm(t), end: hm(t + minutes), type: type };
      if (extra) Object.keys(extra).forEach(function (k) { b[k] = extra[k]; });
      t += minutes;
      blocks.push(b);
      return b;
    }

    blocks.push({ seq: "0a", start: hm(t), end: hm(t + 40), type: "reading", name: "晨间自主管理" });
    t += 40;
    blocks.push({ seq: "0b", start: hm(t), end: hm(t + 10), type: "break", name: "课间" });
    t += 10;

    push("class", lesson, { periodNo: 1 });
    push("ritual", 30, { name: "大课间", tip: "排队下楼，靠右行走，不推不挤" });
    push("class", lesson, { periodNo: 2 });
    push("ritual", 5, { name: "眼保健操", tip: "闭眼，按节拍，坐姿端正" });
    push("break", 10, { name: "课间" });
    push("class", lesson, { periodNo: 3 });
    push("break", 15, { name: "课间" });
    push("class", lesson, { periodNo: 4 });

    push("meal", 30, { name: "午餐", tip: "排队取餐，不推挤；饭后把桌面擦干净" });
    var lunchEnd = t;
    push("noon", 40, { name: "午间", note: "内容由午间规则决定，此处只占位" });
    var noonEnd = t;

    push("break", 10, { name: "课间" });
    push("class", lesson, { periodNo: 5 });
    push("ritual", 5, { name: "眼保健操", tip: "闭眼，按节拍，坐姿端正" });
    push("break", 10, { name: "课间" });
    push("class", lesson, { periodNo: 6 });
    push("ritual", 30, { name: "大课间", tip: "活动前先热身，出汗及时擦" });
    push("class", lesson, { periodNo: 7 });
    push("break", 10, { name: "课间" });
    push("after", 40, { name: "课后服务 · 第一时段", tip: "按老师安排，不擅自离开教室" });
    push("break", 10, { name: "课间" });
    push("after", 40, { name: "课后服务 · 第二时段", tip: "整理书包，带走自己的物品" });

    var end = t;
    return {
      id: "p" + lesson,
      label: label,
      note: note,
      lesson: lesson,
      blocks: blocks,
      noonBand: { lunchEnd: hm(lunchEnd), bell: hm(lunchEnd), noonEnd: hm(noonEnd) },
      marks: [
        { at: hm(7 * 60 + 30 - 10), kind: "arrive", status: "ASSUMED" },
        { at: hm(end - 10), kind: "dismiss", status: "ASSUMED" }
      ]
    };
  }

  root.RHYTHM_TEMPLATES = [
    make(40, "每节 40 分钟", "最常见的小学作息，上午 4 节、下午 3 节"),
    make(35, "每节 35 分钟", "课时偏短，放学相应提前；适合低年级"),
    make(45, "每节 45 分钟", "课时偏长，放学相应推后；适合高年级")
  ];
})(typeof window !== "undefined" ? window : globalThis);
