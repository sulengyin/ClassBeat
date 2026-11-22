//! 配置快照、手机端待应用配置、局域网地址记忆。

use std::path::PathBuf;

use serde_json::{json, Map, Value};

use crate::pyjson;
use crate::state::AppState;
use crate::util;

pub const BACKUP_KEEP: usize = 14;

fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..4].iter().all(|c| c.is_ascii_digit())
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[8..10].iter().all(|c| c.is_ascii_digit())
}

fn backup_path(store: &AppState, day: &str) -> PathBuf {
    store.paths.backup_dir.join(format!("rhythm-{day}.json"))
}

pub fn backup_days(store: &AppState) -> Vec<String> {
    let mut days = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&store.paths.backup_dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(rest) = name.strip_prefix("rhythm-") {
                if let Some(day) = rest.strip_suffix(".json") {
                    if is_day(day) {
                        days.push(day.to_string());
                    }
                }
            }
        }
    }
    days.sort();
    days
}

/// 一天一份，内容没变就不重写。返回 (saved, day, kept)。
pub fn save_snapshot(store: &AppState, payload: &Value) -> std::io::Result<(bool, String, usize)> {
    let day = util::today();
    let body = pyjson::dumps_sorted_compact(payload).into_bytes();
    std::fs::create_dir_all(&store.paths.backup_dir)?;
    let fp = backup_path(store, &day);
    if let Ok(old) = std::fs::read(&fp) {
        if old == body {
            return Ok((false, day, backup_days(store).len()));
        }
    }
    let tmp = fp.with_extension("json.tmp");
    std::fs::write(&tmp, &body)?;
    std::fs::rename(&tmp, &fp)?;
    let days = backup_days(store);
    if days.len() > BACKUP_KEEP {
        for old in &days[..days.len() - BACKUP_KEEP] {
            let _ = std::fs::remove_file(backup_path(store, old));
        }
    }
    let kept = backup_days(store).len();
    Ok((true, day, kept))
}

/// 给面板列最近几份。只回日期、大小、班名，不回名册。
pub fn list_snapshots(store: &AppState, limit: usize) -> Vec<Value> {
    let days = backup_days(store);
    let start = days.len().saturating_sub(limit);
    let mut out = Vec::new();
    for day in days[start..].iter().rev() {
        let fp = backup_path(store, day);
        let text = match std::fs::read_to_string(&fp) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let obj: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let meta = std::fs::metadata(&fp).ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let saved_at = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| util::ts_to_iso_minutes(d.as_secs() as i64))
            .unwrap_or_default();
        let klass = obj
            .get("config")
            .and_then(|c| c.get("meta"))
            .and_then(|m| m.get("klass"))
            .and_then(|k| k.as_str())
            .unwrap_or("")
            .chars()
            .take(40)
            .collect::<String>();
        let mut item = Map::new();
        item.insert("day".into(), json!(day));
        item.insert("savedAt".into(), json!(saved_at));
        item.insert("size".into(), json!(size));
        item.insert("klass".into(), json!(klass));
        out.push(Value::Object(item));
    }
    out
}

pub fn load_snapshot(store: &AppState, day: &str) -> Option<Value> {
    if !is_day(day) {
        return None;
    }
    let text = std::fs::read_to_string(backup_path(store, day)).ok()?;
    serde_json::from_str(&text).ok()
}

// ---------------------------------------------------------------- 手机端待应用

fn remote_path(store: &AppState) -> PathBuf {
    store.paths.backup_dir.join("remote-pending.json")
}

pub fn remote_read(store: &AppState) -> Option<Value> {
    let text = std::fs::read_to_string(remote_path(store)).ok()?;
    let obj: Value = serde_json::from_str(&text).ok()?;
    if !obj.is_object() || obj.get("pending").and_then(|p| p.as_bool()) != Some(true) {
        return None;
    }
    if obj.get("kind").and_then(|k| k.as_str()) == Some("patch")
        && obj.get("patch").map(|p| p.is_object()).unwrap_or(false)
    {
        return Some(obj);
    }
    if obj.get("config").map(|c| c.is_object()).unwrap_or(false) {
        return Some(obj);
    }
    None
}

pub fn remote_write(store: &AppState, payload: &Value, received_at: i64) -> std::io::Result<()> {
    let body = json!({"pending": true, "receivedAt": received_at, "config": payload});
    let text = pyjson::dumps_sorted_compact(&body);
    write_pending(store, &text)
}

pub fn remote_write_patch(
    store: &AppState,
    payload: &Value,
    received_at: i64,
) -> std::io::Result<()> {
    let body = json!({"pending": true, "kind": "patch", "receivedAt": received_at, "patch": payload});
    let text = pyjson::dumps_sorted_compact(&body);
    write_pending(store, &text)
}

