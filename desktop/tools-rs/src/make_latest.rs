//! 生成 tauri-plugin-updater 用的 `latest.json`。
//!
//! 一个源一份文件：URL 写死在 JSON 里，所以「加速域名 + GitHub 双源」就是
//! 同一份签名、两份 JSON（只差 url），客户端的 endpoints 按顺序试。
//!
//! 只放**已签名**的安装包：找不到 `.sig` 直接失败，不让没验签的包混进更新源。
//!
//! `notes` 是给老师看的一句话。大屏的更新面板用 `textContent` 渲染，换行会
//! 塌成一整段，所以这里要么由调用方给现成的句子（`--notes`），要么给一份
//! 写给人看的 Markdown（`--notes-file`，通常是 `CHANGELOG.md`）由
//! [`notes_from_changelog`] 压成一行——直接塞 `head -30 CHANGELOG.md`
//! 会让面板显示成 "## 0.5.2 — 2026-11-22 - 修掉… - …" 这样一串符号。

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
    println!("说明    : {}", opt.notes);
    Ok(())
}

/// 把 CHANGELOG 的**第一节**压成一行纯文本，给更新面板显示。
///
/// 规则刻意保守（只做能一眼验证的变换）：
/// - 只取第一个 `## ` 小节（`# 更新记录` 这种一级标题本身不要）；
/// - `- ` 开头的条目按「；」连起来，散在换行上的续行并回上一条；
/// - 去掉 `**粗体**`、`` `代码` `` 的记号，`[文字](链接)` 只留文字；
/// - 前缀用**安装包版本**（`--version`），因为 CHANGELOG 的小节号是界面版本，
///   两者现在不是一回事；
/// - 超过 `max_chars` 就在最近的「；」处截断并补省略号，不硬切半个句子。
pub fn notes_from_changelog(text: &str, version: &str, max_chars: usize) -> String {
    let mut items: Vec<String> = Vec::new();
    let mut in_section = false;
    let mut seen_heading = false;

    for raw in text.lines() {
        let line = raw.trim_end();
        if line.starts_with("## ") {
            if seen_heading {
                break; // 第二节开始，停
            }
            seen_heading = true;
            in_section = true;
            continue;
        }
        if !in_section {
            continue;
        }
        let t = line.trim();
        if t.is_empty() || t == "---" {
            continue;
        }
        if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            items.push(rest.to_string());
        } else if t.starts_with('#') {
            continue;
        } else if let Some(last) = items.last_mut() {
            // 自动折行的续行：中日文直接接上，跨到西文边界时补一个空格
            // （CHANGELOG 里「解压即用的」+「zip」这种折行，接出来要像"的 zip"）
            let need_space = last
                .chars()
                .last()
                .map(|c| c.is_ascii_alphanumeric())
                .unwrap_or(false)
                || t.chars()
                    .next()
                    .map(|c| c.is_ascii_alphanumeric())
                    .unwrap_or(false);
            if need_space {
                last.push(' ');
            }
            last.push_str(t);
        } else {
            items.push(t.to_string());
        }
    }

    // 每条末尾的句号/分号去掉，否则拼起来会出现「。；」
    let cleaned: Vec<String> = items
        .iter()
        .map(|s| {
            strip_inline_markup(s)
                .trim_end_matches(['。', '；', '，', '、', ' '])
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect();

    let mut body = cleaned.join("；");
    if body.ends_with('。') || body.ends_with('；') {
        body.pop();
    }

    let prefix = if version.is_empty() {
        String::new()
    } else {
        format!("{version}：")
    };
    truncate_sentence(&format!("{prefix}{body}"), max_chars)
}

/// `**粗体**` / `` `代码` `` / `[文字](url)` → 纯文字，连续空白压成一个。
fn strip_inline_markup(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' | '`' => {} // 记号直接丢，星号在正文里不出现
            '#' if matches!(chars.peek(), Some('#') | Some(' ')) => {
                // 正文里夹着的 "## 0.5.2" 是 Markdown 残留：标记丢掉，内容留下
            }
            '[' => {
                // [文字](链接)：留文字
                let mut label = String::new();
                let mut closed = false;
                for c2 in chars.by_ref() {
                    if c2 == ']' {
                        closed = true;
                        break;
                    }
                    label.push(c2);
                }
                if closed {
                    if chars.peek() == Some(&'(') {
                        chars.next();
                        for c3 in chars.by_ref() {
                            if c3 == ')' {
                                break;
                            }
                        }
                    }
                    out.push_str(&label);
                } else {
                    out.push('[');
                    out.push_str(&label);
                }
            }
            c if c.is_whitespace() => {
                if !out.ends_with(' ') && !out.is_empty() {
                    out.push(' ');
                }
            }
            c => out.push(c),
        }
    }
    out.trim().to_string()
}

/// 在 `max_chars` 内收尾：优先切在「；」，否则切在逗号/句号，都没有就硬切。
fn truncate_sentence(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        return s.to_string();
    }
    let window = &chars[..max_chars];
    for sep in ['；', '。', '，'] {
        if let Some(idx) = window.iter().rposition(|c| *c == sep) {
            if idx > max_chars / 3 {
                let mut cut: String = chars[..idx].iter().collect();
                if sep != '，' {
                    cut.push(sep);
                } else {
                    cut.push('，');
                }
                cut.push('…');
                return cut;
            }
        }
    }
    let mut cut: String = chars[..max_chars].iter().collect();
    cut.push('…');
    cut
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
