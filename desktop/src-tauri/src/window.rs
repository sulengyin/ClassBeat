//! 窗口：大屏（无边框全屏置顶）、手机页、错误页。
//!
//! 旧方案靠 Chrome `--kiosk`，窗口不属于自己，只能靠枚举标题去猜（win-titles.ps1 130 行）。
//! 这里窗口是自己造的：全屏、置顶、隐藏、最小化全是方法调用。
//!
//! **兼容层（故意保留）**：窗口标题固定含「班级节律屏」，
//! 页面上的「最小化 / 退出大屏」仍然走服务端的窗口枚举，前端零改动。
//! 详见 docs/04-服务适配契约.md §4.5。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::{config, logging, AppState};

pub fn open_screen(app: &AppHandle, port: u16) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || create_screen(&handle, port));
}

fn create_screen(app: &AppHandle, port: u16) {
    if let Some(w) = app.get_webview_window("screen") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let url = match tauri::Url::parse(&format!("http://127.0.0.1:{port}/screen")) {
        Ok(u) => u,
        Err(e) => {
            logging::error(&format!("大屏地址不合法：{e}"));
            return;
        }
    };
    // 窗口参数一个都不能少：标题（页面靠它找窗口）、全屏、无边框、置顶、不可缩放。
    let built = WebviewWindowBuilder::new(app, "screen", WebviewUrl::External(url))
        .title(config::KIOSK_TITLE)
        .inner_size(1280.0, 720.0)
        .decorations(false)
        .fullscreen(true)
        .always_on_top(true)
        .resizable(false)
        .visible(true)
        .focused(true)
        .build();

    // 关窗语义挂在 build 之后：Tauri 2.12 的 WebviewWindowBuilder 没有
    // on_window_event，只有 WebviewWindow 有（回调只给事件，不给窗口句柄，
    // 所以闭包里捕获 AppHandle 自己找窗口）。见 docs/08 §8.2 降级方案。
    match built {
        Ok(w) => {
            let handle = app.clone();
            w.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    on_screen_close(&handle);
                }
            });
            logging::info("大屏窗口已创建");
        }
        Err(e) => {
            logging::error(&format!("大屏窗口创建失败：{e}"));
            show_error(app, &format!("大屏窗口创建失败：{e}"));
        }
    }
}

/// 关大屏 ≠ 关应用。
/// - 页面点「退出大屏」：服务会先写 `exit-request.flag`，这里认这个标记 → 真退出；
/// - 老师误按 Alt+F4 / 点了关闭：没有标记 → 收进托盘，点托盘「打开大屏」就回来。
/// 这一条顶替了旧的 watchdog.ps1 的"误关自动拉起"，而且不用每 20 秒轮询。
fn on_screen_close(app: &AppHandle) {
    let st = app.state::<AppState>();
    let deliberate = st.is_quitting() || st.paths.exit_flag().exists();

    if deliberate {
        let _ = std::fs::remove_file(st.paths.exit_flag());
        logging::info("收到退出请求：关闭大屏并退出 ClassBeat");
        if let Some(w) = app.get_webview_window("screen") {
            let _ = w.hide();
        }
        crate::shutdown(app);
    } else {
        logging::info("大屏被关闭（没有退出标记，按误触处理）：已收进托盘");
        if let Some(w) = app.get_webview_window("screen") {
            let _ = w.hide();
        }
    }
}

/// 服务重启后端口可能变了（旧端口被别的程序抢走）：把大屏指回新地址。
/// 同端口重启时 EventSource 会自己重连，不需要动窗口。
pub fn reload_screen(app: &AppHandle, port: u16) {
    let Some(w) = app.get_webview_window("screen") else { return };
    let Ok(url) = tauri::Url::parse(&format!("http://127.0.0.1:{port}/screen")) else { return };
    if w.url().map(|u| u.port() != Some(port)).unwrap_or(true) {
        let _ = w.navigate(url);
        logging::info(&format!("大屏已切到新端口 {port}"));
    }
}

pub fn show_or_open(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("screen") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let port = app.state::<AppState>().port();
    if port == 0 {
        // 服务还在起（双击第二下、或开机自启后立刻点托盘）
        logging::warn("服务尚未就绪，稍后再开大屏");
        return;
    }
    open_screen(app, port);
}

/// 手机控制页：给老师看二维码 / 改设置用的普通窗口（可缩放、有关闭按钮）。
pub fn open_phone(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("phone") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let port = app.state::<AppState>().port();
    let url = match tauri::Url::parse(&format!("http://127.0.0.1:{port}/phone")) {
        Ok(u) => u,
        Err(_) => return,
    };
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = WebviewWindowBuilder::new(&app2, "phone", WebviewUrl::External(url))
            .title("ClassBeat · 手机控制页")
            .inner_size(430.0, 760.0)
            .resizable(true)
            .build();
    });
}

/// 服务起不来时的兜底窗口：显示失败原因 + 日志路径，别让老师面对一片黑屏。
pub fn show_error(app: &AppHandle, message: &str) {
    let encoded = percent_encode(message);
    let url = format!("index.html?msg={encoded}");
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app2.get_webview_window("error") {
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        let _ = WebviewWindowBuilder::new(&app2, "error", WebviewUrl::App(url.into()))
            .title("ClassBeat 启动失败")
            .inner_size(760.0, 520.0)
            .resizable(true)
            .center()
            .build();
    });
}

/// 只做 URL 查询参数用的最小转义，不为这一处引依赖。
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn minimize_screen(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("screen") {
        let _ = w.minimize();
    }
}
