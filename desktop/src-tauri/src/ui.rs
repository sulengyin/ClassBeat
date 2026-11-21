//! 系统原生小交互：提示框、确认框、打开资源管理器。
//!
//! 不引对话框插件：只有三个调用点，直接调 user32 更省事，也不会有
//! "插件权限没配所以点了没反应"这类问题。

use std::process::Command;

#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::MESSAGEBOX_STYLE;

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn message_box(title: &str, text: &str, style: MESSAGEBOX_STYLE) -> i32 {
    use windows::Win32::UI::WindowsAndMessaging::MessageBoxW;
    let t = wide(title);
    let b = wide(text);
    unsafe {
        MessageBoxW(
            None,
            windows::core::PCWSTR(b.as_ptr()),
            windows::core::PCWSTR(t.as_ptr()),
            style,
        )
        .0
    }
}

#[cfg(windows)]
pub fn info(title: &str, text: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{
        MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
    };
    message_box(title, text, MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST);
}

#[cfg(windows)]
pub fn warn(title: &str, text: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{
        MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
    };
    message_box(title, text, MB_OK | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST);
}

/// Yes/No 确认。返回 true = 用户点了"是"。
#[cfg(windows)]
pub fn confirm(title: &str, text: &str) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        IDYES, MB_ICONQUESTION, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO,
    };
    message_box(title, text, MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST) == IDYES.0
}

#[cfg(not(windows))]
pub fn info(title: &str, text: &str) {
    println!("[{title}] {text}");
}
#[cfg(not(windows))]
pub fn warn(title: &str, text: &str) {
    println!("[{title}] {text}");
}
#[cfg(not(windows))]
pub fn confirm(_title: &str, _text: &str) -> bool {
    true
}

/// 在资源管理器里打开一个目录（日志、数据目录）。
pub fn open_folder(path: &std::path::Path) {
    if !path.exists() {
        let _ = std::fs::create_dir_all(path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("explorer.exe")
            .arg(path)
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("xdg-open").arg(path).spawn();
    }
}

/// 用默认浏览器打开一个网址（下载页、帮助页）。
/// 降级用：更新器不可用时改开下载页（见 docs/08 §8.2）。
#[allow(dead_code)]
pub fn open_url(url: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
}
