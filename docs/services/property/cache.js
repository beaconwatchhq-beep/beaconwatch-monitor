/* Property lookup cache — reuses the same client-side storage mechanism the
   job logbook already uses (the global `Store` helper, a thin JSON wrapper
   over localStorage — see docs/index.html). No second storage system.

   Facts (sqft, yearBuilt, beds, etc.) are cached indefinitely: buildings
   don't change. estValue is time-sensitive, so the whole card is considered
   "stale" 180 days after fetchedAt — a stale hit is still returned
   immediately (better than nothing), but should trigger a background
   refresh. Image URLs are cached as plain strings; image bytes are never
   written anywhere. */
const PropertyCache = (() => {
  const KEY = 'beaconwatch_property_cache';
  const STALE_MS = 180 * 24 * 3600 * 1000;

  function normalize(address) {
    return (address || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function all() { return Store.get(KEY, {}); }

  function get(address) {
    const k = normalize(address);
    if (!k) return null;
    return all()[k] || null;
  }

  function set(address, card) {
    const k = normalize(address);
    if (!k || !card) return;
    const map = all();
    map[k] = card;
    Store.set(KEY, map);
  }

  function isStale(card) {
    if (!card || !card.fetchedAt) return true;
    const t = new Date(card.fetchedAt).getTime();
    return !Number.isFinite(t) || (Date.now() - t) > STALE_MS;
  }

  function clear() { Store.set(KEY, {}); }

  return { normalize, get, set, isStale, clear };
})();
