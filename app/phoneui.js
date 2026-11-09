/* 大屏右下角「手机」：把发消息的地址变成一个二维码。
   老师不用抄 IP：手机扫一下就进发送页。

   网址从哪来：服务端 /api/ping 会报它自己的局域网地址（lan）。
   只有本机地址时（127.0.0.1）手机是连不上的，宁可显示操作步骤，也不画一个扫不开的码。 */
(function (root) {
  "use strict";

  var doc = root.document;
  if (!doc) return;

  var panel = doc.getElementById("qr-panel");
  var canvas = doc.getElementById("qr-canvas");
  var urlEl = doc.getElementById("qr-url");
  var emptyEl = doc.getElementById("qr-empty");
  var copyRow = doc.getElementById("qr-copy-row");
  var copyBtn = doc.getElementById("qr-copy");
  var copiedEl = doc.getElementById("qr-copied");
  var changeEl = doc.getElementById("qr-change");
  var btn = doc.getElementById("btn-phone");
  var closeBtn = doc.getElementById("qr-close");
  if (!panel || !canvas || !btn) return;

  var currentUrl = "";

  /* file:// 下 navigator.clipboard 不一定可用，用 textarea + execCommand 更稳。
     失败也不抛错——按钮上会说“复制失败，请手动选中”。 */
  function copyText(text) {
    try {
      var ta = doc.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      doc.body.appendChild(ta);
      ta.select();
      if (ta.setSelectionRange) ta.setSelectionRange(0, text.length);
      var ok = doc.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  function isLoopback(u) {
    return /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(u || "");
  }

  /* 优先用服务报的局域网地址；退而求其次用页面自己的地址。
     两个都是本机地址就返回空——那说明手机根本连不过来。 */
  function phoneUrl(info) {
    var loc = root.location || {};
    var served = /^https?:$/.test(loc.protocol || "") ? loc.protocol + "//" + loc.host + "/" : "";
    var srv = info && info.phone ? String(info.phone).replace(/\/+$/, "") + "/" : "";
    if (srv && !isLoopback(srv)) return srv;
    if (served && !isLoopback(served)) return served;
    return "";
  }

  function render(info) {
    var url = phoneUrl(info);
    currentUrl = url;
    if (url) {
      var ok = root.QR && root.QR.paint(canvas, url);
      canvas.hidden = !ok;
      emptyEl.hidden = ok;
      urlEl.textContent = ok ? url : "";
    } else {
      canvas.hidden = true;
      emptyEl.hidden = false;
      urlEl.textContent = "";
    }
    if (copyRow) copyRow.hidden = !url;
    if (changeEl) {
      var changed = !!(url && info && info.addrChanged);
      changeEl.hidden = !changed;
      if (changed) {
        changeEl.textContent = "这台电脑的地址和上次不同"
          + (info.lastLan ? "（上次是 " + info.lastLan + "）" : "")
          + "。钉钉里存的链接要重新复制一次。";
      }
    }
  }

  function open() {
    panel.classList.add("open");
    /* 先用手上的，再问一次服务——大屏可能比服务先开 */
    render(root.Remote && root.Remote.info);
    var p = root.Remote && root.Remote.probe && root.Remote.probe();
    if (p && p.then) p.then(render);
  }

  function close() {
    panel.classList.remove("open");
  }

  btn.addEventListener("click", open);
  if (closeBtn) closeBtn.addEventListener("click", close);
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      if (!currentUrl) return;
      var ok = copyText(currentUrl);
      if (copiedEl) {
        copiedEl.textContent = ok ? "已复制" : "复制失败，请手动选中地址";
        copiedEl.hidden = false;
        if (ok && root.setTimeout) {
          root.setTimeout(function () { copiedEl.hidden = true; }, 2200);
        }
      }
    });
  }
  panel.addEventListener("click", function (e) {
    if (e.target === panel) close();        /* 点空白处关掉 */
  });
  doc.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });

  root.PhoneUI = { open: open, close: close, url: phoneUrl, copy: copyText };
})(window);
