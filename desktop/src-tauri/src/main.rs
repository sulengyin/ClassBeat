// Windows 上不要多一个控制台窗口：这是"点 exe 不弹黑窗"的第一道保证。
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

fn main() {
    classbeat_lib::run()
}
