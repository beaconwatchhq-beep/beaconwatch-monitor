// BeaconWatch — background monitor.
// Runs every 15 min on a GitHub Actions schedule. Polls NWS/FIRMS/News,
// diffs against previously-seen events, and appends new matches to
// state/alerts-log.json (which feeds the dashboard). It does NOT send any
// email or SMS — outbound notifications are handled entirely by the digest
// worker (scripts/send-digest.js), so subscribers get one periodic report
// instead of a per-event blast.

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'state', 'seen-alerts.json');
const ALERTS_LOG_PATH = path.join(__dirname, '..', 'state', 'alerts-log.json');

// Keep enough history for a monthly digest window (~30 days of activity).
const LOG_RETENTION = 1000;

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
    }));
}

function extractDollarAmount(text = '') {
  const match = text.match(/\$[\d,.]+\s?(million|billion|M|B)?/i);
  return match ? match[0] : null;
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
        return { title, link };
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
        estimatedLoss: extractDollarAmount(a.title),
      }));
  }));

  return results.flat();
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
    estimatedLoss: e.estimatedLoss ?? null,
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
