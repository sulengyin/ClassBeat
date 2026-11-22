# server/ · 只剩下手机页的静态资源

**服务本体不在这里。** 局域网服务从 0.5.0 起是 Rust 的
`desktop/server-rs`（编出 `classbeat-server.exe`），2026-11-22 之后这里
的 `rhythm_server.py` / `run.py` / `updater.py` / `update_manifest.py`
已经删除——它们只在「解压即用包 + pythonw + 看门狗」那套形态里存在，
而那套形态（连同 `tools/package.py`、`tools/build_installer.py`、
`tools/launcher/`）已退役。

现在这个目录里只有服务要吐给手机的四样静态资源：

| 文件 | 谁在读 |
|---|---|
| `phone.html` | `classbeat-server` 的 `/phone`，手机扫码后打开的页面 |
| `sw.js` | `/phone-sw.js`，手机页的 Service Worker |
| `icons/icon-192.png`、`icon-512.png` | 手机页 PWA 清单与主屏图标 |

`tools/make_ico.py` 会顺手重生成这两个图标（与大屏图标同一套品牌图）。

装配时 `classbeat-tools stage` 只拷这四样进 `src-tauri/resources/server/`，
连同 `classbeat-server.exe` 一起——不会再有 `.py` 进包。

> 命名遗留：目录叫 `server/` 但放的是前端资源，读起来有点别扭。改名
> （比如 `app/phone/`）会牵动服务的静态根、装配清单和 e2e，等下次有
> 大改再说；在那之前以本文件为准。
