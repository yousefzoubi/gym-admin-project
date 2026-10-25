// Network first: pages always show live data. The cache only serves the offline page and static files.
const CACHE = 'ironman-v1';
const STATIC = ['/offline.html', '/style.css', '/img/logo.webp', '/img/banner.webp'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') return e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
  if (STATIC.includes(new URL(req.url).pathname)) e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; }).catch(() => caches.match(req)));
});
