//! 日志：一个文件、按 1MB 轮转、时间一律北京时间。
//!
//! 不引第三方日志库：这里只需要"老师能把一份文件发过来"，
//! 统一到 %APPDATA%\ClassBeat\logs 就够诊断了（旧版散在 4 个地方）。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 1024 * 1024;
const BJ_OFFSET_SECS: i64 = 8 * 3600;

static LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn init(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = dir.join("app.log");
    *LOG_PATH.lock().unwrap() = Some(path);
    std::panic::set_hook(Box::new(|info| {
        error(&format!("panic: {info}"));
    }));
    Ok(())
}

pub fn info(msg: &str) {
    write_line("INFO", msg);
}
pub fn warn(msg: &str) {
    write_line("WARN", msg);
}
pub fn error(msg: &str) {
    write_line("ERROR", msg);
}

fn write_line(level: &str, msg: &str) {
    let line = format!("{} [{}] {}\n", stamp(), level, msg);
    // 调试时同时打到 stderr（release 下没有控制台，写失败也无所谓）
    #[cfg(debug_assertions)]
    eprint!("{line}");

    let guard = match LOG_PATH.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let Some(path) = guard.as_ref() else { return };
    rotate_if_needed(path);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn rotate_if_needed(path: &Path) {
    let big = fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false);
    if big {
        let old = path.with_extension("log.1");
        let _ = fs::remove_file(&old);
        let _ = fs::rename(path, old);
    }
}

/// 北京时间的时间戳。只为了人能看懂，不参与任何逻辑判断。
fn stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
        + BJ_OFFSET_SECS;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// 天数 → 年月日（Howard Hinnant 的 civil_from_days，公历，无依赖）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates_are_right_for_known_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2025-07-20 距 1970-01-01 是 20289 天（Python: (date(2025,7,20)-date(1970,1,1)).days）
        assert_eq!(civil_from_days(20_289), (2025, 7, 20));
        assert_eq!(civil_from_days(20_290), (2025, 7, 21));
        // 闰日：2024-02-29 必须存在且是当年第 60 天
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }
}
