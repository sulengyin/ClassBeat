//! 把整个大屏内联成**一个** html 文件。
//!
//! 为什么还要这个形态：分享给同事、或者机器上不让装软件时，一个文件双击就能开，
//! 不用解压、不用管相对路径。代价是没有手机发消息的服务端（那需要桌面版）。
//!
//! 以前这是 `tools/package.py:build_single`（Python）。那套打包器同时负责
//! python-embed 运行时、.bat 启动器、看门狗、自解压安装器——0.5.3 起全部退役，
//! 只把「单文件」这一个还有人用的能力搬到这里，于是打演示包不再需要 Python，
//! 也不再需要维护第二份 `data.js` 生成逻辑（直接用 `bundle::build_payload`）。
//!
//! 内联规则刻意和旧的 Python 版保持一致：
//!   · `<link rel="stylesheet" href="x.css">` → `<style>…</style>`
//!   · `<script src="x.js"></script>`      → `<script>…</script>`
//!   · 代码里出现 `</script>` 要转义成 `<\/script>`，否则会提前截断标签
//!   · `version.js` 用 `--version` / `--build` 重写，仓库里的源文件不动

use std::path::{Path, PathBuf};

use crate::bundle;

/// 要内联的 JS，顺序与 `app/index.html` 里的 `<script src>` 顺序一致。
const APP_JS: &[&str] = &[
    "version.js",
    "engine/schedule.js",
    "vendor/qrcode.min.js",
    "qr.js",
    "clock.js",
    "config.js",
    "subjects.js",
    "rhythm.js",
    "pinyin.js",
    "store.js",
    "runtime.js",
    "screen.js",
    "templates.js",
    "setup.js",
    "remote.js",
    "phoneui.js",
    "edit.js",
    "update.js",
    "backup.js",
    "demo.js",
];

/// 样式：主样式写在 index.html 里，编辑面板和向导各有一份。
const APP_CSS: &[&str] = &["edit.css", "setup.css"];

pub struct Options {
    pub data: Option<String>,
    pub out: PathBuf,
    pub version: Option<String>,
    pub build: Option<String>,
}

pub fn run(opt: &Options, repo: &Path) -> Result<(), String> {
    let app = repo.join("app");
    let data_dir = bundle::resolve_data_dir(opt.data.as_deref(), repo)?;
    let payload = bundle::build_payload(&data_dir)?;
    let data_js = bundle::render_data_js(&payload)?;

    let ver_src = std::fs::read_to_string(app.join("version.js"))
        .map_err(|e| format!("读不了 app/version.js：{e}"))?;
    let version = opt
        .version
        .clone()
        .or_else(|| grab(&ver_src, "var VERSION = \""))
        .unwrap_or_else(|| "0.0.0".into());
    let build = opt
        .build
        .clone()
        .or_else(|| git_short(repo))
        .unwrap_or_else(|| "dev".into());

    let mut html = std::fs::read_to_string(app.join("index.html"))
        .map_err(|e| format!("读不了 app/index.html：{e}"))?;

    for name in APP_CSS {
        let css = std::fs::read_to_string(app.join(name))
            .map_err(|e| format!("读不了 app/{name}：{e}"))?;
        let needle = format!("<link rel=\"stylesheet\" href=\"{name}\">");
        if !html.contains(&needle) {
            return Err(format!(
                "app/index.html 里没有 {needle}：模板改过了，内联规则要跟着改"
            ));
        }
        html = html.replace(&needle, &format!("<style>\n{css}\n</style>"));
    }

    for name in APP_JS {
        let code = if *name == "version.js" {
            stamp_version(&ver_src, &version, &build)
        } else {
            std::fs::read_to_string(app.join(name))
                .map_err(|e| format!("读不了 app/{name}：{e}"))?
        };
        // 代码里若出现 </script> 会提前结束标签
        let code = code.replace("</script>", "<\\/script>");
        let needle = format!("<script src=\"{name}\"></script>");
        if !html.contains(&needle) {
            return Err(format!(
                "app/index.html 里没有 {needle}：页面引用的脚本和单文件清单对不上"
            ));
        }
        html = html.replace(&needle, &format!("<script>\n{code}\n</script>"));
    }

    // data.js 不是磁盘上的文件（运行时生成的），单独处理
    let needle = "<script src=\"data.js\"></script>";
    if !html.contains(needle) {
        return Err("app/index.html 里没有 data.js 的引用".into());
    }
    html = html.replace(needle, &format!("<script>\n{data_js}</script>"));

    // 还剩下 <script src> 说明模板新增了脚本而清单没跟上——宁可失败也别出半个包
    if let Some(pos) = html.find("<script src=") {
        let tail: String = html[pos..].chars().take(80).collect();
        return Err(format!(
            "内联后仍有多余的外部脚本引用：{tail}…（把新文件名加进 src/single.rs 的 APP_JS）"
        ));
    }

    let out = if opt.out.is_absolute() {
        opt.out.clone()
    } else {
        repo.join(&opt.out)
    };
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&out, html.as_bytes()).map_err(|e| format!("写不进 {}：{e}", out.display()))?;

    let kb = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0) as f64 / 1024.0;
    println!(
        "已生成 {}：单文件 {kb:.0} KB（v{version} · {build}，数据来自 {}）",
        out.display(),
        data_dir.display()
    );
    println!("注意：单文件版没有手机发消息的服务端，也没有自动更新；要看这两样请用安装包。");
    Ok(())
}

/// `var XXX = "…"` 里的值。
fn grab(src: &str, prefix: &str) -> Option<String> {
    let start = src.find(prefix)? + prefix.len();
    let rest = &src[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// 把 VERSION / BUILD 两行换成真实值（只改前两处，其余不动）。
fn stamp_version(src: &str, version: &str, build: &str) -> String {
    let mut out = src.to_string();
    for (prefix, value) in [("var VERSION = \"", version), ("var BUILD = \"", build)] {
        if let Some(pos) = out.find(prefix) {
            let start = pos + prefix.len();
            if let Some(len) = out[start..].find('"') {
                out.replace_range(start..start + len, value);
            }
        }
    }
    out
}

/// 构建号取 git 短 SHA；没有 git（或不在仓库里）就留 dev。
fn git_short(repo: &Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(repo)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grabs_between_quotes() {
        let src = "  var VERSION = \"0.3.27\";\n  var BUILD = \"dev\";\n";
        assert_eq!(grab(src, "var VERSION = \"").as_deref(), Some("0.3.27"));
        assert_eq!(grab(src, "var BUILD = \"").as_deref(), Some("dev"));
    }

    #[test]
    fn stamps_only_the_two_lines() {
        let src = "var VERSION = \"0.3.27\";\nvar BUILD = \"dev\";\nvar X = \"dev\";\n";
        let out = stamp_version(src, "0.5.3", "abc1234");
        assert!(out.contains("var VERSION = \"0.5.3\""));
        assert!(out.contains("var BUILD = \"abc1234\""));
        assert!(out.contains("var X = \"dev\""), "别的行不能动：{out}");
    }
}
