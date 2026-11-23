/* 版本与更新入口：大屏弹层 + 设置最后一页。
 *
 * 这一组只测页面行为，更新逻辑本身已经在 tools/test_updater.py 里用临时副本
 * 和本地假源跑过。这里用 page.route 扮演服务端，把五种状态摆出来：
 * 正常、有新版本、更新中自动刷新、失败可回滚、单文件版。
 *
 * 不用 openScreen(page, AT) 的假时钟：更新进度靠页面里的 setInterval 轮询，
 * 时钟被钉死以后轮询就不走了，会误判成「点了没反应」。
 */

const { test, expect } = require("@playwright/test");
const { openScreen, openTools } = require("./helpers");

const DOWNLOAD = "https://github.com/sulengyin/ClassBeat/releases/latest";

function status(over) {
  return Object.assign({
    ok: true,
    version: "0.2.1",
    build: "20261112",
    state: "idle",
    progress: 0,
    message: "还没有检查更新",
    error: "",
    busy: false,
    currentVersion: "0.2.1",
    latest: "",
    available: false,
    canApply: false,
    blockedReason: "",
    notes: "",
    publishedAt: "",
    selfUpdate: true,
    canRestart: true,
    downloadPage: DOWNLOAD,
    hasBackup: false,
    last: {},
  }, over);
}

async function mock(page, state) {
  await page.route("**/api/update", (route) =>
    route.fulfill({ json: { ok: true, available: false, latest: "" } }));
  await page.route("**/api/update/status", (route) => route.fulfill({ json: state.value }));
  for (const act of ["check", "apply", "rollback", "restart"]) {
    await page.route(`**/api/update/${act}`, (route) =>
      route.fulfill({ status: 202, json: { ok: true, state: "starting", message: "已开始" } }));
  }
}

async function openPanel(page) {
  await openTools(page);
  await page.locator("#btn-update").click();
  await expect(page.locator("#updatePanel")).toBeVisible();
}

test("正常态：显示当前版本和「检查更新」，不出现更新/回滚按钮", async ({ page }) => {
  const state = { value: status() };
  await mock(page, state);
  const errors = await openScreen(page);

  await openPanel(page);
  await expect(page.locator("#updateBody .up-ver")).toContainText("v0.2.1");
  await expect(page.locator("#updateBody .up-state")).toContainText("还没有检查更新");
  await expect(page.locator('#updateBody [data-act="check"]')).toBeVisible();
  await expect(page.locator('#updateBody [data-act="apply"]')).toBeHidden();
  await expect(page.locator('#updateBody [data-act="rollback"]')).toBeHidden();
  await expect(page.locator('#updateBody [data-act="download"]')).toBeHidden();

  expect(errors, "控制台不应有报错").toEqual([]);
});

test("有新版：显示新版本号和更新说明，可以点「立即更新」", async ({ page }) => {
  const state = {
    value: status({
      latest: "0.2.2",
      available: true,
      canApply: true,
      notes: "修好了课间提醒重复弹两次的问题。",
    }),
  };
  await mock(page, state);
  const errors = await openScreen(page);

  await openPanel(page);
  await expect(page.locator("#updateBody .up-state")).toContainText("v0.2.2");
  await expect(page.locator("#updateBody .up-notes")).toContainText("课间提醒");
  await expect(page.locator('#updateBody [data-act="apply"]')).toBeVisible();
  await expect(page.locator('#updateBody [data-act="download"]')).toBeHidden();

  expect(errors, "控制台不应有报错").toEqual([]);
});

