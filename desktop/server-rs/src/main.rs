//! ClassBeat 局域网服务 —— `rhythm_server.py` 的 Rust 等价实现。
//!
//! 为什么重写：旧版靠捆绑一个 22 MB 的 Python 运行时（`resources/python`）
//! 才能跑起来。安装包大、启动慢、杀软对「打包的 Python」格外敏感。
//! 这里用同一个进程内的 tokio 服务复刻全部端点，成品彻底不再依赖 Python。
//!
//! 等价性口径见 `docs/11-功能等价对比.md`：同一份数据目录、同一套请求脚本，
//! 两版响应逐字节比对。

mod backup;
mod messages;
mod pyjson;
mod resp;
mod routes;
mod state;
mod util;
mod win;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::connect_info::IntoMakeServiceWithConnectInfo;
use axum::Router;
use tokio::net::TcpListener;

use crate::state::{AppState, Paths};

const DEFAULT_PORT: u16 = 8765;
const PORT_SPAN: u16 = 10;

struct Args {
    host: String,
    port: u16,
    klass: Option<String>,
    update_url: Option<String>,
    update_interval: i64,
    wait_port: u64,
    base: Option<PathBuf>,
}

impl Default for Args {
    fn default() -> Self {
        Args {
            host: "0.0.0.0".into(),
            port: DEFAULT_PORT,
            klass: None,
            update_url: None,
            update_interval: 1800,
            wait_port: 0,
            base: None,
        }
    }
}

/// 手写参数解析：只要六个开关，不值得引一整个 clap。
fn parse_args() -> Result<Args, String> {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--port" => {
                a.port = it
                    .next()
                    .ok_or("--port 缺少取值")?
                    .parse()
                    .map_err(|_| "--port 要是数字")?
            }
            "--host" => a.host = it.next().ok_or("--host 缺少取值")?,
            "--class" => a.klass = Some(it.next().ok_or("--class 缺少取值")?),
            "--update-url" => a.update_url = Some(it.next().ok_or("--update-url 缺少取值")?),
            "--update-interval" => {
                a.update_interval = it
                    .next()
                    .ok_or("--update-interval 缺少取值")?
                    .parse()
                    .map_err(|_| "--update-interval 要是数字")?
            }
            "--wait-port" => {
                a.wait_port = it
                    .next()
                    .ok_or("--wait-port 缺少取值")?
                    .parse()
                    .map_err(|_| "--wait-port 要是数字")?
            }
            "--base" => a.base = Some(PathBuf::from(it.next().ok_or("--base 缺少取值")?)),
            "-h" | "--help" => {
                println!(
                    "用法: classbeat-server [--port 8765] [--host 0.0.0.0] [--class 五（1）班]\n\
                     \x20     [--update-url URL] [--update-interval 1800] [--wait-port 20] [--base 目录]"
                );
                std::process::exit(0);
            }
            other => return Err(format!("不认识的参数：{other}")),
        }
    }
    Ok(a)
}

fn base_dir(arg: &Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(b) = arg {
        return Ok(b.clone());
    }
    let exe = std::env::current_exe().map_err(|e| format!("拿不到程序路径：{e}"))?;
    if let Some(dir) = exe.parent() {
        return Ok(dir.to_path_buf());
    }
    std::env::current_dir().map_err(|e| format!("拿不到工作目录：{e}"))
}

/// 从 port 起找一个能绑的端口，被占就往后挪。
async fn bind_server(
    host: &str,
    port: u16,
    span: u16,
    wait: u64,
) -> Result<(TcpListener, u16), String> {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_secs(wait);
    #[allow(unused_assignments)]
    let mut last_err: Option<std::io::Error> = None;

    loop {
        match TcpListener::bind((host, port)).await {
            Ok(l) => {
                let actual = l.local_addr().map(|a| a.port()).unwrap_or(port);
                return Ok((l, actual));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                last_err = Some(e);
            }
            Err(e) => return Err(format!("绑定 {host}:{port} 失败：{e}")),
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    for p in (port + 1)..(port + span.max(1)) {
        match TcpListener::bind((host, p)).await {
            Ok(l) => {
                let actual = l.local_addr().map(|a| a.port()).unwrap_or(p);
                return Ok((l, actual));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                last_err = Some(e);
            }
            Err(e) => return Err(format!("绑定 {host}:{p} 失败：{e}")),
        }
    }
    Err(format!(
        "{port}–{} 都没有可用端口（{}）",
        port + span.max(1) - 1,
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "被占用".into())
    ))
}

#[tokio::main]
async fn main() {
    if let Err(msg) = run().await {
        eprintln!("{msg}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args = parse_args()?;
    let base = base_dir(&args.base)?;
    let paths = Paths::resolve(&base);
    paths.ensure();

    let state = Arc::new(AppState::new(paths));

    {
        let klass = args
            .klass
            .clone()
            .filter(|k| !k.is_empty())
            .unwrap_or_else(|| util::detect_class(&state.paths.install_root));
        let mut conf = state.conf.lock().unwrap_or_else(|e| e.into_inner());
        conf.klass = klass;
    }

    let update_url = args
        .update_url
        .clone()
        .filter(|u| !u.is_empty())
        .or_else(|| std::env::var("CLASSBEAT_UPDATE_URL").ok())
        .filter(|u| !u.is_empty())
        .unwrap_or_default();
    {
        let mut up = state.update.lock().unwrap_or_else(|e| e.into_inner());
        up.url = update_url;
        up.interval = args.update_interval;
    }

    messages::load(&state);

    let (listener, port) = bind_server(&args.host, args.port, PORT_SPAN, args.wait_port).await?;
    let ip = util::lan_ip();
    let lan = format!("http://{ip}:{port}");
    {
        let mut conf = state.conf.lock().unwrap_or_else(|e| e.into_inner());
        conf.port = port;
        conf.lan = lan.clone();
    }
    let (changed, last) = backup::note_address(&state, &lan);

    state.log("教室消息服务已启动");
    if port != args.port {
        state.log(&format!(
            "[!] {} 被别的程序占了，已改用 {port}（大屏会自动找过来）",
            args.port
        ));
    }
    if ip == "127.0.0.1" {
        state.log("[!] 没找到局域网地址，手机连不上。检查电脑是否连了 WiFi/网线。");
    }
    state.log(&format!("  手机打开  {lan}"));
    if changed {
        state.log(&format!(
            "[!] 地址和上次不同（上次是 {last}），钉钉里存的链接要重新复制"
        ));
    }
    state.log(&format!("  大屏同源  http://127.0.0.1:{port}/screen"));
    state.log(&format!("  本机自测  http://127.0.0.1:{port}/api/ping"));
    {
        let n = state
            .msgs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .messages
            .len();
        state.log(&format!("  已存消息  {n} 条"));
    }
    state.log("  端口就绪，等待请求");

    let app = Router::new()
        .fallback(routes::handle)
        .with_state(state.clone());
    let service: IntoMakeServiceWithConnectInfo<_, SocketAddr> =
        app.into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, service)
        .await
        .map_err(|e| format!("服务异常退出：{e}"))?;
    Ok(())
}
