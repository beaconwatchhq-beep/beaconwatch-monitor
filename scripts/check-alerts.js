// BeaconWatch — background monitor.
// Runs every 15 min on a GitHub Actions schedule. Polls NWS/FIRMS/News,
// diffs against previously-seen events, and appends new matches to
// state/alerts-log.json (which feeds the dashboard). It does NOT send any
// email or SMS — outbound notifications are handled entirely by the digest
// worker (scripts/send-digest.js), so subscribers get one periodic report
// instead of a per-event blast.

const fs = require('fs');
const path = require('path');
const { classifyBuildingType, extractAlarmCount, extractDepartmentCount } = require('../lib/buildingType.js');

const STATE_PATH = path.join(__dirname, '..', 'state', 'seen-alerts.json');
const ALERTS_LOG_PATH = path.join(__dirname, '..', 'state', 'alerts-log.json');
const GEOCODE_CACHE_PATH = path.join(__dirname, '..', 'state', 'geocode-cache.json');

// Keep enough history for a monthly digest window (~30 days of activity).
const LOG_RETENTION = 1000;

// Nominatim's usage policy caps unauthenticated callers at 1 req/sec.
const GEOCODE_RATE_MS = 1000;

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}
function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function geometryCentroid(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  const flatten = (coords, depth) => {
    if (depth === 0) return [coords];
    return coords.flatMap(c => flatten(c, depth - 1));
  };
  const depthMap = { Point: 0, MultiPoint: 1, LineString: 1, Polygon: 2, MultiPolygon: 3 };
  const depth = depthMap[geometry.type];
  if (depth === undefined) return null;
  const points = geometry.type === 'Point' ? [geometry.coordinates] : flatten(geometry.coordinates, depth);
  if (!points.length) return null;
  const lon = points.reduce((s, p) => s + p[0], 0) / points.length;
  const lat = points.reduce((s, p) => s + p[1], 0) / points.length;
  return { lat, lon };
}

async function fetchWeatherAlerts() {
  const res = await fetch('https://api.weather.gov/alerts/active', {
    headers: {
      Accept: 'application/geo+json',
      'User-Agent': 'beaconwatch (contact: beaconwatchhq@gmail.com)',
    },
  });
  if (!res.ok) throw new Error('NWS fetch failed: ' + res.status);
  const data = await res.json();

  const target = /(tornado|hurricane|flood|tropical|severe thunderstorm)/i;
  return (data.features || [])
    .filter(f => target.test(f.properties.event || '')
      && (f.properties.severity === 'Extreme' || f.properties.severity === 'Severe'))
    .map(f => {
      const centroid = geometryCentroid(f.geometry);
      return {
        id: f.id,
        source: 'NWS',
        hazard: classifyHazard(f.properties.event),
        title: f.properties.event,
        area: f.properties.areaDesc || '',
        severity: f.properties.severity,
        headline: f.properties.headline || f.properties.event || '',
        link: f.properties['@id'] || '',
        lat: centroid ? centroid.lat : null,
        lon: centroid ? centroid.lon : null,
        geoPrecision: centroid ? 'polygon' : 'none',
      };
    });
}

function classifyHazard(event = '') {
  const e = event.toLowerCase();
  if (e.includes('tornado')) return 'tornado';
  if (e.includes('hurricane') || e.includes('tropical')) return 'hurricane';
  if (e.includes('flood')) return 'flood';
  if (e.includes('thunderstorm')) return 'hail';
  return 'other';
}

