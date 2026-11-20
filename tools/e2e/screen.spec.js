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
  // 远看清：主标题至少占短边的一成多。晨间大字进了贴纸卡（PR #20），
  // 单行字号封顶 CARD_W/字数（6 字标题 = 11.67vmin），设计下限是
  // READING_ONE=10vmin——阈值跟着放到 0.11，再小就是真的被压塌了。
  expect(data.size, `字号 ${data.size}px / 短边 ${data.side}px`).toBeGreaterThan(data.side * 0.11);
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
  // 小数 ÷ 整数。按两位小数四舍五入再抹尾零，别让浮点尾巴变成 0.37000000000000005
  const m = q.match(/([0-9]+\.[0-9]+)\s*÷\s*([0-9]+)/);
  expect(m, `验证码应该是一道小数除法，实际是「${q}」`).not.toBeNull();
  const answer = (Number(m[1]) / Number(m[2])).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  expect(answer, `验证码答案要能算出来，题目是「${q}」`).toMatch(/^[0-9]+(\.[0-9]{1,2})?$/);

  // 键盘逐字输入；小数点也得点得到
  const tap = async (text) => {
    for (const ch of text) {
      const re = new RegExp(`^${ch === "." ? "\\." : ch}$`);
      await page.locator(".gk", { hasText: re }).click();
    }
  };

  // 先故意答错：面板不能开
  await tap(String(Number(answer) + 1));
  await page.locator(".gk.primary").click();
  await expect(page.locator(".ep")).toBeHidden();

  // 再答对
  await tap(answer);
  await page.locator(".gk.primary").click();
  await expect(page.locator("#epTitle")).toBeVisible();
  await expect(page.locator("#epTitle")).toContainText(ping.class);
});

test("7:29 打铃前也归入晨间自主管理，提醒事项上屏", async ({ page }) => {
  await openScreen(page, "2026-11-05T07:29:00+08:00");
  await expect(page.locator("#bandText")).toHaveText("晨间自主管理");
  await expect(page.locator("#heroMain")).toHaveText("晨间自主管理");
  await expect(page.locator(".reminder-line")).toContainText("戴好红领巾");
});

test("7:30 晨间自主管理开始，提醒事项贴纸上屏", async ({ page }) => {
  await openScreen(page, "2026-11-05T07:30:00+08:00");
  await expect(page.locator("#bandText")).toHaveText("晨间自主管理");
  await expect(page.locator(".reminder-line")).toContainText("戴好红领巾");
});

