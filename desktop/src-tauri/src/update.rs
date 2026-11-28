//! 更新：由签名更新器负责（不再用 Python 那套替换文件的方案）。
//!
//! 为什么换：壳装进 Program Files 后程序目录不可写，Python 那套"下载 zip 覆盖文件"
//! 在这儿会失败；而且它不认识 classbeat.exe，两套更新器一起跑必然版本错位。
//! 于是口径统一成一条：
//!   - **程序**（exe + resources）= 壳的更新器，签名校验 + NSIS 被动安装；
//!   - **数据**（班级配置、消息、备份）= 永不参与更新。
//! 页面上的「更新」面板会被服务告知 `selfUpdate: false` 并显示一句说明，
//! 老师改用托盘「检查更新」或 Ctrl+Alt+U，能力没有丢（见 docs/04-服务适配契约.md §4.4）。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

static BUSY: AtomicBool = AtomicBool::new(false);

pub fn is_busy() -> bool {
    BUSY.load(Ordering::SeqCst)
}

pub fn check_interactive(app: &AppHandle) {
    #[cfg(feature = "updater")]
    {
        imp::check(app, true);
    }
    #[cfg(not(feature = "updater"))]
    {
        let _ = app;
        crate::ui::info(
            "更新未启用",
            "这一版构建没有带更新器（Cargo 里 --no-default-features）。\n请到下载页获取新版。",
        );
    }
}

/// 启动后延迟若干秒静默查一次：只写日志，不打扰老师。
#[allow(dead_code)]
pub fn check_quiet_after(app: AppHandle, secs: u64) {
    #[cfg(feature = "updater")]
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(secs));
        imp::check(&app, false);
    });
    #[cfg(not(feature = "updater"))]
    {
        let _ = (app, secs);
    }
}

#[cfg(feature = "updater")]
mod imp {
    use super::BUSY;
    use crate::{logging, ui};
    use std::sync::atomic::Ordering;
    use tauri::AppHandle;
    use tauri_plugin_updater::UpdaterExt;

    /// 把更新器的原始错误折成一句老师能看懂的话；原文只进日志。
    ///
    /// 起因：验收 E4 时「更新源不可达」弹出的框里是
    /// `error sending request for url (https://...)`——老师看不懂，也不知道
    /// 大屏还能不能用。这里按错误形态给结论，并在末尾保留一小段原文方便对日志。
    fn friendly(msg: &str) -> String {
        let low = msg.to_lowercase();
        let (head, tail) = if low.contains("sending request")
            || low.contains("connect")
            || low.contains("dns")
            || low.contains("timed out")
            || low.contains("timeout")
        {
            (
                "连不上更新服务器：这台机器可能没联网，或者学校网络不允许访问外网。",
                "大屏可以照常用，等网络好了再按 Ctrl+Alt+U 试一次。",
            )
        } else if low.contains("signature") || low.contains("verify") || low.contains("minisign") {
            (
                "更新包校验没通过，这次更新已经取消，不会装上来路不明的文件。",
                "如果反复出现，请把日志发给维护的人。",
            )
        } else if low.contains("os error") || low.contains("denied") || low.contains("permission") {
            (
                "没有权限改程序目录，更新没装成。",
                "请联系管理员，或用管理员身份重装一次。",
            )
        } else {
            ("更新没成功。", "大屏可以照常用。")
        };
        format!("{head}\n\n{tail}\n\n技术细节：{}", clip(msg, 200))
    }

