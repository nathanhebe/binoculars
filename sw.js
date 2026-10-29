// Offline shell plus a cache of terrain tiles. Place names come from the network (and the
// app's own localStorage cache), so they are never served stale from here.
const SHELL = 'binoculars-shell-v1';
const TILES = 'binoculars-tiles-v1';
const FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'assets/countries.json', 'assets/places-major.json',
  'assets/peaks-major.json', 'js/app.mjs', 'js/geo.mjs', 'js/terrain.mjs', 'js/places.mjs', 'js/tiles.mjs', 'js/countries.mjs', 'js/orientation.mjs',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // Only our own old versions: other Pages sites on this github.io origin share the cache store.
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('binoculars-') && k !== SHELL && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname === 's3.amazonaws.com' && url.pathname.startsWith('/elevation-tiles-prod/')) {
    e.respondWith(
      caches.open(TILES).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }
  if (url.origin === location.origin) {
    // Network first so a new version shows up straight away; the cache covers no signal.
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
    );
  }
});
