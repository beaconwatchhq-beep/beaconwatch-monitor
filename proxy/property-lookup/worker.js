/* BeaconWatch property-lookup proxy (Cloudflare Worker).
 *
 * Why this exists: BeaconWatch's dashboard is a single static HTML file with
 * no server — real provider API keys (geocoding, parcel/owner facts, imagery)
 * can never live in that file, since anything shipped to the browser is
 * readable by anyone with the passcode via dev tools. This Worker is the
 * smallest possible thing that can hold those keys safely: it takes an
 * address, calls the real providers server-side, and returns a merged
 * PropertyCard. It does nothing else — no auth beyond a shared app secret,
 * no storage, no other endpoints.
 *
 * Providers (matching PLATFORM.md's existing plan):
 *   geocode  -> Mapbox Geocoding
 *   facts    -> Regrid (parcel/owner/assessor record)
 *   imagery  -> Mapbox Static Images (aerial) + Google Street View Static API
 *
 * Deploy: see README.md in this directory.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// ---------------------------------------------------------------- geocode --
async function geocode(address, env) {
  const key = env.MAPBOX_TOKEN;
  if (!key) { console.log('PROPERTY_LOOKUP: missing key MAPBOX_TOKEN'); return null; }
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json`
      + `?access_token=${key}&country=US&limit=1`;
    const res = await fetch(url);
    if (!res.ok) { console.log('PROPERTY_LOOKUP: geocode HTTP', res.status); return null; }
    const data = await res.json();
    const f = data.features && data.features[0];
    if (!f) return null;
    const [lng, lat] = f.center || [];
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    const ctx = f.context || [];
    const county = (ctx.find(c => c.id.startsWith('district')) || {}).text
      || (ctx.find(c => c.id.startsWith('place')) || {}).text || null;
    const state = (ctx.find(c => c.id.startsWith('region')) || {}).short_code
      ?.replace(/^us-/i, '').toUpperCase() || null;
    return { lat, lng, normalizedAddress: f.place_name || address, county, state };
  } catch (err) {
    console.log('PROPERTY_LOOKUP: geocode error', err.message);
    return null;
  }
}

// ------------------------------------------------------------------ facts --
async function facts(lat, lng, env) {
  const key = env.REGRID_TOKEN;
  if (!key) { console.log('PROPERTY_LOOKUP: missing key REGRID_TOKEN'); return null; }
  try {
    const url = `https://app.regrid.com/api/v2/parcels/point?lat=${lat}&lon=${lng}&token=${key}`;
    const res = await fetch(url);
    if (!res.ok) { console.log('PROPERTY_LOOKUP: facts HTTP', res.status); return null; }
    const data = await res.json();
    const p = data.parcels && data.parcels.features && data.parcels.features[0];
    const f = p && p.properties && p.properties.fields;
    if (!f) return null;
    return {
      sqft: numOrNull(f.sqft ?? f.building_sqft ?? f.gisacre_sqft),
      yearBuilt: numOrNull(f.yearbuilt ?? f.year_built),
      beds: numOrNull(f.bedrooms),
      baths: numOrNull(f.bathrooms),
      lotSizeSqft: numOrNull(f.ll_gissqft ?? f.gisacre != null ? f.gisacre * 43560 : null),
      stories: numOrNull(f.stories ?? f.numfloors),
      estValue: numOrNull(f.parval ?? f.landval),
      estValueDate: f.saledate || f.taxyear ? String(f.taxyear || new Date().getFullYear()) : null,
      roofType: f.roof_type || null,
      ownerName: f.owner || null,
    };
  } catch (err) {
    console.log('PROPERTY_LOOKUP: facts error', err.message);
    return null;
  }
}
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// ---------------------------------------------------------------- imagery --
async function imagery(lat, lng, env) {
  const mapboxKey = env.MAPBOX_TOKEN;
  const streetKey = env.GOOGLE_STREETVIEW_KEY;
  let aerialUrl = null, streetViewUrl = null, streetViewAvailable = false, streetViewDate = null;

  if (mapboxKey) {
    aerialUrl = `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/`
      + `${lng},${lat},18,0/640x400@2x?access_token=${mapboxKey}`;
  } else {
    console.log('PROPERTY_LOOKUP: missing key MAPBOX_TOKEN (aerial imagery)');
  }

  if (streetKey) {
    try {
      const metaUrl = `https://maps.googleapis.com/maps/api/streetview/metadata`
        + `?location=${lat},${lng}&key=${streetKey}`;
      const metaRes = await fetch(metaUrl);
      const meta = metaRes.ok ? await metaRes.json() : null;
      if (meta && meta.status === 'OK') {
        streetViewAvailable = true;
        streetViewDate = meta.date || null;
        streetViewUrl = `https://maps.googleapis.com/maps/api/streetview`
          + `?size=640x400&location=${lat},${lng}&key=${streetKey}`;
      }
    } catch (err) {
      console.log('PROPERTY_LOOKUP: imagery (street view) error', err.message);
    }
  } else {
    console.log('PROPERTY_LOOKUP: missing key GOOGLE_STREETVIEW_KEY');
  }

  if (!aerialUrl && !streetViewUrl) return null;
  return { aerialUrl, streetViewUrl, streetViewDate, streetViewAvailable };
}

// ------------------------------------------------------------------ fetch --
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: {
        'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-app-secret',
      } });
    }
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    // Shared secret gate — not a provider key, just keeps this endpoint from
    // being an open proxy anyone can hammer at your expense. Rotate freely.
    if (env.APP_SECRET && request.headers.get('x-app-secret') !== env.APP_SECRET) {
      return json({ error: 'unauthorized' }, 401);
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad JSON body' }, 400); }
    const address = (body && body.address || '').trim();
    if (!address) return json({ error: 'address required' }, 400);

    const geo = await geocode(address, env);
    const corsHeaders = { 'access-control-allow-origin': env.ALLOWED_ORIGIN || '*' };
    if (!geo) return json(null, 200); // geocode failure -> PropertyCard is null per spec

    const [f, img] = await Promise.all([
      facts(geo.lat, geo.lng, env),
      imagery(geo.lat, geo.lng, env),
    ]);

    const card = {
      address,
      normalizedAddress: geo.normalizedAddress,
      lat: geo.lat,
      lng: geo.lng,
      sqft: f?.sqft ?? null,
      yearBuilt: f?.yearBuilt ?? null,
      beds: f?.beds ?? null,
      baths: f?.baths ?? null,
      lotSizeSqft: f?.lotSizeSqft ?? null,
      stories: f?.stories ?? null,
      estValue: f?.estValue ?? null,
      estValueDate: f?.estValueDate ?? null,
      roofType: f?.roofType ?? null,
      ownerName: f?.ownerName ?? null,
      aerialUrl: img?.aerialUrl ?? null,
      streetViewUrl: img?.streetViewUrl ?? null,
      streetViewDate: img?.streetViewDate ?? null,
      streetViewAvailable: img?.streetViewAvailable ?? false,
      fetchedAt: new Date().toISOString(),
      provider: f ? 'Regrid' : null,
      partial: f == null || f.sqft == null || f.yearBuilt == null || f.estValue == null,
    };

    return new Response(JSON.stringify(card), { status: 200, headers: { ...JSON_HEADERS, ...corsHeaders } });
  },
};