    fn clip(s: &str, n: usize) -> String {
        let mut out: String = s.chars().take(n).collect();
        if s.chars().count() > n {
            out.push('…');
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::{
            build_download_urls, build_endpoint_urls, friendly, parse_prefixes, DEFAULT_PREFIXES,
            MANIFEST_URL,
        };

        #[test]
        fn network_error_is_explained_in_chinese() {
            let raw = "error sending request for url (https://classbeat.example.com/update/latest.json)";
            let msg = friendly(raw);
            assert!(msg.starts_with("连不上更新服务器"), "{msg}");
            assert!(msg.contains("大屏可以照常用"), "{msg}");
            assert!(msg.contains("技术细节：error sending request"), "{msg}");
        }

        #[test]
        fn unknown_error_still_says_what_to_expect() {
            let msg = friendly("something odd happened");
            assert!(msg.starts_with("更新没成功。"), "{msg}");
            assert!(msg.contains("大屏可以照常用。"), "{msg}");
        }

        #[test]
        fn long_detail_is_clipped_on_char_boundary() {
            let raw = "坏".repeat(500);
            let msg = friendly(&raw);
            assert!(msg.ends_with('…'), "应当截断");
            assert!(msg.chars().count() < 300, "{}", msg.chars().count());
        }

        // 加速域名不可回退：0.5.3 曾把加速域名弄丢、写死回 GitHub，
        // 导致教室大屏连不上更新服务器。下面这组测试钉住"加速域名优先 +
        // GitHub 兜底"，谁再把 endpoints 改回纯 GitHub 就会红。
        #[test]
        fn endpoints_put_accelerated_mirror_first_and_github_last() {
            let urls = build_endpoint_urls(&DEFAULT_PREFIXES.iter().map(|s| s.to_string()).collect::<Vec<_>>());
            assert!(urls.len() >= 2, "必须是双源以上，不能只剩 GitHub：{urls:?}");
            assert_eq!(urls.last().unwrap(), MANIFEST_URL, "GitHub 原地址必须兜底在最后");
            assert!(
                urls[..urls.len() - 1]
                    .iter()
                    .all(|u| u.contains("ghfast.top") || u.contains("gh-proxy.com") || u.contains("ghproxy.net")),
                "清单来源必须是国内加速域名：{urls:?}"
            );
            // 每个加速地址 = 前缀 + "/" + 原清单地址。必须钉住中间那个 /：
            // 少了它会拼成 https://ghfast.tophttps://github.com/...，Url 解析
            // 仍成功、ends_with 也成立，但主机名错乱、运行时全部连不上。
            for u in &urls[..urls.len() - 1] {
                assert!(u.ends_with(&format!("/{MANIFEST_URL}")), "前缀和清单之间缺 /：{u}");
                assert!(u.contains("top/https://github.com") || u.contains("com/https://github.com") || u.contains("net/https://github.com"), "主机名与路径没分开：{u}");
            }
        }

        #[test]
        fn parse_prefixes_strips_comments_and_adds_slash() {
            let text = "# 国内加速域名\nghfast.top   # 主\nhttps://gh-proxy.com\n\n  ghproxy.net  \n";
            let got = parse_prefixes(text);
            assert_eq!(got, vec!["ghfast.top/", "https://gh-proxy.com/", "ghproxy.net/"]);
        }

        #[test]
        fn accelerated_endpoint_urls_are_valid_https() {
            // 加速地址形如 https://ghfast.top/https://github.com/... ：
            // 里面的 github 是 path 的一部分，不是 scheme。必须能被 Url 解析
            // 且 scheme=https，否则 release 构建的 endpoints 校验会失败。
            let urls = build_endpoint_urls(&DEFAULT_PREFIXES.iter().map(|s| s.to_string()).collect::<Vec<_>>());
            for u in urls {
                let parsed = url::Url::parse(&u).unwrap_or_else(|e| panic!("解析失败 {u}: {e}"));
                assert_eq!(parsed.scheme(), "https", "{u}");
            }
        }

        // 下载源必须跟着配置前缀换，不能只认清单里写死的那个（0.5.17 的单点）。
        // 清单从备用域名拿到、包却去主域名下载时，主域名挂了就更新失败。
        #[test]
        fn download_urls_follow_every_configured_prefix() {
            let manifest = "https://ghfast.top/https://github.com/sulengyin/ClassBeat/releases/download/v0.5.17/ClassBeat_0.5.17_x64-setup.exe";
            let prefixes: Vec<String> = vec![
                "https://ghfast.top/".into(),
                "https://gh-proxy.com".into(),
                "https://ghproxy.net/".into(),
            ];
            let got = build_download_urls(manifest, &prefixes);
            let urls: Vec<&str> = got.iter().map(|(u, _)| u.as_str()).collect();
            assert_eq!(urls.len(), 4, "三个前缀 + GitHub 原地址：{urls:?}");
            // 每一项都指向同一个 GitHub 原路径，只是前缀不同
            for u in &urls {
                assert!(u.contains("https://github.com/sulengyin/ClassBeat/releases/download/v0.5.17/ClassBeat_0.5.17_x64-setup.exe"), "{u}");
            }
            // 备用域名确实在候选里——这是修复的核心
            assert!(urls[1].starts_with("https://gh-proxy.com/"), "{urls:?}");
            assert!(urls[2].starts_with("https://ghproxy.net/"), "{urls:?}");
            // GitHub 原地址兜底在最后
            assert_eq!(urls[3], "https://github.com/sulengyin/ClassBeat/releases/download/v0.5.17/ClassBeat_0.5.17_x64-setup.exe");
            // 标签是人能看懂的域名，便于日志定位
            assert_eq!(got[0].1, "https://ghfast.top");
        }

        #[test]
        fn download_urls_handle_bare_github_manifest() {
            // 清单里 url 本来就是 GitHub 原地址（没加速前缀）时也要能换源
            let bare = "https://github.com/sulengyin/ClassBeat/releases/download/v0.5.17/x.exe";
            let prefixes: Vec<String> = vec!["https://ghfast.top/".into()];
            let got = build_download_urls(bare, &prefixes);
            assert_eq!(got.len(), 2, "{got:?}");
            assert_eq!(got[0].0, "https://ghfast.top/https://github.com/sulengyin/ClassBeat/releases/download/v0.5.17/x.exe");
            assert_eq!(got[1].0, bare);
        }

        #[test]
        fn download_urls_deduplicate_and_reject_unknown_origin() {
            let prefixes: Vec<String> = vec!["https://github.com/".into(), "https://github.com".into()];
            let bare = "https://github.com/o/r/releases/download/v1/x.exe";
            let got = build_download_urls(bare, &prefixes);
            // 两个 GitHub 前缀 trim 后相同，去重成一条；再加 GitHub 原地址兜底 = 2
            assert_eq!(got.len(), 2, "重复前缀必须去重：{got:?}");
            // 没有 GitHub 起点：返回空，绝不拿来历不明的 URL 去下载
            assert!(build_download_urls("https://evil.example/pkg.exe", &prefixes).is_empty());
        }
    }

    pub fn check(app: &AppHandle, interactive: bool) {
        if BUSY.swap(true, Ordering::SeqCst) {
            if interactive {
                ui::info("正在更新", "上一次检查或安装还没结束，稍等一下。");
            }
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = run(app, interactive).await;
            BUSY.store(false, Ordering::SeqCst);
            if let Err(e) = outcome {
                logging::warn(&format!("检查更新失败：{e}"));
                if interactive {
                    // 弹给老师看的必须是中文。原始错误（reqwest 的
                    // "error sending request for url (...)"）只留在日志里，
                    // 框里给一句人话 + 括号里保留一小段原文，方便对日志。
                    ui::warn("检查更新失败", &friendly(&e));
                }
            }
        });
    }

