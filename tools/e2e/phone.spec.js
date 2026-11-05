/* 手机端：在同一台服务器上跑，但视口、UA、内核都由项目决定。
   iPhone / iPhone 小屏 / 安卓 / 鸿蒙 各跑一遍，任何一档失败就是这个机型不能用。 */

const { test, expect } = require("@playwright/test");
const { clearHub } = require("./helpers");

test.beforeEach(async ({ request }) => {
  await clearHub(request);
});

test("打开就能写，班名对得上", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#text")).toBeVisible();
  await expect(page.locator("#cls")).toBeVisible();
  await expect(page.locator("#cls")).not.toBeEmpty();
  await expect(page.locator("#text")).toHaveAttribute("placeholder", /写一句话/);
});

test("按得准：按钮不小于 44px，输入框不小于 16px", async ({ page }) => {
  await page.goto("/");

  const box = await page.locator("#send").boundingBox();
  expect(box, "#send 应该看得见").not.toBeNull();
  expect(box.height, `#send 高度 ${box.height}px，手指按不准`).toBeGreaterThanOrEqual(44);

  const font = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector("#text")).fontSize)
  );
  // iOS Safari 在字号 <16px 的输入框上会自动放大页面，一放大整页就错位
  expect(font, `输入框字号 ${font}px，iOS 会自动缩放`).toBeGreaterThanOrEqual(16);
});

test("不横向溢出", async ({ page }) => {
  await page.goto("/");
  const box = await page.evaluate(() => {
    const de = document.documentElement;
    return { x: de.scrollWidth - de.clientWidth, w: window.innerWidth, h: window.innerHeight };
  });
  expect(box.x, `横向溢出 ${box.x}px（视口 ${box.w}）`).toBeLessThanOrEqual(1);
});

test("空着点发送只给提示，不会发出去", async ({ page, request }) => {
  await page.goto("/");
  await page.locator("#send").click();
  await expect(page.locator("#toast")).toHaveText(/还没写内容/);

  const list = await (await request.get("/api/messages?n=50")).json();
  expect(list.messages.filter((m) => !m.retractedAt)).toHaveLength(0);
});

test("发一条能上屏，撤回能撤下来", async ({ page, request }) => {
  await page.goto("/");

  const text = "手机测试：请把书翻到第 12 页";
  await page.locator("#text").fill(text);
  await page.locator("#send").click();
  await expect(page.locator("#toast")).toHaveText(/已送到教室/);

  const list = await (await request.get("/api/messages?n=50")).json();
  const hit = list.messages.find((m) => m.text === text);
  expect(hit, "服务端应该收到这条").toBeTruthy();
  expect(hit.forWhom, "默认发给全班").toBe("class");

  // 「屏上现在是什么」那一栏要先亮起来，撤回按钮才存在——
  // 没有消息可撤时它是隐藏的，这是有意的，不是 bug
  await expect(page.locator("#live")).toBeVisible();
  const btn = await page.locator("#retract").boundingBox();
  expect(btn.height, `撤回按钮 ${btn.height}px，手指按不准`).toBeGreaterThanOrEqual(36);

  await page.locator("#retract").click();
  await expect(page.locator("#toast")).toHaveText(/已从教室撤下/);
  await expect(page.locator("#live")).toBeHidden();
});

test("历史里能看到刚才那条", async ({ page, request }) => {
  await page.goto("/");
  const text = "历史测试：午休后交作业";
  await page.locator("#text").fill(text);
  await page.locator("#send").click();
  await expect(page.locator("#toast")).toHaveText(/已送到教室/);

  await expect(page.locator("#list")).toContainText(text);
  const count = await request.get("/api/messages?n=8");
  expect(count.ok()).toBeTruthy();
});
