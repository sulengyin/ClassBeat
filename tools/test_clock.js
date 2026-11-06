/* 校时测试：北京时间只看时间戳，不看设备时区。
   node tools/test_clock.js */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
global.window = global;
global.location = { search: "" };

function loadBrowserScript(f) {
  const code = fs.readFileSync(path.join(ROOT, f), "utf8");
  new Function("module", "exports", "require", "self", code)(undefined, undefined, undefined, global);
}
["app/clock.js"].forEach(loadBrowserScript);

const C = global.Clock;
let pass = 0, fail = 0;
function check(ok, title, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + title + (detail ? "  · " + detail : ""));
  ok ? pass++ : fail++;
}

/* UTC 00:00 = 北京 08:00 */
check(C.minutesAt(Date.UTC(2026, 0, 1, 0, 0)) === 480,
  "UTC 零点换算成北京 08:00", String(C.minutesAt(Date.UTC(2026, 0, 1, 0, 0))));

/* 北京 23:59 还是当天；过了 16:00 UTC 才跨日 */
check(C.dayKeyAt(Date.UTC(2026, 10, 5, 15, 59)) === "2026-11-05",
  "北京 23:59 仍是当天", C.dayKeyAt(Date.UTC(2026, 10, 5, 15, 59)));
check(C.dayKeyAt(Date.UTC(2026, 10, 5, 16, 0)) === "2026-11-06",
  "UTC 16:00 到北京次日零点", C.dayKeyAt(Date.UTC(2026, 10, 5, 16, 0)));
check(C.minutesAt(Date.UTC(2026, 10, 5, 16, 30)) === 30,
  "跨日后 00:30 换回 30 分钟", String(C.minutesAt(Date.UTC(2026, 10, 5, 16, 30))));

/* 设备时区改了也不影响：Clock 不吃 getHours()，只吃时间戳 */
check(C.partsAt(Date.UTC(2026, 10, 5, 7, 5)).hour === 15,
  "UTC 07:05 是北京 15:05", String(C.partsAt(Date.UTC(2026, 10, 5, 7, 5)).hour));

/* 校时：合理的偏差采纳，离谱的拒绝 */
const t0 = Date.now();
check(C.sync(t0 + 3600 * 1000), "快一小时的设备能被校正");
check(Math.abs(C.skewMs() - 3600 * 1000) < 5000, "校时偏差写进 Clock", String(C.skewMs()));
const keep = C.skewMs();
check(!C.sync(t0 + 20 * 3600 * 1000), "超过 12 小时的校时当坏数据拒掉");
check(C.skewMs() === keep, "拒绝的校时不能改现有偏差", String(C.skewMs()));
check(!C.sync(0) && !C.sync("not a number"), "空值和非数字都拒绝");

/* 演练/测试注入仍然优先 */
global.__rhythmTime = 600;
global.__rhythmDate = "2026-11-09";
check(C.minutes() === 600 && C.dayKey() === "2026-11-09", "注入的时间优先");
delete global.__rhythmTime;
delete global.__rhythmDate;

console.log("\n" + pass + "/" + (pass + fail) + " 通过");
process.exit(fail ? 1 : 0);
