//! 响应构造：复刻 Python `_common / _json / _err` 的头与体。

use axum::body::Body;
use axum::http::{header, Response, StatusCode};
use serde_json::{json, Value};

use crate::pyjson;

const CORS_ORIGIN: &str = "*";
const CORS_METHODS: &str = "GET, POST, OPTIONS";
const CORS_HEADERS: &str = "Content-Type";

pub fn builder(code: u16, ctype: &str) -> axum::http::response::Builder {
    Response::builder()
        .header(header::SERVER, "RhythmHub/1.0")
        .status(StatusCode::from_u16(code).unwrap_or(StatusCode::OK))
        .header(header::CONTENT_TYPE, ctype)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, CORS_ORIGIN)
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, CORS_METHODS)
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, CORS_HEADERS)
        .header(header::CACHE_CONTROL, "no-store")
}

pub fn json(value: &Value, code: u16) -> Response<Body> {
    let body = pyjson::dumps(value);
    finish_json(body, code)
}

fn finish_json(body: String, code: u16) -> Response<Body> {
    let len = body.as_bytes().len();
    builder(code, "application/json; charset=utf-8")
        .header(header::CONTENT_LENGTH, len)
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

pub fn err(msg: &str, code: u16) -> Response<Body> {
    json(&json!({"ok": false, "error": msg}), code)
}

/// 原样字节（静态文件、图标、手机页）。
pub fn bytes(body: Vec<u8>, ctype: &str, code: u16) -> Response<Body> {
    let len = body.len();
    builder(code, ctype)
        .header(header::CONTENT_LENGTH, len)
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

/// 204：Python 的 do_OPTIONS 也会带 Content-Type、CORS、Cache-Control，只是体为空。
pub fn no_content() -> Response<Body> {
    let mut resp = builder(204, "application/json; charset=utf-8")
        .header(header::CONTENT_LENGTH, 0)
        .body(Body::empty())
        .unwrap_or_else(|_| Response::new(Body::empty()));
    // hyper 会把 204 的 Content-Length 抹掉；补回去让两版响应头一字不差。
    resp.headers_mut()
        .insert(header::CONTENT_LENGTH, header::HeaderValue::from_static("0"));
    resp
}

/// 302：Python 是 `send_response` + Location + Content-Length，没有 CORS、没有 Content-Type。
pub fn redirect(location: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::SERVER, "RhythmHub/1.0")
        .header(header::LOCATION, location)
        .header(header::CONTENT_LENGTH, 0)
        .body(Body::empty())
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

/// Python 的 `BaseHTTPRequestHandler` 遇到没实现的方法会回 501 + 一页 HTML。
/// 这里连页面文案一起复刻，省得验收时要为它开例外。
pub fn not_implemented(method: &str) -> Response<Body> {
    let body = format!(
        "<!DOCTYPE HTML>\n\
         <html lang=\"en\">\n\
         \x20   <head>\n\
         \x20       <meta charset=\"utf-8\">\n\
         \x20       <title>Error response</title>\n\
         \x20   </head>\n\
         \x20   <body>\n\
         \x20       <h1>Error response</h1>\n\
         \x20       <p>Error code: 501</p>\n\
         \x20       <p>Message: Unsupported method ('{method}').</p>\n\
         \x20       <p>Error code explanation: 501 - Server does not support this operation.</p>\n\
         \x20   </body>\n\
         </html>\n"
    );
    // Python 的 501 走默认错误页，不带 CORS —— 这里也不带。
    Response::builder()
        .status(StatusCode::NOT_IMPLEMENTED)
        .header(header::SERVER, "RhythmHub/1.0")
        .header(header::CONTENT_TYPE, "text/html;charset=utf-8")
        .header(header::CONNECTION, "close")
        .header(header::CONTENT_LENGTH, body.len())
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

/// MIME 判定与 Windows 上的 Python `mimetypes` 对齐。
pub fn mime_for(path: &std::path::Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let base = match ext.as_str() {
        "html" | "htm" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webmanifest" => "application/manifest+json",
        "txt" | "map" => "text/plain",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "mp3" => "audio/mpeg",
        "wav" => "audio/x-wav",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    };
    if base.starts_with("text/") || base == "application/javascript" || base == "application/json" {
        format!("{base}; charset=utf-8")
    } else {
        base.to_string()
    }
}
