/* 把 Playwright 的 JSON 结果压成一段可读摘要。
 *
 * 为什么需要它：HTML 报告是 artifact，公开仓库下载也要登录，而 check-run 的
 * annotations 不需要。把「哪个项目、哪一条、失败还是重试才过」打成
 * ::error:: / ::warning::，在 Actions 页面和 API 里都能直接看到。
 *
 * 用法：node tools/e2e/summary.js [结果文件]
 * 没跑过测试（文件不存在）时只提示一句，不报错——这个脚本本身不该挡住任何事。
 */

const fs = require("fs");

const FILE = process.argv[2] || "e2e-results.json";

/** GitHub 的 workflow command 里，百分号、换行要转义，否则整条会被截断。 */
function esc(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function walk(suite, out) {
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) {
      out.push({
        project: t.projectName || "(默认)",
        file: spec.file || suite.file || "",
        line: spec.line || 0,
        title: spec.title,
        status: t.status, // expected / unexpected / flaky / skipped
        attempts: (t.results || []).length,
      });
    }
  }
  for (const child of suite.suites || []) walk(child, out);
}

function main() {
  if (!fs.existsSync(FILE)) {
    console.log(`::notice title=Playwright 报告::没找到 ${FILE}，测试可能没跑起来`);
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    console.log(`::warning title=Playwright 报告::${FILE} 解析失败：${esc(e.message)}`);
    return;
  }

  const rows = [];
  for (const s of data.suites || []) walk(s, rows);

  const failed = rows.filter((r) => r.status === "unexpected");
  const flaky = rows.filter((r) => r.status === "flaky");
  const skipped = rows.filter((r) => r.status === "skipped");
  const passed = rows.length - failed.length - flaky.length - skipped.length;

  const stats = data.stats || {};
  const seconds = stats.duration ? (stats.duration / 1000).toFixed(1) : "?";

  // 按项目汇总：项目名就是配置里的「一体机 / 平板 / iPhone / 鸿蒙」这些
  const byProject = new Map();
  for (const r of rows) {
    const p = byProject.get(r.project) || { pass: 0, fail: 0, flaky: 0, skip: 0 };
    if (r.status === "unexpected") p.fail += 1;
    else if (r.status === "flaky") p.flaky += 1;
    else if (r.status === "skipped") p.skip += 1;
    else p.pass += 1;
    byProject.set(r.project, p);
  }

  const summary = [
    // 「通过」把偶发也算进去：它们最终是绿的，但下面会单独列出来
    `### Playwright：${passed + flaky.length} 通过 / ${failed.length} 失败 / ${flaky.length} 偶发 / ${skipped.length} 跳过（${seconds}s）`,
    "",
    "| 项目 | 通过 | 失败 | 偶发 | 跳过 |",
    "|---|---|---|---|---|",
    ...[...byProject.entries()].map(
      ([name, p]) => `| ${name} | ${p.pass} | ${p.fail} | ${p.flaky} | ${p.skip} |`
    ),
  ];

  if (failed.length) {
    summary.push("", "**失败**", ...failed.map((r) => `- [${r.project}] ${r.file}:${r.line} ${r.title}`));
  }
  if (flaky.length) {
    summary.push(
      "",
      "**重试才过（说明这条不稳，修测试或修产品，别只看最终是绿的）**",
      ...flaky.map((r) => `- [${r.project}] ${r.file}:${r.line} ${r.title}（试了 ${r.attempts} 次）`)
    );
  }

  const text = summary.join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  }

  // 汇总一条，后面每条失败/偶发单独一条，方便在 Annotations 里逐条看
  console.log(
    `::notice title=Playwright 汇总::${esc(
      `${passed + flaky.length} passed, ${failed.length} failed, ${flaky.length} flaky, ${skipped.length} skipped in ${seconds}s`
    )}`
  );

  for (const r of failed) {
    console.log(`::error title=Playwright 失败::${esc(`[${r.project}] ${r.file}:${r.line} ${r.title}`)}`);
  }
  for (const r of flaky) {
    console.log(
      `::warning title=Playwright 偶发::${esc(
        `[${r.project}] ${r.file}:${r.line} ${r.title}（第 ${r.attempts} 次才过）`
      )}`
    );
  }

  // 全局错误（配置读不到、webServer 起不来之类），这些不在任何 spec 里
  for (const e of data.errors || []) {
    const msg = (e.message || "").split("\n")[0].slice(0, 300);
    console.log(`::error title=Playwright 运行错误::${esc(msg)}`);
  }
}

main();
