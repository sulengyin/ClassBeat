# 12 · 服务从 Python 迁到 Rust（0.5.0）

> 一句话结论：**本地服务的对外行为没变，实现语言换了**。1561 行的 `rhythm_server.py` 被
> 2381 行 Rust（axum + tokio）逐端点重写；49 条主请求里 48 条响应逐字节相同，
> `app/` 静态资源 23/23 字节相同，SSE 逐行相同；剩下的 1 条只是 JSON 解析器报错文案措辞不同。
> 代价是安装包从 **10.87 MiB 降到 2.43 MiB**，安装目录从 **29 MB 降到 6.59 MB**，
> 运行期 **Python 进程数归零**，构建链也不再需要 Python。
>
> 取舍：这次是"照抄接口、重写实现"，不是"重新设计服务"。任何一处行为拿不准，
> 一律以 Python 版为准——包括中文错误文案和响应头顺序。

## 12.1 为什么要动它

0.4.x 的桌面版壳是 Rust，但服务还是 Python：安装包里塞一个 22 MB 的嵌入式运行时，
`resources/python/` 下一个 `pythonw.exe` + 标准库 + 脚本。带来三个具体问题：

| 问题 | 具体表现 |
|---|---|
| 体积 | NSIS 包 10.87 MiB / MSI 14.39 MB，其中约 22 MB 解压后是 Python 运行时 |
| 进程 | 老师机器上跑着 `pythonw.exe`，杀软容易盯上无窗 Python（Defender 曾报过） |
| 构建 | 出包要先有 Python 跑 `stage_resources.py` / `verify_package.py`，CI 与开发机都得装 |

另外 `rhythm_server.py` 需要 6 处在**构建副本**上打补丁才能进包（改数据目录、去掉菜单、绑定地址等，
见 [`04-服务适配契约.md`](04-服务适配契约.md)）。服务自己就是 Rust 之后，这些补丁全部退役——
参数从命令行进来，源码不用动。

## 12.2 换成什么样了

```
desktop/
├── src-tauri/    桌面壳（窗口 / 托盘 / 单实例 / 更新器 / NSIS 钩子）  —— 没换
├── server-rs/    本地服务  → classbeat-server.exe（取代 rhythm_server.py）
├── tools-rs/     构建与验收 → classbeat-tools.exe（取代 6 个 .py）
├── web/          启动兜底 / 错误页                                  —— 没换
└── app/ 、server/phone.html 等业务静态资源                          —— 一字未改
```

壳仍然是"起服务 → 轮询 `ping` 探活 → 挂了重启"的结构，只是子进程从 `pythonw.exe rhythm_server.py`
换成了 `classbeat-server.exe`：

```rust
// src-tauri/src/config.rs
pub fn server_exe() -> PathBuf { server_dir().join("classbeat-server.exe") }
```

`CLASSBEAT_SERVER` 环境变量可以覆盖路径（调试用）；`CLASSBEAT_DATA_DIR` 仍然把数据目录指到
`%LOCALAPPDATA%\ClassBeat\data`，与 Python 版完全一致——**老师已有的消息、备份、班级配置原地可用**。

### server-rs 模块划分

| 文件 | 行数 | 职责 |
|---|---|---|
| `routes.rs` | 722 | 手写路由分发 + 全部 GET/POST 端点 + SSE |
| `backup.rs` | 302 | 每日备份快照、远端备份读写、`valid_patch` |
| `main.rs` | 250 | 参数解析、`--wait-port` 重试、启动日志 |
| `state.rs` | 227 | `Paths::resolve`、共享状态、版本号惰性读取 |
| `pyjson.rs` | 223 | **复刻 Python `json.dumps` 的输出格式**（见 12.3） |
| `util.rs` | 222 | 时间/北京时间/`home_id`/`abspath`/`lan_ip`/班级名探测 |
| `messages.rs` | 208 | 消息增删、`as_int`、过期清理、撤回 |
| `resp.rs` | 134 | 统一响应构造（头部、CORS、`no-store`、各类错误页） |
| `win.rs` | 93 | 找「班级节律屏」窗口、最小化、退出 |
| 合计 | **2381** | 对应 `rhythm_server.py` 的 1561 行 |

工具侧 `tools-rs` 1684 行，子命令 `stage` / `bundle` / `verify` / `make-latest` / `accept`，
一一对应被删掉的 `stage_resources.py`、`verify_package.py`、`make_latest.py`、`accept_runtime.py`、
`tools/bundle.py`，外加把 `check_install.py` 的检查并进 `verify`。

## 12.3 三个真正难的地方