    // ---- 更新源：国内加速域名优先 + GitHub 原地址兜底 ------------------
    //
    // 教室一体机不允许直连 GitHub。清单和安装包都必须走国内可访问的
    // 加速域名（ghfast.top / gh-proxy.com / ghproxy.net 这类前缀代理）。
    //
    // 历史教训：0.3.x 就已用加速域名跑通更新（v0.3.4 起），但 0.5.3
    // 换成 Tauri 更新器时把加速域名弄丢了，endpoints 写死回 GitHub，
    // 教室大屏从此连不上更新服务器。这次恢复时把配置从程序里挪到
    // 数据目录的 update-source.txt：改加速域名只改这一行，不用重发版。
    //
    // 格式（每行一个，# 开头为注释）：
    //   # 国内加速域名前缀，末尾带 /
    //   https://ghfast.top/
    //   https://gh-proxy.com/
    const UPDATE_SOURCE_FILE: &str = "update-source.txt";
    const DEFAULT_PREFIXES: &[&str] = &[
        "https://ghfast.top/",
        "https://gh-proxy.com/",
        "https://ghproxy.net/",
    ];
    const MANIFEST_URL: &str =
        "https://github.com/sulengyin/ClassBeat/releases/latest/download/latest.json";

    /// 把 update-source.txt 的文本解析成加速域名前缀列表（纯函数，便于测试）。
    /// 每行 strip 注释与空白，末尾补 /；空文件返回空列表（调用方再填默认值）。
    fn parse_prefixes(text: &str) -> Vec<String> {
        let mut out = Vec::new();
        for line in text.lines() {
            let line = line.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let p = if line.ends_with('/') {
                line.to_string()
            } else {
                format!("{line}/")
            };
            if !out.contains(&p) {
                out.push(p);
            }
        }
        out
    }

