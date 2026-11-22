//! 资源装配：把前端、服务程序、出厂数据装进 `src-tauri/resources`。
//!
//! 与旧 Python 版最大的不同：**不再往包里塞 Python 运行时，也不再给服务打
//! 环境变量补丁**。服务本身就是 Rust 二进制（`classbeat-server.exe`），
//! 壳模式、数据目录重定向都是它自己的原生行为。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Map, Value};

pub fn run(repo: &Path, data_arg: &str, clean: bool, check_only: bool) -> Result<(), String> {
    let desktop = repo.join("desktop");
    let resources = desktop.join("src-tauri").join("resources");
    let server_exe = desktop
        .join("server-rs")
        .join("target")
        .join("release")
        .join("classbeat-server.exe");

    let data_dir = {
        let p = PathBuf::from(data_arg);
        if p.is_absolute() {
            p
        } else {
            repo.join(data_arg)
        }
    };

    println!("== ClassBeat 资源装配 ==");
    println!("仓库：{}", repo.display());
    println!("目标：{}", resources.display());

    if check_only {
        println!("\n[1/3] 校验服务程序");
        if server_exe.is_file() {
            let size = std::fs::metadata(&server_exe).map(|m| m.len()).unwrap_or(0);
            println!("  · {} ok（{} 字节）", server_exe.display(), size);
        } else {
            println!(
                "  ! 缺少 {} —— 先 cargo build --release --manifest-path desktop/server-rs/Cargo.toml",
                server_exe.display()
            );
        }
        println!("\n[2/3] 校验前端");
        for f in ["index.html", "screen.js", "version.js"] {
            let p = repo.join("app").join(f);
            println!("  · {f} {}", if p.is_file() { "ok" } else { "缺失" });
        }
        println!("\n[3/3] 校验服务静态资源");
        for f in ["phone.html", "sw.js"] {
            let p = repo.join("server").join(f);
            println!("  · {f} {}", if p.is_file() { "ok" } else { "缺失" });
        }
        for f in ["icon-192.png", "icon-512.png"] {
            let p = repo.join("server").join("icons").join(f);
            println!("  · icons/{f} {}", if p.is_file() { "ok" } else { "缺失" });
        }
        println!("\n仅校验，未写入任何文件。");
        return Ok(());
    }

    if !data_dir.is_dir() {
        return Err(format!("数据目录不存在：{}", data_dir.display()));
    }
    if !server_exe.is_file() {
        return Err(format!(
            "缺少服务程序：{}\n先跑 cargo build --release --manifest-path desktop/server-rs/Cargo.toml",
            server_exe.display()
        ));
    }

    if clean && resources.exists() {
        std::fs::remove_dir_all(&resources).map_err(|e| format!("清空 resources 失败：{e}"))?;
    }

    // 0.4.x 起服务是 Rust 二进制：旧装配出来的 python 运行时必须清掉，
    // 否则安装包会白白胖 22 MB，也是这次重构要消灭的东西。
    let legacy_py = resources.join("python");
    if legacy_py.exists() {
        std::fs::remove_dir_all(&legacy_py).map_err(|e| format!("清理旧的 Python 运行时失败：{e}"))?;
        println!("  · 已移除遗留的 resources/python");
    }

    println!("\n[1/5] 复制前端与服务静态资源");
    fresh(&resources.join("app"))?;
    copy_dir(&repo.join("app"), &resources.join("app"))?;
    fresh(&resources.join("server"))?;
    // 服务端只需要这三样：手机页、Service Worker、图标。旧的 .py 不再进包。
    for name in ["phone.html", "sw.js"] {
        std::fs::copy(repo.join("server").join(name), resources.join("server").join(name))
            .map_err(|e| format!("复制 {name} 失败：{e}"))?;
    }
    copy_dir(&repo.join("server").join("icons"), &resources.join("server").join("icons"))?;

    copy_dir(&repo.join("sample"), &resources.join("sample"))?;
    copy_dir(&data_dir, &resources.join("data"))?;

    println!("\n[2/5] 把 build 号写进 app/version.js");
    let sha = git_sha(repo);
    let vjs = resources.join("app").join("version.js");
    let txt = std::fs::read_to_string(&vjs).map_err(|e| format!("读 version.js 失败：{e}"))?;
    if sha.is_empty() {
        println!("  · 取不到 git 提交号（不是 git 仓库？）跳过");
    } else {
        let new = replace_build(&txt, &sha);
        if new != txt {
            std::fs::write(&vjs, new).map_err(|e| format!("写 version.js 失败：{e}"))?;
            println!("  · BUILD → {sha}");
        } else {
            println!("  · BUILD 已有具体值，保持不变");
        }
    }

    println!("\n[3/5] 生成 app/data.js");
    super::bundle::run(
        Some(&data_dir.to_string_lossy()),
        Some(&resources.join("app").join("data.js").to_string_lossy()),
        repo,
    )?;

    println!("\n[4/5] 装配服务程序");
    let dst = resources.join("server").join("classbeat-server.exe");
    std::fs::copy(&server_exe, &dst).map_err(|e| format!("复制服务程序失败：{e}"))?;
    let size = std::fs::metadata(&dst).map(|m| m.len()).unwrap_or(0);
    println!("  · classbeat-server.exe 就位（{size} 字节）");

    println!("\n[5/5] 写 build-info.json");
    let (version, build) = read_version(repo);
    let mut info = Map::new();
    info.insert("product".into(), json!("ClassBeat"));
    info.insert("version".into(), json!(version));
    info.insert(
        "build".into(),
        json!(if build == "dev" || build.is_empty() {
            sha
        } else {
            build
        }),
    );
    info.insert(
        "bundledAt".into(),
        json!(chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string()),
    );
    info.insert("dataSource".into(), json!(data_dir.to_string_lossy()));
    info.insert("service".into(), json!("rust"));
    let text = serde_json::to_string_pretty(&Value::Object(info.clone()))
        .map_err(|e| format!("序列化 build-info 失败：{e}"))?;
    std::fs::write(resources.join("build-info.json"), text.as_bytes())
        .map_err(|e| format!("写 build-info.json 失败：{e}"))?;
    println!("{text}");
    println!("\n装配完成。下一步：npx tauri build");
    Ok(())
}

