//! 把班级配置打包成 `app/data.js`。
//!
//! 大屏在 file:// 下不能 fetch，所以配置必须内联成脚本。
//! 只装「配置」，不装任何一天的结果——当天的课表由 app/engine/schedule.js
//! 在浏览器里现算。改一条作息不用重新打包，重开页面就是新时间。

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// 数据目录：`--data` 优先（相对仓库根解析），否则 `data/`，没有就 `sample/`。
/// 公开仓库里没有 `data/`（真实班级数据不入库），所以 CI 一律走 `sample/`。
pub fn resolve_data_dir(arg: Option<&str>, repo: &Path) -> Result<PathBuf, String> {
    let dir = match arg {
        Some(d) => {
            let p = PathBuf::from(d);
            if p.is_absolute() {
                p
            } else {
                repo.join(p)
            }
        }
        None => {
            let d = repo.join("data");
            if d.is_dir() {
                d
            } else {
                repo.join("sample")
            }
        }
    };
    if !dir.join("students.json").is_file() {
        return Err(format!("数据目录里没有 students.json：{}", dir.display()));
    }
    Ok(dir)
}

/// 把一份数据目录拼成 `window.RHYTHM_DATA` 的 payload。
/// 单独拆出来是给 `single`（单文件 HTML）复用：两个产物必须来自同一份数据形状，
/// 否则单文件版和安装版会看到不一样的班级。
pub fn build_payload(data_dir: &Path) -> Result<Value, String> {
    let students = read(data_dir, "students.json", None)?;
    let roles = read(data_dir, "roles.json", None)?;
    let content = read(data_dir, "content.json", None)?;
    let timetable = read(data_dir, "timetable.json", None)?;
    let schedule = read(data_dir, "schedule.json", None)?;
    let noon = read(data_dir, "noon.json", None)?;
    // 校历可选：没有就当成「周一到周五都上学、不放假」
    let calendar = read(data_dir, "calendar.json", Some(json!({"days": {}})))?;

    let school = timetable
        .get("school")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| students.get("school").and_then(|v| v.as_str()))
        .unwrap_or("");
    let klass = schedule
        .get("class")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| students.get("class").and_then(|v| v.as_str()))
        .unwrap_or("");
    let head_teacher = schedule
        .get("headTeacher")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let mut payload = Map::new();
    payload.insert("version".into(), json!(2));
    payload.insert(
        "generatedAt".into(),
        json!(chrono::Local::now()
            .format("%Y-%m-%dT%H:%M:%S")
            .to_string()),
    );
    payload.insert(
        "meta".into(),
        json!({"school": school, "klass": klass, "headTeacher": head_teacher}),
    );
    payload.insert(
        "students".into(),
        students.get("students").cloned().unwrap_or(json!([])),
    );
    // 整个 roles.json：岗位表 + dutyCycle（轮换锚点）都在里面
    payload.insert("roles".into(), roles);
    // 编辑页按科目列准备清单，所以这里给数组
    payload.insert(
        "content".into(),
        content.get("subjects").cloned().unwrap_or(json!([])),
    );
    payload.insert("timetable".into(), timetable);
    payload.insert("schedule".into(), schedule);
    payload.insert("noon".into(), noon);
    payload.insert("calendar".into(), calendar);

    // 老师改好的文字可以烤成这个包的出厂默认：data/texts.json
    let baked = data_dir.join("texts.json");
    if baked.is_file() {
        if let Ok(texts) = read_json(&baked) {
            if texts.is_object() && texts.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
                let n = texts.as_object().map(|o| o.len()).unwrap_or(0);
                payload.insert("texts".into(), texts);
                println!("已并入 {}：{n} 组文字", baked.display());
            }
        }
    }

    Ok(Value::Object(payload))
}

/// `window.RHYTHM_DATA=…;` —— 大屏在 file:// 下不能 fetch，配置必须内联成脚本。
pub fn render_data_js(payload: &Value) -> Result<String, String> {
    let body = serde_json::to_string(payload).map_err(|e| format!("序列化失败：{e}"))?;
    Ok(format!(
        "/* 由 classbeat-tools bundle 生成，不要手改 */\nwindow.RHYTHM_DATA={body};\n"
    ))
}

pub fn run(data_arg: Option<&str>, out_arg: Option<&str>, repo: &Path) -> Result<(), String> {
    let data_dir = resolve_data_dir(data_arg, repo)?;
    let payload = build_payload(&data_dir)?;

    let out = match out_arg {
        Some(o) => {
            let p = PathBuf::from(o);
            if p.is_absolute() {
                p
            } else {
                repo.join(p)
            }
        }
        None => repo.join("app").join("data.js"),
    };
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let text = render_data_js(&payload)?;
    std::fs::write(&out, text.as_bytes()).map_err(|e| format!("写不进 {}：{e}", out.display()))?;
    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0) as f64 / 1024.0;
    println!(
        "已生成 {}：配置包 {size:.0} KB（不含任何一天，运行时现算）",
        out.display()
    );
    Ok(())
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读不了 {}：{e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{} 不是合法 JSON：{e}", path.display()))
}

fn read(dir: &Path, name: &str, default: Option<Value>) -> Result<Value, String> {
    let p = dir.join(name);
    if !p.exists() {
        return match default {
            Some(d) => Ok(d),
            None => Err(format!("缺少 {}", p.display())),
        };
    }
    read_json(&p)
}
