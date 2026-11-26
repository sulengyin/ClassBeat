/* 值日条滚动的真机浏览器验证（2026-11-26）：
   小岗位多到一行放不下时，整行从右往左循环滚动，让每个「岗位+姓名」都能被看到。

   根因：旧代码在 track 还没 append 到 DOM 时就量 scrollWidth，
   脱离文档的 div 没有布局、scrollWidth 恒为 0，判断永远为假——
   滚动从未真正触发过，屏幕只显示前几个岗位。现在改成先入 DOM 再量。 */
const { test, expect } = require("@playwright/test");
const { openScreen, clearHub } = require("./helpers");

const MORNING = "2026-11-05T07:50:00+08:00"; // 晨间自主管理 07:30–08:10

// 示例包里的本班学生名单，确保姓名能上屏（非本班会被过滤成「待定」）
const NAMES = [
  "赵子墨", "钱嘉禾", "孙星野", "李青禾", "周梓萱", "吴书瑶",
  "郑南乔", "王一诺", "冯予安", "周予安", "周予宁", "卫浩然",
];

function manyRoles(n) {
  const roles = NAMES.slice(0, n).map((name, i) => ({
    id: "r" + String(i + 1).padStart(2, "0"),
    name: "小岗位" + (i + 1),
    duty: "示例职责",
    people: [name],
    freq: { kind: "unset" },
    order: 10 + i,
    assign: "fixed",
    grp: null,
  }));
  return {
    roles: { id: "roles-test", class: "五（1）班", roles, dutyCycle: {} },
    // 三个时段里的「晨间自主管理」全部常驻这些岗位 → 同一时段全上屏
    dutyPresents: { reading: roles.map((r) => r.id), break: [], noon: [] },
  };
}

test.beforeEach(async ({ request }) => {
  await clearHub(request);
});

test("小岗位多到写不下时整行滚动，每个岗位+姓名都在 track 里", async ({ page }) => {
  await openScreen(page, MORNING);
  await page.evaluate((cfg) => Store.patchConfig(cfg), manyRoles(12));

  const duty = page.locator("#duty");
  // 所有小岗位和姓名都渲染出来（不再截断）
  for (const name of NAMES) {
    await expect(duty, `${name} 应当出现在值日条上`).toContainText(name);
  }

  const track = duty.locator(".duty-track");
  await expect(track).toHaveClass(/scroll/);

  const info = await track.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      items: el.querySelectorAll(".duty").length,
      clientWidth: el.parentElement.clientWidth,
      scrollWidth: el.scrollWidth,
      animation: cs.animationName,
      dur: el.style.getPropertyValue("--dur"),
    };
  });

  // 两份无缝循环：12 个岗位复制成 24 张卡片
  expect(info.items).toBe(24);
  // 内容确实超出行宽，才需要滚
  expect(info.scrollWidth).toBeGreaterThan(info.clientWidth + 4);
  // CSS 动画真的挂上了，时长落在合理区间（约每秒 60px，最少 10 秒）
  expect(info.animation).toBe("duty-marquee");
  const secs = parseFloat(info.dur);
  expect(secs).toBeGreaterThanOrEqual(10);
  expect(secs).toBeLessThan(120);

  // 关键：长内容是整行内部滚动，不能把整页撑出视口（否则其余元素被带偏）。
  // grid-template-columns:minmax(0,1fr) 钉住，main/footer 宽度都不得超过视口。
  const layout = await duty.evaluate(() => ({
    vw: window.innerWidth,
    mainW: Math.round(document.querySelector("main").getBoundingClientRect().width),
    footerW: Math.round(document.querySelector("footer").getBoundingClientRect().width),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(layout.mainW).toBeLessThanOrEqual(layout.vw);
  expect(layout.footerW).toBeLessThanOrEqual(layout.vw);
  expect(layout.overflowX).toBeLessThanOrEqual(1);
});

test("岗位少、一行写得下时不滚动（其余不变）", async ({ page }) => {
  await openScreen(page, MORNING);
  await page.evaluate((cfg) => Store.patchConfig(cfg), manyRoles(2));

  const track = page.locator("#duty .duty-track");
  await expect(track).toBeVisible();
  await expect(track).not.toHaveClass(/scroll/);
  const items = await track.locator(".duty").count();
  expect(items).toBe(2); // 不复制、不滚动
});
