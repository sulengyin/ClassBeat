//! 运行期验收（对应旧 `accept_runtime.py` 的 D1–D8）。
//!
//! 装好的应用自己跑一遍：服务就绪 → 大屏全屏 → 误关不退出 → 单实例叫回
//! → 最小化 → 服务被杀自愈 → 手机页可达 → 退出干净。
//!
//! 全部通过返回 0；有失败项返回 1。锁屏时合成按键那两项会被跳过。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const TITLE_MARK: &str = "班级节律屏";
const PORTS: std::ops::RangeInclusive<u16> = 8765..=8774;

pub struct Report {
    items: Vec<(String, bool, String)>,
    skips: Vec<(String, String)>,
}

impl Report {
    fn new() -> Self {
        Report {
            items: Vec::new(),
            skips: Vec::new(),
        }
    }
    fn add(&mut self, name: &str, ok: bool, detail: impl Into<String>) {
        let d = detail.into();
        println!("  {} {name}{}", if ok { "ok  " } else { "FAIL" }, if d.is_empty() { String::new() } else { format!("  （{d}）") });
        self.items.push((name.to_string(), ok, d));
    }
    fn skip(&mut self, name: &str, why: &str) {
        println!("  skip {name}  （{why}）");
        self.skips.push((name.to_string(), why.to_string()));
    }
}