test("晨间自主管理 8:10 结束，屏上立刻换成第一节课的准备清单", async ({ page }) => {
  // 晨间自主管理在作息表里是 07:30–08:10 的一段，8:10 的下一段是准备课间
  await openScreen(page, "2026-11-05T08:10:00+08:00");
  await expect(page.locator("#bandText")).toHaveText("课间");
  // 「下一节 语文」走的是主视觉下面那行（#after），不是 #heroSub：
  // #heroSub 只在倒计时接管时写「后上课」。
  await expect(page.locator("#after")).toContainText("下一节 语文");
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

test("手机送来的远程设置，屏上几十秒内生效（P2 B2）", async ({ page, request }) => {
  // 不传时间点：不装假时钟，页内的 15 秒轮询才能真的跑起来
  await openScreen(page);

  // 用屏上真实导出的整份设置当底稿，只改班名——这是老师会做的事
  const cfg = await page.evaluate(() => Store.exportAll());
  cfg.config.meta.klass = "远程测试班";
  const resp = await request.post("/api/config/remote", { data: cfg });
  expect(resp.ok(), "服务应该收下这份设置").toBeTruthy();

  // 大屏轮询取走 → Store.importAll 整份应用 → 渲染刷新，标题跟着换班名
  await expect(page).toHaveTitle(/远程测试班/, { timeout: 30_000 });

  // 应用完要 ack：服务端清掉待办，结果「成功」可查。
  // 标题在 importAll 里同步就换掉了，ack 是后一步异步发的，所以这里等它落地。
  await expect(async () => {
    const done = await (await request.get("/api/config/remote")).json();
    expect(done.pending, "应用完就清掉待办，不会反复应用").toBeFalsy();
    expect(done.result && done.result.ok, "ack 结果是成功").toBeTruthy();
  }).toPass({ timeout: 15_000 });
});

test("手机上改班名，屏上几十秒内生效（P2 B3）", async ({ page, request }) => {
  // 手机编辑器的底稿来自最近的配置备份，先落一份今天的
  await request.post("/api/config/snapshot", {
    data: {
      format: "rhythm-config/v1", schemaVersion: 1,
      config: {
        meta: { klass: "五（1）班" },
        // noonBand 是引擎算一天的必需字段，真实备份里一定有；
        // 测试数据少了它，补丁整份替换后大屏会算不出那天
        timetable: {
          noonBand: { lunchEnd: "12:10", bell: "12:10", noonEnd: "12:50" },
          blocks: [{ seq: 1, type: "class", periodNo: 1, start: "08:20", end: "09:00" }],
        },
        schedule: { entries: [{ weekday: 1, periodNo: 1, subject: "数学", teacher: "李老师" }] },
      },
      texts: {}, phrases: [],
    },
  });

  // 手机页：读取 → 编辑器出现并带上当前值 → 改班名 → 发送
  await page.goto("/");
  await page.locator("#cfgLoad").click();
  await expect(page.locator("#cfgEditor")).toBeVisible();
  // 时间框不许裁字：宽度要装得下 08:10（真机 2026-11-17 裁成 08:1）
  const phoneTimeOk = await page.evaluate(() =>
    [...document.querySelectorAll(".blk time input")].every((i) => {
      const fs = parseFloat(getComputedStyle(i).fontSize);
      return i.clientWidth >= fs * 5.2;  // clientWidth 不含边框，阈值别贴着 min-width
    })
  );
  expect(phoneTimeOk, "手机端时间框太窄会把 08:10 裁成 08:1").toBeTruthy();
  await expect(page.locator("#cfgKlass")).toHaveValue("五（1）班");
  await expect(page.locator("#cfgBlocks input[type=time]").first()).toHaveValue("08:20");
  await page.locator("#cfgKlass").fill("手机改的班");
  await page.locator("#cfgSave").click();
  await expect(page.locator("#toast")).toHaveText(/已送到教室大屏/);

  // 大屏取走补丁 → 与本地配置合并（名册不动）→ 应用 → 标题换班名
  await openScreen(page);
  await expect(page).toHaveTitle(/手机改的班/, { timeout: 30_000 });

  await expect(async () => {
    const done = await (await request.get("/api/config/remote")).json();
    expect(done.pending).toBeFalsy();
    expect(done.result && done.result.ok).toBeTruthy();
  }).toPass({ timeout: 15_000 });
});

test("手机上改提醒文字和话术，屏上生效（P2 B3）", async ({ page, request }) => {
  await request.post("/api/config/snapshot", {
    data: {
      format: "rhythm-config/v1", schemaVersion: 1,
      config: {
        meta: { klass: "五（1）班" },
        timetable: {
          noonBand: { lunchEnd: "12:10", bell: "12:10", noonEnd: "12:50" },
          blocks: [{ seq: 1, type: "class", periodNo: 1, start: "08:20", end: "09:00" }],
        },
        schedule: { entries: [{ weekday: 1, periodNo: 1, subject: "数学", teacher: "李老师" }] },
      },
      texts: { reminders: { default: "戴好红领巾" } },
      phrases: ["翻到第 12 页"],
    },
  });

  // 手机页：读取 → 改提醒文字与话术 → 发送
  await page.goto("/");
  await page.locator("#cfgLoad").click();
  await expect(page.locator("#cfgEditor")).toBeVisible();
  const remind = page.locator("#cfgTexts input");
  await expect(remind).toHaveValue("戴好红领巾");
  await remind.fill("戴好红领巾，带好水杯");
  const phrase = page.locator("#cfgPhrases input");
  await expect(phrase).toHaveValue("翻到第 12 页");
  await phrase.fill("翻到第 20 页");
  await page.locator("#cfgSave").click();
  await expect(page.locator("#toast")).toHaveText(/已送到教室大屏/);

  // 大屏取走补丁应用后，屏上的文字与话术都是新的
  await openScreen(page);
  await expect(async () => {
    const got = await page.evaluate(() => ({
      text: Store.texts().reminders.default,
      phrases: Store.allPhrases(),
    }));
    expect(got.text, "提醒文字要换").toBe("戴好红领巾，带好水杯");
    expect(got.phrases, "话术要换").toEqual(["翻到第 20 页"]);
  }).toPass({ timeout: 30_000 });
});

test("大屏编辑态的作息时间框不裁字（真机 2026-11-17）", async ({ page, request }) => {
  await openScreen(page, ARRIVE);
  const ping = await (await request.get("/api/ping")).json();

  await openTools(page);
  await page.locator("#btn-edit").click();
  await expect(page.locator(".gate")).toBeVisible();
  const q = await page.locator("#gateQ").innerText();
  const m = q.match(/([0-9]+\.[0-9]+)\s*÷\s*([0-9]+)/);
  const answer = (Number(m[1]) / Number(m[2])).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  const tap = async (text) => {
    for (const ch of text) {
      await page.locator(".gk", { hasText: new RegExp(`^${ch === "." ? "\\." : ch}$`) }).click();
    }
  };
  await tap(answer);
  await page.locator(".gk.primary").click();
  await expect(page.locator("#epTitle")).toContainText(ping.class);

  await page.locator(".ep-tab", { hasText: "作息" }).click();
  await expect(page.locator(".tt-row").first()).toBeVisible();
  // 每个时间框都要装得下 08:10：宽度至少 5.5 个字（值 5 字符 + 余量）
  const ok = await page.evaluate(() =>
    [...document.querySelectorAll(".tt-time")].every((i) => {
      const fs = parseFloat(getComputedStyle(i).fontSize);
      return i.clientWidth >= fs * 5.2;  // clientWidth 不含边框，阈值别贴着 min-width
    })
  );
  expect(ok, "大屏时间框太窄会把 08:10 裁成 08:1").toBeTruthy();
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

test("作息边界联动 + 时段改名后文字同步（真机 2026-11-19 ②③）", async ({ page, request }) => {
  await openScreen(page, ARRIVE);
  const ping = await (await request.get("/api/ping")).json();
  await openTools(page);
  await unlockEdit(page, ping.class);

  await page.locator(".ep-tab", { hasText: "作息" }).click();
  await expect(page.locator(".tt-row").first()).toBeVisible();

  // 作息保护（0.3.21）：正课/眼操/课间默认锁住；联动改边界前先解锁
  const guard = page.locator(".tt-unlock");
  await expect(guard).toContainText("已按作息表锁住");
  const classRow = page.locator(".tt-row", { has: page.locator(".tt-tag", { hasText: "正课" }) }).first();
  await expect(classRow.locator(".tt-time").first()).toHaveAttribute("readonly", "");
  await guard.click();
  await expect(guard).toContainText("已解锁");
  await expect(classRow.locator(".tt-time").first()).not.toHaveAttribute("readonly", "");

  // 找一个非锁定（类型/名称可改）又不是第一行的段来操作
  const rows = page.locator(".tt-row");
  const total = await rows.count();
  let target = -1;
  for (let i = 1; i < total; i++) {
    if ((await rows.nth(i).locator("select.tt-type").count()) > 0) { target = i; break; }
  }
  expect(target, "作息里要有一段可编辑的非锁定时段").toBeGreaterThan(0);

  // ① 边界联动：改这一段的开始，上一段的结束自动跟过来，不报「没接上」
  const row = rows.nth(target);
  const startVal = await row.locator(".tt-time").first().inputValue();
  const parts = startVal.split(":").map(Number);
  const nm = parts[0] * 60 + parts[1] + 7;
  const newStart =
    String(Math.floor(nm / 60)).padStart(2, "0") + ":" + String(nm % 60).padStart(2, "0");
  await row.locator(".tt-time").first().fill(newStart);
  // time 输入框的 change 在失焦时才触发（commit 挂在 change 上）
  await row.locator(".tt-time").first().press("Tab");
  await expect(rows.nth(target - 1).locator(".tt-time").nth(1)).toHaveValue(newStart);
  expect(await page.locator(".tt-row.bad").count(), "联动后不应有报错行").toBe(0);
  await expect(page.locator("#epFlash")).toContainText("已保存");

  // ② 给旧时段名写一条提示语，然后改名：提示语应跟到新名下（文字页同步）
  const oldName = (await rows.nth(target).locator(".tt-name").inputValue()).trim();
  await page.locator(".ep-tab", { hasText: "文字" }).click();
  // 「各时段的提示语」区块里、标签恰好等于时段名的那个输入框
  // （「课间 · 大字」等别的字段也含「课间」，不能拿 .first() 撞运气）
  const tipsSec = page.locator(".ep-sec", { hasText: "各时段的提示语" });
  const tipInput = tipsSec.locator(".ep-field").filter({
    has: page.locator(".ep-flabel", { hasText: new RegExp(`^${oldName}$`) }),
  }).locator("input.ep-input");
  await tipInput.fill("先热身，再活动");
  await tipInput.press("Tab");
  await expect(page.locator("#epFlash")).toContainText("已保存");

  const newName = oldName + "乙";
  await page.locator(".ep-tab", { hasText: "作息" }).click();
  const nameInput = page.locator(".tt-row").nth(target).locator(".tt-name");
  await nameInput.fill(newName);
  await nameInput.press("Tab");
  await expect(page.locator("#epFlash")).toContainText("已保存");

  await page.locator(".ep-tab", { hasText: "文字" }).click();
  const renamed = page.locator(".ep-field", { hasText: newName }).first();
  await expect(renamed).toBeVisible();
  await expect(renamed.locator("input.ep-input")).toHaveValue("先热身，再活动");
});
