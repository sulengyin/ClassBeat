/* 开机自动恢复的最小桩测试：backup.js 的 bootRestore 决策树。
   不碰真浏览器，只验证分支与副作用：
     1. 快照班名 ≠ 本地班名（origin 漂移后的空壳）→ 恢复 + 刷新
     2. 快照班名 = 本地班名（就是同一份）→ 一个字都不动
     3. 服务端没有备份 → 不动
     4. 快照没有班名（坏快照）→ 不恢复，退化为手动提示
   node tools/test_backup.js */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(ok, title, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + title + (detail ? "  · " + detail : ""));
  ok ? pass++ : fail++;
}

const SRC = path.resolve(__dirname, "..", "app", "backup.js");
const CODE = fs.readFileSync(SRC, "utf-8");

/* 构造可控桩并加载 backup.js；返回 { log, els }。
   桩里的 setTimeout 立即执行，fetch 用同步 resolve 的 Promise，
   所以加载完再等一轮微任务，整条链就走完了。 */
function makeEnv(snapshot, localKlass) {
  const log = { imported: 0, reloaded: 0 };
  const storeData = { config: { meta: { klass: localKlass } } };
  const els = {};
  function el(id) {
    if (!els[id]) els[id] = { hidden: true, textContent: "" };
    return els[id];
  }

  const win = {
    Store: {
      exportAll() { return JSON.parse(JSON.stringify(storeData)); },
      importAll(obj) {
        storeData.config = (obj && obj.config) || storeData.config;
        log.imported++;
        return { ok: true };
      },
    },
    fetch(url) {
      if (url === "/api/config/backup") {
        const items = snapshot ? [{ day: "2026-11-19" }] : [];
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, items }) });
      }
      if (url.indexOf("/api/config/backup/2026-11-19") === 0) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(snapshot) });
      }
      return Promise.reject(new Error("bad url " + url));
    },
    setTimeout(fn) { fn(); return 0; },
    setInterval() { return 0; },
    location: {
      protocol: "http:",
      hostname: "127.0.0.1",
      reload() { log.reloaded++; },
    },
    localStorage: {
      _m: {},
      getItem(k) { return this._m[k] || null; },
      setItem(k, v) { this._m[k] = v; },
    },
    document: {
      getElementById: el,
      addEventListener() {},
      visibilityState: "visible",
    },
  };
  new Function("window", "document", CODE)(win, win.document);
  return { log, els };
}

function scenario(title, snapshot, localKlass, expect, checks) {
  const env = makeEnv(snapshot, localKlass);
  Promise.resolve().then(() => setTimeout(() => {
    let okAll = true;
    for (const [cond, name] of checks) {
      const ok = !!cond(env);
      okAll = okAll && ok;
      check(ok, name, "");
    }
    if (!okAll) console.log("  （场景 " + title + " 没全过）");
    expect();
  }, 20));
}

const snap = { config: { meta: { klass: "五1班" } }, texts: {}, overrides: {}, phrases: [] };

scenario(
  "1 班名漂移", snap, "班级",
  () => scenario(
    "2 同一份", snap, "五1班",
    () => scenario(
      "3 无备份", null, "班级",
      () => scenario(
        "4 坏快照", { config: {} }, "班级",
        () => {
          console.log();
          console.log(`${pass}/${pass + fail} 通过`);
          process.exit(fail ? 1 : 0);
        },
        [
          [(e) => e.log.imported === 0, "4 快照没有班名时不恢复"],
          [(e) => e.els.tip && e.els.tip.hidden === false, "4a 退化为手动恢复提示"],
          [(e) => (e.els.tipText || {}).textContent
            && e.els.tipText.textContent.indexOf("备份") >= 0, "4b 提示文案在"],
        ]
      ),
      [
        [(e) => e.log.imported === 0, "3 服务端没有备份时不动作"],
        [(e) => e.log.reloaded === 0, "3a 也不刷新"],
      ]
    ),
    [
      [(e) => e.log.imported === 0, "2 班名一致时不恢复"],
      [(e) => e.log.reloaded === 0, "2a 也不刷新"],
    ]
  ),
  [
    [(e) => e.log.imported === 1, "1 班名不一致时自动恢复快照"],
    [(e) => e.log.reloaded === 1, "1a 恢复后刷新页面"],
    [(e) => e.els.tip && e.els.tip.hidden !== false ? false : true, "1b 不弹提示"],
  ]
);
