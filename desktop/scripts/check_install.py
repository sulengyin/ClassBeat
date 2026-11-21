#!/usr/bin/env python3
"""装完 / 卸完之后的机器状态核对（对应 docs/06 的 A5–A8、B2–B5、C2）。

只读：不写注册表、不杀进程、不动文件。用来把"验收"从肉眼变成可复跑的一张表。

用法：
    python desktop/scripts/check_install.py            # 装完自检（默认）
    python desktop/scripts/check_install.py --after-uninstall
"""

import argparse
import os
import subprocess
import sys

if sys.platform != "win32":
    raise SystemExit("这个脚本只跑在 Windows 上。")

import winreg  # noqa: E402

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
APP_PATHS = r"Software\Microsoft\Windows\CurrentVersion\App Paths\classbeat.exe"
CLASSES = r"Software\Classes\classbeat"
UNINSTALL = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"

rows = []


def add(item, ok, detail=""):
    rows.append((item, "通过" if ok else "不通过", detail))


def reg_value(root, path, name=""):
    try:
        with winreg.OpenKey(root, path) as k:
            v, _ = winreg.QueryValueEx(k, name)
            return v
    except OSError:
        return None


def reg_exists(root, path):
    try:
        with winreg.OpenKey(root, path):
            return True
    except OSError:
        return False


def uninstall_entries():
    """HKCU 下所有 Uninstall 子键里 DisplayName 含 ClassBeat 的。"""
    found = []
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, UNINSTALL) as k:
            i = 0
            while True:
                try:
                    name = winreg.EnumKey(k, i)
                except OSError:
                    break
                i += 1
                sub = f"{UNINSTALL}\\{name}"
                dn = reg_value(winreg.HKEY_CURRENT_USER, sub, "DisplayName")
                if dn and "classbeat" in str(dn).lower():
                    found.append(
                        (
                            name,
                            dn,
                            reg_value(winreg.HKEY_CURRENT_USER, sub, "DisplayVersion"),
                            reg_value(winreg.HKEY_CURRENT_USER, sub, "Publisher"),
                            reg_value(winreg.HKEY_CURRENT_USER, sub, "UninstallString"),
                        )
                    )
    except OSError:
        pass
    return found


def shortcut_targets():
    desk = os.path.join(os.environ["USERPROFILE"], "Desktop")
    pubs = r"C:\Users\Public\Desktop"
    out = []
    for d in (desk, pubs):
        for n in ("ClassBeat.lnk", "班级节律屏.lnk"):
            p = os.path.join(d, n)
            if os.path.exists(p):
                out.append(p)
    return out


def port_listeners():
    try:
        out = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True,
            encoding="mbcs", errors="replace", timeout=20
        ).stdout
    except Exception as e:  # noqa: BLE001
        return f"（netstat 失败：{e}）"
    hits = [l.strip() for l in out.splitlines() if ":8765" in l or ":8766" in l]
    return " / ".join(hits) if hits else ""


