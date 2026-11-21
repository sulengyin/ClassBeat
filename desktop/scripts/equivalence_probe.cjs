/**
 * 功能等价性探针：对同一份页面的不同打包形态，穷举"可交互要素"并逐个真点一遍。
 *
 * 用法（由 equivalence_run.py 调用，也可单独跑）：
 *   node desktop/scripts/equivalence_probe.cjs --base http://127.0.0.1:8785 --label a --out <dir>
 *
 * 采集三样东西：
 *   1) 交互要素指纹：标签/类型/文本/id/class/可见性/尺寸 —— 两侧集合必须能一一对上；
 *   2) 逐个点击的后果：body class、可见元素数、可见文本长度、是否弹确认框、
 *      是否跳转、控制台错误、期间打出去的接口 —— 两侧必须一致；
 *   3) 接口契约：状态码 + 顶层键集合（动态字段只比"有没有"，不比值）。
 *
 * 每个点击都独立 reload 复位，避免前一次点击污染后一次 —— 顺序不影响结论。
 */

const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const SEL = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  "[onclick]",
  "[data-action]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** 元素指纹 + 稳定 key（reload 后能重新定位到同一个元素） */
const COLLECT = `(() => {
  const SEL = ${JSON.stringify(SEL)};
  const cls = (e) => (typeof e.className === "string" ? e.className : (e.getAttribute("class") || "")).replace(/\\s+/g, " ").trim().slice(0, 60);
  const txt = (e) => (e.innerText || e.value || e.getAttribute("aria-label") || e.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 40);
  const key = (e) => [e.tagName.toLowerCase(), txt(e), e.id || "", cls(e)].join("|");
  return [...document.querySelectorAll(SEL)].map((e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    const vis = !!(r.width && r.height) && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
    return {
      key: key(e),
      tag: e.tagName.toLowerCase(),
      type: e.getAttribute("type") || "",
      text: txt(e),
      id: e.id || "",
      cls: cls(e),
      vis,
      dis: !!e.disabled,
      box: [Math.round(r.width), Math.round(r.height)],
    };
  });
})()`;

/** 页面整体状态快照：点击前后各采一次，比"有没有变化、变成什么样" */
const STATE = `(() => {
  const vis = [...document.querySelectorAll("body *")].filter((e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  });
  const text = document.body.innerText.replace(/\\s+/g, " ").trim();
  return {
    bodyClass: document.body.className,
    visCount: vis.length,
    textLen: text.length,
    text: text.slice(0, 3000),
    textHashSample: text.slice(0, 120),
    dialogs: document.querySelectorAll('[role="dialog"], .modal, .overlay, .sheet, .pop').length,
    url: location.pathname + location.search,
    title: document.title,
  };
})()`;

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function probePage(browser, base, pageDef, outDir) {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const apiCalls = [];
  let lastDialog = null;

  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  page.on("dialog", async (d) => {
    lastDialog = { type: d.type(), message: d.message().slice(0, 120) };
    await d.dismiss().catch(() => {}); // 一律"取消"，不改变状态
  });
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) apiCalls.push(`${r.request().method()} ${u.pathname} ${r.status()}`);
  });

  const url = base + pageDef.url;

  /** 进页面（可选：先进到某个状态，如"配置班级"编辑态），每次都从同一状态起步 */
  async function enter() {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(pageDef.enterBy ? 900 : 1200);
    if (pageDef.enterBy) {
      const hit = await page.evaluate((t) => {
        const norm = (s) => (s || "").replace(/\s+/g, "");
        const btn = [...document.querySelectorAll("button, a, [role=button]")]
          .find((e) => norm(e.innerText).includes(norm(t)));
        if (!btn) return false;
        btn.click();
        return true;
      }, pageDef.enterBy);
      await page.waitForTimeout(900);
      if (!hit) return false;
    }
    return true;
  }

  const entered = await enter();
  const elements = await page.evaluate(COLLECT);
  const state0 = await page.evaluate(STATE);
  const fullText = await page.evaluate(() => document.body.innerText.replace(/\r/g, ""));
  const shot = path.join(outDir, `${pageDef.name}.png`);
  await page.screenshot({ path: shot, fullPage: false });

  // ---- 逐个点击（只点可见的；每个点击前回到同一初始状态）----
  const clickable = elements.filter((e) => e.vis && !e.dis).slice(0, pageDef.maxClicks || 60);
  const clicks = [];
  for (const el of clickable) {
    consoleErrors.length = 0;
    pageErrors.length = 0;
    apiCalls.length = 0;
    lastDialog = null;

    if (!(await enter())) break;

    const before = await page.evaluate(STATE);
    const hit = await page.evaluate(({ key, sel }) => {
      const cls = (e) => (typeof e.className === "string" ? e.className : (e.getAttribute("class") || "")).replace(/\s+/g, " ").trim().slice(0, 60);
      const txt = (e) => (e.innerText || e.value || e.getAttribute("aria-label") || e.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 40);
      const k = (e) => [e.tagName.toLowerCase(), txt(e), e.id || "", cls(e)].join("|");
      const target = [...document.querySelectorAll(sel)].find((e) => k(e) === key);
      if (!target) return { found: false };
      target.scrollIntoView({ block: "center" });
      try { target.click(); } catch (err) { return { found: true, threw: String(err).slice(0, 80) }; }
      return { found: true };
    }, { key: el.key, sel: SEL });

    await page.waitForTimeout(600);
    const after = await page.evaluate(STATE);

    clicks.push({
      key: el.key,
      found: hit.found,
      threw: hit.threw || null,
      dialog: lastDialog,
      bodyClassChanged: before.bodyClass !== after.bodyClass,
      bodyClassAfter: after.bodyClass.slice(0, 80),
      visCountDelta: after.visCount - before.visCount,
      textLenDelta: after.textLen - before.textLen,
      afterText: after.text,
      dialogsDelta: after.dialogs - before.dialogs,
      urlChanged: before.url !== after.url,
      consoleErrors: [...new Set(consoleErrors)],
      pageErrors: [...new Set(pageErrors)],
      apiCalls: [...new Set(apiCalls)],
    });
  }

  await ctx.close();
  return {
    page: pageDef.name,
    url: pageDef.url,
    entered,
    enterBy: pageDef.enterBy || null,
    elementCount: elements.length,
    elements,
    initial: state0,
    fullText,
    screenshot: path.basename(shot),
    clicks,
  };
}

