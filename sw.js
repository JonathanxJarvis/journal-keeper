// Keeps Journal Keeper working without internet: every file the app needs is
// stored on the phone. The large handwriting reader files are stored the first
// time they are used (the model itself is kept by the reader in its own cache).
const CACHE = 'journal-keeper-v5';
const FILES = [
  './', 'index.html', 'styles.css', 'reader.js', 'claude-reader.js', 'app.js', 'htr-worker.js', 'manifest.webmanifest',
  'vendor/tesseract.min.js', 'vendor/worker.min.js', 'vendor/jspdf.umd.min.js', 'vendor/anthropic-sdk.mjs',
  'vendor/core/tesseract-core-lstm.wasm.js', 'vendor/core/tesseract-core-simd-lstm.wasm.js',
  'lang/eng.traineddata.gz.wasm',
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

// Adding these two headers lets the handwriting reader use several processor
// cores at once (GitHub Pages can't set them itself).
function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// App files: try the network first so updates arrive, fall back to the saved copy.
// Big engine files: use the saved copy first.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const big = /\/(vendor|lang)\//.test(url.pathname);
  if (big) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })).then(isolate));
    return;
  }
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
      .then(isolate)
  );
});
