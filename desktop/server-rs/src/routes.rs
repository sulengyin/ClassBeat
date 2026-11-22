//! 路由。刻意不用 axum 的路径 DSL，而是自己按 Python 版的判断顺序匹配，
//! 这样前缀重叠（`/api/config/backup` 与 `/api/config/backup/{day}`）的
//! 优先级与旧版逐字一致。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body, Bytes};
use axum::extract::{ConnectInfo, State};
use axum::http::{header, Method, Request};
use axum::response::Response;
use futures_util::stream;
use serde_json::{json, Map, Value};

use crate::backup;
use crate::messages;
use crate::pyjson;
use crate::resp;
use crate::state::AppState;
use crate::util;
use crate::win;

/// 读请求体时的硬上限：与 Python 的 BACKUP_DRAIN_MAX 一致（8 MB）。
const BODY_MAX: usize = 8 * 1024 * 1024;
/// 配置类写入的正文上限（BACKUP_MAX_BODY）。
const BACKUP_MAX_BODY: i64 = 512 * 1024;
const MESSAGE_MAX_BODY: i64 = 4096;

pub async fn handle(
    State(st): State<Arc<AppState>>,
    req: Request<Body>,
) -> Response<Body> {
    let client = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0);

    let method = req.method().clone();
    let uri = req.uri().clone();
    let raw_path = uri.path().to_string();
    let query = uri.query().unwrap_or("").to_string();
    let content_length = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<i64>().ok());

    match method {
        Method::OPTIONS => return resp::no_content(),
        Method::GET => {
            return handle_get(&st, &raw_path, &query, client).await;
        }
        Method::POST => {}
        other => return resp::not_implemented(other.as_str()),
    }

    // POST：先按 Python 的顺序把 body 读进来（读之前已经拿到 Content-Length）
    let body = match to_bytes(req.into_body(), BODY_MAX).await {
        Ok(b) => b.to_vec(),
        Err(_) => Vec::new(),
    };
    handle_post(&st, &raw_path, &query, client, content_length, &body).await
}

fn trim_path(raw: &str) -> String {
    let t = raw.trim_end_matches('/');
    if t.is_empty() {
        "/".to_string()
    } else {
        t.to_string()
    }
}

fn is_loopback(a: Option<SocketAddr>) -> bool {
    match a {
        Some(SocketAddr::V4(v4)) => v4.ip().is_loopback(),
        Some(SocketAddr::V6(v6)) => match v6.ip().to_ipv4_mapped() {
            Some(v4) => v4.is_loopback(),
            None => v6.ip().is_loopback(),
        },
        None => false,
    }
}

fn pct_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 对应 `urllib.parse.parse_qs`（keep_blank_values=False）。
fn parse_qs(query: &str) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        if v.is_empty() {
            continue;
        }
        out.entry(pct_decode(k)).or_default().push(pct_decode(v));
    }
    out
}

