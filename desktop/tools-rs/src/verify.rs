//! 开发包自检：不联网、不编译，只查「这份包是不是自洽」。
//!
//! 能查出来的错，都是最难在真机上定位的那类：
//!   · 少了某个源文件 / 图标 / 钩子，构建到一半才炸；
//!   · tauri.conf 指向一个不存在的钩子或资源目录；
//!   · lib.rs 里 mod 了不存在的模块；
//!   · 包里又混进了 Python（这次重构的核心约束）。

use std::path::{Path, PathBuf};

use serde_json::Value;

pub fn run(repo: &Path) -> Result<(), String> {
    let desktop = repo.join("desktop");
    let src = desktop.join("src-tauri");
    let resources = src.join("resources");

    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();

    println!("== ClassBeat 开发包自检 ==\n");

    check_files(repo, &desktop, &src, &mut errors);
    check_modules(&src, &mut errors);
    check_cargo(&src, &mut errors);
    check_conf(&src, &mut errors, &mut warnings);
    check_hooks(&src, &mut errors);
    check_rust_invariants(&src, &mut errors);
    check_no_python(&resources, &mut errors, &mut notes);
    check_staged_build(&resources, &mut errors, &mut notes);
    check_repo_untouched(repo, &mut warnings, &mut notes);

    for n in &notes {
        println!("  ok   {n}");
    }
    for w in &warnings {
        println!("  warn {w}");
    }
    for e in &errors {
        println!("  FAIL {e}");
    }

    println!("\n未覆盖（需要联网 + Windows 构建机）：");
    println!("  · cargo check / tauri build 的编译错误");
    println!("  · NSIS 编译与安装/卸载真机行为");
    println!("  · WebView2 全屏在触控一体机上的表现");
    println!("  → 见 docs/06-验收清单.md 的 P0 探测与验收 A~E");

    if errors.is_empty() {
        println!("\n结果：通过（{} 条提醒）", warnings.len());
        Ok(())
    } else {
        println!("\n结果：{} 个错误", errors.len());
        Err("自检未通过".into())
    }
}

fn need(cond: bool, msg: impl Into<String>, errors: &mut Vec<String>) {
    if !cond {
        errors.push(msg.into());
    }
}

fn check_files(repo: &Path, desktop: &Path, src: &Path, errors: &mut Vec<String>) {
    let required = [
        "Cargo.toml",
        "build.rs",
        "tauri.conf.json",
        "capabilities/default.json",
        "icons/classbeat.ico",
        "installer/hooks.nsh",
        "installer/stop-legacy.ps1",
        "src/main.rs",
        "src/lib.rs",
        "src/config.rs",
        "src/logging.rs",
        "src/server.rs",
        "src/window.rs",
        "src/tray.rs",
        "src/power.rs",
        "src/hotkey.rs",
        "src/autostart.rs",
        "src/migrate.rs",
        "src/commands.rs",
        "src/update.rs",
        "src/ui.rs",
    ];
    for rel in required {
        need(
            src.join(rel).is_file(),
            format!("缺少文件：src-tauri/{rel}"),
            errors,
        );
    }
    need(
        desktop.join("web").join("index.html").is_file(),
        "缺少 web/index.html（错误页）",
        errors,
    );
    for rel in [
        "server-rs/Cargo.toml",
        "server-rs/src/main.rs",
        "server-rs/src/routes.rs",
        "tools-rs/Cargo.toml",
    ] {
        need(
            desktop.join(rel).is_file(),
            format!("缺少文件：desktop/{rel}"),
            errors,
        );
    }
    let _ = repo;
}

