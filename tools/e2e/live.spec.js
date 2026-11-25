/* 配置换端一致：这是 2026-11-25 真机反馈③的验收。
 *
 * 老师在大屏上把班级配好，用 Edge / 手机再打开同一个地址，看到的必须是同一份。
 * 起因是配置只存 localStorage，而它按「协议 + 主机 + 端口」隔离：大屏是 WebView2，
 * 浏览器是另一套存储，于是「向导看着全对，大屏一直不变」。
 * 现在服务端存一份，客户端靠 rev 对齐——这一条就用两个真实上下文钉住它。
 *
 * 不用 openScreen(page, AT) 的假时钟：配置推上去靠页里的 setTimeout，
 * 时钟钉死以后定时器不走，会误判成「没同步」。
 */

const { test, expect } = require("@playwright/test");
const { clearHub, openScreen } = require("./helpers");

test.beforeEach(async ({ request }) => {
  await clearHub(request);
});

test("大屏上配好的班，另一个浏览器打开就是同一份", async ({ page, browser }) => {
  await openScreen(page);

  /* 走的是向导保存时那条路（patchConfig），不是直接写 localStorage */
  await page.evaluate(() => {
    window.Store.patchConfig({
      meta: { school: "常州市局前街小学", klass: "六（2）班", headTeacher: "李老师" },
      students: [
        { name: "周予宁", active: true },
        { name: "陈知远", active: true },
      ],
    });
  });
  // 推上去是防抖 400ms 之后的事，等它真的落库
  await expect
    .poll(() => page.evaluate(() => window.Store.liveRev()), { timeout: 10_000 })
    .toBeGreaterThan(0);
  await expect(page.locator("#cls")).toHaveText("六（2）班");

  /* 另一个浏览器：全新上下文 = 另一份 localStorage，和老师在教室里
     用 Edge 打开是同一回事 */
  const other = await browser.newContext();
  const far = await other.newPage();
  const errors = await openScreen(far);

  await expect(far.locator("#cls")).toHaveText("六（2）班");
  const got = await far.evaluate(() => ({
    head: (window.Store.config().meta || {}).headTeacher,
    students: (window.Store.config().students || []).map((s) => s.name),
  }));
  expect(got.head, "班主任也要跟着过来").toBe("李老师");
  expect(got.students, "名单要跟着过来").toEqual(["周予宁", "陈知远"]);
  expect(errors, "另一个浏览器打开时不该有脚本报错").toEqual([]);

  await other.close();
});

test("另一端改了，这一端不刷新也会跟上", async ({ page, browser }) => {
  await openScreen(page);
  await page.evaluate(() => {
    window.Store.patchConfig({ meta: { klass: "五（1）班" } });
  });
  await expect
    .poll(() => page.evaluate(() => window.Store.liveRev()), { timeout: 10_000 })
    .toBeGreaterThan(0);
  await expect(page.locator("#cls")).toHaveText("五（1）班");

  /* 另一台设备改班名 */
  const other = await browser.newContext();
  const far = await other.newPage();
  await openScreen(far);
  await far.evaluate(() => {
    window.Store.patchConfig({ meta: { klass: "六（3）班" } });
  });
  await expect
    .poll(() => far.evaluate(() => window.Store.liveRev()), { timeout: 10_000 })
    .toBeGreaterThan(1);

  /* 大屏 24 小时开着，没人会去刷新它——靠 5 秒轮询自己跟上 */
  await expect(page.locator("#cls")).toHaveText("六（3）班", { timeout: 15_000 });

  await other.close();
});
