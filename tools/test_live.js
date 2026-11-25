/* 配置的「服务端保管」层测试（0.5.9）。
   为什么单独一个文件：这一层全是异步 + 失败重试，用真定时器跑才像真环境，
   塞进 test_store.js（纯同步）会把那边搅乱。
   覆盖的都是真实踩点：
     · 单文件演示版（file://）不能因为这一层去联网；
     · 服务停了 / WiFi 断着时改的配置，不能丢；
     · 页面刚打开还没对上版本号就写，不能被当成过期修改丢掉；
     · 重置 / 导入也要推上去，否则别的设备会把旧配置带回来。
   node tools/test_live.js */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
global.window = global;
function loadBrowserScript(f) {
  const code = fs.readFileSync(path.join(ROOT, f), "utf8");
  new Function("module", "exports", "require", "self", code)(undefined, undefined, undefined, global);
}
["app/data.js", "app/engine/schedule.js", "app/rhythm.js", "app/pinyin.js",
 "app/store.js", "app/runtime.js"].forEach(loadBrowserScript);

const S = global.window.Store;

let pass = 0, fail = 0;
function check(ok, title, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + title + (detail ? "  · " + detail : ""));
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const names = () => (S.config().students || []).map((s) => s.name).join("/");

/* 一个够用的假服务端：rev 冲突就按真服务端那样回 stale。 */
function makeServer(rev, config) {
  const st = { rev: rev || 0, config: config || null, writes: 0, calls: [], online: true, lastBase: null };
  st.fetch = (url, opt) => {
    const method = (opt && opt.method) || "GET";
    st.calls.push(method + " " + url);
    if (!st.online) return Promise.reject(new Error("offline"));
    if (method === "GET") {
      const revOnly = /[?&]rev=/.test(url);
      const body = revOnly ? { ok: true, rev: st.rev } : { ok: true, rev: st.rev, config: st.config };
      return Promise.resolve({ json: () => Promise.resolve(body) });
    }
    const payload = JSON.parse(opt.body);
    st.lastBase = payload.baseRev;
    if (payload.baseRev !== st.rev) {
      return Promise.resolve({
        json: () => Promise.resolve({ ok: false, stale: true, rev: st.rev, config: st.config }),
      });
    }
    st.rev++;
    st.config = payload.config;
    st.writes++;
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, rev: st.rev }) });
  };
  return st;
}

