//! 大屏窗口的寻找、最小化与关闭请求。
//!
//! 判据与旧版一致：可见顶层窗口的标题里带「班级节律屏」。壳把窗口标题
//! 固定成这个字符串，所以 `app/` 里一行 JS 都不用改。

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;

    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible, PostMessageW,
        ShowWindow, SW_MINIMIZE, WM_CLOSE,
    };

    pub const KIOSK_TITLE_MARK: &str = "班级节律屏";

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<(isize, String)>);
        if IsWindowVisible(hwnd).as_bool() {
            let len = GetWindowTextLengthW(hwnd);
            if len > 0 {
                let mut buf = vec![0u16; len as usize + 1];
                let got = GetWindowTextW(hwnd, &mut buf);
                if got > 0 {
                    let title = String::from_utf16_lossy(&buf[..got as usize]);
                    out.push((hwnd.0 as isize, title));
                }
            }
        }
        TRUE
    }

    fn visible_windows() -> Vec<(isize, String)> {
        let mut out: Vec<(isize, String)> = Vec::new();
        let ptr = &mut out as *mut Vec<(isize, String)> as *mut c_void;
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(ptr as isize));
        }
        out
    }

    fn hwnd_of(h: isize) -> HWND {
        HWND(h as *mut c_void)
    }

    pub fn find_kiosk_windows() -> Vec<(isize, String)> {
        visible_windows()
            .into_iter()
            .filter(|(_, title)| title.contains(KIOSK_TITLE_MARK))
            .collect()
    }

    /// 返回 (找到几个, 最小化几个)。
    pub fn screen_minimize() -> (usize, usize) {
        let wins = find_kiosk_windows();
        let mut done = 0usize;
        for (h, _) in &wins {
            unsafe {
                if ShowWindow(hwnd_of(*h), SW_MINIMIZE).as_bool() {
                    done += 1;
                }
            }
        }
        (wins.len(), done)
    }

    /// 壳模式：留退出标记（壳认它才真退出），再发 WM_CLOSE。
    /// 不等看门狗、不强杀进程——强杀壳会留下孤儿服务。
    pub fn screen_exit(exit_flag: &std::path::Path) {
        let stamp = crate::util::iso_seconds(&crate::util::now_bj());
        let _ = std::fs::write(exit_flag, stamp);
        for (h, _) in find_kiosk_windows() {
            unsafe {
                let _ = PostMessageW(Some(hwnd_of(h)), WM_CLOSE, Default::default(), Default::default());
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn find_kiosk_windows() -> Vec<(isize, String)> {
        Vec::new()
    }
    pub fn screen_minimize() -> (usize, usize) {
        (0, 0)
    }
    pub fn screen_exit(_exit_flag: &std::path::Path) {}
}

pub use imp::{screen_exit, screen_minimize};