    /// 读加速域名前缀。优先级：老师可改的 %APPDATA%\ClassBeat\update-source.txt
    /// → 包内只读的 resources/update-source.txt → 内置默认列表。
    fn load_prefixes(app: &AppHandle) -> Vec<String> {
        use tauri::Manager;
        let (data, install_root) = match app.try_state::<crate::AppState>() {
            Some(st) => (st.paths.data.clone(), st.paths.install_root.clone()),
            None => return DEFAULT_PREFIXES.iter().map(|s| s.to_string()).collect(),
        };
        // 先读可写数据目录（老师改过的），再读包内默认
        for path in [data.join(UPDATE_SOURCE_FILE), install_root.join(UPDATE_SOURCE_FILE)] {
            if let Ok(text) = std::fs::read_to_string(&path) {
                let got = parse_prefixes(&text);
                if !got.is_empty() {
                    logging::info(&format!("更新源前缀来自 {}", path.display()));
                    return got;
                }
            }
        }
        DEFAULT_PREFIXES.iter().map(|s| s.to_string()).collect()
    }

    /// 构造更新源地址列表（纯函数，便于测试）：每个加速域名拼清单地址在前，
    /// GitHub 原地址最后兜底。updater 插件按顺序试，第一个返回有效清单的胜出
    /// （插件源码 updater.rs::check 已确认）。
    fn build_endpoint_urls(prefixes: &[String]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for prefix in prefixes {
            // 前缀末尾去斜杠、清单以 https:// 开头，中间必须补一个 /，
            // 否则拼成 https://ghfast.tophttps://github.com/...（主机名错乱，
            // 运行时 endpoints 全部连不上）。2026-11-28 实测抓到这个拼接错误。
            let raw = format!("{}/{}", prefix.trim_end_matches('/'), MANIFEST_URL);
            if !out.contains(&raw) {
                out.push(raw);
            }
        }
        // GitHub 原地址兜底：加速域名全挂、且学校临时放行 GitHub 时仍可更新
        if !out.contains(&MANIFEST_URL.to_string()) {
            out.push(MANIFEST_URL.to_string());
        }
        out
    }

    fn build_endpoints(app: &AppHandle) -> Result<Vec<String>, String> {
        let urls = build_endpoint_urls(&load_prefixes(app));
        if urls.is_empty() {
            return Err("没有可用的更新源".into());
        }
        Ok(urls)
    }

    /// GitHub 原地址在加速 URL 里的固定起点。清单里的 `url` 不论有没有
    /// 加速前缀，都包含这一段（前缀只是拼在完整 GitHub 地址前面）。
    const GITHUB_ORIGIN: &str = "https://github.com/";

    /// 把清单给出的下载 URL 拆成「按配置前缀换源后的候选列表 + 标签」。
    ///
    /// 清单里的 `url` 形如 `https://ghfast.top/https://github.com/o/r/.../x.exe`
    /// 或干脆就是 `https://github.com/o/r/.../x.exe`。两种都从 GITHUB_ORIGIN
    /// 起截取原路径，再对每个加速前缀拼一份；GitHub 原地址放最后兜底。
    /// 找不到 GitHub 起点（异常清单）时返回空列表，调用方按「全部失败」处理，
    /// 不会拿一个来历不明的 URL 去下载。
    fn build_download_urls(download_url: &str, prefixes: &[String]) -> Vec<(String, String)> {
        let Some(at) = download_url.find(GITHUB_ORIGIN) else {
            return Vec::new();
        };
        let origin = &download_url[at..];
        let mut out: Vec<(String, String)> = Vec::new();
        for prefix in prefixes {
            let p = prefix.trim_end_matches('/');
            let candidate = format!("{p}/{origin}");
            if !out.iter().any(|(u, _)| u == &candidate) {
                out.push((candidate, p.to_string()));
            }
        }
        // GitHub 原地址兜底；也可能前缀里本来就含 GitHub，去重。
        if !out.iter().any(|(u, _)| u == origin) {
            out.push((origin.to_string(), "GitHub 原地址".to_string()));
        }
        out
    }

