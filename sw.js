// Keeps Journal Keeper working without internet: every file the app needs is
// stored on the phone. (Reading pages with Claude needs internet; pages wait until it is back.)
const CACHE = 'journal-keeper-v11';
const FILES = [
  './', 'index.html', 'styles.css', 'chrono.js', 'claude-reader.js', 'app.js', 'reader-view.js', 'library.js', 'manifest.webmanifest',
  'vendor/jspdf.umd.min.js', 'vendor/anthropic-sdk.mjs', 'vendor/sortable.min.js',
  'fonts/fraunces.woff2', 'fonts/fraunces-italic.woff2', 'fonts/atkinson-400.woff2', 'fonts/atkinson-400-italic.woff2',
  'fonts/atkinson-700.woff2', 'fonts/caveat-600.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Try the network first so updates arrive straight away, fall back to the saved copy offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
