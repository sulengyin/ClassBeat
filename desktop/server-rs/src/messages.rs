//! 消息：校验、落盘、撤回。逐条对齐 `rhythm_server.py` 的文案与边界。

use serde_json::{json, Map, Value};

use crate::pyjson;
use crate::state::AppState;
use crate::util;

pub const MAX_TEXT: usize = 60;
pub const MAX_MINUTES: i64 = 180;
pub const MAX_KEEP: usize = 300;

fn is_level(v: &str) -> bool {
    v == "normal" || v == "urgent"
}

/// 文件坏了就备份再重来，绝不让服务起不来。
pub fn load(store: &AppState) {
    let path = &store.paths.msg_file;
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return,
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Array(items)) => {
            let mut msgs = store.msgs.lock().unwrap_or_else(|e| e.into_inner());
            msgs.messages = items
                .into_iter()
                .filter(|m| {
                    m.is_object()
                        && (m.get("text").is_some()
                            || m.get("type").and_then(|t| t.as_str()) == Some("clear"))
                })
                .collect();
            msgs.seq = msgs
                .messages
                .iter()
                .filter_map(|m| m.get("seq").and_then(|s| s.as_i64()))
                .max()
                .unwrap_or(0);
        }
        _ => {
            let bad = format!("{}.bad", path.display());
            let _ = std::fs::rename(path, &bad);
            store.log(&format!("messages.json 损坏，已备份到 {bad}，从空开始"));
        }
    }
}

/// 先写临时文件再改名，避免断电写半截。缩进 1 与 Python 版一致。
pub fn save(store: &AppState) {
    let body = {
        let msgs = store.msgs.lock().unwrap_or_else(|e| e.into_inner());
        let start = msgs.messages.len().saturating_sub(MAX_KEEP);
        Value::Array(msgs.messages[start..].to_vec())
    };
    let text = pyjson::dumps_indent(&body, 1);
    let path = &store.paths.msg_file;
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text.as_bytes()).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    } else {
        store.log("写 messages.json 失败");
    }
}

/// `int(x)` 的 Python 语义：数字截断、字符串可解析、bool 当 0/1。
fn as_int(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f.trunc() as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok().or_else(|| {
            s.trim()
                .parse::<f64>()
                .ok()
                .map(|f| f.trunc() as i64)
        }),
        Value::Bool(b) => Some(if *b { 1 } else { 0 }),
        _ => None,
    }
}

pub fn add(
    store: &AppState,
    text: Option<&Value>,
    level: &str,
    minutes: &Value,
    for_whom: &str,
) -> Result<Value, String> {
    let raw = match text {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let text = raw.trim().to_string();
    if text.is_empty() {
        return Err("内容不能为空".into());
    }
    if text.chars().count() > MAX_TEXT {
        return Err(format!("最多 {MAX_TEXT} 字"));
    }
    if !is_level(level) {
        return Err("level 只能是 normal 或 urgent".into());
    }
    let minutes = match as_int(minutes) {
        Some(m) => m,
        None => return Err("时长必须是数字".into()),
    };
    if minutes < 0 || minutes > MAX_MINUTES {
        return Err(format!("时长要在 0–{MAX_MINUTES} 分钟之间（0 = 手动关）"));
    }
    if for_whom != "class" && for_whom != "self" {
        return Err("forWhom 只能是 class 或 self".into());
    }

    let mut msg = Map::new();
    {
        let mut msgs = store.msgs.lock().unwrap_or_else(|e| e.into_inner());
        msgs.seq += 1;
        msg.insert("seq".into(), json!(msgs.seq));
        msg.insert("text".into(), json!(text));
        msg.insert("level".into(), json!(level));
        msg.insert("forWhom".into(), json!(for_whom));
        msg.insert("at".into(), json!(util::hhmm(0)));
        msg.insert(
            "until".into(),
            json!(if minutes > 0 {
                util::hhmm(minutes)
            } else {
                "23:59".to_string()
            }),
        );
        msg.insert("createdAt".into(), json!(util::ms_now()));
        msgs.messages.push(Value::Object(msg.clone()));
    }
    let _ = store.notify.send(());
    save(store);
    Ok(Value::Object(msg))
}

/// 手机端历史只给真消息，撤回事件不占位置。
pub fn recent(store: &AppState, n: usize) -> Vec<Value> {
    let msgs = store.msgs.lock().unwrap_or_else(|e| e.into_inner());
    let real: Vec<Value> = msgs
        .messages
        .iter()
        .filter(|m| m.get("type").and_then(|t| t.as_str()) != Some("clear"))
        .cloned()
        .collect();
    let start = real.len().saturating_sub(n);
    real[start..].to_vec()
}

pub fn expired(m: &Value) -> bool {
    let until = m.get("until").and_then(|u| u.as_str()).unwrap_or("");
    if until.is_empty() {
        return false;
    }
    let now = util::hhmm(0);
    if until >= "00:00" && until < "06:00" {
        return false;
    }
    now.as_str() >= until
}

/// 撤回最近一条还没撤回的班级消息，并广播一个 clear 事件。
pub fn retract_latest(store: &AppState) -> Option<Value> {
    let mut ev: Option<Value> = None;
    {
        let mut msgs = store.msgs.lock().unwrap_or_else(|e| e.into_inner());
        let mut found: Option<usize> = None;
        for (i, m) in msgs.messages.iter().enumerate().rev() {
            if m.get("type").and_then(|t| t.as_str()) == Some("clear") {
                continue;
            }
            if m.get("forWhom").and_then(|f| f.as_str()) != Some("class") {
                continue;
            }
            if m.get("retractedAt").is_some() {
                continue;
            }
            if expired(m) {
                continue;
            }
            found = Some(i);
            break;
        }
        if let Some(i) = found {
            let target = msgs.messages[i]
                .get("seq")
                .and_then(|s| s.as_i64())
                .unwrap_or(0);
            if let Value::Object(obj) = &mut msgs.messages[i] {
                obj.insert("retractedAt".into(), json!(util::ms_now()));
            }
            msgs.seq += 1;
            let e = json!({"seq": msgs.seq, "type": "clear", "target": target});
            msgs.messages.push(e.clone());
            ev = Some(e);
        }
    }
    if ev.is_some() {
        let _ = store.notify.send(());
        save(store);
    }
    ev
}
