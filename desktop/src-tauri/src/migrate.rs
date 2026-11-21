//! 旧版数据接管。
//!
//! 0.3.x 是"程序与数据同目录"（%LOCALAPPDATA%\ClassBeat\{app,data,backups}）。
//! 新壳把数据搬到 %APPDATA%\ClassBeat，安装器会先搬一遍（installer/hooks.nsh）；
//! 这里是第二道保险：万一安装器被跳过（绿色版、手动覆盖装），
//! 首次运行也能把老师的班级数据接过来——只复制，绝不覆盖、绝不删除。

use std::path::Path;

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
    if !detect_legacy(&paths) {
        return;
    }
    let report = migrate(&paths);
    if report.copied > 0 {
        logging::info(&format!(
            "从旧版接管了 {} 项数据（来源 {}）",
            report.copied,
            paths.legacy.display()
        ));
    }
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