### ① 响应体是给前端和手机端直接解析的，格式必须"逐字节"像 Python

`serde_json` 默认输出 `{"a":1}`，Python 默认输出 `{"a": 1}`（冒号后带空格）。前端虽然能解析两种，
但只要有一处对不上，"等价"就无从谈起——验收就没法用字节比较，只能靠人眼看。
所以单独写了 `pyjson.rs`，提供三个出口：

| 函数 | 复刻的 Python 调用 | 用在哪 |
|---|---|---|
| `dumps()` | `json.dumps(x)` | 绝大多数接口，分隔符 `", "` / `": "` |
| `dumps_indent(1)` | `json.dumps(x, indent=1)` | `messages.json` 落盘 |
| `dumps_sorted_compact()` | `json.dumps(x, sort_keys=True, separators=(",",":"))` | `data.js` 里的 `RHYTHM_DATA` |

细节坑：中文**不转义**（Python `ensure_ascii=False`）、控制字符按 `\u00XX` 转义、
浮点 `1.0` 保留小数点（不能输出 `1`）、`sort_keys` 要按 Unicode 码点排、缩进时空数组输出 `[]` 而不是 `[\n\n]`。
`pyjson.rs` 里 5 条单测就是钉这些的。

### ② 路径与 `home_id`：不能用 `canonicalize`

Python 版用 `os.path.abspath` 算设备目录，再取 `sha256(路径小写 + 反斜杠转斜杠)[:8]` 当 `home_id`。
Rust 里最顺手的是 `Path::canonicalize`，但它会返回 `\\?\C:\Users\...` 形式，
`home_id` 立刻变成一个和旧数据对不上的值——**老师的远端备份会"消失"**。
所以 `util::abspath` 是手写的：拼当前目录 + `normalize`（消 `.` / `..`），一个字符不乱加。
同理 `mimetypes` 在 Windows 上的判定（`.js` → `text/javascript`、`.html` → `text/html; charset=utf-8`）
也是照抄，没用 `mime_guess`。

### ③ 头部也要对，包括"没有头部"这件事

逐字节比较暴露了三处"实现差异导致的协议差异"，都不是功能问题，但会让 diff 变红：

| 情况 | Python（wsgiref/内置） | Rust（axum/hyper）初版 | 处理 |
|---|---|---|---|
| 302 重定向 | 无 CORS、无 `Content-Type` | 被统一层加了 CORS | `resp::redirect` 单独构造，绕开统一层 |
| 204 无内容 | 带 `Content-Length: 0` | hyper 会抹掉 | `resp::no_content` 手动补回 |
| 501 未实现 | 返回 HTML 默认错误页 | 空 501 | `resp::not_implemented` 逐字复刻页面全文 + `Connection: close` |

SSE 也照抄了：`id: <seq>\ndata: <json>\n\n` 三段式、15 秒一次 `: ping` 注释行、
`since=-1` 不回放历史、`since=0` 从头回放。

## 12.4 怎么证明"行为没变"

方法是**两侧同时跑、同一套请求各打一遍、逐条 diff**：

- **A 侧**：`server/rhythm_server.py`，用自带 Python 起在 8781，`CLASSBEAT_DATA_DIR` 指到临时目录
- **B 侧**：`classbeat-server.exe`，起在 8782，同样指到各自独立的临时目录
- 两侧数据起点一致（同一份 `sample/` + 空 `messages.json`/`net.json`）
- 每条请求抓 **状态码 + 关键响应头 + 响应体**，先把 `<TS>` / `"now"` / `"at"` / `"until"` / `<MS>`
  这类必然不同的时间戳归一化，再做字节比较

### 结果

| 组 | 条数 | 一致 | 不一致 | 说明 |
|---|---|---|---|---|
| 主请求集（`app/*.js` 里所有 fetch 调用点 + `phone.html` 的调用点） | 49 | **48** | 1 | 唯一差异见下 |
| 补充探测（更新端点、备份单份、`n=abc/0/999`、HEAD、PUT、路径穿越、`minutes` 传字符串/布尔/小数、`text:null`、多余键、空 body） | 23 | **23** | 0 | — |
| 静态文件 `app/`（HTML/CSS/JS/图片） | 23 | **23** | 0 | 字节相同，`Content-Type` 全同 |
| SSE `since=-1` / `since=0` | 2 | **2** | 0 | 逐行相同（9 行 / 24 行） |

唯一不一致的一条，是**故意发空 body 触发 JSON 解析失败**时的 400 文案：

```
Python: {"ok": false, "error": "Expecting value: line 1 column 1 (char 0)"}
Rust  : {"ok": false, "error": "expected ident at line 1 column 2"}
```

