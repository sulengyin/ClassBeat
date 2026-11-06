/* 把一段文字画成二维码。编码交给 vendor/qrcode.min.js（MIT），这里只管排版：
   选整数倍像素、留四个模块的静区、居中等分。

   出错就返回 false——大屏宁可只显示地址，也不能因为画不出码而白屏。 */
(function (root) {
  "use strict";

  var QUIET = 4;          /* 静区：扫码器靠这圈白边认出码的边界 */

  function make(text, ecc) {
    var Lib = root.qrcode;
    if (typeof Lib !== "function" || !text) return null;
    try {
      var q = Lib(0, ecc || "M");   /* 0 = 按内容长度自动选版本 */
      q.addData(text, "Byte");
      q.make();
      return q;
    } catch (e) {
      return null;
    }
  }

  function paint(canvas, text) {
    var q = make(text);
    if (!q || !canvas) return false;
    var ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) return false;

    var side = canvas.width || 512;
    var n = q.getModuleCount();
    var total = n + QUIET * 2;
    var cell = Math.max(1, Math.floor(side / total));
    var off = Math.floor((side - cell * total) / 2);   /* 除不尽的余数变成四周白边 */

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, side, side);
    ctx.fillStyle = "#000";
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (q.isDark(r, c)) {
          ctx.fillRect(off + (c + QUIET) * cell, off + (r + QUIET) * cell, cell, cell);
        }
      }
    }
    return true;
  }

  root.QR = { make: make, paint: paint, quiet: QUIET };
})(window);