async function probeApi(base) {
  const endpoints = [
    ["GET", "/api/ping"],
    ["GET", "/api/time"],
    ["GET", "/api/messages"],
    ["GET", "/api/config/remote"],
    ["GET", "/api/config/remote/state"],
    ["GET", "/api/update"],
    ["GET", "/api/update/status"],
    ["GET", "/api/config/backup"],
  ];
  const out = {};
  for (const [method, p] of endpoints) {
    try {
      const r = await fetch(base + p, { method, signal: AbortSignal.timeout(8000) });
      const raw = await r.text();
      let keys = null;
      try {
        const j = JSON.parse(raw);
        keys = j && typeof j === "object" ? Object.keys(j).sort() : null;
      } catch {
        keys = null;
      }
      out[p] = { status: r.status, keys, len: raw.length };
    } catch (e) {
      out[p] = { status: "ERR", error: String(e).slice(0, 80) };
    }
  }
  return out;
}

(async () => {
  const args = process.argv.slice(2);
  const get = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : d;
  };
  const base = get("--base");
  const label = get("--label", "x");
  const outDir = get("--out", ".");
  if (!base) {
    console.error("缺少 --base");
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const limit = process.env.CB_EQ_MAX_CLICKS ? parseInt(process.env.CB_EQ_MAX_CLICKS, 10) : 0;
  const pages = [
    { name: "screen", url: "/app/index.html", maxClicks: limit || 25 },
    { name: "screen-edit", url: "/app/index.html", maxClicks: limit || 40, enterBy: "配置班级" },
    { name: "phone", url: "/phone", maxClicks: limit || 15 },
  ];
  const result = { label, base, when: nowStamp(), pages: [], api: null };

  for (const p of pages) {
    const ctxProbe = await probePage(browser, base, p, outDir);
    result.pages.push(ctxProbe);
  }
  // 接口放在页面之后采：大屏打开时才会 POST /api/config/backup 生成快照，
  // 而 /api/config/remote/state 依赖快照存在与否。先采接口会把三侧比成
  // "200 vs 404"（旧包自带历史快照、新包还没有），那是采样顺序造成的假差异。
  result.api = await probeApi(base);
  await browser.close();

  const file = path.join(outDir, `${label}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 1), "utf8");
  const total = result.pages.reduce((n, p) => n + p.elements.length, 0);
  const clickable = result.pages.reduce((n, p) => n + p.clicks.length, 0);
  console.log(`${label}: 要素 ${total} 个，实际点击 ${clickable} 个 → ${file}`);
  process.exit(0);
})().catch((e) => {
  console.error("探针失败:", e);
  process.exit(1);
});