pub fn run(exe: Option<&str>) -> Result<(), String> {
    let exe = match exe {
        Some(p) => std::path::PathBuf::from(p),
        None => default_exe()?,
    };
    if !exe.is_file() {
        return Err(format!("找不到主程序：{}", exe.display()));
    }
    println!("== ClassBeat 运行期验收 ==");
    println!("程序：{}\n", exe.display());

    let mut rep = Report::new();
    let locked = session_locked();
    if locked {
        println!("!! 会话已锁屏：最小化/退出要合成按键，这轮会跳过相关项。\n");
    }

    println!("== 启动 ==");
    let mut child: Child = Command::new(&exe)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动失败：{e}"))?;
    let pid = child.id();

    let (port, info) = wait_port(Duration::from_secs(30))?;
    rep.add(
        "服务就绪（壳模式）",
        info.get("shell").and_then(|v| v.as_bool()) == Some(true),
        format!("port={port} shell={:?}", info.get("shell")),
    );

    std::thread::sleep(Duration::from_secs(2));
    let hwnd = find_window();
    rep.add("大屏窗口存在", hwnd.is_some(), "");
    if let Some(h) = hwnd {
        let (w, ht) = window_size(h);
        let (sw, sh) = screen_size();
        rep.add(
            "大屏全屏（覆盖整屏）",
            w >= sw - 8 && ht >= sh - 8,
            format!("窗口 {w}x{ht} 屏幕 {sw}x{sh}"),
        );
        rep.add("大屏可见", is_visible(h), "");
    }

    println!("\n== D2 误关 ==");
    if let Some(h) = hwnd {
        post_close(h);
        std::thread::sleep(Duration::from_secs(3));
        let h2 = find_window();
        rep.add("误关后进程仍在", alive(pid), "");
        rep.add(
            "误关后窗口隐藏（不真退）",
            h2.map(|h| !is_visible(h)).unwrap_or(true),
            format!("hwnd={h2:?}"),
        );
    } else {
        rep.add("误关后进程仍在", false, "没有窗口可关");
    }

    println!("\n== 单实例再启 ==");
    let _second = Command::new(&exe)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    std::thread::sleep(Duration::from_secs(4));
    let h3 = find_window();
    rep.add(
        "再启一次 → 大屏回来",
        h3.map(is_visible).unwrap_or(false),
        format!("hwnd={h3:?}"),
    );
    let n = count_process("classbeat.exe");
    rep.add("只有一个 classbeat.exe", n == 1, format!("count={n}"));

    println!("\n== D3 最小化 ==");
    if locked {
        rep.skip("Ctrl+Alt+M 最小化/隐藏", "锁屏，合成按键到不了应用");
    } else {
        // 优先用服务自己的窗口控制（页面上「⋯ → 最小化」走的就是这条）
        let min = http(port, "POST", "/api/screen/minimize", None);
        let ok = min
            .as_ref()
            .map(|(code, body)| *code == 200 && body.contains("\"minimized\": 1"))
            .unwrap_or(false);
        std::thread::sleep(Duration::from_millis(800));
        let h4 = find_window();
        let minimized = h4.map(|h| is_iconic(h) || !is_visible(h)).unwrap_or(true);
        rep.add(
            "最小化（服务端窗口控制）",
            ok && minimized,
            format!("响应={min:?} hwnd={h4:?}"),
        );
        if let Some(h) = h4 {
            show_window(h, 9); // SW_RESTORE
            std::thread::sleep(Duration::from_millis(800));
        }
    }

    println!("\n== D6 服务自愈 ==");
    let kids = pids_by_name("classbeat-server.exe");
    rep.add("找到服务子进程", !kids.is_empty(), format!("{kids:?}"));
    if let Some(&kp) = kids.first() {
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &kp.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let t0 = Instant::now();
        let mut recovered = None;
        while t0.elapsed() < Duration::from_secs(25) {
            if let Some((code, _)) = http(port, "GET", "/api/ping", None) {
                if code == 200 {
                    recovered = Some(t0.elapsed().as_secs_f32());
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(700));
        }
        rep.add(
            "服务 25 秒内自愈",
            recovered.is_some(),
            match recovered {
                Some(s) => format!("耗时 {s:.1}s"),
                None => "未恢复".into(),
            },
        );
        rep.add("自愈后仍是同一个壳进程", alive(pid), "");
    }

    println!("\n== C4 手机页 ==");
    match http(port, "GET", "/phone", None) {
        Some((code, body)) => rep.add(
            "手机页可达",
            code == 200 && body.to_lowercase().contains("<html"),
            format!("{} 字节", body.len()),
        ),
        None => rep.add("手机页可达", false, "连接失败"),
    }

    println!("\n== D4 退出 ==");
    if locked {
        rep.skip("退出确认框 / 退出 / 无残留 / 端口释放", "锁屏；改用强制结束收尾");
        for p in pids_by_name("classbeat-server.exe") {
            let _ = Command::new("taskkill")
                .args(["/F", "/PID", &p.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = child.kill();
        std::thread::sleep(Duration::from_secs(2));
        rep.add("收尾：进程已结束", !alive(pid), "");
    } else {
        let resp = http(port, "POST", "/api/screen/exit", None);
        rep.add(
            "退出请求被接受",
            resp.as_ref().map(|(c, _)| *c == 200).unwrap_or(false),
            format!("{resp:?}"),
        );
        std::thread::sleep(Duration::from_secs(5));
        rep.add("退出后壳进程消失", !alive(pid), "");
        rep.add(
            "退出后服务无残留",
            pids_by_name("classbeat-server.exe").is_empty(),
            "",
        );
        rep.add(
            "壳的端口已释放",
            !port_listening(port),
            format!("port={port}"),
        );
    }

    let _ = child.wait();
    println!();
    let bad = rep.items.iter().filter(|(_, ok, _)| !ok).count();
    let tail = if rep.skips.is_empty() {
        String::new()
    } else {
        format!("，跳过 {} 项", rep.skips.len())
    };
    println!("共 {} 项，失败 {bad} 项{tail}", rep.items.len());
    if bad == 0 && rep.skips.is_empty() {
        Ok(())
    } else {
        Err("有失败或跳过项".into())
    }
}

fn default_exe() -> Result<std::path::PathBuf, String> {
    let local = std::env::var("LOCALAPPDATA").map_err(|_| "没有 LOCALAPPDATA")?;
    let p = std::path::PathBuf::from(local).join("ClassBeat").join("classbeat.exe");
    if p.is_file() {
        return Ok(p);
    }
    let pf = std::env::var("ProgramFiles").unwrap_or_default();
    let p2 = std::path::PathBuf::from(pf).join("ClassBeat").join("classbeat.exe");
    if p2.is_file() {
        return Ok(p2);
    }
    Err("找不到已安装的 classbeat.exe（用 --exe 指定）".into())
}

// ---------------------------------------------------------------- HTTP

fn http(port: u16, method: &str, path: &str, body: Option<&str>) -> Option<(u16, String)> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(1500)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_millis(4000)));
    let payload = body.unwrap_or("");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: {}\r\nContent-Type: application/json\r\n\r\n{payload}",
        payload.len()
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).to_string();
    let code = text
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())?;
    let body = match text.find("\r\n\r\n") {
        Some(i) => text[i + 4..].to_string(),
        None => String::new(),
    };
    Some((code, body))
}

