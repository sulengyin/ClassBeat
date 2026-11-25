//! 运行期状态：路径、班级、消息、地址、更新。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::util;

/// 与 Python 版逐项对应的路径。
pub struct Paths {
    /// `server/` 目录（服务程序所在处）
    pub base: PathBuf,
    /// `server/..`，包根
    pub install_root: PathBuf,
    /// `server/../app`
    pub app_dir: PathBuf,
    /// `%APPDATA%\ClassBeat`，没有则为空
    pub data_home: PathBuf,
    pub msg_file: PathBuf,
    pub net_file: PathBuf,
    pub log_file: PathBuf,
    pub phone_file: PathBuf,
    pub backup_dir: PathBuf,
    pub exit_flag: PathBuf,
    /// 配置的唯一权威副本：大屏、浏览器、手机读写的都是这一份
    pub config_file: PathBuf,
}

impl Paths {
    pub fn resolve(base: &Path) -> Paths {
        let base = util::abspath(base);
        let install_root = base
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| base.clone());
        let app_dir = install_root.join("app");
        let data_home = std::env::var("CLASSBEAT_DATA_DIR")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(|s| util::abspath(Path::new(&s)))
            .unwrap_or_default();
        let pick = |name: &str| {
            if data_home.as_os_str().is_empty() {
                base.join(name)
            } else {
                let _ = std::fs::create_dir_all(&data_home);
                data_home.join(name)
            }
        };
        let backup_dir = if data_home.as_os_str().is_empty() {
            install_root.join("backups").join("config")
        } else {
            data_home.join("backups").join("config")
        };
        Paths {
            msg_file: pick("messages.json"),
            net_file: pick("net.json"),
            log_file: pick("server.log"),
            phone_file: base.join("phone.html"),
            exit_flag: pick("exit-request.flag"),
            config_file: pick("config.json"),
            backup_dir,
            base,
            install_root,
            app_dir,
            data_home,
        }
    }

    pub fn version_file(&self) -> PathBuf {
        self.app_dir.join("version.js")
    }

    /// 数据写在 `%APPDATA%` 时不建目录也能跑（保存时才建），这里只做尽力而为。
    pub fn ensure(&self) {
        if !self.data_home.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(&self.data_home);
        }
    }
}

#[derive(Clone)]
pub struct Conf {
    pub port: u16,
    pub klass: String,
    pub lan: String,
}

pub struct MsgStore {
    pub messages: Vec<Value>,
    pub seq: i64,
}

#[derive(Default)]
pub struct Addr {
    pub seen: String,
    pub changed: bool,
    pub last: String,
}

pub struct UpdateInfo {
    pub url: String,
    pub interval: i64,
    pub checked_at: String,
    pub latest: String,
    pub available: bool,
}

pub struct VersionInfo {
    pub version: String,
    pub build: String,
    pub started_at: String,
}

pub struct AppState {
    pub paths: Paths,
    /// 这份安装的身份证（路径哈希前 8 位），与 Python 版同算法。
    pub home_id: String,
    /// 安装包版本（`resources/build-info.json` 里的 version）。
    /// 和 `version.js` 的网页版本不是一回事：桌面版要露的是这个号。
    pub package: String,
    /// 桌面壳模式。Rust 服务本身就是壳的一部分，恒为 true，
    /// 保留这个字段是为了让 `/api/ping` 的 `shell` 键与前端契约不变。
    pub shell: bool,
    pub conf: Mutex<Conf>,
    pub msgs: Mutex<MsgStore>,
    /// 新消息唤醒 SSE；容量小，满了丢通知也不影响正确性（SSE 会自己比对 seq）。
    pub notify: broadcast::Sender<()>,
    pub addr: Mutex<Addr>,
    pub update: Mutex<UpdateInfo>,
    pub remote_result: Mutex<Value>,
    pub version: Mutex<Option<VersionInfo>>,
    pub restarting: AtomicBool,
    pub stopping: AtomicBool,
}

impl AppState {
    pub fn new(paths: Paths) -> AppState {
        let (tx, _rx) = broadcast::channel(16);
        let home_id = util::home_id(&paths.base);
        let package = read_package_version(&paths.install_root);
        AppState {
            paths,
            home_id,
            package,
            shell: true,
            conf: Mutex::new(Conf {
                port: 0,
                klass: String::new(),
                lan: String::new(),
            }),
            msgs: Mutex::new(MsgStore {
                messages: Vec::new(),
                seq: 0,
            }),
            notify: tx,
            addr: Mutex::new(Addr::default()),
            update: Mutex::new(UpdateInfo {
                url: String::new(),
                interval: 1800,
                checked_at: String::new(),
                latest: String::new(),
                available: false,
            }),
            remote_result: Mutex::new(json!({"ok": Value::Null, "why": "", "at": ""})),
            version: Mutex::new(None),
            restarting: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
        }
    }

    /// 惰性读一次 version.js 并缓存；启动时间也在第一次拿到版本时记下。
    pub fn app_version(&self) -> VersionInfo {
        let mut slot = self.version.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            let (version, build) = util::read_app_version(&self.paths.version_file());
            *slot = Some(VersionInfo {
                version,
                build,
                started_at: util::iso_seconds(&util::now_bj()),
            });
        }
        let v = slot.as_ref().unwrap();
        VersionInfo {
            version: v.version.clone(),
            build: v.build.clone(),
            started_at: v.started_at.clone(),
        }
    }

    #[allow(dead_code)]
    /// 更新或回滚后重读磁盘上的 version.js（Rust 版没有程序内更新，
    /// 保留是为了与 Python 版接口一致）。
    pub fn refresh_version(&self) {
        let (version, build) = util::read_app_version(&self.paths.version_file());
        if version.is_empty() {
            return;
        }
        let mut slot = self.version.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(v) = slot.as_mut() {
            v.version = version;
            v.build = build;
        } else {
            *slot = Some(VersionInfo {
                version,
                build,
                started_at: util::iso_seconds(&util::now_bj()),
            });
        }
    }

    pub fn conf_snapshot(&self) -> Conf {
        self.conf.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn log(&self, msg: &str) {
        let line = format!("[{}] {}\n", util::iso_seconds(&util::now_bj()), msg);
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.paths.log_file)
        {
            let _ = f.write_all(line.as_bytes());
        }
        eprint!("{}", line);
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }
}

/// 安装包版本：只有桌面版带 `resources/build-info.json`；
/// 解压即用版没有这个文件，返回空串，前端就退回网页版本号。
fn read_package_version(install_root: &Path) -> String {
    let file = install_root.join("build-info.json");
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(|s| s.to_string()))
        .unwrap_or_default()
}
