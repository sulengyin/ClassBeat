/* 节律屏手机页 Service Worker（scope 只圈手机页，不碰大屏）。
   目标：装到主屏幕后全屏秒开；教室 WiFi 抖一下页面不至于白屏。
   原则：网络优先——消息永远要新的；只有页面壳与图标在断网时用缓存兜底。
   绝不碰 /api/*：SSE 与消息接口照常直连，不受 SW 缓冲影响。 */
var CACHE = "classbeat-phone-v1";
var SHELL = ["/phone", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        // 先查一遍：已缓存的不重拉，避免每次打开都下载图标
        return caches.match(u).then(function (hit) {
          return hit ? null : c.add(new Request(u, { cache: "no-store" }));
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  // 这些直连：消息、SSE、更新接口、SW 自己
  if (url.pathname.indexOf("/api/") === 0) return;
  if (url.pathname === "/phone-sw.js") return;
  // 只兜页面壳与图标；其余（/app/ 大屏等）一律直连，不缓存不拦截
  var ours = url.pathname === "/phone" || url.pathname === "/"
    || url.pathname === "/manifest.json" || url.pathname.indexOf("/icons/") === 0;
  if (!ours) return;

  e.respondWith(
    fetch(e.request).then(function (resp) {
      if (resp && resp.ok) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return resp;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        return hit || new Response("离线，且没有缓存可用", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      });
    })
  );
});
