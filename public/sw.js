/* Cache the shell so the inbox opens instantly and the 3.5 MB mermaid bundle is
   fetched once. API traffic is never cached — an answered question must vanish. */
const CACHE = 'beadcause-v14';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  // The answer's flight to the mark. In the shell rather than left to network-first
  // because it is loaded on the tap that answers a question — the one moment the
  // link is least likely to be there and most likely to be slow.
  '/absorb.js',
  // The bottom tab bar, on all four standing views. Every one of them is useless
  // without it now — it is the only way off a page — so it belongs in the shell
  // rather than being fetched four times over a phone link.
  '/tabbar.js',
  // On every page that can open a detail drawer, and on both pages that can be one.
  '/drawer.js',
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
  // The advocate console. Two paths for one page, the same way /work and /sessions
  // are: launchd opens '/monitor', and '/advocates' is what you guess when typing.
  '/monitor',
  '/monitor.html',
  '/monitor.js',
  // Pause all / resume all. In the shell for the reason the terminal is: you open
  // it because something needs stopping now, and that is often the moment the link
  // is worst. The page is useless without the daemon — but it says so instantly
  // rather than after a timeout on a blank screen.
  '/admin',
  '/admin.html',
  '/admin.js',
  // The in-app terminal. Worth pre-caching rather than leaving to network-first:
  // it is the one page you open *because* something needs steering right now, and
  // 490 kB of xterm.js over a phone link is a long time to look at nothing.
  '/terminal',
  '/term.html',
  '/term.js',
  '/icon.svg',
  '/vendor/marked.js',
  '/vendor/purify.js',
  '/vendor/xterm.js',
  '/vendor/xterm.css',
  '/vendor/xterm-addon-fit.js',
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