    async fn run(app: AppHandle, interactive: bool) -> Result<(), String> {
        // 安装器要覆盖 $INSTDIR 里的服务程序与 resources，而 updater 插件装完是
        // 直接 std::process::exit(0)（绕过 Drop 也绕过我们自己的 shutdown），
        // 所以必须在安装前把服务停掉，否则 NSIS 会卡在"文件正在使用"。
        let app_for_exit = app.clone();
        let endpoint_strings = build_endpoints(&app)?;
        logging::info(&format!("更新源（按序）：{}", endpoint_strings.join(" | ")));
        let endpoints: Vec<url::Url> = endpoint_strings
            .iter()
            .filter_map(|s| match url::Url::parse(s) {
                Ok(u) => Some(u),
                Err(e) => {
                    logging::warn(&format!("忽略无效更新源 {s}：{e}"));
                    None
                }
            })
            .collect();
        if endpoints.is_empty() {
            return Err("没有可用的更新源地址".into());
        }
        let updater = app
            .updater_builder()
            .endpoints(endpoints)
            .map_err(|e| format!("更新源地址无效：{e}"))?
            .on_before_exit(move || {
                logging::info("更新安装前先停掉本地服务，避免文件占用");
                crate::server::stop(&app_for_exit);
            })
            .build()
            .map_err(|e| format!("更新器不可用：{e}"))?;
        let found = updater.check().await.map_err(|e| e.to_string())?;

        let Some(mut update) = found else {
            if interactive {
                ui::info("检查更新", "已经是最新版。");
            }
            return Ok(());
        };

        let version = update.version.clone();
        logging::info(&format!("发现新版本 {version}"));
        if !interactive {
            return Ok(());
        }

        let notes = update.body.clone().unwrap_or_default();
        let detail = if notes.trim().is_empty() {
            "（这一版没有写更新说明）".to_string()
        } else {
            notes
        };
        let question = format!(
            "新版本：{version}\n\n{detail}\n\n现在下载并安装吗？装完 ClassBeat 会自己重启，班级数据不受影响。"
        );
        if !ui::confirm("发现新版本", &question) {
            return Ok(());
        }

        // 下载源逐个试：插件 check() 只按 endpoints 顺序拿清单，
        // 下载时用的却是 latest.json 里写死的 URL（updater.rs::download）。
        // 于是清单从备用域名拿到、包却仍去主域名下载时就会失败。这里从
        // 清单给出的下载地址里剥出 GitHub 原路径，按配置的前缀逐个换源，
        // GitHub 原地址放最后兜底，试到成功为止。每次 download() 内部都
        // 做 minisign 验签，换源不会绕过验签。
        let download_candidates = build_download_urls(update.download_url.as_str(), &load_prefixes(&app));
        let mut last_err = String::new();
        let mut bytes = None;
        for (candidate, label) in download_candidates {
            let Ok(parsed) = url::Url::parse(&candidate) else {
                last_err = format!("下载源地址无效：{candidate}");
                continue;
            };
            update.download_url = parsed;
            match update
                .download(
                    |_chunk, _total| {},
                    || logging::info("更新包下载完成，开始安装"),
                )
                .await
            {
                Ok(b) => {
                    logging::info(&format!("更新包来自 {label}"));
                    bytes = Some(b);
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    logging::warn(&format!("下载源 {label} 不可用，换下一个：{last_err}"));
                }
            }
        }
        // 先落盘再装：backups/installers/ 里留一份，装坏了能人工回滚（06 §E3）。
        let bytes = bytes.ok_or_else(|| format!("所有下载源都失败：{last_err}"))?;

        let kept = keep_installer(&app, &version, &bytes);
        logging::info(&format!(
            "更新包 {} 字节，已留底：{}",
            bytes.len(),
            kept.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "（留底失败，继续安装）".into())
        ));

        // install() 在 Windows 上是"起安装器然后 std::process::exit(0)"，
        // 不会返回 —— 所以这句日志必须写在它前面，写在后面就等于没写。
        logging::info("更新已交给安装器，ClassBeat 即将重启");
        update
            .install(&bytes)
            .map_err(|e| format!("安装失败：{e}"))?;
        Ok(())
    }

    /// 把安装包存进 `%APPDATA%\ClassBeat\backups\installers\`。
    /// 版本号要洗一遍再用作文件名（它来自 latest.json，属于远端数据）。
    fn keep_installer(app: &AppHandle, version: &str, bytes: &[u8]) -> Option<std::path::PathBuf> {
        use tauri::Manager;
        let st = app.state::<crate::AppState>();
        let dir = st.paths.data.join("backups").join("installers");
        std::fs::create_dir_all(&dir).ok()?;
        let safe: String = version
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            .take(24)
            .collect();
        let name = if safe.is_empty() {
            "ClassBeat_unknown".to_string()
        } else {
            format!("ClassBeat_{safe}_x64-setup.exe")
        };
        let path = dir.join(name);
        std::fs::write(&path, bytes).ok()?;
        Some(path)
    }
}
