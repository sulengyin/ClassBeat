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
        reveal(&w);
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
    //
    // **先隐藏建窗、设好全屏再显示**：`visible(true)` + `fullscreen(true)` 同时传，
    // Windows 上偶尔会先闪一下 1280x720 的窗口再撑满屏（老师看到的就是"没全屏，
    // 打了个窗口"）。建完再补一次 set_fullscreen 是幂等的，多这一下不亏。
    let built = WebviewWindowBuilder::new(app, "screen", WebviewUrl::External(url))
        .title(config::KIOSK_TITLE)
        .inner_size(1280.0, 720.0)
        .decorations(false)
        .fullscreen(true)
        .always_on_top(true)
        .resizable(false)
        /* 不进任务栏：大屏 24 小时开着，任务栏里再挂一个按钮只是碍事，
           而且任务栏按 exe 路径缓存图标，覆盖安装后常显示上一个版本的图案。
           统一只留右下角托盘图标（2026-11-25 真机反馈）。 */
        .skip_taskbar(true)
        .visible(false)
        .focused(true)
        .build();

    // 关窗语义挂在 build 之后：Tauri 2.12 的 WebviewWindowBuilder 没有
    // on_window_event，只有 WebviewWindow 有（回调只给事件，不给窗口句柄，
    // 所以闭包里捕获 AppHandle 自己找窗口）。见 docs/08 §8.2 降级方案。
    match built {
        Ok(w) => {
            reveal(&w);
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

/// 把大屏露出来：先让 Win32 把窗口从最小化里拉回来，再补全屏 / 置顶 / 焦点。
///
/// **为什么不能只靠 Tauri 的方法**：页面上的「最小化」是服务用 Win32
/// `SW_MINIMIZE` 做的（`server-rs/src/win.rs`），Tauri 侧完全不知情——
/// 它记的状态还是「可见、全屏」，于是 `unminimize()` 直接空转。真机上
/// 表现就是「点了最小化，再点图标 / 托盘『打开大屏』，什么都没发生」。
/// 这里先用 `IsIconic` + `SW_RESTORE` 按窗口实际状态还原，再走 Tauri 的补全，
/// 两条路都走一遍，谁的状态准就听谁的。
fn reveal(w: &tauri::WebviewWindow) {
    let visible_before = w.is_visible().unwrap_or(false);
    let minimal_before = w.is_minimized().unwrap_or(false);

    #[cfg(windows)]
    native_restore(w);

    let _ = w.show();

    #[cfg(windows)]
    {
        /* Tauri 的 skip_taskbar 只在建窗时调一次 ITaskbarList::DeleteTab，
           窗口重新 show 出来以后任务栏又可能把按钮加回来。所以放在 show 之后
           每次都补一遍窗口样式，才是持久的「永远不进任务栏」。 */
        hide_from_taskbar(w);
    }
    /* 【0.5.13 修复】这里以前是 `if !w.is_fullscreen()` 条件判断，是个坑：
       页面上的「最小化」是服务端用 Win32 SW_MINIMIZE 做的（server-rs/src/win.rs），
       Tauri 侧完全不知情，它记的状态还是「全屏」，条件判断就直接跳过，
       窗口于是停在建窗时的 inner_size(1280x720)——在逻辑分辨率更小的机器上
       画面就会超出屏幕右边。真机照片里右上角时间被切、底部岗位栏贴边，
       就是窗口没真正撑满的表现；「后来又突然好了」也和这种状态滞后吻合。
       set_fullscreen(true) 是幂等的：本来就是全屏则空转，没全屏则补上。
       无条件调一次，不管 Tauri 记的状态准不准，都能覆盖到。 */
    let _ = w.set_fullscreen(true);
    let _ = w.set_always_on_top(true);
    let _ = w.set_focus();

    /* 以前每一步都是 `let _ =`，恢复失败时日志里一个字都没有，
       真机报「点图标没反应」只能靠猜。现在把前后状态记下来。
       顺带记窗口/显示器尺寸：真机若再报「画面超出屏幕」，日志里能直接
       看出窗口是不是又停在了 1280x720，不用靠斜拍的照片猜。 */
    #[cfg(windows)]
    let size_note = match (w.current_monitor(), w.inner_size()) {
        (Ok(Some(m)), Ok(s)) => format!(
            "，窗口 {}x{} / 屏 {}x{}",
            s.width,
            s.height,
            m.size().width,
            m.size().height
        ),
        _ => String::new(),
    };
    #[cfg(not(windows))]
    let size_note = String::new();

    logging::info(&format!(
        "恢复大屏：可见 {}→{}，最小化 {}→{}，全屏 {}{}",
        visible_before,
        w.is_visible().unwrap_or(false),
        minimal_before,
        w.is_minimized().unwrap_or(false),
        w.is_fullscreen().unwrap_or(false),
        size_note
    ));
}

/// 把窗口标记成「工具窗」：任务栏不再给它按钮，Alt+Tab 也跳过它。
/// 用窗口样式而不是只靠 `ITaskbarList::DeleteTab`——后者是一次性的，
/// 窗口每次重新显示都可能被任务栏加回来。
#[cfg(windows)]
fn hide_from_taskbar(w: &tauri::WebviewWindow) {
    use std::ffi::c_void;

    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    let Ok(h) = w.hwnd() else { return };
    let hwnd = HWND(h.0 as *mut c_void);
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | WS_EX_TOOLWINDOW.0 as isize;
        if ex != want {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
        }
    }
}

/// 按窗口的真实状态（而不是 Tauri 记的状态）把它从最小化 / 后台拉回来。
#[cfg(windows)]
fn native_restore(w: &tauri::WebviewWindow) {
    use std::ffi::c_void;

    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    let Ok(h) = w.hwnd() else { return };
    /* 跨 windows crate 版本取裸句柄：tauri 依赖的版本号未必和这里一致，
       直接传 HWND 会因类型不同编不过，取 .0 再转最稳。 */
    let hwnd = HWND(h.0 as *mut c_void);
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = SetForegroundWindow(hwnd);
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
        reveal(&w);
        return;
    }
    let port = app.state::<AppState>().port();
    if port == 0 {
        /* 服务还在起（双击第二下、或开机自启后立刻点图标）。
           以前这里只打一行 warn 就 return，老师看到的就是「点了图标没反应」。
           现在等它就绪再开，最多等 10 秒——反正此时也没有窗口可显示。 */
        logging::warn("服务尚未就绪，等它就绪后再开大屏");
        let handle = app.clone();
        std::thread::spawn(move || {
            for _ in 0..20 {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let p = handle.state::<AppState>().port();
                if p != 0 {
                    if handle.get_webview_window("screen").is_none() {
                        open_screen(&handle, p);
                    }
                    return;
                }
            }
            logging::error("等了 10 秒服务仍没就绪，大屏没有打开（看 logs/app.log 与 server.log）");
        });
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
