/* BeaconWatch service worker — installable app shell.
   Network-first for the shell (index.html/navigation) so a new deploy is
   visible on the very next load instead of getting stuck behind a stale
   cache forever; cache is only the offline fallback. Icons/manifest stay
   cache-first since they rarely change. Live alerts feed is always
   network-only. */
const CACHE = 'beaconwatch-v3';
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

  const isShell = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');

  if (isShell) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) (await caches.open(CACHE)).put(req, res.clone());
        return res;
      } catch (err) {
        const cached = await caches.match(req) || await caches.match('./index.html');
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      throw err;
    }
  })());
});
