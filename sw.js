/* BeaconWatch service worker — installable app shell.
   Cache-first for the static shell; network-only for the live alerts feed
   (raw.githubusercontent.com) so leads are never served stale. */
const CACHE = 'beaconwatch-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/beaconwatchlockupdark.png',
  './assets/beaconwatchicon512.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Add each item individually so one missing asset can't fail the whole install.
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

  // Live data + third-party (tiles, Leaflet, fonts): always go to network.
  if (url.hostname === 'raw.githubusercontent.com' || url.origin !== self.location.origin) {
    return; // let the browser handle it normally
  }

  // App shell: cache-first, fall back to network, then to cached index for navigations.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
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
