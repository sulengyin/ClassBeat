/* 大屏：能不能开起来、会不会溢出、老师改得动、手机发的消息上不上屏。 */

const { test, expect } = require("@playwright/test");
const { clearHub, openScreen, openTools, overflow, hubNow } = require("./helpers");

// 固定到 11 月 5 日（周四）07:45：刚过到校，第一节还没开始。
// 数据包是从 2026-11-05 开始编的，钉住日期就不会因为「今天」变了而失效。
const ARRIVE = "2026-11-05T07:45:00+08:00";

test.beforeEach(async ({ request }) => {
  await clearHub(request);
});

test("打开就有内容，且没有脚本错误", async ({ page }) => {
  const errors = await openScreen(page, ARRIVE);

  await expect(page.locator("#heroMain")).not.toBeEmpty();
  await expect(page.locator("#bandText")).not.toBeEmpty();
  await expect(page.locator("#clock")).toHaveText(/^\d{1,2}:\d{2}$/);
  expect(errors, "控制台不应有报错").toEqual([]);
});

test("整屏不出滚动条（一体机没有鼠标，溢出即丢失）", async ({ page }) => {
  await openScreen(page, ARRIVE);
  const box = await overflow(page);
  expect(box.x, `横向溢出 ${box.x}px（视口 ${box.w}）`).toBeLessThanOrEqual(1);
  expect(box.y, `纵向溢出 ${box.y}px（视口 ${box.h}）`).toBeLessThanOrEqual(1);
});

test("主标题用 vmin 撑满，没被小屏压成小字", async ({ page }) => {
  await openScreen(page, ARRIVE);
  const data = await page.evaluate(() => {
    const el = document.querySelector("#heroMain");
    return {
      size: parseFloat(getComputedStyle(el).fontSize),
      side: Math.min(window.innerWidth, window.innerHeight),
      text: el.textContent.trim(),
    };
  });
  // 远看清：主标题至少占短边的 12%
  expect(data.size, `字号 ${data.size}px / 短边 ${data.side}px`).toBeGreaterThan(data.side * 0.12);
});

test("深色模式是纯黑底、白字", async ({ page }) => {
  await openScreen(page, ARRIVE);
  await openTools(page);

  await page.locator("#btn-theme").click();
  await expect(page.locator("body")).toHaveAttribute("data-theme", "dark");

  const readColors = () =>
    page.evaluate(() => {
      const bg = getComputedStyle(document.body).backgroundColor;
      const fg = getComputedStyle(document.querySelector("#heroMain")).color;
      return { bg, fg };
    });

  // 底色是带过渡的（天光一天里慢慢变），点下去的一瞬间读到的还是上一帧的颜色，
  // 用轮询等它走完，别把过渡当成没生效
  await expect
    .poll(async () => (await readColors()).bg, { timeout: 5_000 })
    .toBe("rgb(0, 0, 0)");

  const colors = await readColors();
  expect(colors.fg).toBe("rgb(255, 255, 255)");

  await page.locator("#btn-theme").click();
  await expect(page.locator("body")).not.toHaveAttribute("data-theme", "dark");
});

test("验证码挡住乱输，答对才进设置", async ({ page, request }) => {
  await openScreen(page, ARRIVE);
  const ping = await (await request.get("/api/ping")).json();

  await openTools(page);
  await page.locator("#btn-edit").click();
  await expect(page.locator(".gate")).toBeVisible();

  const q = await page.locator("#gateQ").innerText();
  const m = q.match(/(\d+)\s*[×x*]\s*(\d+)/);
  expect(m, `验证码应该是一道算式，实际是「${q}」`).not.toBeNull();
  const answer = Number(m[1]) * Number(m[2]);

  // 先故意答错：面板不能开
  const wrong = String(answer + 1);
  for (const ch of wrong) await page.locator(".gk", { hasText: new RegExp(`^${ch}$`) }).click();
  await page.locator(".gk.primary").click();
  await expect(page.locator(".ep")).toBeHidden();

  // 再答对
  for (const ch of String(answer)) {
    await page.locator(".gk", { hasText: new RegExp(`^${ch}$`) }).click();
  }
  await page.locator(".gk.primary").click();
  await expect(page.locator("#epTitle")).toBeVisible();
  await expect(page.locator("#epTitle")).toContainText(ping.class);
});

test("7:29 还没到早读，屏上写「到校」", async ({ page }) => {
  await openScreen(page, "2026-11-05T07:29:00+08:00");
  await expect(page.locator("#bandText")).toHaveText("到校");
  await expect(page.locator(".reminder-line")).toHaveCount(0);
});

test("7:30 早读开始，提醒事项贴纸上屏", async ({ page }) => {
  await openScreen(page, "2026-11-05T07:30:00+08:00");
  await expect(page.locator("#bandText")).toHaveText("早读");
  await expect(page.locator(".reminder-line")).toContainText("戴好红领巾");
});

