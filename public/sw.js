/* Cache the shell so the inbox opens instantly and the 3.5 MB mermaid bundle is
   fetched once. API traffic is never cached — an answered question must vanish. */
const CACHE = 'beadcause-v8';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/doc.html',
  '/doc.js',
  '/graph.html',
  '/graph.js',
  // Both paths for the current-sessions page: '/work' is what the phone's home
  // screen and the Android shell's history still point at.
  '/sessions',
  '/work.html',
  '/work.js',
  '/console.html',
  '/console.js',
  '/icon.svg',
  '/vendor/marked.js',
  '/vendor/purify.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  // Vendor bundles are immutable: cache-first.
  if (url.pathname.startsWith('/vendor/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetchAndStore(e.request)));
    return;
  }

  // Everything else: network-first, cache as the offline fallback.
  e.respondWith(fetchAndStore(e.request).catch(() => caches.match(e.request).then((hit) => hit || caches.match('/'))));
});

function fetchAndStore(request) {
  return fetch(request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy));
    }
    return res;
  });
}
