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

test("第一步只说班级；旧设置从末页「换电脑时用」导入", async ({ page }) => {
  /* 以前第一步顶上挂着一块「以前用网页版（0.3.x）？导出成 JSON 再导进来」，
     把版本号和技术词摆在老师第一眼看到的地方，而它做的事末页本来就有。
     2026-11-24 删掉那块：这条用例钉住「第一步干净」和「导入能力没丢」。 */
  await page.route("**/app/data.js", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "window.RHYTHM_DATA={};" }));

  const errors = await openScreen(page, AT);
  await expect(page.locator("#setup")).toHaveClass(/open/);
  await expect(page.locator(".setup-step")).toHaveCount(5);

  const first = page.locator(".setup-page.on");
  await expect(first).toContainText("先告诉屏，这是哪个班");
  // 四个格子：学校 / 班级 / 班主任 / 开学日，不多不少
  await expect(first.locator(".setup-field")).toHaveCount(4);
  const firstText = await first.innerText();
  expect(firstText, "第一步不该再出现版本号").not.toMatch(/0\.3/);
  expect(firstText, "第一步不该再出现 JSON 这类技术词").not.toContain("JSON");
  await expect(page.locator(".setup-legacy")).toHaveCount(0);

  // 走到末页：导入入口在那儿，和「导出成文件」并排。
  // 第一步的班级名是必填的（不是所有人都能跳），先填上再往下走。
  await first.locator(".setup-field input").nth(1).fill("占位班");
  for (let i = 0; i < 4; i += 1) await next(page);
  await expect(page.locator(".setup-page.on")).toContainText("换电脑时用");

  /* 用程序自己导出的格式造一份设置，保证走的是真格式而不是测试自造的字段。 */
  const payload = await page.evaluate(() => {
    const o = window.Store.exportAll();
    o.config = o.config || {};
    o.config.meta = Object.assign({}, o.config.meta, { klass: "导入来的班" });
    return o;
  });

  const importBtn = page.locator(".setup-btn", { hasText: "从文件导入" });
  await expect(importBtn).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), importBtn.click()]);
  await chooser.setFiles({
    name: "设置.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(payload), "utf8"),
  });

  await expect(page.locator(".setup-page.on")).toContainText("已导入");
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
  await expect(page.locator(".setup-step")).toHaveCount(5);

  await page.locator(".setup-field input").nth(1).fill("空包测试班");
  await next(page);

  /* 空包没有名单。这一页必须仍然给得出录入框——以前名册为空时整块 return，
     老师被指到这儿却发现无处可填，问题就卡死在这里。 */
  await expect(page.locator(".setup-roster-new")).toBeVisible();
  await next(page);

  // 空包没有作息可改，这一页应该先套上一套模板，而不是一张空表
  await expect(page.locator(".setup-tpl")).toHaveCount(3);
  expect(await page.locator(".setup-row").count()).toBeGreaterThan(20);
  await next(page);

  // 课表 5×7：一条课都不填，屏上显示「—」，但不报错
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
  await next(page); // 班级 → 名单
  // 名单页包里有名单，不用动，直接过
  await next(page); // 名单 → 作息

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

test("岗位表核对时漏了人，打一个字或姓氏拼音首字母就能补进来", async ({ page }) => {
  /* 只给一个名单的最小包：前三步不依赖具体的作息与课表内容，
     这条只关心「核对人员」那一步的补人。 */
  const roster = ["赵子墨", "钱嘉禾", "孙星野", "李青禾", "周梓萱", "张望舒"]
    .map((n, i) => ({ id: "s" + (i + 1), name: n, active: true }));
  await page.route("**/app/data.js", (route) => route.fulfill({
    status: 200, contentType: "application/javascript",
    body: "window.RHYTHM_DATA=" + JSON.stringify({ students: roster, texts: {} }) + ";"
  }));

  const errors = await openScreen(page, AT);

  await page.locator(".setup-field input").nth(1).fill("补人测试班");
  await next(page);   // 名单：包里有，直接用
  await next(page);   // 作息：用默认那一套
  await next(page);   // 课表：一节课都不填也能往下走
  await next(page);   // 岗位 / 文案

  await page.locator(".setup-import-open").click();

  await page.locator(".setup-import-text").fill("岗位\t职责\t负责人\n路队长\t提醒排队\t赵子墨");
  await page.locator(".setup-import-run").click();

  await expect(page.locator(".setup-import-add").first()).toBeVisible();
  await page.locator(".setup-import-add").first().click();

  /* 打字母按姓氏拼音首字母找：z 应该出张/周，且已经在这一行里的人不再出现 */
  await page.locator(".setup-quickadd-input").fill("z");
  const items = page.locator(".setup-quickadd-item");
  await expect(items.first()).toBeVisible();
  const texts = await items.allTextContents();
  expect(texts).toContain("张望舒");
  expect(texts, "已经在表里的人不该再出现在候选里").not.toContain("赵子墨");

  await page.locator(".setup-quickadd-item", { hasText: "张望舒" }).click();
  await expect(page.locator(".setup-import-person.exact", { hasText: "张望舒" })).toBeVisible();

  expect(errors, "控制台不应有报错").toEqual([]);
});

