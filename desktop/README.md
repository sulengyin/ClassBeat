# ClassBeat 桌面化 · 开发包

把 ClassBeat 从「解压包 + bat + 自解压 exe + PowerShell 看门狗 + Chrome kiosk」
改成**一个可安装、可注册、可卸载、无控制台窗口**的 Windows 应用（Tauri 2）。

**0.5.0 起，壳与本地服务都是 Rust**：安装包 10.87 MiB → 2.43 MiB，
运行期不再有任何 Python 进程，构建也不再需要 Python。

---

## 现在的结构

```
desktop/
├── src-tauri/     ← 桌面壳（窗口 / 托盘 / 单实例 / 更新器 / NSIS 钩子）
├── server-rs/     ← 本地服务（classbeat-server.exe，取代 rhythm_server.py）
├── tools-rs/      ← 构建与验收工具（classbeat-tools.exe）
├── web/           ← 启动兜底 / 错误页
├── docs/          ← 规格、构建、验收、实测记录
└── scripts/       ← PowerShell 入口（build_windows.ps1 / dev.ps1）
```

`app/`（大屏页面）与 `server/phone.html` 等业务静态资源一字未改；
Rust 服务是按端点逐条对齐 Python 版重写的，等价性证据见
[`docs/11-功能等价对比.md`](docs/11-功能等价对比.md) 与
[`docs/12-服务从Python迁到Rust.md`](docs/12-服务从Python迁到Rust.md)。

## 怎么构建

```powershell
# 一条命令：编译工具 → 自检 → 装配资源 → 编译打包
powershell -ExecutionPolicy Bypass -File desktop\scripts\build_windows.ps1

# 只想自检
desktop\tools-rs\target\release\classbeat-tools.exe verify

# 装完跑一遍运行期验收（D1–D8：全屏 / 误关 / 单实例 / 最小化 / 自愈 / 退出）
desktop\tools-rs\target\release\classbeat-tools.exe accept
```

前置只有 Rust 1.77+ 与 Node（装 tauri-cli 用）；WebView2 在 Win10 1803+ 通常自带。

签名发布要带 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，
否则只出包、不出 `.sig`，也就没法生成 `latest.json`。

## 文档清单

| 文件 | 内容 |
|---|---|
| [`docs/01-方案总览.md`](docs/01-方案总览.md) | 问题证据、目标形态、三条不可让步的约束 |
| [`docs/02-模块规格.md`](docs/02-模块规格.md) | 12 个模块的职责 / 函数 / 失败处理 / 验收点 |
| [`docs/03-安装与系统注册.md`](docs/03-安装与系统注册.md) | tauri.conf 关键段、注册表五面、NSIS 钩子、卸载、签名 |
| [`docs/04-服务适配契约.md`](docs/04-服务适配契约.md) | 壳与服务之间的契约（0.5.0 起服务为 Rust，历史补丁已退役） |
| [`docs/05-构建与发布.md`](docs/05-构建与发布.md) | 环境、装配、构建命令、更新链路、发布检查单 |
| [`docs/06-验收清单.md`](docs/06-验收清单.md) | P0 探测 + 验收 A~E + 一票否决项 |
| [`docs/07-任务清单与提示词.md`](docs/07-任务清单与提示词.md) | 阶段表、勾选清单、启动词 |
| [`docs/08-风险与待确认.md`](docs/08-风险与待确认.md) | 风险登记、Tauri API 差异与降级、真机复测项 |
| [`docs/09-阶段小结-P0P2实测.md`](docs/09-阶段小结-P0P2实测.md) | P0–P2 阶段实测：探测、构建、进程树、偏差 |
| [`docs/10-验收实测-A到E.md`](docs/10-验收实测-A到E.md) | 真机实测记录（安装 / 更新 / 卸载 / Defender） |
| [`docs/11-功能等价对比.md`](docs/11-功能等价对比.md) | 旧包 vs 新包的功能等价证据 |
| [`docs/12-服务从Python迁到Rust.md`](docs/12-服务从Python迁到Rust.md) | 0.5.0 迁移：为什么、怎么做、差在哪 |

## 一句话结论

**问题不是功能缺，是壳层架构。** 旧链路跑着四个不属于本项目的进程，
所以每加一个需求就要打一层壳层补丁。换成 Tauri 之后，窗口、服务、安装生命周期
都在自己手里；再把服务换成 Rust，连「捆一个 Python 运行时」这个包袱也卸掉了。