两边**状态码相同、结构相同、`ok:false` 相同**，只有那句"解析器原话"不同——
它本来就是 `json` 模块和 `serde_json` 各自的内部措辞，除非把 serde 的报错表翻成 Python 的措辞，
否则无法消除。判断：**不值得消除**，因为这条路只有前端发坏数据才会走到，老师看不到。

同理，501 默认错误页里 Python 那侧会带 `Server: SimpleHTTP/0.6 Python/3.x`，
Rust 侧是 `Server: RhythmHub/1.0`——版本号本来就是平台信息，不追求一致。

## 12.5 换完之后的体量

| 指标 | 0.4.2（Python 服务） | 0.5.0（Rust 服务） | 变化 |
|---|---|---|---|
| NSIS 安装包 | 11,402,060 B（10.87 MiB） | 2,552,879 B（2.43 MiB） | **−78%** |
| MSI 安装包 | 14,389,248 B（13.72 MiB） | 3,665,920 B（3.50 MiB） | −75% |
| 安装目录（装完占用） | 29 MB | **6.59 MB** | −77% |
| 服务可执行文件 | `pythonw.exe` + 标准库 ≈ 22 MB | `classbeat-server.exe` 816 KiB | — |
| 运行期进程 | `classbeat.exe` + `pythonw.exe` | `classbeat.exe` 38.2 MB + `classbeat-server.exe` 10.8 MB | Python 进程 **0** |
| 构建前置 | Rust + Node + **Python** | Rust + Node | 少一个 |

## 12.6 装完之后的验收

用 `classbeat-tools accept` 在真机（Win11 26200 / 非管理员）跑，**17 项全过、0 失败**。
脚本里的分组与 `06-验收清单.md` 的 D 组是同一套编号：

| 组 | 查什么 | 结果 |
|---|---|---|
| 启动 | 进程树只有 `classbeat.exe` + `classbeat-server.exe`（没有 `conhost`、没有 Python）；全屏无边框无菜单；`/api/ping` 自报 `shell=true`、`class=五（1）班`、`build=f24c3b9`、`port=8765`；窗口标题「班级节律屏」 | 过 |
| D2 误关 | Alt+F4 / 点叉 → 收进托盘，不退出 | 过 |
| 单实例再启 | 第二次启动只唤起已有窗口，不起第二个服务 | 过 |
| D3 最小化 | `Ctrl+Alt+M` → 最小化；再恢复 | 过（`{"ok":true,"found":1,"minimized":1}`） |
| D6 服务自愈 | 杀掉 `classbeat-server.exe` → 25 秒内重启、页面重连 | 过，**16.5 秒** |
| C4 手机页 | 手机侧页面照常可达 | 过 |
| D4 退出 | 确认退出后壳与服务一起消失、8765 释放、无 `exit-request.flag` 残留 | 过 |

**踩到一个假 FAIL（已修）**：静默装完之后 NSIS 会自动拉起一次应用，紧接着跑 `accept`，
它再起的第二个实例被单实例挡掉、当场退出，于是"记下的 pid"一直是死的，报出两条
`误关后进程仍在` / `自愈后仍是同一个壳进程` —— 而窗口、最小化、自愈其实全都正常，
因为测的其实是安装器拉起的那个实例。
现在 `accept` 启动前会先把已在跑的实例清掉（先杀壳再杀服务，等端口放掉），
用"先手动起一个再跑"复现过：**17 项全过、0 失败**。

## 12.7 迁移带出来的两个坑

**① NSIS 覆盖安装不会删"新包里没有的旧文件"。**
0.5.0 不再需要 `resources/python/`，但覆盖安装时那 22 MB 会原地留着——用户看到的"瘦身"是假的。
所以在 `installer/hooks.nsh` 的 POSTINSTALL 里显式清理：

```nsis
RMDir /r "$INSTDIR\resources\python"
Delete "$INSTDIR\resources\server\*.py"
RMDir /r "$INSTDIR\resources\server\__pycache__"
```

`classbeat-tools verify` 里加了一条断言钉住这段代码还在，且装配结果里 `.py` 数量为 0、
`resources/python` 不存在。重装后安装目录 29 MB → **6.59 MB**，与预期一致。

