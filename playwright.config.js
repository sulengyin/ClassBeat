// 三个问题，三组项目：
//   大屏在不同分辨率的教室里会不会溢出 / 报错 → 一体机、平板
//   手机能不能顺畅发一条消息 → iPhone、安卓、鸿蒙
//   连开一整天会不会越跑越卡 → soak.spec.js（只在一体机项目里跑）
//
// 说明：鸿蒙项目是 Chromium + 鸿蒙 UA + 360×780 视口，不是真机。
// 真实鸿蒙浏览器（ArkWeb）只有内核版本差异，没有可下载的 Playwright 引擎，
// 这一项能挡住视口/触摸/字号问题，但挡不住鸿蒙特有的渲染差异，别当成真机结论。

const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tools/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // 所有用例共用一个消息服务与一个消息文件，串行才不会互相撤回
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:8765",
    timezoneId: "Asia/Shanghai",
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: process.env.CI ? "retain-on-failure" : "off",
  },
  webServer: {
    command: "python3 server/rhythm_server.py --port 8765",
    url: "http://127.0.0.1:8765/api/ping",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "一体机",
      testMatch: /(screen|soak)\.spec\.js/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } },
    },
    {
      // 教室一体机也有 1366×768 的老机型，字号和换行最容易在这里出问题
      name: "老一体机",
      testMatch: /screen\.spec\.js/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } },
    },
    {
      // WebKit ≈ Safari 内核，用来挡 iPad / Mac 教室场景
      name: "平板",
      testMatch: /screen\.spec\.js/,
      use: { ...devices["iPad (gen 7)"], viewport: { width: 1024, height: 768 } },
    },
    {
      name: "iPhone",
      testMatch: /phone\.spec\.js/,
      use: { ...devices["iPhone 13"] },
    },
    {
      name: "iPhone小屏",
      testMatch: /phone\.spec\.js/,
      use: { ...devices["iPhone SE"] },
    },
    {
      name: "安卓",
      testMatch: /phone\.spec\.js/,
      use: { ...devices["Pixel 7"] },
    },
    {
      // 鸿蒙：Chromium 内核 + 鸿蒙 UA + 常见 360×780 视口（模拟，不是真机）
      name: "鸿蒙",
      testMatch: /phone\.spec\.js/,
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 360, height: 780 },
        userAgent:
          "Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile",
      },
    },
  ],
});
