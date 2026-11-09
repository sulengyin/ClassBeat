/* 大屏找服务：端口被别的软件占了，服务会挪到 8766、8767…
   大屏得自己找过去，否则手机能发、屏上没反应。
   没有浏览器，这里用桩 fetch 模拟「哪个端口上有我们自己的服务」。
   node tools/test_remote.js */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function check(ok, title, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + title + (detail ? "  · " + detail : ""));
  ok ? pass++ : fail++;
}

const CODE = fs.readFileSync(path.join(__dirname, "..", "app", "remote.js"), "utf8");

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* hubPorts：哪几个端口上跑着我们的服务（只在该端口返回 app=classbeat） */
function boot(hubPorts, search, opts) {
  const legacy = !!(opts && opts.legacy);
  const calls = [];
  const root = {
    location: { search: search || "", protocol: "file:", host: "" },
    document: { readyState: "complete", addEventListener() {} },
    Screen: {
      nowMinutes: () => 600,
      todayKey: () => "2026-11-09",
      render() {},
      hideMessage() {},
      showMessage() {}
    },
    Store: { patchDayOverride() {} },
    EventSource: function (url) { this.url = url; this.readyState = 0; this.close = function () {}; },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    /* 大屏在真机上会常驻，这里给个假的，别让 node 等十分钟 */
    setInterval: () => 0,
    URLSearchParams: URLSearchParams,
    Promise: Promise,
    console: console,
    fetch: function (url) {
      calls.push(url);
      const port = Number((url.match(/:(\d+)\//) || [])[1]);
      const live = hubPorts && hubPorts.has(port);
      if (/\/api\/ping/.test(url)) {
        if (!live) return Promise.reject(new Error("refused"));
        const body = {
          ok: true, port: port,
          lan: "http://192.168.11.28:" + port,
          class: "测试班", addrChanged: false, lastLan: ""
        };
        if (!legacy) body.app = "classbeat";
        return Promise.resolve({ json: () => Promise.resolve(body) });
      }
      if (!live) return Promise.reject(new Error("refused"));
      if (/\/api\/messages/.test(url)) {
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, messages: [] }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, now: Date.now() }) });
    }
  };
  const ctx = vm.createContext(root);
  ctx.window = ctx;
  vm.runInContext(CODE, ctx, { filename: "remote.js" });
  return { root: ctx, calls: calls };
}

(async function main() {
  /* ① 8765 上没有，8767 上有：应该自己切到 8767 */
  const a = boot(new Set([8767]));
  await wait(120);
  check(/^http:\/\/127\.0\.0\.1:8767$/.test(a.root.Remote.hub),
        "① 服务挪到 8767，大屏自己找过去", a.root.Remote.hub);
  const info = await a.root.Remote.probe();
  check(info.online === true && /192\.168\.11\.28:8767\/?$/.test(info.phone),
        "①a 找到之后二维码用的是新端口", info.phone);

  const pinged = a.calls.filter((u) => /\/api\/ping/.test(u)).map((u) => (u.match(/:(\d+)\//) || [])[1]);
  check(pinged.indexOf("8765") >= 0 && pinged.indexOf("8766") >= 0 && pinged.indexOf("8767") >= 0,
        "①b 从 8765 起按顺序问过来", pinged.join(" → "));
  check(pinged.indexOf("8768") < 0, "①c 命中就停，不白问后面的", pinged.join(","));

  /* ② 全都没有：保持默认端口，报离线，绝不抛错 */
  const b = boot(new Set());
  await wait(200);
  check(/^http:\/\/127\.0\.0\.1:8765$/.test(b.root.Remote.hub),
        "② 一个都没有时仍是默认 8765", b.root.Remote.hub);
  const info2 = await b.root.Remote.probe();
  check(info2.online === false, "②a 如实报离线，不挡大屏");
  const scans = b.calls.filter((u) => /\/api\/ping/.test(u)).length;
  check(scans >= 10, "②b 十个端口都问过才放弃", scans + " 次");

  /* ③ 指定了 ?hub=：不再扫本机，免得扫出一台不相干的机器 */
  const c = boot(new Set([8767]), "?hub=10.0.0.5:9000");
  await wait(120);
  check(/^http:\/\/10\.0\.0\.5:9000$/.test(c.root.Remote.hub),
        "③ 指定 hub 时原样使用", c.root.Remote.hub);
  const local = c.calls.filter((u) => /127\.0\.0\.1/.test(u));
  check(local.length === 0, "③a 指定 hub 后不扫本机端口", local.join(",") || "无");

  /* ④ 老版本服务没有 app 字段：升级到一半也不能互相找不到 */
  const d = boot(new Set([8766]), "", { legacy: true });
  await wait(120);
  check(/^http:\/\/127\.0\.0\.1:8766$/.test(d.root.Remote.hub),
        "④ 老服务没 app 字段也认（升级不停机）", d.root.Remote.hub);

  /* ⑤ 老师先开大屏、后启动服务：下一次探测要能重新找到，不用刷新 */
  const live = new Set();
  const e = boot(live);
  await wait(150);
  check(/^http:\/\/127\.0\.0\.1:8765$/.test(e.root.Remote.hub),
        "⑤ 服务还没起时停在默认端口", e.root.Remote.hub);
  live.add(8766);
  const late = await e.root.Remote.probe();
  check(late.online === true && /^http:\/\/127\.0\.0\.1:8766$/.test(e.root.Remote.hub),
        "⑤a 服务后起，下次探测自动接上", e.root.Remote.hub);

  console.log();
  console.log(`${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})();
