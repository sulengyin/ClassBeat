//! 防休眠：大屏要亮一整天。
//!
//! 旧方案在 start-kiosk.ps1 里用 P/Invoke 调同一个 API，
//! 这里换成直接调用，行为一致：只要进程活着，屏就不会睡。

use std::time::Duration;

pub fn keep_awake() {
    std::thread::spawn(|| {
        #[cfg(windows)]
        {
            use windows::Win32::System::Power::{
                SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
            };
            loop {
                // ES_CONTINUOUS 让状态一直有效；再每 30 秒刷新一次，
                // 防止别的程序把显示状态改回去。
                unsafe {
                    SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
                }
                std::thread::sleep(Duration::from_secs(30));
            }
        }
        #[cfg(not(windows))]
        {
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
    });
}
