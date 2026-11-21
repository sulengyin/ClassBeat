//! 服务的启动、健康检查与重启。
//!
//! 旧的 watchdog.ps1（395 行）干的所有事，这里只有三件：
//!   1. 用隐藏窗口起 pythonw（用户看不见任何控制台）；
//!   2. 轮询 /api/ping，确认服务真的在（不是"进程在"就算数）；
//!   3. 挂了就重启，连续失败就放慢，但绝不放弃——和 run.py 的语义一致。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::{config, logging, window, AppState};

pub struct ServerState {
    child: Mutex<Option<Child>>,
    stopping: AtomicBool,
}

impl ServerState {
    pub fn new() -> Self {
        ServerState { child: Mutex::new(None), stopping: AtomicBool::new(false) }
    }
    pub fn is_running(&self) -> bool {
        self.child.lock().map(|c| c.is_some()).unwrap_or(false)
    }
}

/// 启动线程：开机自启时先让系统安顿几秒（旧的看门狗也是这么做的），
/// 否则会和杀软、输入法、网卡驱动抢时间。
pub fn boot(app: AppHandle) {
    let autostart = app.state::<AppState>().autostart_launch;
    std::thread::spawn(move || {
        if autostart {
            std::thread::sleep(Duration::from_secs(8));
        }
        match start(&app) {
            Ok(port) => {
                app.state::<AppState>().set_port(port);
                logging::info(&format!("服务就绪：http://127.0.0.1:{port}/screen"));
                window::open_screen(&app, port);
                supervise(app, port);
            }
            Err(e) => {
                logging::error(&format!("服务启动失败：{e}"));
                window::show_error(&app, &e);
            }
        }
    });
}

fn start(app: &AppHandle) -> Result<u16, String> {
    let paths = {
        let st = app.state::<AppState>();
        st.paths.clone()
    };
    let _ = paths.ensure();

    let pythonw = std::env::var("CLASSBEAT_PYTHONW")
        .ok()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| paths.pythonw());
    if !pythonw.is_file() {
        return Err(format!(
            "缺少内置运行时：{}\n\n先运行 desktop/scripts/stage_resources.py 把 app/、server/、python 运行时装进 desktop/src-tauri/resources，再重新构建。",
            pythonw.display()
        ));
    }
    let script = paths.server_dir().join("rhythm_server.py");
    if !script.is_file() {
        return Err(format!("缺少服务脚本：{}", script.display()));
    }

    let port = config::pick_port();
    let mut cmd = Command::new(&pythonw);
    cmd.arg(&script)
        .arg("--port")
        .arg(port.to_string())
        .arg("--host")
        .arg("0.0.0.0")
        // 壳模式：不跑 PowerShell 看门狗交接、不抢程序内更新（见 docs/04-服务适配契约.md §4.1）
        .env("CLASSBEAT_SHELL", "1")
        .env("CLASSBEAT_DATA_DIR", &paths.data)
        // 程序目录可能只读（perMachine）：不许 Python 往里写 __pycache__
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .current_dir(paths.server_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| format!("拉起 pythonw 失败：{e}"))?;
    if let Ok(mut slot) = app.state::<AppState>().server.child.lock() {
        *slot = Some(child);
    }

    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        if let Some(actual) = ping(port) {
            return Ok(actual);
        }
        if Instant::now() > deadline {
            return Err("服务 25 秒没有响应 /api/ping（看 logs/server.log 与服务日志）".into());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// 打一次 /api/ping，返回服务自己报告的端口（可能因为端口顺延而与入参不同）。
fn ping(port: u16) -> Option<u16> {
    let addr = format!("127.0.0.1:{port}");
    let sock = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&sock, Duration::from_millis(600)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1200)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let req = format!("GET /api/ping HTTP/1.0\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::with_capacity(2048);
    let _ = stream.take(8192).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    if !text.starts_with("HTTP/") || !text.contains("200") || !text.contains("classbeat") {
        return None;
    }
    // 服务端 json.dumps 默认分隔符就是 `"port": 8765`，这里只取这一个数，
    // 不为一行数字引整个 JSON 解析器进依赖树。
    Some(json_u16(&text, "\"port\"").unwrap_or(port))
}

fn json_u16(text: &str, key: &str) -> Option<u16> {
    let at = text.find(key)? + key.len();
    let rest = &text[at..];
    let colon = rest.find(':')? + 1;
    let digits: String = rest[colon..]
        .chars()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// 每 5 秒看一次，连续 3 次不通就重启；重启失败就逐步放慢（最长 30 秒一次）。
fn supervise(app: AppHandle, mut port: u16) {
    let mut misses = 0u32;
    let mut backoff = 1u64;
    loop {
        std::thread::sleep(Duration::from_secs(5));
        {
            let st = app.state::<AppState>();
            if st.is_quitting() || st.server.stopping.load(Ordering::SeqCst) {
                return;
            }
        }
        match ping(port) {
            Some(p) => {
                port = p;
                misses = 0;
                backoff = 1;
            }
            None => {
                misses += 1;
                if misses < 3 {
                    continue;
                }
                logging::warn("服务连续 3 次无响应，准备重启");
                kill_child(&app);
                match start(&app) {
                    Ok(p) => {
                        if p != port {
                            // 端口顺延了：把大屏指到新地址，否则页面会一直空着
                            window::reload_screen(&app, p);
                        }
                        port = p;
                        app.state::<AppState>().set_port(p);
                        misses = 0;
                        backoff = 1;
                        logging::info(&format!("服务已重启：{p}"));
                    }
                    Err(e) => {
                        logging::error(&format!("重启失败（{} 秒后重试）：{e}", backoff));
                        std::thread::sleep(Duration::from_secs(backoff));
                        backoff = (backoff * 2).min(30);
                        misses = 2;
                    }
                }
            }
        }
    }
}

fn kill_child(app: &AppHandle) {
    if let Ok(mut slot) = app.state::<AppState>().server.child.lock() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 退出：先停服务再让进程走，别留孤儿 pythonw。
pub fn stop(app: &AppHandle) {
    if let Some(st) = app.try_state::<AppState>() {
        st.server.stopping.store(true, Ordering::SeqCst);
    }
    kill_child(app);
}
