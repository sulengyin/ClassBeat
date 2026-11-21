//! 全局热键 = 逃生门。
//!
//! 旧包靠桌面上的「退出大屏.bat」。装了壳以后老师可能连桌面上有什么都不知道，
//! 所以留三个在任何时候都能按的热键：
//!
//! - `Ctrl+Alt+Q`：退出 ClassBeat（真退出，不再自己回来，直到下次开机）
//! - `Ctrl+Alt+M`：把大屏最小化，临时看一眼桌面
//! - `Ctrl+Alt+U`：检查更新
//!
//! 用 user32 的 RegisterHotKey + 一个自己的消息循环，不引插件：
//! 这段代码在 Windows 上行为确定，出问题也只影响热键，不影响大屏。

use std::sync::OnceLock;
use tauri::AppHandle;

use crate::{logging, ui, window};

static APP: OnceLock<AppHandle> = OnceLock::new();

const HOTKEY_QUIT: i32 = 1;
const HOTKEY_MIN: i32 = 2;
const HOTKEY_UPDATE: i32 = 3;

pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    std::thread::spawn(run_loop);
}

#[cfg(windows)]
fn run_loop() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, VK_Q, VK_U, VK_M,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, TranslateMessage, MSG, WM_HOTKEY,
    };

    unsafe {
        let mods = MOD_CONTROL | MOD_ALT | MOD_NOREPEAT;
        let q = RegisterHotKey(None, HOTKEY_QUIT, mods, VK_Q.0 as u32);
        let m = RegisterHotKey(None, HOTKEY_MIN, mods, VK_M.0 as u32);
        let u = RegisterHotKey(None, HOTKEY_UPDATE, mods, VK_U.0 as u32);
        if q.is_err() || m.is_err() || u.is_err() {
            logging::warn("全局热键注册失败（可能被别的软件占用），托盘菜单仍然可用");
        }

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            if msg.message == WM_HOTKEY {
                on_hotkey(msg.wParam.0 as i32);
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(not(windows))]
fn run_loop() {}

fn on_hotkey(id: i32) {
    let Some(app) = APP.get() else { return };
    match id {
        HOTKEY_QUIT => {
            logging::info("热键 Ctrl+Alt+Q：退出");
            if ui::confirm(
                "退出 ClassBeat",
                "退出后大屏会关掉，手机也发不了消息。\n\n确定退出吗？（开机后会自己回来）",
            ) {
                crate::shutdown(app);
            }
        }
        HOTKEY_MIN => {
            logging::info("热键 Ctrl+Alt+M：最小化大屏");
            window::minimize_screen(app);
        }
        HOTKEY_UPDATE => {
            logging::info("热键 Ctrl+Alt+U：检查更新");
            crate::update::check_interactive(app);
        }
        _ => {}
    }
}
