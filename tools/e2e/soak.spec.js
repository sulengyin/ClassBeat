/* 连续开一整天：从 06:30 到 18:30，每半小时推进一次。
   教室里的大屏是「开机就没人管」的设备，最怕的是跑着跑着内存涨、DOM 越堆越多、
   或者某个时间点切不过去。这里不给它重开的机会，一次跑完 12 小时。 */

const { test, expect } = require("@playwright/test");
const { clearHub, openScreen } = require("./helpers");

test("连开 12 小时不报错、不堆积、每个时段都切得过去", async ({ page, request }) => {
  test.setTimeout(180_000);
  await clearHub(request);

  const errors = await openScreen(page, "2026-11-05T06:30:00+08:00");

  const samples = [];
  const bands = new Set();

  // 12 小时 / 30 分钟 = 24 次推进
  for (let i = 0; i < 24; i += 1) {
    await page.clock.fastForward(30 * 60 * 1000);
    const snap = await page.evaluate(() => ({
      clock: (document.querySelector("#clock")?.textContent || "").trim(),
      band: (document.querySelector("#bandText")?.textContent || "").trim(),
      nodes: document.querySelectorAll("*").length,
    }));
    samples.push(snap);
    bands.add(snap.band);
  }

  expect(errors, "整天运行不应该有脚本错误").toEqual([]);

  expect(samples[0].clock).toMatch(/^\d{1,2}:\d{2}$/);
  expect(samples[samples.length - 1].clock, "12 小时后时钟应该还在走").toMatch(/^\d{1,2}:\d{2}$/);
  expect(new Set(samples.map((s) => s.clock)).size, "时钟不能卡住").toBeGreaterThan(1);

  // 一天里至少要换过几个时段：早读、上课、午餐、午间、放学后……
  expect(bands.size, `只出现了 ${[...bands].join(" / ")}`).toBeGreaterThanOrEqual(4);

  // 节点数不能一路涨（涨说明每次都新建 DOM 没回收）
  const first = samples[0].nodes;
  const last = samples[samples.length - 1].nodes;
  expect(last, `节点从 ${first} 涨到 ${last}`).toBeLessThan(first * 1.5 + 50);
});
