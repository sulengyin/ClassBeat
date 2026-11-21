//! 托盘：老师能感知到"这是个应用"的唯一常驻入口。
//!
//! 旧方案连托盘都没有（ROADMAP 里明确写着缺口），退出只能靠桌面的 .bat。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::{commands, logging, ui, window};

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开大屏", true, None::<&str>)?;
    let phone = MenuItem::with_id(app, "phone", "手机控制页…", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let update = MenuItem::with_id(
        app,
        "update",
        "检查更新…",
        cfg!(feature = "updater"),
        None::<&str>,
    )?;
    let restart = MenuItem::with_id(app, "restart", "重启后台服务", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "打开日志目录", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出 ClassBeat", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&open, &phone, &sep1, &update, &restart, &logs, &sep2, &quit],
    )?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/classbeat.ico"))?;

    TrayIconBuilder::with_id("classbeat")
        .icon(icon)
        .tooltip("ClassBeat · 班级节律屏")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            logging::info(&format!("托盘菜单：{id}"));
            match id {
                "open" => window::show_or_open(app),
                "phone" => window::open_phone(app),
                "update" => crate::update::check_interactive(app),
                "restart" => commands::restart_server_inner(app),
                "logs" => {
                    let dir = app.state::<crate::AppState>().paths.logs.clone();
                    ui::open_folder(&dir);
                }
                "quit" => {
                    if crate::update::is_busy() {
                        ui::warn("正在更新", "更新还没装完，等它装完再退出。");
                    } else if ui::confirm(
                        "退出 ClassBeat",
                        "退出后大屏会关掉，手机也发不了消息。\n\n确定退出吗？（开机后会自己回来）",
                    ) {
                        crate::shutdown(app);
                    }
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}