fn check_modules(src: &Path, errors: &mut Vec<String>) {
    let lib_path = src.join("src").join("lib.rs");
    let lib = std::fs::read_to_string(&lib_path).unwrap_or_default();
    let mut mods: Vec<String> = Vec::new();
    for line in lib.lines() {
        if let Some(rest) = line.strip_prefix("mod ") {
            let name: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                mods.push(name);
            }
        }
    }
    for m in &mods {
        need(
            src.join("src").join(format!("{m}.rs")).is_file(),
            format!("lib.rs 声明了 mod {m}，但没有 src/{m}.rs"),
            errors,
        );
    }
    for c in [
        "config", "logging", "server", "tray", "hotkey", "power", "migrate", "update", "window",
    ] {
        need(
            mods.iter().any(|m| m == c),
            format!("lib.rs 没把 {c} 声明成模块（但代码里用到了）"),
            errors,
        );
    }
    if lib.contains("commands::") {
        need(
            mods.iter().any(|m| m == "commands"),
            "lib.rs 用了 commands 但没声明模块",
            errors,
        );
    }
}

fn check_cargo(src: &Path, errors: &mut Vec<String>) {
    let text = std::fs::read_to_string(src.join("Cargo.toml")).unwrap_or_default();
    for token in ["tauri", "tauri-plugin-single-instance", "serde", "windows"] {
        need(
            text.contains(token),
            format!("Cargo.toml 缺少依赖：{token}"),
            errors,
        );
    }
    need(
        text.contains("crate-type = [\"staticlib\", \"cdylib\", \"rlib\"]"),
        "Cargo.toml 的 [lib] crate-type 不标准（Tauri 需要 staticlib/cdylib/rlib）",
        errors,
    );
    need(
        text.contains("features = [\"tray-icon\""),
        "Cargo.toml 的 tauri 没开 tray-icon（托盘会编译失败）",
        errors,
    );
    need(
        text.contains("image-ico"),
        "Cargo.toml 的 tauri 没开 image-ico（托盘图标读 .ico 会失败）",
        errors,
    );
    need(text.contains("updater"), "Cargo.toml 没有 updater feature", errors);
}

fn check_conf(src: &Path, errors: &mut Vec<String>, warnings: &mut Vec<String>) {
    let path = src.join("tauri.conf.json");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let conf: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            errors.push(format!("tauri.conf.json 不是合法 JSON：{e}"));
            return;
        }
    };
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();

    need(
        s(&conf["identifier"]) == "cn.classbeat.app",
        "identifier 不是 cn.classbeat.app",
        errors,
    );
    need(
        s(&conf["productName"]) == "ClassBeat",
        "productName 不是 ClassBeat",
        errors,
    );
    let bundle = &conf["bundle"];
    need(bundle["active"] == Value::Bool(true), "bundle.active 不是 true", errors);
    let targets: Vec<String> = bundle["targets"]
        .as_array()
        .map(|a| a.iter().map(|v| s(v)).collect())
        .unwrap_or_default();
    need(targets.iter().any(|t| t == "nsis"), "bundle.targets 里没有 nsis", errors);
    need(targets.iter().any(|t| t == "msi"), "bundle.targets 里没有 msi", errors);

    if let Some(icons) = bundle["icon"].as_array() {
        for icon in icons {
            let rel = s(icon);
            need(
                src.join(&rel).is_file(),
                format!("bundle.icon 指向不存在的文件：{rel}"),
                errors,
            );
        }
    }
    let hooks = s(&bundle["windows"]["nsis"]["installerHooks"]);
    need(!hooks.is_empty(), "没有配置 nsis.installerHooks（安装/卸载钩子不会生效）", errors);
    if !hooks.is_empty() {
        need(
            src.join(&hooks).is_file(),
            format!("installerHooks 指向不存在的文件：{hooks}"),
            errors,
        );
    }
    let mode = s(&bundle["windows"]["nsis"]["installMode"]);
    need(
        mode == "currentUser",
        format!("installMode 应为 currentUser（免管理员），实际 {mode}"),
        errors,
    );
    let res_ok = bundle["resources"]
        .as_array()
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    need(res_ok, "bundle.resources 为空：壳找不到 app/ 与 server/", errors);
    need(
        conf["app"]["windows"].as_array().map(|a| a.is_empty()).unwrap_or(false),
        "app.windows 应为空数组：窗口由壳在服务就绪后创建",
        errors,
    );
    let pubkey = s(&conf["plugins"]["updater"]["pubkey"]);
    if pubkey.contains("REPLACE") {
        warnings.push(
            "updater.pubkey 还是占位符：正式发布前必须换成 minisign 公钥（否则「检查更新」会报错，但大屏不受影响）".into(),
        );
    }
}

