/* 配置向导：别的老师不碰命令行，从「什么都没有」配出一块能用的屏。
 *
 * 这一条补的是 B5 的验收：真实浏览器里点完四步、应用、刷新，
 * 班名 / 作息 / 课表都还在。node 的 DOM 桩已经在 test_dom.js 里钉过一遍，
 * 这里只负责真浏览器里那份 localStorage 和脚本加载顺序。
 */

const { test, expect } = require("@playwright/test");
const { openScreen, openTools, clearHub } = require("./helpers");

/* 配置从 0.5.9 起存在服务端，会被下一个用例拉到自己的空上下文里。
   这一组全都是「从什么都没有配起」，所以每个用例先把服务端那份清干净。 */
test.beforeEach(async ({ request }) => {
  await clearHub(request);
});

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

  // 完成页给出汇总；时间线预览已移出配置流程（2026-11-25 反馈）
  await expect(page.locator(".setup-preview")).toHaveCount(0);
  await expect(page.locator(".setup-sum")).toContainText("空包测试班");

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

  /* 还没应用，末页汇总也要显示刚改的 07:40——它读的是草稿，不是已保存配置。
     时间线预览已移出配置流程（2026-11-25），这里用汇总行钉同一件事。 */
  await expect(page.locator(".setup-sum")).toContainText("07:40");

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

test("岗位清单只听老师上传的那张表：不摊人员、不摊置信度、不残留来源班的岗位", async ({ page }) => {
  /* 2026-11-25 真机反馈：
     ① 配置阶段把「每个岗位对应的人」和「置信度」摊给老师看，一页很长，
        点一下就弹回顶部——这些属于编辑模式；
     ③ 岗位名称和人员来自包里的来源班，老师上传自己的表也不管用。
     这条把两件事一起钉住：表里有什么岗位，本班就有什么岗位；表里点了名，
     人就换成表里的。 */
  const roster = ["赵子墨", "钱嘉禾", "孙星野", "李青禾", "周梓萱", "张望舒"]
    .map((n, i) => ({ id: "s" + (i + 1), name: n, active: true }));
  const roles = {
    class: "来源班",
    dutyCycle: {},
    roles: [
      { id: "r01", name: "路队长", duty: "排队", people: ["孙星野"], freq: { kind: "event" }, order: 10 },
      { id: "r02", name: "节能小队长", duty: "关灯", people: ["钱嘉禾"], freq: { kind: "daily" }, order: 20 },
    ],
  };
  await page.route("**/app/data.js", (route) => route.fulfill({
    status: 200, contentType: "application/javascript",
    body: "window.RHYTHM_DATA=" + JSON.stringify({ students: roster, roles, texts: {} }) + ";"
  }));

  const errors = await openScreen(page, AT);

  await page.locator(".setup-field input").nth(1).fill("清单测试班");
  await next(page);   // 名单：包里有，直接用
  await next(page);   // 作息：用默认那一套
  await next(page);   // 课表：一节课都不填也能往下走
  await next(page);   // 岗位 / 文案

  await page.locator(".setup-import-open").click();
  await page.locator(".setup-import-text")
    .fill("岗位\t职责\t负责人\n饮水机管理员\t每天换水\t李青禾\n图书角管理员\t整理图书\t张望舒");
  await page.locator(".setup-import-run").click();

  const rows = page.locator(".setup-import-preview .setup-import-row");
  await expect(rows).toHaveCount(2);
  await expect(page.locator(".setup-import-preview")).toContainText("饮水机管理员");

  /* 人员、置信度、补人按钮都不该出现在配置阶段 */
  expect(await page.locator(".setup-import-person, .setup-import-conf, .setup-import-add").count())
    .toBe(0);
  /* 岗位名是只读文本，不是输入框 */
  await expect(page.locator(".setup-import-name-text").first()).toHaveText("饮水机管理员");
  expect(await page.locator(".setup-import-name").count()).toBe(0);

  await page.locator(".setup-import-apply").click();

  /* 并入后：草稿里的岗位清单就是表里那两条，来源班的两个岗位不再留下 */
  const draftRoles = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("rhythm.setup.draft.v1") || "{}");
    return (((d.roles || {}).roles) || []).map((r) => ({ name: r.name, people: r.people || [] }));
  });
  expect(draftRoles.map((r) => r.name).sort()).toEqual(["图书角管理员", "饮水机管理员"]);
  const water = draftRoles.filter((r) => r.name === "饮水机管理员")[0];
  expect(water.people, "表里点名的负责人要真正写进去").toEqual(["李青禾"]);

  expect(errors, "控制台不应有报错").toEqual([]);
});

test("岗位表里勾选不会把人弹回页面顶部（真机 2026-11-25）", async ({ page }) => {
  /* 真机反馈：班级配置 → 岗位/文案这一页内容多，点一下（勾选、全选、全不选）
     整页重画，.setup-body 的 scrollTop 归 0，老师得自己再往下滚一次，
     触摸屏上等于没法连续操作。
     这条按「滚到哪里、点完还在哪里」来验，不钉元素顺序或行数。 */
  await page.setViewportSize({ width: 1100, height: 700 });

  const roster = ["赵子墨", "钱嘉禾", "孙星野", "李青禾", "周梓萱", "张望舒"]
    .map((n, i) => ({ id: "s" + (i + 1), name: n, active: true }));
  await page.route("**/app/data.js", (route) => route.fulfill({
    status: 200, contentType: "application/javascript",
    body: "window.RHYTHM_DATA=" + JSON.stringify({ students: roster, texts: {} }) + ";",
  }));

  const errors = await openScreen(page, AT);

  await page.locator(".setup-field input").nth(1).fill("滚动测试班");
  await next(page);   // 名单
  await next(page);   // 作息
  await next(page);   // 课表
  await next(page);   // 岗位 / 文案

  await page.locator(".setup-import-open").click();
  await page.locator(".setup-import-text").fill(
    "岗位\t职责\t负责人\n"
    + ["饮水机管理员\t每天换水\t李青禾",
       "图书角管理员\t整理图书\t张望舒",
       "窗台小管家\t擦窗台\t赵子墨",
       "讲台清洁员\t擦讲台\t钱嘉禾",
       "黑板管理员\t擦黑板\t孙星野",
       "桌椅小卫士\t摆桌椅\t周梓萱"].join("\n"));
  await page.locator(".setup-import-run").click();
  await expect(page.locator(".setup-import-row")).toHaveCount(6);

  /* 有得滚才谈得上「别跳回去」；没有就说明用例前提不成立，直接失败更好排查 */
  const scrollable = await page.evaluate(() => {
    const el = document.querySelector(".setup-body");
    el.scrollTop = 260;
    return { max: el.scrollHeight - el.clientHeight, top: el.scrollTop };
  });
  expect(scrollable.max, "这一页要能滚起来，用例才有意义").toBeGreaterThan(120);
  expect(scrollable.top).toBeGreaterThan(120);

  /* 用 DOM 点击，绕开 Playwright 的「滚到元素可见」——那一步本身会改 scrollTop */
  await page.evaluate(() => document.querySelector(".setup-import-none").click());
  const after = await page.evaluate(() => document.querySelector(".setup-body").scrollTop);
  expect(after, "点了「全不选」之后还应该停在原处").toBeGreaterThan(120);
  expect(Math.abs(after - scrollable.top), "位置浮动不该超过一屏的零头").toBeLessThan(40);

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
