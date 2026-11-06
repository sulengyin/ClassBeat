#!/usr/bin/env node
/* 引擎对拍：app/engine/schedule.js 的输出必须与 tools/golden/ 里的 Python 基准逐字段一致。
 *
 * 为什么不写「断言某天第 3 节是数学」这种用例：规则本身会变，写死的期望值
 * 每次改规则都要重写一遍。基准是把整份 Python 输出冻住，改规则时基准跟着变，
 * 但「前端和编译器判断不一致」这种事一定会被这条测试挡住。
 *
 * 用法：node tools/test_engine.js [--verbose]
 */

const fs = require("fs");
const path = require("path");
const Schedule = require("../app/engine/schedule.js");

const ROOT = path.join(__dirname, "..");
const GOLDEN = path.join(__dirname, "golden");
const SAMPLE = path.join(ROOT, "sample");

/* content 取 subjects 数组，与 data.js / 浏览器里保持同一形态 */
const FILES = ["timetable", "schedule", "roles", "noon"];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadConfig(patch) {
  const cfg = {};
  for (const name of FILES) cfg[name] = readJson(path.join(SAMPLE, `${name}.json`));
  cfg.content = readJson(path.join(SAMPLE, "content.json")).subjects;
  const calPath = path.join(SAMPLE, "calendar.json");
  cfg.calendar = fs.existsSync(calPath) ? readJson(calPath) : { days: {} };

  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      cfg[key] = Object.assign({}, cfg[key], value);
    } else {
      cfg[key] = value;
    }
  }
  return cfg;
}

/** 逐字段比较，返回第一处差异的描述；完全一致返回 null。 */
function diff(a, b, at) {
  at = at || "$";
  if (a === b) return null;

  if (a === null || b === null || typeof a !== typeof b) {
    return `${at}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return `${at}: 一边是数组一边不是（${JSON.stringify(a)} vs ${JSON.stringify(b)}）`;
    }
    if (a.length !== b.length) return `${at}: 长度 ${a.length}，期望 ${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const d = diff(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }

  if (typeof a === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    const extra = ka.filter((k) => !kb.includes(k));
    const missing = kb.filter((k) => !ka.includes(k));
    if (extra.length) return `${at}: 多出字段 ${extra.join(",")}`;
    if (missing.length) return `${at}: 缺少字段 ${missing.join(",")}`;
    for (const k of kb) {
      const d = diff(a[k], b[k], `${at}.${k}`);
      if (d) return d;
    }
    return null;
  }

  return `${at}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`;
}

function main() {
  const verbose = process.argv.includes("--verbose");
  const variants = readJson(path.join(GOLDEN, "variants.json")).variants;
  let checked = 0;
  const failures = [];

  for (const v of variants) {
    const goldenPath = path.join(GOLDEN, `${v.name}.json`);
    if (!fs.existsSync(goldenPath)) {
      failures.push(`${v.name}: 没有基准文件，先跑 python3 tools/golden/gen.py`);
      continue;
    }
    const golden = readJson(goldenPath);
    const cfg = loadConfig(v.patch);

    const dates = Object.keys(golden.days);
    for (const date of dates) {
      const want = golden.days[date];
      let got;
      try {
        got = Schedule.buildDay(cfg, date);
      } catch (e) {
        failures.push(`${v.name} ${date}: 抛异常 ${e.message}`);
        continue;
      }
      const d = diff(got, want);
      checked += 1;
      if (d) failures.push(`${v.name} ${date}: ${d}`);
    }
  }

  // 基准本身不能是空的：否则「全部一致」毫无意义
  const rot = readJson(path.join(GOLDEN, "rot.json"));
  const groups = new Set(
    Object.values(rot.days)
      .filter((d) => d.inSchool)
      .map((d) => d.group)
  );
  const guards = [];
  if (!groups.has("A") || !groups.has("B")) {
    guards.push(`rot 基准里没有 A/B 两组（实际 ${[...groups].join("/")}）`);
  }
  const holidays = Object.values(readJson(path.join(GOLDEN, "base.json")).days).filter(
    (d) => !d.inSchool
  );
  if (!holidays.length) guards.push("base 基准里一天放假都没有，校历分支没被覆盖");
  const makeup = Object.values(rot.days).filter((d) => (d.calendar || {}).makeup);
  if (!makeup.length) guards.push("基准里没有调休上课日，asWeekday 分支没被覆盖");

  for (const g of guards) failures.push(`基准自检：${g}`);

  if (failures.length) {
    console.log(`引擎对拍失败（${failures.length} 处，已比对 ${checked} 天）：`);
    for (const f of failures.slice(0, 12)) console.log("  ✗ " + f);
    process.exit(1);
  }

  const days = checked / variants.length;
  console.log(
    `引擎对拍通过：${variants.length} 套配置 × ${days} 天 = ${checked} 天，逐字段一致`
  );
  if (verbose) console.log(`  变体：${variants.map((v) => v.name).join(" / ")}`);
}

main();