def procs():
    try:
        out = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True,
            encoding="mbcs", errors="replace", timeout=30
        ).stdout
    except Exception:  # noqa: BLE001
        return {}
    names = {}
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if parts:
            names[parts[0].lower()] = names.get(parts[0].lower(), 0) + 1
    return names


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--after-uninstall", action="store_true")
    ap.add_argument("--expect-version", default="")
    args = ap.parse_args()

    install = os.path.join(os.environ["LOCALAPPDATA"], "ClassBeat")
    data = os.path.join(os.environ["APPDATA"], "ClassBeat")
    legacy = os.path.join(os.environ["LOCALAPPDATA"], "ClassBeat_legacy_probe")
    del legacy

    exe = os.path.join(install, "classbeat.exe")
    run_val = reg_value(winreg.HKEY_CURRENT_USER, RUN_KEY, "ClassBeat")
    app_path = reg_value(winreg.HKEY_CURRENT_USER, APP_PATHS, "")
    app_path_dir = reg_value(winreg.HKEY_CURRENT_USER, APP_PATHS, "Path")
    proto_cmd = reg_value(winreg.HKEY_CURRENT_USER, CLASSES + r"\shell\open\command", "")
    ents = uninstall_entries()
    scs = shortcut_targets()
    listeners = port_listeners()
    pn = procs()

    if args.after_uninstall:
        add("B3 程序目录已删", not os.path.isdir(install), install)
        add("B3 Run 项已删", run_val is None, str(run_val))
        add("B3 App Paths 已删", not reg_exists(winreg.HKEY_CURRENT_USER, APP_PATHS))
        add("B3 classbeat:// 已删", not reg_exists(winreg.HKEY_CURRENT_USER, CLASSES))
        add("B3 卸载项已删", not ents, str(ents))
        add("B3 快捷方式已删", not scs, ",".join(scs))
        add("B4 端口已释放", not listeners, listeners or "无监听")
        add("B5 无残留进程", pn.get("classbeat.exe", 0) == 0 and pn.get("pythonw.exe", 0) == 0,
            f"classbeat={pn.get('classbeat.exe',0)} pythonw={pn.get('pythonw.exe',0)}")
        add("B2 数据目录保留", os.path.isdir(data), data)
        snaps = []
        cfg = os.path.join(data, "backups", "config")
        if os.path.isdir(cfg):
            snaps = [f for f in os.listdir(cfg) if f.startswith("rhythm-")]
        add("B2 里还有配置快照", bool(snaps), ",".join(sorted(snaps)[-3:]) or "无")
    else:
        add("A3/A8 exe 存在", os.path.isfile(exe), exe)
        if args.expect_version:
            # A4 看的是"设置→应用"里显示的那个版本 = 卸载项的 DisplayVersion（= 桌面壳版本）。
            # resources\build-info.json 里的是**业务包**版本（app/version.js），
            # 两者本来就不是一个号：壳 0.4.0 里装的是业务 0.3.24，这里只做提示。
            ver = ents[0][2] if ents else ""
            add(
                f"A4 版本={args.expect_version}",
                str(ver) == args.expect_version,
                f"注册表 DisplayVersion={ver or '（无）'}",
            )
            import json

            bi = os.path.join(install, "resources", "build-info.json")
            if os.path.isfile(bi):
                try:
                    bv = json.load(open(bi, encoding="utf-8")).get("version", "")
                    rows.append(("（提示）业务包版本", "通过", f"resources/build-info.json = {bv}"))
                except Exception:  # noqa: BLE001
                    pass
        add("A5 App Paths 默认值", bool(app_path), str(app_path))
        add("A5 App Paths Path", bool(app_path_dir), str(app_path_dir))
        add("A6 自启项", bool(run_val) and "--autostart" in str(run_val), str(run_val))
        add("A4 设置→应用有条目", bool(ents), str([e[1] for e in ents]))
        pv = reg_value(winreg.HKEY_CURRENT_USER, APP_PATHS, "Path")
        add("协议 classbeat://", bool(proto_cmd), str(proto_cmd))
        add("A7/A8 快捷方式", bool(scs), ",".join(scs))
        add("C2 旧装目录已清", not os.path.exists(os.path.join(install, "tools")),
            "仍有 tools/（旧启动器）" if os.path.exists(os.path.join(install, "tools")) else "无 tools/")
        add("C5 无旧看门狗进程", pn.get("powershell.exe", 0) == 0, f"powershell={pn.get('powershell.exe',0)}")
        add("端口在听", bool(listeners), listeners or "无监听")
        del pv

    w = max(len(r[0]) for r in rows) + 2
    print("=" * 72)
    for item, verdict, detail in rows:
        mark = "✓" if verdict == "通过" else "✗"
        print(f"{mark} {item.ljust(w)} {verdict}")
        if detail:
            print(f"  {' ' * w} {detail}")
    print("=" * 72)
    bad = sum(1 for r in rows if r[1] != "通过")
    print(f"共 {len(rows)} 项，未通过 {bad} 项")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
