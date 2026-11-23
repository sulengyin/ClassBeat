/* 配置向导：别的老师不碰命令行，从「什么都没有」配出一块能用的屏。
 *
 * 这一条补的是 B5 的验收：真实浏览器里点完四步、应用、刷新，
 * 班名 / 作息 / 课表都还在。node 的 DOM 桩已经在 test_dom.js 里钉过一遍，
 * 这里只负责真浏览器里那份 localStorage 和脚本加载顺序。
 */

const { test, expect } = require("@playwright/test");
const { openScreen, openTools } = require("./helpers");

/* 不能取决于「今天恰好是几号」：钉在周四上午，当天一定有时间线。 */
const AT = "2026-11-05T08:30:00+08:00";

async function next(page) {
  await page.locator(".setup-foot .setup-btn.primary").click();
}

async function apply(page) {
  await page.locator(".setup-btn", { hasText: "应用到这台机器" }).click();
  await expect(page.locator(".setup-confirm")).toBeVisible();
  await page.locator(".setup-btn", { hasText: "确认保存" }).click();
  await expect(page.locator(".setup-page.on")).toContainText("已经生效");
  await page.locator(".setup-foot .setup-btn.primary", { hasText: "完成" }).click();
  await expect(page.locator("#setup")).not.toHaveClass(/open/);
}

function stored(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("rhythm.config.v1") || "{}"));
}

test("向导第一步就能导入旧设置，不用先填班名（0.3.x 跨代升级）", async ({ page }) => {
  /* 0.3.x 的数据在浏览器 localStorage 里，只能导出/导入。以前导入入口在第 4 步，
     第一步还强制先填班级名——从网页版升上来的老师得先编一个班名再绕回去。
     这个用例钉住：入口在第一步、点得到、导入后直接跳到最后一页。 */
  await page.route("**/app/data.js", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "window.RHYTHM_DATA={};" }));

  const errors = await openScreen(page, AT);
  await expect(page.locator("#setup")).toHaveClass(/open/);
  await expect(page.locator(".setup-step")).toHaveCount(4);

  const legacy = page.locator(".setup-legacy");
  await expect(legacy).toBeVisible();
  await expect(legacy).toContainText("导出设置");
  const btn = page.locator(".setup-legacy-btn");
  await expect(btn).toHaveText("导入旧设置 JSON");

  /* 用程序自己导出的格式造一份"旧设置"，保证走的是真格式而不是测试自造的字段。 */
  const payload = await page.evaluate(() => {
    const o = window.Store.exportAll();
    o.config = o.config || {};
    o.config.meta = Object.assign({}, o.config.meta, { klass: "导入来的班" });
    return o;
  });

  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), btn.click()]);
  await chooser.setFiles({
    name: "旧版设置.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(payload), "utf8"),
  });

  // 导入成功 → 直接跳到第 4 步，只剩点「完成」
  await expect(page.locator(".setup-step").nth(3)).toHaveClass(/on/);
  expect(await page.evaluate(() => window.Store.config().meta.klass)).toBe("导入来的班");
  expect(await page.evaluate(() => window.Store.config().meta.klass)).not.toBe("空包测试班");
  expect(errors, "控制台不应有报错").toEqual([]);
});

test("空配置打开就进向导，不碰命令行也能配出当天的屏", async ({ page }) => {
  /* 空包 = 还没跑 bundle.py。把 data.js 换成空对象，模拟一台新电脑第一次打开。 */
  await page.route("**/app/data.js", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "window.RHYTHM_DATA={};" }));

  const errors = await openScreen(page, AT);

  await expect(page.locator("#setup")).toHaveClass(/open/);
  await expect(page.locator("body")).toHaveAttribute("data-setup", "1");
  await expect(page.locator(".setup-step")).toHaveCount(4);

  await page.locator(".setup-field input").nth(1).fill("空包测试班");
  await next(page);

  // 空包没有作息可改，第二步应该先套上一套模板，而不是一张空表
  await expect(page.locator(".setup-tpl")).toHaveCount(3);
  expect(await page.locator(".setup-row").count()).toBeGreaterThan(20);
  await next(page);

  // 第三步 5×7：一条课都不填，屏上显示「—」，但不报错
  await expect(page.locator(".setup-grid-row:not(.head) input")).toHaveCount(35);
  await next(page);

  // 完成页当场给出时间线，不用等第二天
  await expect(page.locator(".setup-preview")).toBeVisible();
  expect(await page.locator(".tl-row").count()).toBeGreaterThan(10);

  await apply(page);

  // 应用后不刷新，屏上立刻换班名，并且算得出当天时间线
  await expect(page.locator("#cls")).toHaveText("空包测试班");
  const ready = await page.evaluate(() => ({
    ready: window.Runtime.ready(),
    klass: window.Runtime.config().meta.klass,
    blocks: window.Runtime.day(window.Clock.dayKey()).timeline.length,
  }));
  expect(ready.ready).toBe(true);
  expect(ready.klass).toBe("空包测试班");
  expect(ready.blocks, "应用后当天时间线应该算得出来").toBeGreaterThan(0);

  // 刷新：只靠 localStorage，不靠刚才那次运行时
  await page.reload();
  await expect(page.locator("#cls")).toHaveText("空包测试班");
  await expect(page.locator("#heroMain")).not.toBeEmpty();

  expect(errors, "控制台不应有报错").toEqual([]);
});

test("改班名和课表后刷新仍在，屏上抬头跟着换", async ({ page }) => {
  const errors = await openScreen(page, AT);

  // 走真实的入口：右下角「⋯」→「配置班级」
  await openTools(page);
  await page.locator("#btn-setup").click();
  await expect(page.locator("#setup")).toHaveClass(/open/);

  await page.locator(".setup-field input").nth(1).fill("测试二班");
  await next(page);

  // 作息第一段的开始时间改成 07:40，验证相邻段仍然衔接
  await page.locator(".setup-row input").first().evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, "07:40");
  await next(page);

  // 课表第一格（周一第 1 节）填上数学
  await page.locator(".setup-grid-row:not(.head) input").first().fill("数学");
  await next(page);

  // 还没应用，预览也要显示刚改的 07:40
  await expect(page.locator(".setup-timeline")).toContainText("07:40");

  await apply(page);

  await expect(page.locator("#cls")).toHaveText("测试二班");
  const landed = await stored(page);
  expect(landed.meta && landed.meta.klass).toBe("测试二班");
  expect(landed.timetable.blocks[0].start).toBe("07:40");
  expect(landed.schedule.entries.some((e) => e.weekday === 1 && e.periodNo === 1 && e.subject === "数学"))
    .toBe(true);

  // 刷新：班名、作息、课表都要还在，当天时间线也按新作息算
  await page.reload();
  await expect(page.locator("#cls")).toHaveText("测试二班");
  const after = await page.evaluate(() => ({
    klass: window.Runtime.config().meta.klass,
    start: window.Runtime.config().timetable.blocks[0].start,
    timelineStart: window.Runtime.day(window.Clock.dayKey()).timeline[0].start,
  }));
  expect(after.klass).toBe("测试二班");
  expect(after.start).toBe("07:40");
  expect(after.timelineStart).toBe("07:40");

  expect(errors, "控制台不应有报错").toEqual([]);
});
