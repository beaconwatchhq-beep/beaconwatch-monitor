/* BeaconWatch service worker — installable app shell.
   Cache-first for the static shell so the app opens instantly / offline;
   network-only for the live alerts feed so leads are never stale. */
const CACHE = 'beaconwatch-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './assets/beaconwatchlockuplight.png',
  './assets/beaconwatchicon512.png',
  './assets/beaconwatchappicon512.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(url => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Live data + any third-party (Leaflet, CARTO tiles, fonts): straight to network.
  if (url.hostname === 'raw.githubusercontent.com' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
