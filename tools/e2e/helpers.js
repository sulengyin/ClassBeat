/* 三个 spec 共用的启动与清理。 */

const { expect } = require("@playwright/test");

const SCREEN_PATH = "/app/index.html?hub=127.0.0.1:8765";

/** 把服务端攒下的旧消息全部撤回，免得上一轮的通知串到这一轮。 */
async function clearHub(request) {
  for (let i = 0; i < 20; i += 1) {
    const res = await request.post("/api/retract");
    const body = await res.json();
    if (!body.cleared) return;
  }
}

/**
 * 打开大屏。
 * at 传 ISO 时间就把浏览器时钟钉住——教室屏显示哪一天的内容，必须由测试决定，
 * 不能取决于「今天恰好是几号」。
 */
async function openScreen(page, at) {
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/favicon|Failed to load resource/i.test(text)) return; // 静态资源 404 不算故障
    errors.push("console: " + text);
  });
  if (at) await page.clock.install({ time: new Date(at) });
  await page.goto(SCREEN_PATH);
  // 用 Playwright 自己的轮询，不用页内 waitForFunction：
  // 时钟被 fake 之后，页内的定时器/Raf 都不走了，页内轮询会一直等下去。
  await expect(page.locator("#clock")).not.toBeEmpty({ timeout: 20_000 });
  return errors;
}

/** 页面有没有被撑出滚动条。一体机没有鼠标，看不见的地方等于不存在。 */
async function overflow(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    return {
      x: de.scrollWidth - de.clientWidth,
      y: de.scrollHeight - de.clientHeight,
      w: window.innerWidth,
      h: window.innerHeight,
    };
  });
}

/** 服务端此刻的 HH:MM，用来把浏览器时钟调到「消息还没过期」的时刻。 */
async function hubNow(request) {
  const res = await request.get("/api/ping");
  const body = await res.json();
  return body.now;
}

module.exports = { SCREEN_PATH, clearHub, openScreen, overflow, hubNow };