fn write_pending(store: &AppState, text: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(&store.paths.backup_dir)?;
    let fp = remote_path(store);
    let tmp = fp.with_extension("json.tmp");
    std::fs::write(&tmp, text.as_bytes())?;
    std::fs::rename(&tmp, &fp)
}

pub fn remote_clear(store: &AppState, ok: bool, why: &str) {
    let _ = std::fs::remove_file(remote_path(store));
    let at = util::iso_seconds(&util::now_bj());
    let truncated: String = why.chars().take(200).collect();
    let mut slot = store
        .remote_result
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *slot = json!({"ok": ok, "why": truncated, "at": at});
}

pub fn remote_result(store: &AppState) -> Value {
    store
        .remote_result
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// 手机编辑视图：只给 meta / timetable / schedule，名册一律不出服务。
pub fn remote_state(store: &AppState) -> Option<Value> {
    let days = backup_days(store);
    let obj = load_snapshot(store, days.last()?)?;
    let cfg = obj.get("config")?;
    let klass = cfg
        .get("meta")
        .and_then(|m| m.get("klass"))
        .and_then(|k| k.as_str())
        .unwrap_or("");
    if klass.is_empty() {
        return None;
    }
    let mut kept = Map::new();
    for key in ["meta", "timetable", "schedule"] {
        if let Some(v) = cfg.get(key) {
            kept.insert(key.to_string(), v.clone());
        }
    }
    let mut out = Map::new();
    out.insert("format".into(), json!("rhythm-config-state/v1"));
    out.insert(
        "schemaVersion".into(),
        obj.get("schemaVersion").cloned().unwrap_or(json!(0)),
    );
    out.insert(
        "savedAt".into(),
        obj.get("savedAt").cloned().unwrap_or(json!("")),
    );
    out.insert("day".into(), json!(days.last().unwrap()));
    out.insert("config".into(), Value::Object(kept));
    out.insert(
        "texts".into(),
        match obj.get("texts") {
            Some(v) if v.is_object() => v.clone(),
            _ => json!({}),
        },
    );
    out.insert(
        "phrases".into(),
        match obj.get("phrases") {
            Some(v) if v.is_array() => v.clone(),
            _ => json!([]),
        },
    );
    Some(Value::Object(out))
}

/// 形状校验。深层校验交给大屏 importAll，这里只挡明显不是补丁的东西。
pub fn valid_patch(p: &Value) -> bool {
    let obj = match p.as_object() {
        Some(o) => o,
        None => return false,
    };
    if obj.get("format").and_then(|f| f.as_str()) != Some("rhythm-config-patch/v1") {
        return false;
    }
    if let Some(c) = obj.get("config") {
        let c = match c.as_object() {
            Some(o) => o,
            None => return false,
        };
        if let Some(meta) = c.get("meta") {
            if !meta.is_object() {
                return false;
            }
        }
        if let Some(tt) = c.get("timetable") {
            if !tt.is_object() || !tt.get("blocks").map(|b| b.is_array()).unwrap_or(false) {
                return false;
            }
        }
        if let Some(sc) = c.get("schedule") {
            if !sc.is_object() || !sc.get("entries").map(|b| b.is_array()).unwrap_or(false) {
                return false;
            }
        }
    }
    if let Some(t) = obj.get("texts") {
        if !t.is_object() {
            return false;
        }
    }
    if let Some(ph) = obj.get("phrases") {
        if !ph.is_array() {
            return false;
        }
    }
    !(obj.get("config").is_none() && obj.get("texts").is_none() && obj.get("phrases").is_none())
}

// ---------------------------------------------------------------- 地址自检

/// 记下这次启动的局域网地址，和上次比一比。
pub fn note_address(store: &AppState, lan: &str) -> (bool, String) {
    let mut addr = store.addr.lock().unwrap_or_else(|e| e.into_inner());
    if lan.is_empty() || lan == addr.seen {
        return (addr.changed, addr.last.clone());
    }
    addr.seen = lan.to_string();
    let mut last = String::new();
    if let Ok(text) = std::fs::read_to_string(&store.paths.net_file) {
        if let Ok(obj) = serde_json::from_str::<Value>(&text) {
            last = obj
                .get("lan")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
        }
    }
    if !last.is_empty() && last != lan {
        addr.changed = true;
        addr.last = last.clone();
    }
    let body = json!({"lan": lan, "at": util::iso_seconds(&util::now_bj())});
    let _ = std::fs::write(&store.paths.net_file, pyjson::dumps(&body));
    (addr.changed, addr.last.clone())
}
