//! ClassBeat 桌面壳。
//!
//! 目标只有一句：**让 ClassBeat 自己拥有窗口、进程和安装生命周期**，
//! 业务逻辑（大屏页面 + 本地服务）一行不改地继续跑。
//!
//! 启动顺序：
//!   解析路径 → 建日志 → 托盘 → 热键 → 防休眠 → 旧数据接管
//!   → 起服务（隐藏 classbeat-server.exe）→ 等到 /api/ping 通 → 开大屏窗口
//!
//! 退出顺序：
//!   置 quitting → 停服务进程 → app.exit(0)

mod autostart;
mod commands;
mod config;
mod hotkey;
mod logging;
mod migrate;
mod power;
mod server;
mod tray;
mod ui;
mod update;
mod window;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::Manager;

pub struct AppState {
    pub paths: config::Paths,
    pub server: server::ServerState,
    port: Mutex<u16>,
    quitting: AtomicBool,
    pub autostart_launch: bool,
}

impl AppState {
    pub fn set_port(&self, p: u16) {
        if let Ok(mut g) = self.port.lock() {
            *g = p;
        }
    }
    pub fn port(&self) -> u16 {
        self.port.lock().map(|g| *g).unwrap_or(0)
    }
    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }
    pub fn begin_quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }
}

pub fn run() {
    let autostart_launch = std::env::args().any(|a| a == "--autostart");

    // 不带 updater feature 的构建里 builder 不会被重新赋值，别为此报警告。
    #[cfg_attr(not(feature = "updater"), allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        // 第二次双击：不开第二个实例，把已有大屏拉到前面
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            logging::info(&format!("第二个实例被拦下，改为把大屏拉到前面（argv={argv:?} cwd={cwd}）"));
            window::show_or_open(app);
        }));

    #[cfg(feature = "updater")]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(move |app| {
            let resource_dir = app.path().resource_dir().unwrap_or_default();
            let paths = config::Paths::discover(&resource_dir);
            let _ = paths.ensure();
            let _ = logging::init(&paths.logs);

            logging::info(&format!(
                "ClassBeat 壳 {} 启动（{}）",
                env!("CARGO_PKG_VERSION"),
                if autostart_launch { "开机自启" } else { "手动启动" }
            ));
            logging::info(&format!("程序目录 {}", paths.install_root.display()));
            logging::info(&format!("数据目录 {}", paths.data.display()));

            // WebView2 的 localStorage / IndexedDB 由 Tauri 2 固定在
            // app_local_data_dir()（%LOCALAPPDATA%\cn.classbeat.app）。
            // 它在安装目录之外，NSIS 覆盖安装和更新都不碰，所以老师的班级、
            // 名单、课表不会因为升级消失。
            //
            // 别再用 WEBVIEW2_USER_DATA_FOLDER 试图换目录：Tauri 会显式把
            // data_directory 传给 WebView2，环境变量被忽略
            // （tauri-2.12.7/src/manager/webview.rs:559）。真要换目录，只能给
            // 每个 WebviewWindowBuilder 调 .data_directory()，三个窗口必须是同一个。
            //
            // 日志里打 Tauri 解析出的同一个路径：真机排查时一眼能对上是哪份数据。
            match app.path().app_local_data_dir() {
                Ok(dir) => logging::info(&format!("WebView2 数据目录 {}", dir.display())),
                Err(e) => logging::warn(&format!("WebView2 数据目录解析失败：{e}")),
            }

            app.manage(AppState {
                paths,
                server: server::ServerState::new(),
                port: Mutex::new(0),
                quitting: AtomicBool::new(false),
                autostart_launch,
            });

            // 开机自启是"系统注册"的一项：装好后第一次运行补齐，卸载由安装器删。
            if !autostart_launch {
                autostart::ensure_enabled();
            }

            power::keep_awake();
            migrate::run_at_startup(app.handle());
            tray::install(app.handle())?;
            hotkey::install(app.handle());
            server::boot(app.handle().clone());

            #[cfg(feature = "updater")]
            update::check_quiet_after(app.handle().clone(), 120);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::restart_server,
            commands::open_screen_window,
            commands::open_phone,
            commands::open_logs,
            commands::quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("ClassBeat 初始化失败（看 logs/app.log）")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                server::stop(app);
            }
        });
}

/// 唯一的退出路径：托盘、热键、页面「退出大屏」都走这里。
pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(st) = app.try_state::<AppState>() {
        if st.is_quitting() {
            return;
        }
        st.begin_quit();
    }
    logging::info("准备退出：先停后台服务");
    server::stop(app);
    app.exit(0);
}