async function fetchFireAlerts() {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) {
    console.log('FIRMS_MAP_KEY not set, skipping satellite fire tracking.');
    return [];
  }
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/-125,24,-66,50/1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('FIRMS fetch failed: ' + res.status);
  const csv = await res.text();
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  const latIdx = headers.indexOf('latitude');
  const lonIdx = headers.indexOf('longitude');
  const dateIdx = headers.indexOf('acq_date');
  const confIdx = headers.indexOf('confidence');

  return lines.slice(1)
    .map(line => line.split(','))
    .map(cols => ({
      lat: parseFloat(cols[latIdx]),
      lon: parseFloat(cols[lonIdx]),
      acq_date: cols[dateIdx],
      confidence: cols[confIdx],
    }))
    .filter(r => r.confidence === 'h' || r.confidence === 'high' || r.confidence === '100')
    .map(r => ({
      id: `fire_${r.lat}_${r.lon}_${r.acq_date}`,
      source: 'FIRMS',
      hazard: 'fire',
      title: 'High-confidence fire detection',
      area: `${r.lat.toFixed(3)}, ${r.lon.toFixed(3)}`,
      severity: 'Severe',
      headline: `Satellite fire detection near ${r.lat.toFixed(2)}, ${r.lon.toFixed(2)}`,
      link: '',
      lat: r.lat,
      lon: r.lon,
      geoPrecision: 'point',
    }));
}

function extractDollarAmount(text = '') {
  const match = text.match(/\$[\d,.]+\s?(million|billion|M|B)?/i);
  return match ? match[0] : null;
}

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

// Google News RSS titles are always "<headline> - <publisher>" — strip that
// suffix before hunting for a city/state, or a publisher name like
// "KTTC | Rochester, MN" gets mistaken for the story's location.
function stripPublisherSuffix(title = '') {
  const idx = title.lastIndexOf(' - ');
  return idx === -1 ? title : title.slice(0, idx);
}

// Finds a "City, ST" pair in headline text, e.g. "Fire destroys warehouse in
// Springfield, MO overnight" -> { city: 'Springfield', state: 'MO' }. The
// state-abbreviation check is what keeps this from firing on things like
// "Ready, Set..." — a bare capitalized-word-comma-two-letters match alone is
// far too loose against real headline data. The all-caps rejection stops a
// second state abbreviation from being misread as the city, e.g. "flooding
// in southeastern PA, NJ" would otherwise extract city:"PA".
function extractCityState(text = '') {
  const re = /\b([A-Z][a-zA-Z.'-]+(?:\s[A-Z][a-zA-Z.'-]+){0,3}),\s*([A-Z]{2})\b/g;
  let m;
  while ((m = re.exec(text))) {
    const city = m[1].trim();
    const state = m[2];
    if (!US_STATES.has(state)) continue;
    if (!/[a-z]/.test(city)) continue;
    return { city, state };
  }
  return null;
}

let lastGeocodeCallAt = 0;