test("向导作息的时间框不裁字、不溢出格子、表头和列对齐（真机 2026-11-24）", async ({ page }) => {
  /* 真机反馈：「结束」那一列的时间被表格右边框切掉，屏幕越小越明显。
     根因是 .setup-row 的列宽写死 9vmin，而里面 input 写死 11vmin——输入框天生
     比列宽 15~21px，必然往右溢出，最右一列再被 .setup-blocks 的 overflow:hidden
     切掉。编辑面板早就有一条同类用例（screen.spec.js「作息时间框不裁字」），
     但它量的是 .tt-time，向导用的是 .setup-row —— 所以这个 bug 一路绿着上线了。

     这条按「输入框必须完整落在自己的格子里」来验，不钉具体的 vmin 数值：
     字号是 vmin 算的，换个分辨率、换个字号，写死的期望值立刻失效。 */
  await page.route("**/app/data.js", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "window.RHYTHM_DATA={};" }));

  const errors = await openScreen(page, AT);
  await page.locator(".setup-field input").nth(1).fill("作息检查班");
  await next(page); // 名单
  await next(page); // 作息
  await expect(page.locator(".setup-blocks .setup-row").first()).toBeVisible();

  // 两种屏幕都量：1920 是一体机主流，1366 是老机型，vmin 更小、最容易挤
  for (const vp of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(vp);

    const report = await page.evaluate(() => {
      const box = document.querySelector(".setup-blocks");
      const bb = box.getBoundingClientRect();
      const rows = [...box.querySelectorAll(".setup-row")];
      const issues = [];
      let inputs = 0;

      for (const row of rows) {
        for (const inp of row.querySelectorAll("input")) {
          inputs += 1;
          const r = inp.getBoundingClientRect();
          const cell = inp.parentElement.getBoundingClientRect();
          const fs = parseFloat(getComputedStyle(inp).fontSize);
          const tag = "第 " + [...rows].indexOf(row) + " 行";
          if (r.right > cell.right + 1) {
            issues.push(tag + " 溢出所在列 " + (r.right - cell.right).toFixed(1) + "px");
          }
          if (r.right > bb.right + 1) {
            issues.push(tag + " 超出表格右边框 " + (r.right - bb.right).toFixed(1) + "px（会被切掉）");
          }
          // 08:10 是 5 个字符；等宽数字 + 时钟图标，留一点余量
          if (r.width < fs * 4.6) {
            issues.push(tag + " 框宽 " + r.width.toFixed(1) + " 装不下 08:10（字号 " + fs + "）");
          }
          if (inp.scrollWidth > inp.clientWidth + 1) issues.push(tag + " 框内文字被裁");
        }
      }

      /* 表头和数据行是两份独立的网格（各有自己的 grid-template-columns）。
         列宽若按内容解析（auto / max-content），两份会解析出不同结果——数据行里
         有输入框、表头里只有「开始」两个字，字体一换就差出几十像素，1fr 那一列
         跟着让位，表头整体错位。所以这里直接比两行的实际列宽，而不是只看对齐：
         这张截图式的判据不依赖字体，Windows 本地和 Linux CI 能给出同样结论。 */
      const head = box.querySelector(".setup-row.head");
      const data = rows.find((r) => !r.classList.contains("head"));
      const tracks = (el) => getComputedStyle(el).gridTemplateColumns.split(" ").map((v) => Math.round(parseFloat(v) * 10) / 10);
      const headTracks = head ? tracks(head) : [];
      const dataTracks = data ? tracks(data) : [];
      const trackDrift = headTracks.length === dataTracks.length
        ? headTracks.map((v, i) => Math.round(Math.abs(v - dataTracks[i]) * 10) / 10)
        : [999];

      const misalign = head && data
        ? [...head.children].slice(2).map((c, i) => {
            const a = c.getBoundingClientRect().left;
            const b = data.children[i + 2].getBoundingClientRect().left;
            return Math.round(Math.abs(a - b) * 10) / 10;
          })
        : [];

      return { inputs, issues, misalign, trackDrift, overflowX: box.scrollWidth - box.clientWidth };
    });

    const where = vp.width + "×" + vp.height;
    expect(report.inputs, where + "：作息表里应该有开始 / 结束两组时间框").toBeGreaterThan(1);
    expect(report.issues, where + " 的时间框没落在自己的格子里").toEqual([]);
    expect(Math.max(0, ...report.trackDrift),
      where + " 表头和数据行的列宽不一致（两行是独立网格，列宽按内容解析就会各算各的）").toBeLessThanOrEqual(1);
    expect(Math.max(0, ...report.misalign),
      where + " 表头「开始 / 结束」和数据列没对齐").toBeLessThanOrEqual(2);
    expect(report.overflowX,
      where + " 作息表横向溢出（表格是 overflow:hidden，溢出就等于被切掉）").toBeLessThanOrEqual(1);
  }

  expect(errors, "控制台不应有报错").toEqual([]);
});
