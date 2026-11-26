/* 值日表三处修复的真机浏览器验证（2026-11-26）：
   ① 编辑面板有「新增岗位」按钮，能加岗位、改名；
   ② 岗位卡片描边已加粗。 */
const { test, expect } = require("@playwright/test");
const { openScreen, openTools, clearHub } = require("./helpers");

const ARRIVE = "2026-11-26T09:30:00+08:00";

test.beforeEach(async ({ request }) => {
  await clearHub(request);
});

async function unlockEdit(page, klass) {
  await page.locator("#btn-edit").click();
  await expect(page.locator(".gate")).toBeVisible();
  const q = await page.locator("#gateQ").innerText();
  const m = q.match(/([0-9]+\.[0-9]+)\s*÷\s*([0-9]+)/);
  expect(m, `验证码应是小数除法，实际「${q}」`).not.toBeNull();
  const answer = (Number(m[1]) / Number(m[2])).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  for (const ch of answer) {
    await page.locator(".gk", { hasText: new RegExp(`^${ch === "." ? "\\." : ch}$`) }).click();
  }
  await page.locator(".gk.primary").click();
  await expect(page.locator("#epTitle")).toContainText(klass);
}

test("编辑面板有新增岗位按钮，点了能加岗位并改名", async ({ page, request }) => {
  await openScreen(page, ARRIVE);
  const ping = await (await request.get("/api/ping")).json();
  await openTools(page);
  await unlockEdit(page, ping.class);
  await page.locator(".ep-tab", { hasText: "值日" }).click();

  const addBtn = page.locator(".ep-addrole");
  await expect(addBtn).toBeVisible();

  // 用 Runtime.config() 读合并后的配置（Store.config() 可能还没落 roles）
  const before = await page.evaluate(() => (window.Runtime.config().roles.roles || []).length);
  await addBtn.click();
  const after = await page.evaluate(() => (window.Runtime.config().roles.roles || []).length);
  expect(after).toBe(before + 1);

  const nameInput = page.locator(".ep-role-name-input");
  await expect(nameInput).toBeVisible();
  await nameInput.fill("图书管理员");
  await page.locator(".ep-primary").click();
  const names = await page.evaluate(() => window.Runtime.config().roles.roles.map(r => r.name));
  expect(names).toContain("图书管理员");
});

test("岗位卡片边框已加粗（0.44vmin）", async ({ page }) => {
  await openScreen(page, ARRIVE);
  const bw = await page.evaluate(() => {
    const d = document.createElement("div");
    d.className = "duty";
    document.body.appendChild(d);
    const w = parseFloat(getComputedStyle(d).borderTopWidth);
    d.remove();
    return w;
  });
  // 1920x1080 一体机下 0.44vmin ≈ 4.75px，明显比旧值 0.26vmin(≈2.8px) 粗
  expect(bw).toBeGreaterThan(3.5);
});
