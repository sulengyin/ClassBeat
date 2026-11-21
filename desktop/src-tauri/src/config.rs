//! 路径与常量。
//!
//! 一条硬规矩：**程序目录只读，可写数据全部落在 %APPDATA%\ClassBeat**。
//! 这样 perMachine 装进 Program Files 也能跑，卸载时删程序目录不会碰老师的数据。

use std::path::{Path, PathBuf};

/// 托盘、注册表、快捷方式里显示的产品名。
pub const APP_NAME: &str = "ClassBeat";
/// 大屏窗口标题。**必须包含「班级节律屏」**：页面上的「最小化 / 退出大屏」
/// 走的是 server/rhythm_server.py 的窗口枚举（按标题认窗口），壳把标题定死，
/// 那条链路就能原样继续工作，前端一个字都不用改。
pub const KIOSK_TITLE: &str = "班级节律屏";

pub const DEFAULT_PORT: u16 = 8765;
pub const PORT_SPAN: u16 = 10;

/// 退出标记：页面点「退出大屏」时由服务写下，壳看到它才真退出；
/// 没有它就把关窗当成误触，收进托盘。见 docs/04-服务适配契约.md §4.6。
pub const EXIT_FLAG: &str = "exit-request.flag";

#[derive(Clone, Debug)]
pub struct Paths {
    /// 含 `app/` 与 `server/` 的目录（打包后在 resources 里）
    pub install_root: PathBuf,
    /// %APPDATA%\ClassBeat
    pub data: PathBuf,
    pub logs: PathBuf,
    /// 0.3.x 旧安装：%LOCALAPPDATA%\ClassBeat（程序与数据同目录那一版）
    pub legacy: PathBuf,
}

impl Paths {
    pub fn discover(resource_dir: &Path) -> Self {
        let install_root = find_install_root(resource_dir);
        let mut data = env_path("APPDATA")
            .unwrap_or_else(|| install_root.clone())
            .join(APP_NAME);
        if let Ok(v) = std::env::var("CLASSBEAT_DATA_DIR") {
            let t = v.trim();
            if !t.is_empty() {
                data = PathBuf::from(t);
            }
        }
        let logs = data.join("logs");
        let legacy = env_path("LOCALAPPDATA")
            .unwrap_or_default()
            .join(APP_NAME);
        Paths { install_root, data, logs, legacy }
    }

    pub fn app_dir(&self) -> PathBuf {
        self.install_root.join("app")
    }
    pub fn server_dir(&self) -> PathBuf {
        self.install_root.join("server")
    }
    pub fn pythonw(&self) -> PathBuf {
        self.install_root.join("python").join("pythonw.exe")
    }
    pub fn backups(&self) -> PathBuf {
        self.data.join("backups")
    }
    pub fn exit_flag(&self) -> PathBuf {
        self.data.join(EXIT_FLAG)
    }

    /// 数据目录、日志目录、备份目录一次建好。失败不致命（只记日志），
    /// 因为读多写少的场景下磁盘只读也能把屏开起来。
    pub fn ensure(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.data)?;
        std::fs::create_dir_all(&self.logs)?;
        std::fs::create_dir_all(self.backups().join("config"))?;
        std::fs::create_dir_all(self.backups().join("installers"))?;
        Ok(())
    }
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// Tauri 的 resources 布局可能多一层 `resources/`（取决于打包器版本与配置），
/// 两种都认，别让路径差异变成"装上打不开"。
fn find_install_root(resource_dir: &Path) -> PathBuf {
    let candidates = [resource_dir.to_path_buf(), resource_dir.join("resources")];
    for c in candidates {
        if c.join("app").join("index.html").is_file() && c.join("server").is_dir() {
            return c;
        }
    }
    resource_dir.to_path_buf()
}

/// 8765..8774 里挑一个能绑的端口。挑不到就交回 8765，让服务自己顺延
/// （服务本来就有 10 个端口的顺延逻辑，这里只是尽量别撞）。
pub fn pick_port() -> u16 {
    for offset in 0..PORT_SPAN {
        let port = DEFAULT_PORT + offset;
        if std::net::TcpListener::bind(("0.0.0.0", port)).is_ok() {
            return port;
        }
    }
    DEFAULT_PORT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_port_is_inside_the_expected_window() {
        let p = pick_port();
        assert!(p >= DEFAULT_PORT && p < DEFAULT_PORT + PORT_SPAN);
    }

    #[test]
    fn data_dir_env_override_wins() {
        std::env::set_var("CLASSBEAT_DATA_DIR", "C:\\tmp\\cb-test");
        let p = Paths::discover(Path::new("C:\\nonexistent"));
        assert!(p.data.ends_with("cb-test"));
        std::env::remove_var("CLASSBEAT_DATA_DIR");
    }
}