test("早读 8:10 结束，屏上立刻换成第一节课的准备清单", async ({ page }) => {
  // 早读在作息表里是 07:30–08:10 的一段，8:10 的下一段是准备课间
  await openScreen(page, "2026-11-05T08:10:00+08:00");
  await expect(page.locator("#bandText")).toHaveText("课间");
  // 「下一节 语文」走的是主视觉下面那行（#after），不是 #heroSub：
  // #heroSub 只在倒计时接管时写「后上课」。
  await expect(page.locator("#after")).toContainText("下一节");
  // 「准备好」并到主视觉下面那一行，和「课间」同字号，不再沉到底部色块里
  await expect(page.locator("#heroTask")).toContainText("准备好");
  await expect(page.locator("#heroTask")).toContainText("语文书");
});

test("放学前值日条有内容", async ({ page }) => {
  await openScreen(page, "2026-11-05T17:12:00+08:00");
  await expect(page.locator("#duty .duty").first()).toBeVisible();
  const labels = await page.locator("#duty .duty").allInnerTexts();
  expect(labels.length, "值日条至少一条").toBeGreaterThan(0);
  expect(labels.join(" ")).not.toMatch(/undefined|NaN/);
});

test("手机发的那条会出现在屏上，撤回后消失", async ({ page, request }) => {
  // 把屏上的时间调到服务端此刻，否则「还没过期」这条判断会把消息挡掉
  const now = await hubNow(request);
  await openScreen(page, `2026-11-05T${now}:00+08:00`);

  const text = "测试：请把窗关上";
  const res = await request.post("/api/messages", {
    data: { text, level: "normal", minutes: 10 },
  });
  expect(res.ok(), "消息应该发得出去").toBeTruthy();

  await expect(page.locator(".notice-text")).toContainText(text);

  /* 新消息要弹卡片，而且不能顶到屏幕边：宽高都按 vmin 算，
     这里用实际外接框卡一遍，改 CSS 改过头会立刻红。 */
  await expect(page.locator("#msgModal")).toHaveClass(/open/);
  await expect(page.locator("#msgBody")).toContainText(text);
  const card = await page.locator("#msgCard").boundingBox();
  const vp = page.viewportSize();
  expect(card.x, "左边留白").toBeGreaterThan(8);
  expect(card.y, "上边留白").toBeGreaterThan(8);
  expect(card.x + card.width, "右边留白").toBeLessThan(vp.width - 8);
  expect(card.y + card.height, "下边留白").toBeLessThan(vp.height - 8);
  const bodyFont = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.getElementById("msgBody")).fontSize)
  );
  expect(bodyFont, `弹窗正文 ${bodyFont}px，最后一排看不清`).toBeGreaterThanOrEqual(28);

  await request.post("/api/retract");
  await expect(page.locator(".notice-text")).toHaveCount(0);
  await expect(page.locator("#msgModal")).not.toHaveClass(/open/);
});

test("「手机」面板出二维码，地址就是手机要打开的那个", async ({ page }) => {
  // 教室电脑的 LAN 地址在 CI 里不可预测，钉一个固定的 ping 响应
  await page.route("**/api/ping", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true, class: "测试班", port: 8765, lan: "http://192.168.1.5:8765",
    }),
  }));

  await openScreen(page);
  await openTools(page);
  await page.locator("#btn-phone").click();

  await expect(page.locator("#qr-panel")).toHaveClass(/open/);
  await expect(page.locator("#qr-url")).toHaveText("http://192.168.1.5:8765/");
  await expect(page.locator("#qr-empty")).toBeHidden();
  await expect(page.locator("#qr-copy-row")).toBeVisible();

  // 复制按钮要么成功要么明确失败，都必须给一句反馈，不能点了没反应
  await page.locator("#qr-copy").click();
  await expect(page.locator("#qr-copied")).toBeVisible();

  // 画布上真的落了黑块，不是一张空白
  const dark = await page.evaluate(() => {
    const c = document.getElementById("qr-canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n += 1;
    return n;
  });
  expect(dark, "二维码应该有黑块").toBeGreaterThan(1000);
});

test("地址变了：面板写出上次的地址，提醒重新复制", async ({ page }) => {
  await page.route("**/api/ping", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true, class: "测试班", port: 8765,
      lan: "http://192.168.1.9:8765",
      addrChanged: true, lastLan: "http://192.168.1.5:8765",
    }),
  }));

  await openScreen(page);
  await openTools(page);
  await page.locator("#btn-phone").click();

  await expect(page.locator("#qr-change")).toBeVisible();
  await expect(page.locator("#qr-change")).toContainText("192.168.1.5");
  await expect(page.locator("#qr-url")).toHaveText("http://192.168.1.9:8765/");
});

test("紧急通知走大字区，而不是角落的小提示条", async ({ page, request }) => {
  const now = await hubNow(request);
  await openScreen(page, `2026-11-05T${now}:00+08:00`);

  await request.post("/api/messages", {
    data: { text: "现在立刻到走廊排队", level: "urgent", minutes: 10 },
  });

  await expect(page.locator("#bandText")).toHaveText("紧急通知");
  await expect(page.locator("#heroMain")).toContainText("现在立刻到走廊排队");
});
