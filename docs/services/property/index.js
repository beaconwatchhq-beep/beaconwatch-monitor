/* BeaconWatch property lookup — client side.
 *
 * NOT FUNCTIONAL until CFG.propertyLookupUrl points at a deployed proxy (see
 * proxy/property-lookup/README.md). Until then every call fails soft and
 * returns null, exactly like a missing-key adapter would per spec — nothing
 * crashes, nothing is fabricated.
 *
 * Calls the property-lookup proxy instead of any provider directly, so real
 * API keys never ship in this file or any other part of the client bundle.
 * Caches by normalized address using PropertyCache (facts indefinitely,
 * estValue flagged stale after 180 days — stale hits still return
 * immediately, with a silent background refresh). Requests made while
 * offline are queued via PropertyQueue and drained sequentially (500ms gap)
 * on reconnect. Rate-limited to 1 real network call per 2 seconds per
 * device, enforced here regardless of how many callers ask at once.
 */
const PropertyService = (() => {
  let lastCallAt = 0;
  const MIN_GAP_MS = 2000;

  async function callProxy(address) {
    const url = CFG.propertyLookupUrl;
    if (!url) { console.log('PROPERTY_LOOKUP: missing key PROPERTY_LOOKUP_URL'); return null; }

    const wait = Math.max(0, lastCallAt + MIN_GAP_MS - Date.now());
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(CFG.propertyLookupSecret ? { 'x-app-secret': CFG.propertyLookupSecret } : {}),
        },
        body: JSON.stringify({ address }),
      });
      if (!res.ok) { console.log('PROPERTY_LOOKUP: proxy HTTP', res.status); return null; }
      return await res.json(); // proxy already returns null or a shaped PropertyCard
    } catch (err) {
      console.log('PROPERTY_LOOKUP: proxy error', err.message);
      return null;
    }
  }

  /* address: string. jobId: optional, only used to tag an offline-queue
     entry so the logbook UI can badge the right job. */
  async function lookupProperty(address, jobId) {
    address = (address || '').trim();
    if (!address) return null;

    const cached = PropertyCache.get(address);
    if (cached && !PropertyCache.isStale(cached)) return cached;

    if (!navigator.onLine) {
      PropertyQueue.push({ jobId: jobId ?? null, address, queuedAt: new Date().toISOString() });
      return cached || { queued: true };
    }

    if (cached && PropertyCache.isStale(cached)) {
      // Stale hit: hand back what we have now, refresh quietly in the background.
      callProxy(address).then(fresh => { if (fresh) PropertyCache.set(address, fresh); });
      return cached;
    }

    const card = await callProxy(address);
    if (card) PropertyCache.set(address, card);
    return card;
  }

  function getCachedProperty(address) { return PropertyCache.get(address); }
  function clearPropertyCache() { PropertyCache.clear(); }

  async function drainQueue() {
    await PropertyQueue.drain(async entry => {
      const card = await callProxy(entry.address);
      if (card) PropertyCache.set(entry.address, card);
      Views.renderLists && Views.renderLists();
      Logbook.render && Logbook.render(); // clears the queued dot once this entry drains
      return card;
    });
  }

  addEventListener('online', () => { drainQueue(); });

  return { lookupProperty, getCachedProperty, clearPropertyCache, drainQueue };
})();