fn wait_port(timeout: Duration) -> Result<(u16, serde_json::Value), String> {
    let t0 = Instant::now();
    while t0.elapsed() < timeout {
        for port in PORTS {
            if let Some((code, body)) = http(port, "GET", "/api/ping", None) {
                if code == 200 {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                        if v.get("app").and_then(|a| a.as_str()) == Some("classbeat") {
                            return Ok((port, v));
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err("30 秒内没等到 /api/ping".into())
}

fn port_listening(port: u16) -> bool {
    TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_millis(600),
    )
    .is_ok()
}

// ---------------------------------------------------------------- 进程

fn alive(pid: u32) -> bool {
    pids_by_name("classbeat.exe").contains(&pid)
}

fn count_process(name: &str) -> usize {
    pids_by_name(name).len()
}

#[cfg(windows)]
fn pids_by_name(name: &str) -> Vec<u32> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    unsafe {
        let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return out,
        };
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let exe = String::from_utf16_lossy(&entry.szExeFile[..end]);
                if exe.eq_ignore_ascii_case(name) {
                    out.push(entry.th32ProcessID);
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snap);
    }
    out
}

#[cfg(not(windows))]
fn pids_by_name(_name: &str) -> Vec<u32> {
    Vec::new()
}

// ---------------------------------------------------------------- 窗口

#[cfg(windows)]
mod ui {
    use std::ffi::c_void;

    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetSystemMetrics, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        IsIconic, IsWindowVisible, PostMessageW, ShowWindow, SM_CXSCREEN, SM_CYSCREEN, SW_RESTORE,
        WM_CLOSE, WM_COMMAND,
    };

    pub const TITLE_MARK: &str = super::TITLE_MARK;

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<(isize, String)>);
        if IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            let n = GetWindowTextLengthW(hwnd);
            if n > 0 {
                let mut buf = vec![0u16; n as usize + 1];
                let got = GetWindowTextW(hwnd, &mut buf);
                if got > 0 {
                    let t = String::from_utf16_lossy(&buf[..got as usize]);
                    if t.contains(TITLE_MARK) {
                        out.push((hwnd.0 as isize, t));
                    }
                }
            }
        }
        TRUE
    }

    pub fn find() -> Option<isize> {
        let mut out: Vec<(isize, String)> = Vec::new();
        unsafe {
            let _ = EnumWindows(
                Some(collect),
                LPARAM(&mut out as *mut Vec<(isize, String)> as isize),
            );
        }
        out.first().map(|(h, _)| *h)
    }

    fn hwnd(h: isize) -> HWND {
        HWND(h as *mut c_void)
    }

    pub fn visible(h: isize) -> bool {
        unsafe { IsWindowVisible(hwnd(h)).as_bool() }
    }

    pub fn iconic(h: isize) -> bool {
        unsafe { IsIconic(hwnd(h)).as_bool() }
    }

    pub fn size(h: isize) -> (i32, i32) {
        let mut r = RECT::default();
        unsafe {
            if GetWindowRect(hwnd(h), &mut r).is_ok() {
                return (r.right - r.left, r.bottom - r.top);
            }
        }
        (0, 0)
    }

    pub fn screen() -> (i32, i32) {
        unsafe {
            (
                GetSystemMetrics(SM_CXSCREEN),
                GetSystemMetrics(SM_CYSCREEN),
            )
        }
    }

    pub fn close(h: isize) {
        unsafe {
            let _ = PostMessageW(Some(hwnd(h)), WM_CLOSE, Default::default(), Default::default());
        }
    }

    pub fn command(h: isize, id: usize) {
        unsafe {
            let _ = PostMessageW(
                Some(hwnd(h)),
                WM_COMMAND,
                windows::Win32::Foundation::WPARAM(id),
                Default::default(),
            );
        }
    }

    pub fn show(h: isize, cmd: i32) {
        unsafe {
            let c = if cmd == 9 {
                SW_RESTORE
            } else {
                windows::Win32::UI::WindowsAndMessaging::SHOW_WINDOW_CMD(cmd)
            };
            let _ = ShowWindow(hwnd(h), c);
        }
    }
}

#[cfg(windows)]
fn find_window() -> Option<isize> {
    ui::find()
}
#[cfg(windows)]
fn is_visible(h: isize) -> bool {
    ui::visible(h)
}
#[cfg(windows)]
fn is_iconic(h: isize) -> bool {
    ui::iconic(h)
}
#[cfg(windows)]
fn window_size(h: isize) -> (i32, i32) {
    ui::size(h)
}
#[cfg(windows)]
fn screen_size() -> (i32, i32) {
    ui::screen()
}
#[cfg(windows)]
fn post_close(h: isize) {
    ui::close(h)
}
#[cfg(windows)]
fn show_window(h: isize, cmd: i32) {
    ui::show(h, cmd)
}

#[cfg(not(windows))]
fn find_window() -> Option<isize> {
    None
}
#[cfg(not(windows))]
fn is_visible(_h: isize) -> bool {
    false
}
#[cfg(not(windows))]
fn is_iconic(_h: isize) -> bool {
    false
}
#[cfg(not(windows))]
fn window_size(_h: isize) -> (i32, i32) {
    (0, 0)
}
#[cfg(not(windows))]
fn screen_size() -> (i32, i32) {
    (0, 0)
}
#[cfg(not(windows))]
fn post_close(_h: isize) {}
#[cfg(not(windows))]
fn show_window(_h: isize, _cmd: i32) {}

/// 锁屏检测：没有前台窗口且输入桌面打不开，合成按键送不到应用。
#[cfg(windows)]
fn session_locked() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe {
        let fg = GetForegroundWindow();
        let _ = fg;
        // 输入桌面打不开 = 锁屏；这里只做保守判断：没有前台窗口就当作锁屏
        fg.0.is_null()
    }
}

#[cfg(not(windows))]
fn session_locked() -> bool {
    true
}

/// 给外部（文档里的手工验收）留个提示：界面上的「退出」确认框按钮是 IDYES。
pub const IDYES: usize = 6;
#[allow(dead_code)]
fn _unused(h: isize) {
    #[cfg(windows)]
    ui::command(h, IDYES);
}
