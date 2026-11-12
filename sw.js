/* Service worker — 版本號由所有檔案內容的雜湊產生；任何檔案改變，這行就會不同，瀏覽器便會安裝新版。 */
const CACHE = 'vocab-6d7ae052317a';
const FILES = ["./", "index.html", "app.css", "app.js", "atk-400.woff2", "atk-700.woff2", "icon-180.png", "icon-192.png", "icon-512.png", "manifest.webmanifest", "noto-greek.woff2", "noto-latin.woff2", "noto-latinext.woff2", "words.json"];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('vocab-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 詞典連結等外部網址不經過快取
  event.respondWith(
    caches.open(CACHE).then((c) =>
      c.match(req, { ignoreSearch: true }).then((hit) => {
        if (hit) return hit;
        if (req.mode === 'navigate') return c.match('index.html').then((r) => r || fetch(req));
        return fetch(req);
      })
    ).catch(() => fetch(req))
  );
});