async fn handle_get(
    st: &Arc<AppState>,
    raw_path: &str,
    query: &str,
    client: Option<SocketAddr>,
) -> Response<Body> {
    let loopback = is_loopback(client);
    let path = trim_path(raw_path);

    if path == "/" || path == "/index.html" || path == "/phone" {
        return phone_page(st);
    }
    if path == "/manifest.json" {
        return manifest(st);
    }
    if path == "/phone-sw.js" {
        return sw(st);
    }
    if let Some(name) = path.strip_prefix("/icons/") {
        return icon(st, name);
    }
    if path == "/version" || path == "/api/version" {
        let v = st.app_version();
        return resp::json(
            &json!({"ok": true, "version": v.version, "build": v.build, "startedAt": v.started_at}),
            200,
        );
    }
    if path == "/api/ping" {
        let conf = st.conf_snapshot();
        let lan = if conf.lan.is_empty() {
            format!("http://127.0.0.1:{}", conf.port)
        } else {
            conf.lan.clone()
        };
        let (changed, last) = backup::note_address(st, &lan);
        let v = st.app_version();
        return resp::json(
            &json!({
                "ok": true,
                "app": "classbeat",
                "shell": st.shell,
                "home": st.home_id,
                "class": conf.klass,
                "port": conf.port,
                "lan": lan,
                "version": v.version,
                "build": v.build,
                "addrChanged": changed,
                "lastLan": last,
                "now": util::hhmm(0),
                "time": util::iso_seconds(&util::now_bj()),
            }),
            200,
        );
    }
    if path == "/api/update" {
        let v = st.app_version();
        let up = st.update.lock().unwrap_or_else(|e| e.into_inner());
        return resp::json(
            &json!({
                "ok": true,
                "version": v.version,
                "build": v.build,
                "startedAt": v.started_at,
                "checked": !up.checked_at.is_empty(),
                "checkedAt": up.checked_at,
                "available": up.available,
                "latest": if up.available { up.latest.clone() } else { String::new() },
            }),
            200,
        );
    }
    if path == "/api/update/status" {
        return update_status(st);
    }
    if path == "/api/time" {
        return resp::json(
            &json!({
                "ok": true,
                "now": util::ms_now(),
                "beijing": util::iso_seconds(&util::now_bj()),
                "offsetMinutes": 480,
            }),
            200,
        );
    }
    if path == "/api/messages" {
        let q = parse_qs(query);
        let n = q
            .get("n")
            .and_then(|v| v.first())
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(5)
            .clamp(1, 50) as usize;
        return resp::json(&json!({"ok": true, "messages": messages::recent(st, n)}), 200);
    }
    if path == "/api/config/backup" {
        if !loopback {
            return resp::err("forbidden", 403);
        }
        return resp::json(
            &json!({
                "ok": true,
                "keep": backup::BACKUP_KEEP,
                "dir": "backups/config",
                "items": backup::list_snapshots(st, 5),
            }),
            200,
        );
    }
    if let Some(day) = path.strip_prefix("/api/config/backup/") {
        if !loopback {
            return resp::err("forbidden", 403);
        }
        return match backup::load_snapshot(st, day) {
            Some(obj) => resp::json(&obj, 200),
            None => resp::err("没有这份备份", 404),
        };
    }
    if path == "/api/config/remote" {
        if !loopback {
            return resp::err("forbidden", 403);
        }
        let obj = backup::remote_read(st);
        let kind = obj
            .as_ref()
            .and_then(|o| o.get("kind"))
            .and_then(|k| k.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("full");
        return resp::json(
            &json!({
                "ok": true,
                "pending": obj.is_some(),
                "kind": kind,
                "receivedAt": obj.as_ref().and_then(|o| o.get("receivedAt")).cloned().unwrap_or(Value::Null),
                "config": obj.as_ref().and_then(|o| o.get("config")).cloned().unwrap_or(Value::Null),
                "patch": obj.as_ref().and_then(|o| o.get("patch")).cloned().unwrap_or(Value::Null),
                "result": backup::remote_result(st),
            }),
            200,
        );
    }
    if path == "/api/config/remote/state" {
        return match backup::remote_state(st) {
            Some(obj) => resp::json(&obj, 200),
            None => resp::err("还没有配置备份，请先在大屏上打开一次", 404),
        };
    }
    if path == "/api/stream" {
        return sse(st, query);
    }
    if path == "/screen" {
        return resp::redirect("/app/index.html");
    }
    if path.starts_with("/app/") {
        return static_file(st, &raw_path[5..]);
    }

    resp::err("not found", 404)
}

async fn handle_post(
    st: &Arc<AppState>,
    raw_path: &str,
    _query: &str,
    client: Option<SocketAddr>,
    content_length: Option<i64>,
    body: &[u8],
) -> Response<Body> {
    let route = raw_path.trim_end_matches('/');
    let loopback = is_loopback(client);

    if route == "/api/screen/minimize" {
        if !loopback {
            return resp::err("只接受本机操作", 403);
        }
        let (found, done) = win::screen_minimize();
        return resp::json(&json!({"ok": true, "found": found, "minimized": done}), 200);
    }

    if route == "/api/screen/exit" {
        if !loopback {
            return resp::err("只接受本机操作", 403);
        }
        let flag = st.paths.exit_flag.clone();
        std::thread::spawn(move || win::screen_exit(&flag));
        return resp::json(&json!({"ok": true}), 200);
    }

    if route == "/api/retract" {
        let ev = messages::retract_latest(st);
        return resp::json(
            &json!({"ok": true, "cleared": ev.is_some(), "event": ev.unwrap_or(Value::Null)}),
            200,
        );
    }

    if route == "/api/config/snapshot" {
        if !loopback {
            return resp::err("只接受本机写入", 403);
        }
        if let Some(r) = too_big(content_length, BACKUP_MAX_BODY) {
            return r;
        }
        let payload = match parse_json_object(body) {
            Ok(v) => v,
            Err(msg) => return resp::err(&msg, 400),
        };
        if payload.get("format").and_then(|f| f.as_str()) != Some("rhythm-config/v1") {
            return resp::err("请求体不是合法配置：不是节律屏的设置文件", 400);
        }
        return match backup::save_snapshot(st, &payload) {
            Ok((saved, day, kept)) => resp::json(
                &json!({"ok": true, "saved": saved, "day": day, "kept": kept}),
                200,
            ),
            Err(e) => resp::err(&format!("写不进备份目录：{e}"), 500),
        };
    }

    if route == "/api/config/remote" {
        if let Some(r) = too_big(content_length, BACKUP_MAX_BODY) {
            return r;
        }
        let payload = match parse_json_object(body) {
            Ok(v) => v,
            Err(msg) => return resp::err(&msg, 400),
        };
        if payload.get("format").and_then(|f| f.as_str()) != Some("rhythm-config/v1") {
            return resp::err("请求体不是合法配置：不是节律屏的设置文件", 400);
        }
        let received_at = util::ms_now();
        return match backup::remote_write(st, &payload, received_at) {
            Ok(()) => resp::json(&json!({"ok": true, "receivedAt": received_at}), 200),
            Err(e) => resp::err(&format!("写不进备份目录：{e}"), 500),
        };
    }

    if route == "/api/config/remote/patch" {
        if let Some(r) = too_big(content_length, BACKUP_MAX_BODY) {
            return r;
        }
        let payload = match parse_json_object(body) {
            Ok(v) => v,
            Err(msg) => return resp::err(&msg, 400),
        };
        if !backup::valid_patch(&payload) {
            return resp::err("请求体不是合法补丁：不是节律屏的设置补丁", 400);
        }
        let received_at = util::ms_now();
        return match backup::remote_write_patch(st, &payload, received_at) {
            Ok(()) => resp::json(&json!({"ok": true, "receivedAt": received_at}), 200),
            Err(e) => resp::err(&format!("写不进备份目录：{e}"), 500),
        };
    }

    if route == "/api/config/remote/ack" {
        if !loopback {
            return resp::err("forbidden", 403);
        }
        if let Some(cl) = content_length {
            if cl > BACKUP_MAX_BODY {
                return resp::err("请求体太大", 413);
            }
        }
        let (mut ok, mut why) = (true, String::new());
        if content_length.map(|n| n > 0).unwrap_or(false) {
            if let Ok(obj) = serde_json::from_slice::<Value>(body) {
                ok = obj.get("ok") == Some(&Value::Bool(true));
                why = obj
                    .get("why")
                    .and_then(|w| w.as_str())
                    .unwrap_or("")
                    .to_string();
            }
        }
        if backup::remote_read(st).is_none() {
            return resp::err("没有待应用的配置", 404);
        }
        backup::remote_clear(st, ok, &why);
        return resp::json(&json!({"ok": true}), 200);
    }

    if route == "/api/update/restart" {
        if !loopback {
            return resp::err("只接受本机操作", 403);
        }
        if st
            .restarting
            .compare_exchange(false, true, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst)
            .is_err()
        {
            return resp::json(&json!({"ok": true, "message": "已经在重启了"}), 200);
        }
        spawn_restart();
        return resp::json(
            &json!({"ok": true, "message": "服务重启中，端口会短暂失联"}),
            202,
        );
    }

    if route == "/api/update/check" || route == "/api/update/apply" || route == "/api/update/rollback" {
        if !loopback {
            return resp::err("只接受本机操作", 403);
        }
        // 壳版的程序文件由安装器（tauri-plugin-updater）维护，服务不做程序内更新。
        // 三个端点保留是为了前端的旧分支不 404，语义与 Python 壳模式一致。
        let hint = "桌面版由 ClassBeat 应用统一更新：点托盘图标 → 检查更新（或按 Ctrl+Alt+U）";
        return match route {
            "/api/update/check" => resp::json(
                &json!({"ok": false, "error": "还没有配置更新源，暂时不能在线更新", "state": "failed"}),
                502,
            ),
            "/api/update/apply" => resp::err(hint, 409),
            _ => resp::err("没有可回滚的上一版", 409),
        };
    }

    if route != "/api/messages" {
        return resp::err("not found", 404);
    }

    if let Some(cl) = content_length {
        if cl <= 0 || cl > MESSAGE_MAX_BODY {
            return resp::err("请求体太大或为空", 413);
        }
    } else {
        return resp::err("请求体太大或为空", 413);
    }
    let payload = match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(o)) => Value::Object(o),
        Ok(_) => return resp::err("请求体不是合法 JSON：要 JSON 对象", 400),
        Err(e) => return resp::err(&format!("请求体不是合法 JSON：{e}"), 400),
    };
    let level = payload
        .get("level")
        .and_then(|v| v.as_str())
        .unwrap_or("normal");
    let for_whom = payload
        .get("forWhom")
        .and_then(|v| v.as_str())
        .unwrap_or("class");
    let minutes = payload.get("minutes").cloned().unwrap_or(json!(10));
    match messages::add(st, payload.get("text"), level, &minutes, for_whom) {
        Ok(msg) => resp::json(&json!({"ok": true, "message": msg}), 200),
        Err(e) => resp::err(&e, 400),
    }
}