**② 旧版脚本不能直接删干净。**
`server/*.py`（`rhythm_server.py` / `updater.py` / `run.py` / `update_manifest.py`）和 `tools/*.py`
仍然留在仓库里：它们是"解压即用"的单文件版历史工具，还有老师在用，只是**不再参与桌面版构建、不进安装包**。
桌面版这边被删掉的只有 `desktop/scripts/` 下被 `classbeat-tools` 取代的 4 个：
`stage_resources.py`、`verify_package.py`、`make_latest.py`、`accept_runtime.py`。
`tools/bundle.py` 保留（单文件版还要用），`data.js` 的生成逻辑在 `tools-rs/src/bundle.rs` 里另写了一份。
仓库里 `.py` 总数从 32 降到 28，剩下 28 个全是业务侧/测试侧的，与桌面版构建无关。

## 12.8 还没做 / 已知不追平

| 项 | 状态 |
|---|---|
| 空 body 的 JSON 报错措辞 | 已知差异，不追平（见 12.4） |
| 501 默认页 `Server:` 头 | 平台信息，不追平 |
| `equivalence_run.py` / `diff_legacy_vs_new.py` 的 Rust 版 | 未移植。这两个是**一次性取证脚本**，不是构建链；留着当历史 |
| 本地双源（8799 / 8798）双份 `latest.json` | **已验**：`make-latest` 生成后起两个静态源，读回的 `version`/`signature` 与 `.sig` 一致，下载到的包 sha256 与本地包一致（见 12.9） |
| 完整的"点托盘→确认→被动安装→重启"GUI 流程 | 0.5.0 上未重跑：教室机已经是 0.5.0，降级再升会动真实数据。更新器代码这次没改，0.4.x 的 e2e 记录见 `10-验收实测-A到E.md` §10.5 |

## 12.9 更新链路的机械验证

服务换语言不影响更新器（在壳里），但 `make_latest.py` 也换成了 `classbeat-tools make-latest`，
所以出包后单独验了一遍"双源是否自洽"：

```powershell
classbeat-tools make-latest --bundle ...\bundle\nsis --version 0.5.0 `
  --base-url http://127.0.0.1:8799 --out dist\local-test\github\latest.json
classbeat-tools make-latest --bundle ...\bundle\nsis --version 0.5.0 `
  --base-url http://127.0.0.1:8798 --out dist\local-test\accelerated\latest.json
# 两个源各起一个静态服务，然后读 latest.json、比对 signature、下载包算 sha256
```

| 源 | version | signature 与 `.sig` | 下载体积 | sha256 与本地包 |
|---|---|---|---|---|
| 127.0.0.1:8799（对应 GitHub 源） | 0.5.0 | 一致 | 2,552,879 B | 一致 |
| 127.0.0.1:8798（对应加速域名源） | 0.5.0 | 一致 | 2,552,879 B | 一致 |

也就是说"签名、清单、安装包"三者是对得上的——剩下那步（人点"检查更新"）只是把这三样喂给
`tauri-plugin-updater`，那段代码 0.5.0 没动过。

## 12.10 想复现这套对比

```powershell
# 1) 备好两个独立数据目录，各放一份 sample/ 数据
# 2) A 侧（Python）
$env:CLASSBEAT_DATA_DIR = "$env:TEMP\eq-a"
python server\rhythm_server.py --port 8781

# 3) B 侧（Rust）
$env:CLASSBEAT_DATA_DIR = "$env:TEMP\eq-b"
desktop\server-rs\target\release\classbeat-server.exe --port 8782 --base desktop\src-tauri\resources

# 4) 对每个端点各打一次，抓 状态码 + 头 + body，归一化时间戳后比较
```

注意两点：B 侧要用 `--base` 指到装配后的资源目录（`stage` 的产物），否则静态文件 404；
两侧的 `messages.json` 起点必须一样，否则 `recent` 的差异是数据造成的、不是实现造成的。

## 12.11 回滚方案

`server/rhythm_server.py` 与 `server/updater.py` **从未改动**，它们在仓库里就是可运行的原件。
真要退回 0.4.x 形态，需要三步（半天工作量，不是改一个开关）：

1. `git revert` 掉 0.5.0 那次对 `tools-rs/src/stage.rs` 的替换，恢复 `scripts/stage_resources.py`
   与 `resources/python/` 的装配逻辑（`git log` 里还在）；
2. `src-tauri/src/config.rs` 的 `server_exe()` 换回 `pythonw()`，`server.rs` 的启动参数换回脚本路径；
3. 去掉 `hooks.nsh` 里的 `RMDir /r "$INSTDIR\resources\python"`，否则装完服务启动不了。

**数据层不需要迁移**：`%LOCALAPPDATA%\ClassBeat\data` 下的 `messages.json`、`backups/`、`net.json`
格式前后一致，两个方向都能直接读——这也是当初坚持"照抄 `os.path.abspath`"换来的好处。