// Spec called for the Census Bureau geocoder, but its live API only accepts
// full street addresses — verified empirically against "Chicago, IL",
// "Miami, FL", "New York, NY", "Houston, TX" across every benchmark
// (Public_AR_Current, Public_AR_Census2020) and endpoint variant
// (onelineaddress, structured address, geographies): all return zero
// matches, and the structured endpoint rejects a request with no street
// with "Street address cannot be empty". It has no city-centroid mode, so
// it can't do what this step needs. Nominatim (OpenStreetMap) resolves
// city/state text directly and is free/keyless like the Census API would
// have been; kept to the same 1 req/sec ceiling and a descriptive
// User-Agent per its usage policy (https://operations.osmfoundation.org/policies/nominatim/).
async function geocodeCityState(city, state) {
  const wait = Math.max(0, lastGeocodeCallAt + GEOCODE_RATE_MS - Date.now());
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastGeocodeCallAt = Date.now();

  const address = `${city}, ${state}, USA`;
  const url = `https://nominatim.openstreetmap.org/search`
    + `?q=${encodeURIComponent(address)}&format=json&countrycodes=us&limit=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'beaconwatch-monitor/1.0 (cron geocoder; contact beaconwatchhq@gmail.com)' },
  });
  if (!res.ok) throw new Error('Geocoder HTTP ' + res.status);
  const data = await res.json();
  const match = data && data[0];
  if (!match || match.lat == null || match.lon == null) return null;
  return { lat: parseFloat(match.lat), lon: parseFloat(match.lon) };
}

// Mutates each NEWS event in place with city/state/lat/lon/geoPrecision.
// Geocoder outages or per-item errors are swallowed here (geoPrecision:
// 'none') so a bad geocoder response never fails the whole cron run.
async function geocodeNewsEvents(events) {
  const cache = loadJSON(GEOCODE_CACHE_PATH, {});
  let dirty = false;

  for (const e of events) {
    const cs = extractCityState(stripPublisherSuffix(e.title)) || extractCityState(e.description || '');
    if (!cs) { e.city = null; e.state = null; e.lat = null; e.lon = null; e.geoPrecision = 'none'; e.area = 'Location unknown'; continue; }

    e.city = cs.city;
    e.state = cs.state;
    // `area` is the human-readable display string every part of the app
    // already reads (map popup, search, territory match, CSV export). A
    // resolved city/state is real information even when the coordinate
    // lookup below fails, so it's never re-blanked to "Location unknown"
    // past this point — only a total extraction miss (above) gets that.
    e.area = `${cs.city}, ${cs.state}`;
    const key = `${cs.city}, ${cs.state}`.toLowerCase();

    if (Object.prototype.hasOwnProperty.call(cache, key)) {
      const hit = cache[key];
      e.lat = hit ? hit.lat : null;
      e.lon = hit ? hit.lon : null;
      e.geoPrecision = hit ? 'city' : 'none';
      continue;
    }

    try {
      const coords = await geocodeCityState(cs.city, cs.state);
      cache[key] = coords;
      dirty = true;
      e.lat = coords ? coords.lat : null;
      e.lon = coords ? coords.lon : null;
      e.geoPrecision = coords ? 'city' : 'none';
    } catch (err) {
      console.log('GEOCODE: error for', key, err.message);
      e.lat = null; e.lon = null; e.geoPrecision = 'none';
      // Don't cache: a transient fetch error isn't a real "no match", so
      // leave it uncached to retry on the next cron run.
    }
  }

  if (dirty) saveJSON(GEOCODE_CACHE_PATH, cache);
}

let lastCensusCallAt = 0;

// FIRMS gives coordinates, not a place name, and `area` was showing them
// raw ("37.210, -93.290") — never acceptable to display. Unlike the NEWS
// forward lookup, Census's *reverse* geocoder (coordinates -> geography)
// works fine with no street address; verified live. Prefers "Incorporated
// Places" (a real city name) but FIRMS detections are often in wildland/
// rural areas with no incorporated place at that point — verified with a
// Yellowstone coordinate, which has no "Incorporated Places" entry at all
// — so this falls back to "County Subdivisions" then "Counties". Returns
// null (-> "Location unknown") if even the state lookup comes up empty
// (e.g. an offshore point), never a guess.
async function reverseGeocodeCoords(lat, lon) {
  const wait = Math.max(0, lastCensusCallAt + GEOCODE_RATE_MS - Date.now());
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastCensusCallAt = Date.now();

  const url = `https://geocoding.geo.census.gov/geocoder/geographies/coordinates`
    + `?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Census reverse geocoder HTTP ' + res.status);
  const data = await res.json();
  const geo = (data.result && data.result.geographies) || {};
  const first = key => geo[key] && geo[key][0];

  const state = (first('States') || {}).STUSAB;
  if (!state) return null;
  const place = (first('Incorporated Places') || first('County Subdivisions') || first('Counties') || {}).BASENAME;
  if (!place) return null;
  return `${place}, ${state}`;
}

// Mutates each FIRMS event's `area` in place. Same fail-soft shape as
// geocodeNewsEvents(): a cache hit or miss both resolve without a network
// call, an outage never fails the whole run, and coordinates are cached
// rounded to ~1km (2 decimal places) since nearby hotspots resolve to the
// same place — full-precision coordinates would almost never repeat.
async function geocodeFirmsEvents(events) {
  const cache = loadJSON(GEOCODE_CACHE_PATH, {});
  let dirty = false;

  for (const e of events) {
    if (e.lat == null || e.lon == null) { e.area = 'Location unknown'; continue; }
    const key = `rev:${e.lat.toFixed(2)},${e.lon.toFixed(2)}`;

    if (Object.prototype.hasOwnProperty.call(cache, key)) {
      e.area = cache[key] || 'Location unknown';
      continue;
    }

    try {
      const place = await reverseGeocodeCoords(e.lat, e.lon);
      cache[key] = place;
      dirty = true;
      e.area = place || 'Location unknown';
    } catch (err) {
      console.log('GEOCODE: reverse error for', key, err.message);
      e.area = 'Location unknown';
      // Don't cache: a transient fetch error isn't a real "no match".
    }
  }

  if (dirty) saveJSON(GEOCODE_CACHE_PATH, cache);
}

const NEWS_CATEGORIES = [
  {
    hazard: 'flood',
    query: '("flood damage" OR "flooding damages" OR "flash flooding" OR "homes flooded" OR "water rescue" OR "floodwaters" OR "record flooding")',
    hint: /(flood|floodwater|water rescue|inundat|submerged|evacuat|damage|destroyed|million)/i,
  },
  {
    hazard: 'fire',
    query: '("three-alarm fire" OR "four-alarm fire" OR "multi-alarm fire" OR "warehouse fire" OR "industrial fire" OR "plant fire")',
    hint: /(three-alarm|four-alarm|multi-alarm|warehouse|industrial|plant|factory|evacuat)/i,
  },
  {
    hazard: 'collapse',
    query: '("roof collapse" OR "structural collapse" OR "building collapse" OR "partial collapse")',
    hint: /(collapse|evacuat|million|destroyed|structural)/i,
  },
  {
    hazard: 'stormdamage',
    query: '("severe storm damage" OR "storm damage" OR "tornado damage" OR "hail damage")',
    hint: /(million|destroyed|damage|evacuat|shelter|debris)/i,
  },
];

async function fetchNewsAlerts() {
  const results = await Promise.all(NEWS_CATEGORIES.map(async cat => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(cat.query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { headers: { 'User-Agent': 'beaconwatch/1.0' } });
    if (!res.ok) throw new Error(`Google News fetch failed for ${cat.hazard}: ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

    return items
      .map(m => {
        const block = m[1];
        const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1]
          .replace('<![CDATA[', '').replace(']]>', '').trim();
        const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [, ''])[1].trim();
        const description = (block.match(/<description>([\s\S]*?)<\/description>/) || [, ''])[1]
          .replace('<![CDATA[', '').replace(']]>', '').replace(/<[^>]+>/g, '').trim();
        return { title, link, description };
      })
      .filter(a => a.title && a.link && cat.hint.test(a.title))
      .map(a => ({
        id: `news_${cat.hazard}_${a.link}`,
        source: 'NEWS',
        hazard: cat.hazard,
        title: a.title,
        area: a.title,
        severity: 'Severe',
        headline: a.title,
        link: a.link,
        description: a.description,
        estimatedLoss: extractDollarAmount(a.title),
      }));
  }));

  return results.flat();
}