fn fresh(p: &Path) -> Result<(), String> {
    if p.exists() {
        std::fs::remove_dir_all(p).map_err(|e| format!("清空 {} 失败：{e}", p.display()))?;
    }
    std::fs::create_dir_all(p).map_err(|e| format!("建 {} 失败：{e}", p.display()))
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Err(format!("不是目录：{}", src.display()));
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("建 {} 失败：{e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("读 {} 失败：{e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == "__pycache__" || name_str.ends_with(".pyc") {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)
                .map_err(|e| format!("复制 {} 失败：{e}", from.display()))?;
        }
    }
    Ok(())
}

/// `var BUILD = "dev"` → 提交号；已有具体值就不动。
fn replace_build(src: &str, sha: &str) -> String {
    let key = "var BUILD = \"";
    let Some(at) = src.find(key).map(|i| i + key.len()) else {
        return src.to_string();
    };
    let rest = &src[at..];
    let Some(end) = rest.find('"') else {
        return src.to_string();
    };
    let cur = &rest[..end];
    if !cur.is_empty() && cur != "dev" {
        return src.to_string();
    }
    format!("{}{}{}", &src[..at], sha, &rest[end..])
}

pub fn git_sha(repo: &Path) -> String {
    let out = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(repo)
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

fn read_version(repo: &Path) -> (String, String) {
    let js = std::fs::read_to_string(repo.join("app").join("version.js")).unwrap_or_default();
    (grab(&js, "var VERSION = \""), grab(&js, "var BUILD = \""))
}

fn grab(src: &str, key: &str) -> String {
    match src.find(key) {
        Some(at) => {
            let rest = &src[at + key.len()..];
            match rest.find('"') {
                Some(end) => rest[..end].to_string(),
                None => String::new(),
            }
        }
        None => String::new(),
    }
}
