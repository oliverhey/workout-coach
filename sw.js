// Offline-first service worker: the whole app shell is cached; API calls always go to the network.
const CACHE = 'workout-coach-v10';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/store.js', 'js/db.js', 'js/ai.js', 'js/md.js', 'js/charts.js', 'js/importer.js', 'js/manual.js',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/anton-latin-400-normal.woff2', 'fonts/oswald-latin-500-normal.woff2', 'fonts/oswald-latin-600-normal.woff2', 'fonts/oswald-latin-700-normal.woff2',
  'fonts/inter-latin-400-normal.woff2', 'fonts/inter-latin-500-normal.woff2', 'fonts/inter-latin-600-normal.woff2', 'fonts/inter-latin-700-normal.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Claude API etc. untouched
  // Stale-while-revalidate: instant from cache, refresh in the background when online.
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const network = fetch(e.request).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => null);
    return cached || (await network) || cache.match('index.html');
  }));
});