// buildingType/alarmCount/departmentCount/lossScale — see lib/buildingType.js
// for the matching itself; this is just the per-lead wiring.
//
// classifyBuildingType(text) matches whatever single string it's given and
// can't tell title from description on its own, but the spec's confidence
// rule needs exactly that distinction (high: matched in title, medium:
// matched only once description/headline is added). So this calls it up to
// twice: title alone first, then title+extra only if the first call missed
// — a hit on that second call is downgraded to 'medium'. alarmCount and
// departmentCount have no confidence concept, so they run once against the
// combined text either way.
const COMMERCIAL_BUILDING_TYPES = new Set([
  'warehouse', 'industrial', 'multifamily', 'institutional', 'retail', 'office',
  'auto_marine', 'agricultural',
]);
const LOSS_TEXT_RE = /\b(total\s+loss|destroyed|leveled|collapsed|explosion)\b/i;

function classifyLead(e) {
  // NWS's `headline` is real extra prose distinct from its short `title`
  // ("Flood Warning"). FIRMS/NEWS `headline` is just a derived copy of
  // `title` with no new information — `description` (NEWS only, from the
  // geocoding pass) is the real extra text for those.
  const extra = e.source === 'NWS' ? e.headline : e.description;
  const titleText = (e.title || '').toLowerCase();

  let cls = classifyBuildingType(titleText);
  if (cls.buildingType === 'other' && extra) {
    const combined = (titleText + ' ' + extra).toLowerCase();
    const combinedCls = classifyBuildingType(combined);
    if (combinedCls.buildingType !== 'other') {
      cls = { buildingType: combinedCls.buildingType, typeConfidence: 'medium' };
    }
  }

  const alarmText = (titleText + ' ' + (extra || '')).toLowerCase();
  const alarmCount = extractAlarmCount(alarmText);
  const departmentCount = extractDepartmentCount(alarmText);

  let lossScale = null;
  if (alarmCount >= 4 || departmentCount >= 5 || LOSS_TEXT_RE.test(alarmText)) lossScale = 'major';
  else if (alarmCount === 3 || departmentCount >= 3) lossScale = 'large';
  else if (alarmCount === 1 || alarmCount === 2) lossScale = 'medium';

  return {
    buildingType: cls.buildingType,
    typeConfidence: cls.typeConfidence,
    alarmCount,
    departmentCount,
    lossScale,
    commercial: COMMERCIAL_BUILDING_TYPES.has(cls.buildingType),
  };
}

