//! 路径、时间与版本读取。全部照 `rhythm_server.py` 的语义来。

use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, FixedOffset, TimeZone};
use sha2::{Digest, Sha256};

/// 教室消息的 at / until 一律按北京时间算，不跟本机时区走。
pub fn beijing() -> FixedOffset {
    FixedOffset::east_opt(8 * 3600).expect("UTC+8 合法")
}

pub fn now_bj() -> DateTime<FixedOffset> {
    chrono::Utc::now().with_timezone(&beijing())
}

/// `isoformat(timespec="seconds")` → `2026-11-22T19:18:03+08:00`
pub fn iso_seconds(t: &DateTime<FixedOffset>) -> String {
    t.format("%Y-%m-%dT%H:%M:%S%:z").to_string()
}

/// `isoformat(timespec="minutes")` → `2026-11-22T19:18+08:00`
pub fn iso_minutes(t: &DateTime<FixedOffset>) -> String {
    t.format("%Y-%m-%dT%H:%M%:z").to_string()
}

/// `%H:%M`
pub fn hhmm(offset_minutes: i64) -> String {
    let t = now_bj() + chrono::Duration::minutes(offset_minutes);
    t.format("%H:%M").to_string()
}

pub fn today() -> String {
    now_bj().format("%Y-%m-%d").to_string()
}

pub fn ms_now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn ts_to_iso_minutes(secs: i64) -> String {
    let t = chrono::Utc
        .timestamp_opt(secs, 0)
        .single()
        .unwrap_or_else(|| chrono::Utc.timestamp_opt(0, 0).unwrap())
        .with_timezone(&beijing());
    iso_minutes(&t)
}

/// `os.path.abspath` 的等价物：绝对化 + normpath（处理 `.` 与 `..`，不解析符号链接）。
///
/// 不能用 `canonicalize`：它会把路径变成 `\\?\C:\...` 并解析 8.3 短名，
/// 而 home_id 是对这个字符串取哈希——一变，新旧两版就对不上同一份安装了。
pub fn abspath(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(p)
    };
    normalize(&abs)
}

fn normalize(p: &Path) -> PathBuf {
    let mut out: Vec<Component> = Vec::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // 根目录之上再 `..` 就停在根，和 normpath 一致
                if matches!(out.last(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other),
        }
    }
    let mut buf = PathBuf::new();
    for c in out {
        buf.push(c.as_os_str());
    }
    if buf.as_os_str().is_empty() {
        buf.push(".");
    }
    buf
}

/// 这份安装的身份证：路径小写、反斜杠统一成 `/`，取 sha256 前 8 位。
/// 与 Python 版逐字一致，否则 ping 里的 home 变了，壳会认不出自己。
pub fn home_id(base: &Path) -> String {
    let s = abspath(base)
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase();
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let hex = format!("{:x}", h.finalize());
    hex[..8].to_string()
}

/// 从 `app/version.js` 里抠 VERSION / BUILD，读不到就当空串。
pub fn read_app_version(version_file: &Path) -> (String, String) {
    let src = match std::fs::read_to_string(version_file) {
        Ok(s) => s,
        Err(_) => return (String::new(), String::new()),
    };
    (grab(&src, "VERSION"), grab(&src, "BUILD"))
}

/// 对应 `re.search(name + r'\s*=\s*"([^"]{1,40})"', src)`
fn grab(src: &str, name: &str) -> String {
    let mut from = 0usize;
    while let Some(pos) = src[from..].find(name) {
        let start = from + pos + name.len();
        // 名字后面必须是空白或等号，避免 BUILD 命中别的标识符
        let rest = &src[start..];
        let mut chars = rest.char_indices().peekable();
        let mut ok = true;
        let mut eq_at: Option<usize> = None;
        for (i, c) in chars.by_ref() {
            if c.is_whitespace() {
                continue;
            }
            if c == '=' {
                eq_at = Some(i + 1);
            } else {
                ok = false;
            }
            break;
        }
        if ok {
            if let Some(eq) = eq_at {
                let after = &rest[eq..];
                let after = after.trim_start();
                if let Some(stripped) = after.strip_prefix('"') {
                    if let Some(end) = stripped.find('"') {
                        let val = &stripped[..end];
                        if !val.is_empty() && val.chars().count() <= 40 {
                            return val.to_string();
                        }
                    }
                }
            }
        }
        from = start;
    }
    String::new()
}

/// 班级名从数据里读：先 data/，再 sample/，都没有就退到中性值。
pub fn detect_class(root: &Path) -> String {
    for folder in ["data", "sample"] {
        let path = root.join(folder).join("schedule.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(name) = obj.get("class").and_then(|v| v.as_str()) {
                    if !name.is_empty() {
                        return name.to_string();
                    }
                }
            }
        }
    }
    "班级".to_string()
}

/// 局域网地址：连一个外部地址看本机用了哪块网卡（UDP connect 不发包）。
/// 失败就是回环——这时手机连不上，启动日志会明说。
pub fn lan_ip() -> String {
    match std::net::UdpSocket::bind("0.0.0.0:0") {
        Ok(sock) => {
            if sock.connect("8.8.8.8:80").is_ok() {
                if let Ok(addr) = sock.local_addr() {
                    let ip = addr.ip().to_string();
                    if !ip.is_empty() {
                        return ip;
                    }
                }
            }
            "127.0.0.1".to_string()
        }
        Err(_) => "127.0.0.1".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_handles_dotdot() {
        assert_eq!(
            normalize(Path::new(r"C:\a\b\..\c\.\d")),
            PathBuf::from(r"C:\a\c\d")
        );
    }

    #[test]
    fn home_id_is_stable_and_short() {
        let a = home_id(Path::new(r"C:\Users\hello\App\resources\server"));
        let b = home_id(Path::new("c:/USERS/hello/App/resources/server"));
        assert_eq!(a, b);
        assert_eq!(a.len(), 8);
    }

    #[test]
    fn grab_version_from_js() {
        let src = "var VERSION = \"0.4.2\";\nvar BUILD = \"abc1234\";";
        assert_eq!(grab(src, "VERSION"), "0.4.2");
        assert_eq!(grab(src, "BUILD"), "abc1234");
    }

    #[test]
    fn iso_formats_match_python() {
        let t = beijing()
            .with_ymd_and_hms(2026, 11, 22, 19, 18, 3)
            .unwrap();
        assert_eq!(iso_seconds(&t), "2026-11-22T19:18:03+08:00");
        assert_eq!(iso_minutes(&t), "2026-11-22T19:18+08:00");
    }
}