fn check_hooks(src: &Path, errors: &mut Vec<String>) {
    let text = std::fs::read_to_string(src.join("installer").join("hooks.nsh")).unwrap_or_default();
    for m in [
        "NSIS_HOOK_PREINSTALL",
        "NSIS_HOOK_POSTINSTALL",
        "NSIS_HOOK_PREUNINSTALL",
        "NSIS_HOOK_POSTUNINSTALL",
    ] {
        need(text.contains(&format!("!macro {m}")), format!("hooks.nsh 缺少 {m}"), errors);
    }
    need(text.contains("WriteRegStr HKCU"), "hooks.nsh 没有写注册表（App Paths / 自启 / 协议）", errors);
    need(text.contains("netsh advfirewall"), "hooks.nsh 没有防火墙规则", errors);
    need(text.contains("update-source.txt"), "hooks.nsh 没有接管旧版的 update-source.txt", errors);
    need(!text.contains("${If}"), "hooks.nsh 用了 LogicLib 的 ${If}，但模板不保证引入 LogicLib", errors);

    let stop = std::fs::read_to_string(src.join("installer").join("stop-legacy.ps1")).unwrap_or_default();
    need(
        stop.contains("Get-CimInstance") && stop.contains("classbeat.exe"),
        "stop-legacy.ps1 没有按命令行精确清场",
        errors,
    );
    need(
        stop.contains("classbeat-need-reboot.flag"),
        "stop-legacy.ps1 没在权限不足时写 classbeat-need-reboot.flag",
        errors,
    );
    // 0.5.0 起服务是 Rust：升级安装必须显式清掉 0.4.x 的 resources\python，
    // 否则 22 MB 的捆绑运行时会一直留在老师机器上（NSIS 覆盖安装不删多余文件）。
    need(
        text.contains("RMDir /r \"$INSTDIR\\resources\\python\""),
        "hooks.nsh 没有清理 0.4.x 残留的 resources/python（升级后会白留 22 MB）",
        errors,
    );
    need(
        text.matches("classbeat-need-reboot.flag").count() >= 2,
        "hooks.nsh 没在装/卸结束时读取 classbeat-need-reboot.flag（权限不足就没提示）",
        errors,
    );
}

fn check_rust_invariants(src: &Path, errors: &mut Vec<String>) {
    let win = std::fs::read_to_string(src.join("src").join("window.rs")).unwrap_or_default();
    need(
        win.contains("KIOSK_TITLE"),
        "window.rs 没有用 KIOSK_TITLE 设窗口标题（页面「退出大屏」会失效）",
        errors,
    );
    let srv = std::fs::read_to_string(src.join("src").join("server.rs")).unwrap_or_default();
    need(srv.contains("CLASSBEAT_DATA_DIR"), "server.rs 没有把数据目录传给服务", errors);
    need(srv.contains("server_exe"), "server.rs 没有指向 Rust 服务程序", errors);
    need(
        srv.contains("CREATE_NO_WINDOW"),
        "server.rs 没设 CREATE_NO_WINDOW（会闪黑窗）",
        errors,
    );
    let main = std::fs::read_to_string(src.join("src").join("main.rs")).unwrap_or_default();
    need(
        main.contains("windows_subsystem"),
        "main.rs 没声明 windows_subsystem=windows（release 下会带控制台）",
        errors,
    );
    let lib = std::fs::read_to_string(src.join("src").join("lib.rs")).unwrap_or_default();
    need(lib.contains("single_instance"), "lib.rs 没挂单实例插件", errors);
}

