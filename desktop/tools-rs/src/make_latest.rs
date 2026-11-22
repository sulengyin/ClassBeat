//! 生成 tauri-plugin-updater 用的 `latest.json`。
//!
//! 一个源一份文件：URL 写死在 JSON 里，所以「加速域名 + GitHub 双源」就是
//! 同一份签名、两份 JSON（只差 url），客户端的 endpoints 按顺序试。
//!
//! 只放**已签名**的安装包：找不到 `.sig` 直接失败，不让没验签的包混进更新源。

use std::path::{Path, PathBuf};

pub struct Options {
    pub bundle: PathBuf,
    pub version: String,
    pub base_url: String,
    pub notes: String,
    pub out: PathBuf,
    pub pub_date: Option<String>,
}

const PLATFORM: &str = "windows-x86_64";

pub fn run(opt: &Options) -> Result<(), String> {
    let artifact = pick_artifact(&opt.bundle, &opt.version)?;
    let sig_path = PathBuf::from(format!("{}.sig", artifact.display()));
    if !sig_path.is_file() {
        return Err(format!(
            "缺少签名文件 {}：请带 TAURI_SIGNING_PRIVATE_KEY 重新构建（bundle.createUpdaterArtifacts 必须为 true）。",
            sig_path.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    let signature = std::fs::read_to_string(&sig_path)
        .map_err(|e| format!("读签名失败：{e}"))?
        .trim()
        .to_string();
    if signature.is_empty() {
        return Err(format!(
            "{} 是空的",
            sig_path.file_name().unwrap_or_default().to_string_lossy()
        ));
    }

    let pub_date = opt
        .pub_date
        .clone()
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());
    let url = format!(
        "{}/{}",
        opt.base_url.trim_end_matches('/'),
        artifact.file_name().unwrap_or_default().to_string_lossy()
    );

    let data = serde_json::json!({
        "version": opt.version,
        "notes": opt.notes,
        "pub_date": pub_date,
        "platforms": {
            PLATFORM: {
                "signature": signature,
                "url": url,
            }
        },
    });
    if let Some(parent) = opt.out.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&data).map_err(|e| format!("序列化失败：{e}"))?
    );
    std::fs::write(&opt.out, text.as_bytes()).map_err(|e| format!("写不进 {}：{e}", opt.out.display()))?;

    let size = std::fs::metadata(&artifact).map(|m| m.len()).unwrap_or(0) as f64 / 1048576.0;
    println!(
        "安装包  : {}  ({size:.2} MB)",
        artifact.file_name().unwrap_or_default().to_string_lossy()
    );
    println!("签名文件: {}", sig_path.file_name().unwrap_or_default().to_string_lossy());
    println!("写入    : {}", opt.out.display());
    println!("指向    : {url}");
    Ok(())
}

/// 优先 `.nsis.zip`（updater 首选），没有就退到 `-setup.exe`。
/// 目录里常躺着多个版本，所以先按版本号过滤。
fn pick_artifact(dir: &Path, version: &str) -> Result<PathBuf, String> {
    let mut cands: Vec<PathBuf> = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("读不了 {}：{e}", dir.display()))?;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(".nsis.zip") || name.ends_with("-setup.exe") {
            cands.push(e.path());
        }
    }
    if cands.is_empty() {
        return Err(format!(
            "在 {} 下没找到 *.nsis.zip 或 *-setup.exe",
            dir.display()
        ));
    }
    // .nsis.zip 优先于 -setup.exe
    cands.sort_by_key(|p| {
        let n = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        (!n.ends_with(".nsis.zip"), n)
    });
    if !version.is_empty() {
        let hit: Vec<PathBuf> = cands
            .iter()
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().contains(&format!("_{version}_")))
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        if hit.is_empty() {
            let names: Vec<String> = cands
                .iter()
                .map(|p| p.file_name().unwrap_or_default().to_string_lossy().to_string())
                .collect();
            return Err(format!(
                "{} 下没有版本 {version} 的安装包（现有：{}）",
                dir.display(),
                names.join(", ")
            ));
        }
        return Ok(hit[0].clone());
    }
    Ok(cands[0].clone())
}
