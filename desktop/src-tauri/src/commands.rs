//! 给未来"设置窗口"和调试预留的命令（页面目前不需要 IPC，一律走本地 HTTP）。
//!
//! 这些命令也方便维护者用 `tauri dev` 时在控制台里直接调：
//!   await window.__TAURI_INTERNALS__.invoke('app_status')

use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::{logging, server, ui, window, AppState};

#[tauri::command]
pub fn app_status(app: AppHandle) -> serde_json::Value {
    let st = app.state::<AppState>();
    json!({
        "product": crate::config::APP_NAME,
        "version": env!("CARGO_PKG_VERSION"),
        "shell": true,
        "port": st.port(),
        "serverRunning": st.server.is_running(),
        "installRoot": st.paths.install_root.to_string_lossy(),
        "dataDir": st.paths.data.to_string_lossy(),
        "logDir": st.paths.logs.to_string_lossy(),
    })
}

#[tauri::command]
pub fn restart_server(app: AppHandle) {
    restart_server_inner(&app);
}

/// 托盘与命令共用：停掉旧进程 → 重新拉起 → 重开大屏（页面里的 SSE 会自己重连）。
pub fn restart_server_inner(app: &AppHandle) {
    logging::info("手动重启后台服务");
    server::stop(app);
    server::boot(app.clone());
}

#[tauri::command]
pub fn open_screen_window(app: AppHandle) {
    window::show_or_open(&app);
}

#[tauri::command]
pub fn open_phone(app: AppHandle) {
    window::open_phone(&app);
}

#[tauri::command]
pub fn open_logs(app: AppHandle) {
    let dir = app.state::<AppState>().paths.logs.clone();
    ui::open_folder(&dir);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    crate::shutdown(&app);
}
