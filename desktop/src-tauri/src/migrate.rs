//! 旧版数据接管。
//!
//! 0.3.x 是"程序与数据同目录"（%LOCALAPPDATA%\ClassBeat\{app,data,backups}）。
//! 新壳把数据搬到 %APPDATA%\ClassBeat，安装器会先搬一遍（installer/hooks.nsh）；
//! 这里是第二道保险：万一安装器被跳过（绿色版、手动覆盖装），
//! 首次运行也能把老师的班级数据接过来——只复制，绝不覆盖、绝不删除。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::config::Paths;
use crate::logging;
use crate::AppState;

pub struct Report {
    pub copied: u32,
}

/// 旧安装的判断口径要够窄：只有确实存在 0.3.x 的启动器或内置运行时才算。
/// （%LOCALAPPDATA%\ClassBeat 现在只放日志，不能一看到目录就当成旧版）
pub fn detect_legacy(paths: &Paths) -> bool {
    paths.legacy.join("tools").join("launcher").join("watchdog.ps1").is_file()
        || paths.legacy.join("server").join("python").join("python.exe").is_file()
}

pub fn run_at_startup(app: &AppHandle) {
    let paths = app.state::<AppState>().paths.clone();
    if detect_legacy(&paths) {
        let report = migrate(&paths);
        if report.copied > 0 {
            logging::info(&format!(
                "从旧版接管了 {} 项数据（来源 {}）",
                report.copied,
                paths.legacy.display()
            ));
        }
    }
    // WebView2 数据迁移：旧版没设 WEBVIEW2_USER_DATA_FOLDER，localStorage /
    // IndexedDB 落在 exe 同级的默认目录，NSIS 覆盖安装时被清。新版已把它
    // 指到 %APPDATA%\ClassBeat\webview，这里把旧数据搬过来。
    // 必须在 WebView 创建之前做（server::boot 还没起窗口），否则文件被锁。
    migrate_webview_data(&paths);
}

pub fn migrate(paths: &Paths) -> Report {
    let mut copied = 0;
    for name in ["data", "backups", "update-source.txt"] {
        let src = paths.legacy.join(name);
        let dst = paths.data.join(name);
        if !src.exists() || dst.exists() {
            continue; // 新装已经有的，一律以新的为准
        }
        match copy_tree(&src, &dst) {
            Ok(()) => copied += 1,
            Err(e) => logging::warn(&format!("接管 {name} 失败（继续启动）：{e}")),
        }
    }
    Report { copied }
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_file() {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dst)?;
        return Ok(());
    }
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            if is_program_dir(&from) {
                continue; // 程序文件不搬，只搬数据
            }
            copy_tree(&from, &to)?;
        } else {
            let _ = std::fs::copy(&from, &to);
        }
    }
    Ok(())
}

/// 把旧版 WebView2 的数据搬到新目录（%APPDATA%\ClassBeat\webview）。
/// 旧版没设 WEBVIEW2_USER_DATA_FOLDER，WebView2 把数据建在 exe 同级的
/// `{exe_name}.exeWebview` 目录里。新版换目录后那个位置就废弃了——
/// 不搬的话，从 0.5.x 升级上来老师会发现自己的班级、名单全没了。
fn migrate_webview_data(paths: &Paths) {
    let new_dir = paths.data.join("webview");
    // 新目录已有 EBWebView 子目录：已迁移过或有数据，不动。
    if new_dir.join("EBWebView").is_dir() {
        return;
    }
    for src in legacy_webview_candidates(paths) {
        let eb = src.join("EBWebView");
        if !eb.is_dir() {
            continue;
        }
        match copy_tree(&eb, &new_dir.join("EBWebView")) {
            Ok(()) => {
                logging::info(&format!(
                    "迁移 WebView2 数据：{} → {}",
                    src.display(),
                    new_dir.display()
                ));
                return;
            }
            Err(e) => logging::warn(&format!(
                "迁移 WebView2 数据失败（{} → {}）：{e}",
                src.display(),
                new_dir.display()
            )),
        }
    }
    // 找不到旧目录：全新安装，或旧数据已被 NSIS 清掉。
    // 不报错——WebView2 会在新目录建空数据，老师进向导重新配。
}

/// 旧版没设 WEBVIEW2_USER_DATA_FOLDER 时，WebView2 把数据建在几个可能的
/// 位置。不确定具体在哪（取决于安装模式和 Tauri 版本），所以列候选，
/// 找到第一个含 EBWebView 子目录的就用。
fn legacy_webview_candidates(paths: &Paths) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    // WebView2 原生默认：{exe_dir}/{exe_name}.exeWebview
    if let Ok(exe) = std::env::current_exe() {
        if let (Some(dir), Some(stem)) =
            (exe.parent(), exe.file_stem().and_then(|s| s.to_str()))
        {
            out.push(dir.join(format!("{stem}.exeWebview")));
        }
    }
    // Tauri 可能用 identifier（cn.classbeat.app）作目录名，落在 %APPDATA%
    if let Some(appdata) = std::env::var_os("APPDATA") {
        out.push(PathBuf::from(&appdata).join("cn.classbeat.app"));
    }
    // 0.3.x 旧版在 %LOCALAPPDATA%\ClassBeat
    out.push(paths.legacy.join("classbeat.exeWebview"));
    if let Some(localappdata) = std::env::var_os("LOCALAPPDATA") {
        let la = PathBuf::from(localappdata);
        out.push(la.join("Programs").join("ClassBeat").join("classbeat.exeWebview"));
        out.push(la.join("ClassBeat").join("classbeat.exeWebview"));
    }
    out
}

fn is_program_dir(p: &Path) -> bool {
    matches!(
        p.file_name().and_then(|s| s.to_str()).unwrap_or(""),
        "app" | "server" | "tools" | "python"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn copies_only_missing_things() {
        let base = std::env::temp_dir().join("cb-migrate-test");
        let _ = fs::remove_dir_all(&base);
        let legacy = base.join("legacy");
        let data = base.join("data");
        fs::create_dir_all(legacy.join("data")).unwrap();
        fs::create_dir_all(legacy.join("app")).unwrap();
        fs::write(
            legacy.join("data").join("schedule.json"),
            "{\"class\":\"五（1）班\"}".as_bytes(),
        )
        .unwrap();
        fs::write(legacy.join("app").join("index.html"), b"x").unwrap();
        fs::create_dir_all(&data).unwrap();

        let paths = Paths {
            install_root: base.clone(),
            data: data.clone(),
            logs: base.join("logs"),
            legacy: legacy.clone(),
        };
        let r = migrate(&paths);
        assert_eq!(r.copied, 1);
        assert!(data.join("data").join("schedule.json").is_file());
        assert!(!data.join("app").exists(), "程序文件不该被搬过来");
    }
}
