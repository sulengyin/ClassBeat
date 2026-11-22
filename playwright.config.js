// 三个问题，三组项目：
//   大屏在不同分辨率的教室里会不会溢出 / 报错 → 一体机、平板
//   手机能不能顺畅发一条消息 → iPhone、安卓、鸿蒙
//   连开一整天会不会越跑越卡 → soak.spec.js（只在一体机项目里跑）
//
// 说明：鸿蒙项目是 Chromium + 鸿蒙 UA + 360×780 视口，不是真机。
// 真实鸿蒙浏览器（ArkWeb）只有内核版本差异，没有可下载的 Playwright 引擎，
// 这一项能挡住视口/触摸/字号问题，但挡不住鸿蒙特有的渲染差异，别当成真机结论。

const { defineConfig, devices } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

// 服务端口：默认 8765（产品默认值，配置里别再写别的数）。
// 本机 8765 被别的进程占着时（比如旧版残留的 pythonw），
// 用 CB_PORT=8766 npx playwright test 临时绕开——别把改过的端口提交上来，
// 那会让别人的机器和 CI 都对不上。
const PORT = process.env.CB_PORT || "8765";
const BASE_URL = `http://127.0.0.1:${PORT}`;

// 被测服务：0.5.3 起就是 Rust 的 classbeat-server（Python 版已退役）。
// 跑测试前先编一次：
//   cargo build --release --manifest-path desktop/server-rs/Cargo.toml
// 想指到别处的二进制就设 CLASSBEAT_SERVER。
// `--base server` 是关键：服务把 base 当静态根（手机页、sw.js、图标在这儿），
// 并把它的父目录当安装根（大屏页面在 ./app）——和装完之后的布局一致。
const SERVER_BIN =
  process.env.CLASSBEAT_SERVER ||
  path.join(
    __dirname,
    "desktop",
    "server-rs",
    "target",
    "release",
    process.platform === "win32" ? "classbeat-server.exe" : "classbeat-server"
  );
if (!process.env.CLASSBEAT_SERVER && !fs.existsSync(SERVER_BIN)) {
  console.warn(
    `[playwright] 找不到 ${SERVER_BIN}\n` +
      "先跑：cargo build --release --manifest-path desktop/server-rs/Cargo.toml"
  );
}

module.exports = defineConfig({
  testDir: "./tools/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // 所有用例共用一个消息服务与一个消息文件，串行才不会互相撤回
  retries: process.env.CI ? 1 : 0,
  // json 是给 tools/e2e/summary.js 用的：它把结果压成 notice/warning，
  // 这样不登录也能从 check-run 里读到是哪一条挂了（HTML 报告是 artifact，要登录）。
  reporter: process.env.CI
    ? [
        ["list"],
        ["html", { open: "never" }],
        ["github"],
        ["json", { outputFile: "e2e-results.json" }],
      ]
    : [["list"], ["html", { open: "never" }], ["json", { outputFile: "e2e-results.json" }]],
  use: {
    baseURL: BASE_URL,
    timezoneId: "Asia/Shanghai",
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: process.env.CI ? "retain-on-failure" : "off",
  },
  webServer: {
    command: `"${SERVER_BIN}" --port ${PORT} --base server`,
    // 服务端和浏览器必须同一个时区，否则「这条消息过期没有」两边会差 8 小时
    env: { TZ: "Asia/Shanghai" },
    url: `${BASE_URL}/api/ping`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "一体机",
      testMatch: /(screen|soak|setup|update)\.spec\.js/,
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
