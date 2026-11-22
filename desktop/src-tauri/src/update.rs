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
        use super::friendly;

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

    async fn run(app: AppHandle, interactive: bool) -> Result<(), String> {
        // 安装器要覆盖 $INSTDIR 里的服务程序与 resources，而 updater 插件装完是
        // 直接 std::process::exit(0)（绕过 Drop 也绕过我们自己的 shutdown），
        // 所以必须在安装前把服务停掉，否则 NSIS 会卡在"文件正在使用"。
        let app_for_exit = app.clone();
        let updater = app
            .updater_builder()
            .on_before_exit(move || {
                logging::info("更新安装前先停掉本地服务，避免文件占用");
                crate::server::stop(&app_for_exit);
            })
            .build()
            .map_err(|e| format!("更新器不可用：{e}"))?;
        let found = updater.check().await.map_err(|e| e.to_string())?;

        let Some(update) = found else {
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

        // 先落盘再装：backups/installers/ 里留一份，装坏了能人工回滚（06 §E3）。
        // download() 内部做 minisign 验签，签名不对这里就 Err，不会走到安装。
        let bytes = update
            .download(
                |chunk, total| {
                    // 只记到日志：失败时能核对下载量，正常时老师看不到。
                    let _ = (chunk, total);
                },
                || logging::info("更新包下载完成，开始安装"),
            )
            .await
            .map_err(|e| format!("下载或验签失败：{e}"))?;

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