test("更新中：进度自动刷新，完成后提示要重启服务", async ({ page }) => {
  const state = {
    value: status({
      state: "downloading",
      busy: true,
      progress: 40,
      message: "正在下载 v0.2.2…",
      latest: "0.2.2",
      available: true,
    }),
  };
  await mock(page, state);
  const errors = await openScreen(page);

  await openPanel(page);
  await expect(page.locator("#updateBody .up-state")).toContainText("正在下载");
  await expect(page.locator("#updateBody .up-bar")).toBeVisible();
  await expect(page.locator('#updateBody [data-act="check"]')).toBeHidden();
  await expect(page.locator('#updateBody [data-act="apply"]')).toBeHidden();

  /* 不做任何点击，只把服务端状态改成完成，等页面自己轮询到。
     第一次不给 canRestart：旧进程没有 restart 能力，按钮必须藏着。 */
  state.value = status({
    state: "done",
    progress: 100,
    message: "已更新到 v0.2.2。",
    latest: "0.2.2",
    available: false,
    hasBackup: true,
    canRestart: false,
  });
  await expect(page.locator("#updateBody [data-act=\"restart\"]")).toBeHidden({ timeout: 8000 });

  /* 服务报告自己认得 restart 路由（0.3.17+ 进程）：按钮亮起；
     点下后轮询 /api/version，服务一回来就整页重载加载新 UI。 */
  state.value.canRestart = true;
  let versionPolled = 0;
  await page.route("**/api/version", (route) => {
    versionPolled += 1;
    return route.fulfill({ json: { ok: true, version: "0.2.2", build: "", startedAt: "" } });
  });
  await expect(page.locator("#updateBody [data-act=\"restart\"]")).toBeVisible({ timeout: 8000 });
  await expect(page.locator("#updateBody [data-act=\"restart\"]")).toContainText("重启服务");
  await page.locator('#updateBody [data-act="restart"]').click();
  await expect(page.locator("#updateBody .up-state")).toContainText("服务重启中");
  await expect.poll(() => versionPolled, { timeout: 15000 }).toBeGreaterThan(0);
  /* 整页重载的可靠证据：mock 在导航后仍返回 done——同一页面里
     "服务重启中"唯一的退场方式就是重载后重新 mount 拉到 done 态，
     按钮也会重新亮起来。 */
  await expect(page.locator("#updateBody .up-state"))
    .toContainText("已更新到 v0.2.2。", { timeout: 15000 });
  /* 重载后面板是关着的（模态状态不跨刷新保留）；重新打开，
     done 态 + 服务支持重启 → 按钮应再次亮起。 */
  await openPanel(page);
  await expect(page.locator("#updateBody [data-act=\"restart\"]")).toBeVisible();

  expect(errors, "控制台不应有报错").toEqual([]);
});

test("失败可回滚：给一句原因，点回滚后自动刷新到完成", async ({ page }) => {
  const state = {
    value: status({
      state: "failed",
      progress: 100,
      message: "更新失败，已自动回到原来的文件",
      error: "新版本页面打不开，已经恢复成原来的版本。",
      latest: "0.2.2",
      available: true,
      hasBackup: true,
    }),
  };
  await mock(page, state);
  const errors = await openScreen(page);

  await openPanel(page);
  await expect(page.locator("#updateBody .up-error")).toContainText("页面打不开");
  const rollback = page.locator('#updateBody [data-act="rollback"]');
  await expect(rollback).toBeVisible();

  state.value = status({
    state: "done",
    progress: 100,
    message: "已回到 v0.2.1。",
    hasBackup: false,
  });
  await rollback.click();
  await expect(page.locator("#updateBody [data-act=\"restart\"]")).toBeVisible({ timeout: 8000 });
  await expect(page.locator("#updateBody .up-state")).toContainText("回到 v0.2.1");
  await expect(page.locator("#updateBody .up-error")).toBeHidden();

  expect(errors, "控制台不应有报错").toEqual([]);
});

test("单文件版：只给「去下载新版」，没有可点的更新按钮", async ({ page }) => {
  const state = {
    value: status({
      selfUpdate: false,
      blockedReason: "这是单文件版，不能自己更新；请到下载页获取新版。",
    }),
  };
  await mock(page, state);
  const errors = await openScreen(page);

  await openPanel(page);
  await expect(page.locator("#updateBody .up-state")).toContainText("单文件版");
  const download = page.locator('#updateBody [data-act="download"]');
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute("href", DOWNLOAD);
  await expect(page.locator('#updateBody [data-act="check"]')).toBeHidden();
  await expect(page.locator('#updateBody [data-act="apply"]')).toBeHidden();
  await expect(page.locator('#updateBody [data-act="rollback"]')).toBeHidden();

  expect(errors, "控制台不应有报错").toEqual([]);
});

test("设置最后一页也有同一个入口", async ({ page }) => {
  const state = { value: status() };
  await mock(page, state);
  const errors = await openScreen(page);

  await openTools(page);
  await page.locator("#btn-setup").click();
  await expect(page.locator("#setup")).toHaveClass(/open/);
  await page.locator(".setup-field input").nth(1).fill("更新入口测试班");
  // 班级 → 名单 → 作息 → 课表 → 岗位/文案（最后一页）：四步，不是三步
  for (let i = 0; i < 4; i += 1) {
    await page.locator(".setup-foot .setup-btn.primary").click();
  }

  const box = page.locator("#setupUpdate");
  await expect(box).toBeVisible();
  await expect(box.locator(".up-ver")).toContainText("v0.2.1");
  await expect(box.locator('[data-act="check"]')).toBeVisible();

  expect(errors, "控制台不应有报错").toEqual([]);
});