/// 这次重构的硬约束：包里不许再有 Python。
fn check_no_python(resources: &Path, errors: &mut Vec<String>, notes: &mut Vec<String>) {
    if !resources.is_dir() {
        notes.push("resources/ 还没装配，跳过一次 Python 残留检查".into());
        return;
    }
    let mut py_files: Vec<PathBuf> = Vec::new();
    walk(resources, &mut |p: &Path| {
        if p.extension().and_then(|e| e.to_str()) == Some("py") {
            py_files.push(p.to_path_buf());
        }
    });
    need(
        py_files.is_empty(),
        format!(
            "resources 里仍有 Python 源文件（{} 个，例如 {}）",
            py_files.len(),
            py_files
                .first()
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        ),
        errors,
    );
    need(
        !resources.join("python").exists(),
        "resources/python 还在：捆绑的 Python 运行时应当已经移除",
        errors,
    );
    need(
        resources.join("server").join("classbeat-server.exe").is_file(),
        "resources/server/classbeat-server.exe 缺失（壳拉不起服务）",
        errors,
    );
    if py_files.is_empty() && !resources.join("python").exists() {
        notes.push("资源里没有 Python 源文件、没有捆绑运行时".into());
    }
}

fn walk(dir: &Path, f: &mut impl FnMut(&Path)) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, f);
        } else {
            f(&p);
        }
    }
}

/// 构建副本里的 build 号必须是真提交号。
fn check_staged_build(resources: &Path, errors: &mut Vec<String>, notes: &mut Vec<String>) {
    let vjs = resources.join("app").join("version.js");
    if !vjs.is_file() {
        notes.push("resources/ 还没装配，跳过 build 号检查".into());
        return;
    }
    let txt = std::fs::read_to_string(&vjs).unwrap_or_default();
    let build = grab(&txt, "var BUILD = \"");
    need(
        build != "" && build != "dev",
        format!("构建副本 app/version.js 的 BUILD=\"{build}\"，应为 git 提交号（重跑 classbeat-tools stage）"),
        errors,
    );
    let info = resources.join("build-info.json");
    if info.is_file() {
        let j: Value = std::fs::read_to_string(&info)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null);
        let b = j["build"].as_str().unwrap_or("");
        need(
            b == build,
            format!("build-info.json 的 build={b} 与 app/version.js 的 {build} 不一致"),
            errors,
        );
    }
}

fn grab(src: &str, key: &str) -> String {
    match src.find(key) {
        Some(at) => {
            let rest = &src[at + key.len()..];
            rest.find('"').map(|e| rest[..e].to_string()).unwrap_or_default()
        }
        None => String::new(),
    }
}

/// 打包脚本只能动 desktop/，不该改仓库里的业务代码。
fn check_repo_untouched(repo: &Path, warnings: &mut Vec<String>, notes: &mut Vec<String>) {
    let out = std::process::Command::new("git")
        .args(["-c", "core.quotePath=false", "status", "--porcelain"])
        .current_dir(repo)
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o,
        _ => {
            notes.push("不在 git 仓库里，跳过「业务代码是否被改动」检查".into());
            return;
        }
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut changed: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut p = line.get(3..).unwrap_or("").trim().to_string();
        if p.len() > 1 && p.starts_with('"') && p.ends_with('"') {
            p = p[1..p.len() - 1].to_string();
        }
        if let Some(idx) = p.find(" -> ") {
            p = p[idx + 4..].trim().trim_matches('"').to_string();
        }
        if p.is_empty() || p.starts_with("desktop/") || p == "app/data.js" {
            continue;
        }
        changed.push(p);
    }
    if !changed.is_empty() {
        warnings.push(format!(
            "desktop/ 之外存在未提交改动（多半是你在别的分支上的工作，与本包无关）：{}",
            changed.join("、")
        ));
    }
}
