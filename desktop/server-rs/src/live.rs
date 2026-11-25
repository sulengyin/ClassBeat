//! 配置的唯一权威副本。
//!
//! **为什么要有这个文件**：以前配置只存浏览器 localStorage，而 localStorage 按
//! 「协议 + 主机 + 端口」隔离。大屏是 Tauri 的 WebView2，老师用 Edge / Chrome /
//! 手机打开同一个地址时是另外几份存储——在浏览器里配完，向导看着全对（它读自己
//! 那份），大屏读自己那份，两边永远不相通（2026-11-25 真机反馈）。
//!
//! 现在配置落在服务端一个文件里，所有页面读同一份；客户端手里留一份缓存，
//! 用 `rev` 判断谁新。没有服务（单文件演示版 file://）时仍走 localStorage。
//!
//! 文件形如：
//! ```json
//! { "rev": 7, "updatedAt": "2026-11-25T11:30:00+08:00", "config": { ... } }
//! ```

use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::state::AppState;
use crate::util;

/// 同一进程内的读写串行化：两个页面同时 PUT 时，rev 不能同时加两次。
static LOCK: Mutex<()> = Mutex::new(());

const MAX_REV_SANE: i64 = 1_000_000_000;

fn parse(raw: &str) -> (i64, Option<Value>) {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return (0, None);
    };
    let rev = v.get("rev").and_then(|r| r.as_i64()).unwrap_or(0);
    let cfg = v.get("config").cloned().filter(|c| c.is_object());
    (rev.clamp(0, MAX_REV_SANE), cfg)
}

fn load(path: &Path) -> (i64, Option<Value>) {
    match std::fs::read_to_string(path) {
        Ok(raw) => parse(&raw),
        Err(_) => (0, None),
    }
}

fn store(path: &Path, rev: i64, config: &Value) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = json!({
        "rev": rev,
        "updatedAt": util::iso_seconds(&util::now_bj()),
        "config": config,
    });
    let text = serde_json::to_string(&body).unwrap_or_else(|_| "{}".into());
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text.as_bytes())?;
    std::fs::rename(&tmp, path)
}

/// 读当前版本。返回 (rev, config)；没有文件时 (0, None)。
pub fn read(store_state: &AppState) -> (i64, Option<Value>) {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load(&store_state.paths.config_file)
}

pub enum WriteError {
    /// 客户端手里的版本已经过时：服务端有更新的版本，应先把这份拉下去
    Stale(i64, Option<Value>),
    Io(String),
}

/// 写一份新配置。`base_rev` 是客户端读到的版本：
/// - 相等 → 正常写入，rev + 1
/// - 不等 → 拒绝并回传当前版本，避免把别人刚改的东西盖掉
pub fn write(state: &AppState, config: &Value, base_rev: i64) -> Result<i64, WriteError> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (cur, cur_cfg) = load(&state.paths.config_file);
    if base_rev != cur {
        return Err(WriteError::Stale(cur, cur_cfg));
    }
    let next = cur.saturating_add(1);
    store(&state.paths.config_file, next, config).map_err(|e| WriteError::Io(e.to_string()))?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_roundtrip() {
        let (rev, cfg) = parse(r#"{"rev":3,"config":{"meta":{"klass":"五（1）班"}}}"#);
        assert_eq!(rev, 3);
        assert_eq!(cfg.unwrap()["meta"]["klass"], "五（1）班");
    }

    #[test]
    fn parse_rejects_garbage() {
        assert_eq!(parse("not json").0, 0);
        assert!(parse("not json").1.is_none());
        assert!(parse(r#"{"rev":1,"config":null}"#).1.is_none());
    }

    #[test]
    fn parse_clamps_absurd_rev() {
        assert_eq!(parse(r#"{"rev":99999999999,"config":{}}"#).0, MAX_REV_SANE);
        assert_eq!(parse(r#"{"rev":-5,"config":{}}"#).0, 0);
    }
}