async function main() {
  const seen = new Set(loadJSON(STATE_PATH, []));

  const [weatherEvents, fireEvents, newsFireEvents] = await Promise.all([
    fetchWeatherAlerts(),
    fetchFireAlerts().catch(err => { console.error('FIRMS error:', err.message); return []; }),
    fetchNewsAlerts().catch(err => { console.error('News error:', err.message); return []; }),
  ]);
  const allEvents = [...weatherEvents, ...fireEvents, ...newsFireEvents];
  const newEvents = allEvents.filter(e => !seen.has(e.id));

  console.log(`Fetched ${allEvents.length} events, ${newEvents.length} new.`);

  if (newEvents.length === 0) {
    saveJSON(STATE_PATH, [...seen].slice(-2000));
    return;
  }

  // Only geocode leads we're about to log — a geocoder outage here must
  // never fail the whole run, so this step's own per-item errors already
  // fail soft, and this is a second net around the entire step.
  try {
    await geocodeNewsEvents(newEvents.filter(e => e.source === 'NEWS'));
  } catch (err) {
    console.error('Geocode step error:', err.message);
  }
  try {
    await geocodeFirmsEvents(newEvents.filter(e => e.source === 'FIRMS'));
  } catch (err) {
    console.error('FIRMS reverse-geocode step error:', err.message);
  }

  // classifyLead() already never throws internally, but this is a second
  // net around the whole step per spec: a bug here must still leave the
  // lead in the feed, classified 'other', not drop the run.
  for (const e of newEvents) {
    try {
      Object.assign(e, classifyLead(e));
    } catch (err) {
      console.error('Classify error for', e.id, err.message);
      Object.assign(e, { buildingType: 'other', typeConfidence: 'low', alarmCount: null, departmentCount: null, lossScale: null, commercial: false });
    }
  }

  const logEntries = newEvents.map(e => ({
    id: e.id,
    hazard: e.hazard,
    title: e.title,
    area: e.area,
    severity: e.severity,
    headline: e.headline,
    link: e.link,
    source: e.source,
    lat: e.lat ?? null,
    lon: e.lon ?? null,
    city: e.city ?? null,
    state: e.state ?? null,
    geoPrecision: e.geoPrecision ?? null,
    estimatedLoss: e.estimatedLoss ?? null,
    buildingType: e.buildingType,
    typeConfidence: e.typeConfidence,
    alarmCount: e.alarmCount,
    departmentCount: e.departmentCount,
    lossScale: e.lossScale,
    commercial: e.commercial,
    timestamp: new Date().toISOString(),
  }));
  const existingLog = loadJSON(ALERTS_LOG_PATH, []);
  saveJSON(ALERTS_LOG_PATH, [...logEntries, ...existingLog].slice(0, LOG_RETENTION));

  // Mark everything we just logged as seen so it isn't re-logged next run.
  newEvents.forEach(e => seen.add(e.id));
  saveJSON(STATE_PATH, [...seen].slice(-2000));
  console.log(`Logged ${newEvents.length} new events. No emails sent (digest worker handles delivery).`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
