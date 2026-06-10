// =========================================================
// Tokyo Pulse – Service Worker
// アプリシェルをキャッシュし、オフライン起動と高速再訪を実現する。
//   - 静的アセット: cache-first（バージョン更新時に入れ替え）
//   - /api/*       : network-first（常に最新データを優先、失敗時はキャッシュ）
// =========================================================

const CACHE_VERSION = 'tokyo-pulse-v1';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './js/main.js',
  './game.html',
  './icon.svg',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API はネットワーク優先（リアルタイム性を確保）
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // 同一オリジンの静的アセットはキャッシュ優先
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached ||
        fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, copy));
          return res;
        })
      )
    );
  }
  // クロスオリジン（MapLibre CDN・地図タイル）はブラウザ既定に任せる
});
