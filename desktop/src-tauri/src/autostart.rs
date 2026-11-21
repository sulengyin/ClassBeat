//! 开机自启（= 系统注册的一项）。
//!
//! 写的是 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，
//! 不是启动文件夹快捷方式——旧方案那个 .lnk 一旦被清理工具删掉就再也回不来，
//! 而注册表这一项卸载器能精确删除（见 installer/hooks.nsh）。
//!
//! 为什么不用 `reg.exe`：早先图省事调命令行，实测在装了安全软件的机器上
//! 会被"程序启动控制"直接拦掉（进程创建被拒，`os error 5`），自启静默失效；
//! 而且每启动一次就多一个子进程，跟"全程不出窗口"的目标也别扭。
//! 现在直接调注册表 API：无子进程、无窗口、被杀软拦的概率为零。

/// 只用注册表 API，不需要额外 crate：`windows` 已经在依赖里（见 Cargo.toml）。
#[cfg(windows)]
mod imp {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "ClassBeat";

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// 打开（必要时创建）Run 项。Run 项在正常 Windows 上一定存在，
    /// 但精简系统/首次登录时可能还没有，所以创建一次更稳。
    fn open_run_key(write: bool) -> Result<HKEY, String> {
        let sub = wide(RUN_KEY);
        let mut key = HKEY::default();
        let access = if write {
            KEY_SET_VALUE
        } else {
            KEY_QUERY_VALUE
        };

        let rc = unsafe {
            RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), Some(0), access, &mut key)
        };
        if rc == ERROR_SUCCESS {
            return Ok(key);
        }

        // 不存在 → 建一个（只能在写的时候建；读的时候建没意义）。
        if write {
            let mut created = HKEY::default();
            let rc = unsafe {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    PCWSTR(sub.as_ptr()),
                    Some(0),
                    PCWSTR::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_SET_VALUE,
                    None,
                    &mut created,
                    None,
                )
            };
            if rc == ERROR_SUCCESS {
                return Ok(created);
            }
            return Err(format!("创建 Run 项失败（Win32 {}）", rc.0));
        }
        Err(format!("打开 Run 项失败（Win32 {}）", rc.0))
    }

    pub fn is_enabled() -> bool {
        let key = match open_run_key(false) {
            Ok(k) => k,
            Err(_) => return false,
        };
        let name = wide(VALUE_NAME);
        let mut size: u32 = 0;
        let rc = unsafe {
            RegQueryValueExW(key, PCWSTR(name.as_ptr()), None, None, None, Some(&mut size))
        };
        unsafe {
            let _ = RegCloseKey(key);
        }
        rc == ERROR_SUCCESS && size > 0
    }

    pub fn set(value: &str) -> Result<(), String> {
        let key = open_run_key(true)?;
        let name = wide(VALUE_NAME);
        let data = wide(value);
        // REG_SZ 要连结尾的 0 一起算进字节数。
        let bytes = unsafe {
            std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * std::mem::size_of::<u16>())
        };
        let rc = unsafe { RegSetValueExW(key, PCWSTR(name.as_ptr()), Some(0), REG_SZ, Some(bytes)) };
        unsafe {
            let _ = RegCloseKey(key);
        }
        if rc == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("写 Run 值失败（Win32 {}）", rc.0))
        }
    }

    pub fn delete() -> Result<(), String> {
        let key = open_run_key(true)?;
        let name = wide(VALUE_NAME);
        let rc = unsafe { RegDeleteValueW(key, PCWSTR(name.as_ptr())) };
        unsafe {
            let _ = RegCloseKey(key);
        }
        // 本来就没有这个值：不算错。
        if rc == ERROR_SUCCESS || rc == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!("删 Run 值失败（Win32 {}）", rc.0))
        }
    }
}

/// 非 Windows 构建（本仓只发 Windows，这里留空实现仅为编译通过）。
#[cfg(not(windows))]
mod imp {
    pub fn is_enabled() -> bool {
        false
    }
    pub fn set(_value: &str) -> Result<(), String> {
        Err("仅支持 Windows".into())
    }
    pub fn delete() -> Result<(), String> {
        Ok(())
    }
}

fn command_line() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(format!("\"{}\" --autostart", exe.display()))
}

pub fn is_enabled() -> bool {
    imp::is_enabled()
}

pub fn enable() -> Result<(), String> {
    imp::set(&command_line()?)
}

/// 保留给托盘开关 / 卸载排障用。
#[allow(dead_code)]
pub fn disable() -> Result<(), String> {
    imp::delete()
}

/// 装好后第一次运行补一次自启；已经在了就不动。
/// 静默、幂等、失败只记日志（没有自启也能手动开，不该阻断启动）。
pub fn ensure_enabled() {
    if is_enabled() {
        return;
    }
    match enable() {
        Ok(()) => crate::logging::info("已写入开机自启（HKCU Run）"),
        Err(e) => crate::logging::warn(&format!("写开机自启失败：{e}")),
    }
}

#[cfg(test)]
mod tests {
    /// 真机自检：写 → 读 → 删，最后必须回到"没有这一项"的状态。
    /// 会短暂往 HKCU\...\Run 写一个 ClassBeat 值（就是它该待的地方），
    /// 跑完立刻删掉。会动真实注册表，所以标成 ignore，要手动确认才跑：
    ///     cargo test -- --ignored
    #[cfg(windows)]
    #[test]
    #[ignore = "会临时写真实注册表（验完自删）"]
    fn roundtrip_leaves_no_trace() {
        use super::*;
        let before = is_enabled();
        enable().expect("写自启失败");
        assert!(is_enabled(), "写进去了却读不到");
        disable().expect("删自启失败");
        assert_eq!(is_enabled(), before, "删除后状态没回到原样");
    }
}
