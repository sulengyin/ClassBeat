//! ClassBeat 构建与验收工具。
//!
//! 取代 `desktop/scripts/*.py` 与 `tools/bundle.py`：装配资源、打包配置包、
//! 自检、生成更新清单、跑验收。仓库里不再需要 Python 才能构建桌面版。
//!
//!     classbeat-tools stage [--data sample] [--clean] [--check-only]
//!     classbeat-tools bundle [--data DIR] [--out FILE]
//!     classbeat-tools verify
//!     classbeat-tools accept [--exe 主程序路径]

mod accept;
mod bundle;
mod make_latest;
mod stage;
mod verify;

use std::path::{Path, PathBuf};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("{USAGE}");
        std::process::exit(2);
    }
    let cmd = args.remove(0);
    let repo = match find_repo() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };

    let result = match cmd.as_str() {
        "stage" => {
            let (data, clean, check_only) = parse_stage_args(&args);
            stage::run(&repo, &data, clean, check_only)
        }
        "bundle" => {
            let (data, out) = parse_bundle_args(&args);
            bundle::run(data.as_deref(), out.as_deref(), &repo)
        }
        "make-latest" => match parse_make_latest_args(&args) {
            Ok(opt) => make_latest::run(&opt),
            Err(e) => Err(e),
        },
        "verify" => verify::run(&repo),
        "accept" => {
            let mut exe: Option<String> = None;
            let mut i = 0;
            while i < args.len() {
                if args[i] == "--exe" && i + 1 < args.len() {
                    exe = Some(args[i + 1].clone());
                    i += 1;
                }
                i += 1;
            }
            accept::run(exe.as_deref())
        }
        "-h" | "--help" | "help" => {
            println!("{USAGE}");
            Ok(())
        }
        other => Err(format!("不认识的子命令：{other}\n\n{USAGE}")),
    };

    if let Err(e) = result {
        eprintln!("[失败] {e}");
        std::process::exit(1);
    }
}

const USAGE: &str = "用法:
  classbeat-tools stage [--data sample] [--clean] [--check-only]
  classbeat-tools bundle [--data DIR] [--out FILE]
  classbeat-tools verify
  classbeat-tools accept [--exe 主程序路径]
  classbeat-tools make-latest --bundle DIR --version X.Y.Z --base-url URL --out FILE [--notes 文本] [--pub-date ISO]";

fn parse_stage_args(args: &[String]) -> (String, bool, bool) {
    let mut data = "sample".to_string();
    let mut clean = false;
    let mut check_only = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--data" => {
                if i + 1 < args.len() {
                    data = args[i + 1].clone();
                    i += 1;
                }
            }
            "--clean" => clean = true,
            "--check-only" => check_only = true,
            _ => {}
        }
        i += 1;
    }
    (data, clean, check_only)
}

fn parse_make_latest_args(args: &[String]) -> Result<make_latest::Options, String> {
    let mut bundle = None;
    let mut version = None;
    let mut base_url = None;
    let mut notes = String::new();
    let mut out = None;
    let mut pub_date = None;
    let mut i = 0;
    while i < args.len() {
        let v = args.get(i + 1).cloned();
        match args[i].as_str() {
            "--bundle" => {
                bundle = v;
                i += 1;
            }
            "--version" => {
                version = v;
                i += 1;
            }
            "--base-url" => {
                base_url = v;
                i += 1;
            }
            "--notes" => {
                notes = v.unwrap_or_default();
                i += 1;
            }
            "--out" => {
                out = v;
                i += 1;
            }
            "--pub-date" => {
                pub_date = v;
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    let bundle = bundle.ok_or("make-latest 缺少 --bundle")?;
    let version = version.ok_or("make-latest 缺少 --version")?;
    let base_url = base_url.ok_or("make-latest 缺少 --base-url")?;
    let out = out.ok_or("make-latest 缺少 --out")?;
    Ok(make_latest::Options {
        bundle: PathBuf::from(bundle),
        version,
        base_url,
        notes,
        out: PathBuf::from(out),
        pub_date,
    })
}

fn parse_bundle_args(args: &[String]) -> (Option<String>, Option<String>) {
    let mut data = None;
    let mut out = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--data" if i + 1 < args.len() => {
                data = Some(args[i + 1].clone());
                i += 1;
            }
            "--out" if i + 1 < args.len() => {
                out = Some(args[i + 1].clone());
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    (data, out)
}

/// 从 exe 位置或当前目录往上找仓库根（含 `app/version.js` 与 `desktop/src-tauri`）。
fn find_repo() -> Result<PathBuf, String> {
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            starts.push(d.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    for start in starts {
        let mut cur: Option<&Path> = Some(start.as_path());
        let mut depth = 0;
        while let Some(dir) = cur {
            if dir.join("app").join("version.js").is_file()
                && dir.join("desktop").join("src-tauri").is_dir()
            {
                return Ok(dir.to_path_buf());
            }
            cur = dir.parent();
            depth += 1;
            if depth > 8 {
                break;
            }
        }
    }
    Err("找不到仓库根（需要一个含 app/version.js 与 desktop/src-tauri 的目录）".into())
}