fn too_big(content_length: Option<i64>, max: i64) -> Option<Response<Body>> {
    match content_length {
        Some(n) if n > 0 && n <= max => None,
        _ => Some(resp::err("请求体太大或为空", 413)),
    }
}

fn parse_json_object(body: &[u8]) -> Result<Value, String> {
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(o)) => Ok(Value::Object(o)),
        Ok(_) => Err("请求体不是合法配置：要 JSON 对象".to_string()),
        Err(e) => Err(format!("请求体不是合法配置：{e}")),
    }
}

fn phone_page(st: &Arc<AppState>) -> Response<Body> {
    match std::fs::read(&st.paths.phone_file) {
        Ok(body) => resp::bytes(body, "text/html; charset=utf-8", 200),
        Err(_) => resp::err("phone.html 缺失", 500),
    }
}

fn manifest(st: &Arc<AppState>) -> Response<Body> {
    let klass = {
        let c = st.conf_snapshot();
        if c.klass.is_empty() {
            "班级".to_string()
        } else {
            c.klass
        }
    };
    let body = json!({
        "name": format!("节律屏 · {klass}"),
        "short_name": "节律屏",
        "description": "教室大屏的随身入口：发消息、看屏上现在是什么",
        "start_url": "/phone",
        "scope": "/phone",
        "display": "standalone",
        "orientation": "portrait",
        "background_color": "#FBF3DF",
        "theme_color": "#FBF3DF",
        "icons": [
            {"src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
        ],
    });
    let text = pyjson::dumps_indent(&body, 2);
    let len = text.as_bytes().len();
    let b = resp::builder(200, "application/manifest+json; charset=utf-8")
        .header(header::CONTENT_LENGTH, len);
    b.body(Body::from(text))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn sw(st: &Arc<AppState>) -> Response<Body> {
    let path = st.paths.base.join("sw.js");
    match std::fs::read(&path) {
        Ok(body) => {
            let len = body.len();
            resp::builder(200, "application/javascript; charset=utf-8")
                .header("Service-Worker-Allowed", "/phone")
                .header(header::CONTENT_LENGTH, len)
                .body(Body::from(body))
                .unwrap_or_else(|_| Response::new(Body::empty()))
        }
        Err(_) => resp::err("sw.js 缺失", 500),
    }
}

fn icon(st: &Arc<AppState>, name: &str) -> Response<Body> {
    if name != "icon-192.png" && name != "icon-512.png" {
        return resp::err("not found", 404);
    }
    let path = st.paths.base.join("icons").join(name);
    match std::fs::read(&path) {
        Ok(body) => {
            let len = body.len();
            resp::builder(200, "image/png")
                .header(header::CACHE_CONTROL, "public, max-age=86400")
                .header(header::CONTENT_LENGTH, len)
                .body(Body::from(body))
                .unwrap_or_else(|_| Response::new(Body::empty()))
        }
        Err(_) => resp::err("not found", 404),
    }
}

fn static_file(st: &Arc<AppState>, rel: &str) -> Response<Body> {
    let rel = rel.trim_start_matches('/');
    let app_dir = &st.paths.app_dir;
    let target = util::abspath(&app_dir.join(rel));
    if !target.starts_with(app_dir) {
        return resp::err("forbidden", 403);
    }
    if !target.is_file() {
        return resp::err("not found", 404);
    }
    match std::fs::read(&target) {
        Ok(body) => {
            let ctype = resp::mime_for(&target);
            resp::bytes(body, &ctype, 200)
        }
        Err(_) => resp::err("not found", 404),
    }
}

/// 壳模式下的 `/api/update/status`：与 `updater.UpdateManager.status()` 的
/// 键集合、键序、取值逐项对齐，再由 handler 追加 ok / canRestart / version / build。
fn update_status(st: &Arc<AppState>) -> Response<Body> {
    let v = st.app_version();
    let mut m = Map::new();
    m.insert("state".into(), json!("idle"));
    m.insert("progress".into(), json!(0));
    m.insert("message".into(), json!("还没有检查更新"));
    m.insert("error".into(), json!(""));
    m.insert("busy".into(), json!(false));
    m.insert("currentVersion".into(), json!(v.version));
    m.insert("latest".into(), json!(""));
    m.insert("available".into(), json!(false));
    m.insert("canApply".into(), json!(false));
    m.insert(
        "blockedReason".into(),
        json!("桌面版由 ClassBeat 应用统一更新：点托盘图标 → 检查更新（或按 Ctrl+Alt+U）"),
    );
    m.insert("notes".into(), json!(""));
    m.insert("publishedAt".into(), json!(""));
    m.insert("selfUpdate".into(), json!(false));
    m.insert(
        "downloadPage".into(),
        json!("https://github.com/sulengyin/ClassBeat/releases/latest"),
    );
    m.insert("hasBackup".into(), json!(false));
    m.insert("last".into(), json!({}));
    m.insert("ok".into(), json!(true));
    m.insert("canRestart".into(), json!(true));
    m.insert("version".into(), json!(v.version));
    m.insert("build".into(), json!(v.build));
    resp::json(&Value::Object(m), 200)
}

// ---------------------------------------------------------------- SSE

struct SseCursor {
    st: Arc<AppState>,
    last: i64,
    rx: tokio::sync::broadcast::Receiver<()>,
    first: bool,
}

fn sse(st: &Arc<AppState>, query: &str) -> Response<Body> {
    let q = parse_qs(query);
    let mut last = q
        .get("since")
        .and_then(|v| v.first())
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(0);
    if last < 0 {
        // 只收从现在开始的新消息，不回放历史。
        last = st.msgs.lock().unwrap_or_else(|e| e.into_inner()).seq;
    }
    let cursor = SseCursor {
        st: st.clone(),
        last,
        rx: st.notify.subscribe(),
        first: true,
    };
    let body = Body::from_stream(stream::unfold(cursor, |mut c| async move {
        if c.st.is_stopping() {
            return None;
        }
        if c.first {
            c.first = false;
            return Some((
                Ok::<Bytes, std::convert::Infallible>(Bytes::from_static(
                    b"retry: 2000\n: connected\n\n",
                )),
                c,
            ));
        }
        loop {
            let pending: Vec<(i64, String)> = {
                let guard = c.st.msgs.lock().unwrap_or_else(|e| e.into_inner());
                guard
                    .messages
                    .iter()
                    .filter(|m| m.get("seq").and_then(|s| s.as_i64()).unwrap_or(0) > c.last)
                    .filter_map(|m| {
                        let seq = m.get("seq")?.as_i64()?;
                        Some((seq, pyjson::dumps(m)))
                    })
                    .collect()
            };
            if !pending.is_empty() {
                let mut chunk = String::new();
                for (seq, data) in pending {
                    c.last = seq;
                    chunk.push_str(&format!("id: {seq}\ndata: {data}\n\n"));
                }
                return Some((
                    Ok::<Bytes, std::convert::Infallible>(Bytes::from(chunk)),
                    c,
                ));
            }
            tokio::select! {
                _ = c.rx.recv() => {},
                _ = tokio::time::sleep(Duration::from_secs(15)) => {},
            }
        }
    }));
    resp::builder(200, "text/event-stream; charset=utf-8")
        .header(header::CONNECTION, "keep-alive")
        .header("X-Accel-Buffering", "no")
        .body(body)
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn spawn_restart() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(300));
        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(_) => return,
        };
        let mut args: Vec<String> = std::env::args().skip(1).collect();
        if !args.iter().any(|a| a == "--wait-port") {
            args.push("--wait-port".into());
            args.push("20".into());
        }
        let _ = std::process::Command::new(exe)
            .args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        std::process::exit(0);
    });
}
