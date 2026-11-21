fn main() {
    // tauri-build 负责把 tauri.conf.json、capabilities、图标编译进产物。
    // 只改 src/*.rs 时不必重跑，改了 conf/图标才需要。
    tauri_build::build()
}