(async () => {
  /* ---------- 1. 单文件演示版不联网 ---------- */
  const spy = makeServer(0, null);
  global.location = { protocol: "file:" };
  global.fetch = () => { spy.calls.push("SHOULD-NOT-HAPPEN"); return Promise.reject(new Error("x")); };
  S.livePull();
  await sleep(600);
  check(spy.calls.length === 0, "file:// 打开时这一层自动停用，不会去联网", spy.calls.join(",") || "0 次请求");

  /* ---------- 2. 服务端空着、本机有配置：开机自己推上去 ---------- */
  let srv = makeServer(0, null);
  global.location = { protocol: "http:" };
  global.fetch = srv.fetch;
  S.patchConfig({
    meta: { school: "常州市局前街小学", klass: "五（1）班", headTeacher: "张老师" },
    students: [{ name: "旧名单甲", active: true }, { name: "旧名单乙", active: true }],
  });
  await sleep(700);
  check(srv.rev === 1 && srv.config && srv.config.meta.klass === "五（1）班",
    "服务端还没有配置时，本机这份自动变成服务端那份", "rev=" + srv.rev);
  check(srv.config && srv.config.students.length === 2, "名单跟着上去", names());

  /* ---------- 3. 服务停了时改的配置，不能丢 ---------- */
  srv.online = false;
  S.patchConfig({ students: [{ name: "离线甲", active: true }, { name: "离线乙", active: true }] });
  await sleep(600);
  check(names() === "离线甲/离线乙", "断网时改动留在本机（屏上照常变）", names());

  /* 服务回来了，但版本号已经比本机高（别的设备改过）。本机这笔没推的改动
     不能因为「版本号落后」被悄悄丢掉；只推本机改过的那一块。 */
  srv.online = true;
  srv.rev = 7;
  srv.config = {
    meta: { klass: "别人的班" },
    students: [{ name: "别人的学生", active: true }],
    timetable: { blocks: [{ start: "08:00", end: "08:40", label: "别人的作息" }] },
  };
  S.livePull();
  await sleep(1200);
  check(names() === "离线甲/离线乙", "断线期间的改动没被服务端那份盖掉", names());
  check(S.config().timetable && S.config().timetable.blocks[0].label === "别人的作息",
    "本机没改过的块听服务端的（课表没被推回旧版本）",
    S.config().timetable ? S.config().timetable.blocks[0].label : "(丢了)");
  check(srv.config.students.map((s) => s.name).join("/") === "离线甲/离线乙",
    "补推之后服务端也是断线期间改的那份", srv.config.students.map((s) => s.name).join("/"));
  check(srv.rev === 8 && srv.lastBase === 7,
    "补推带的是服务端最新 rev，不是 0（不会被判过期）",
    "带去的 baseRev=" + srv.lastBase + "，推完 rev=" + srv.rev);

  /* ---------- 4. 别的设备改了，本机跟上 ---------- */
  srv.rev++;
  srv.config = { meta: { klass: "六（2）班" }, students: [{ name: "周予宁", active: true }] };
  S.livePull();
  await sleep(500);
  check(S.config().meta.klass === "六（2）班" && names() === "周予宁",
    "服务端有新版本时，本机采用它", S.config().meta.klass + " / " + names());
  check(S.liveRev() === srv.rev, "本机记下的版本号跟着走", "本机=" + S.liveRev() + " 服务端=" + srv.rev);

  /* ---------- 5. 重置也要推上去 ---------- */
  const before = srv.rev;
  S.resetConfig();
  await sleep(700);
  check(srv.rev === before + 1, "重置配置也写了服务端（不然别的设备会把旧配置带回来）",
    "rev " + before + " → " + srv.rev);
  check(!srv.config.students && !srv.config.meta, "服务端那份确实清空了", JSON.stringify(srv.config));

  /* ---------- 6. 导入整份设置也要推上去 ---------- */
  const imported = S.importAll({
    format: "rhythm-config/v1",
    schemaVersion: 2,
    config: { meta: { klass: "四（3）班" }, students: [{ name: "导入甲", active: true }] },
  });
  await sleep(700);
  check(imported.ok, "导入本身成功", imported.why || "");
  check(srv.config && srv.config.meta && srv.config.meta.klass === "四（3）班",
    "导入的配置也成了服务端那份", srv.config && srv.config.meta && srv.config.meta.klass);

  /* ---------- 7. 两端同时改：按块合并，不互相整份覆盖 ---------- */
  srv.rev++;                                        /* 另一台设备刚改过班级名 */
  srv.config = Object.assign({}, srv.config, { meta: { klass: "另一台改的班" } });
  /* 本机这时还不知道它改过（没拉），自己改了另一块并保存 */
  S.patchConfig({ content: { notice: "本机刚写的通知" } });
  await sleep(1200);
  check(S.config().meta.klass === "另一台改的班",
    "撞车后本机没把别人改的班级名推回旧值", S.config().meta.klass);
  check(S.config().content && S.config().content.notice === "本机刚写的通知",
    "本机刚保存的那块生效了（没被悄悄回滚）", JSON.stringify(S.config().content));
  check(srv.config.meta.klass === "另一台改的班" &&
        srv.config.content.notice === "本机刚写的通知",
    "服务端那份两边都在", JSON.stringify(srv.config.meta) + " " + JSON.stringify(srv.config.content));
  check(S.liveRev() === srv.rev, "合并后版本号对齐", "本机=" + S.liveRev() + " 服务端=" + srv.rev);

  console.log("\n" + pass + "/" + (pass + fail) + " 通过");
  process.exit(fail ? 1 : 0);
})();
