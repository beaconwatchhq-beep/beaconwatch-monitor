// BeaconWatch — building-type / fire-scale extraction.
//
// Plain-regex classification of what kind of structure a lead is about and
// how big the reported fire response was. No NLP, no network call — this
// runs inside the 15-minute ingest cron against hundreds of leads, so every
// export here must be cheap and must never throw (a bad lead should still
// reach the feed, just classified 'other').
//
// classifyBuildingType(text) matches against exactly the text it's given —
// it doesn't know or care whether that text came from a title or a
// description. Confidence is 'high' when it finds a match, 'low' for
// 'other'. The title-vs-description "high vs medium" distinction the
// ingest spec asks for is a caller concern: call this once against the
// title alone first, and only fall back to a second call against
// title+description (downgrading a hit there to 'medium') if the first
// call misses. See check-alerts.js's classifyLeadText() for that wiring.

const BUILDING_TYPE_KEYWORDS = [
  { type: 'warehouse', keywords: [
    'warehouse', 'distribution center', 'distribution facility', 'fulfillment center',
    'storage facility', 'self storage', 'cold storage', 'logistics center', 'freight terminal',
  ] },
  { type: 'industrial', keywords: [
    'manufacturing plant', 'factory', 'industrial facility',
    'processing plant', 'refinery', 'mill', 'foundry', 'plant fire', 'chemical plant',
    'recycling facility',
    // Bare "industrial" (and "industrial park"/"industrial district"/etc,
    // pulled out of the plain list above for the same reason) is too broad
    // on its own — "industrial park closed", "industrial area" — so it only
    // counts here when a loss noun shows up within a few words after it.
    // "industrial park fire" and "massive industrial blaze" still match;
    // "industrial district traffic delays" doesn't. Directional only
    // (industrial -> noun), per spec; "fire closes industrial park" (noun
    // before industrial) is a known miss, not covered here.
    /\bindustrial\b(?:\s+\S+){0,3}\s+(?:fire|blaze|explosion|damage|destroyed|collapse)\b/i,
  ] },
  { type: 'multifamily', keywords: [
    'apartment', 'apartment complex', 'condo', 'condominium', 'hotel', 'motel', 'inn',
    'dormitory', 'senior living', 'assisted living', 'nursing home', 'mobile home park',
  ] },
  { type: 'institutional', keywords: [
    'school', 'high school', 'elementary', 'middle school', 'university', 'college',
    'campus', 'hospital', 'medical center', 'clinic', 'church', 'temple', 'mosque',
    'synagogue', 'library', 'courthouse', 'city hall', 'fire station', 'police station',
    'post office',
  ] },
  { type: 'retail', keywords: [
    'retail', 'shopping center', 'strip mall', 'mall', 'store', 'restaurant', 'bar',
    'grocery', 'supermarket', 'salon', 'gym', 'dealership', 'gas station',
    'convenience store',
  ] },
  { type: 'office', keywords: [
    'office building', 'office complex', 'office park', 'professional building',
    'high-rise office',
  ] },
  { type: 'auto_marine', keywords: [
    'auto shop', 'body shop', 'repair shop', 'garage', 'marina', 'boatyard', 'dry dock',
    'barge', 'shipyard',
  ] },
  { type: 'agricultural', keywords: [
    'barn', 'silo', 'grain elevator', 'dairy', 'poultry', 'farm building', 'greenhouse',
  ] },
  { type: 'residential', keywords: [
    'home', 'house', 'residence', 'duplex', 'townhome', 'single family',
  ] },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Precompiled once at module load — classifyBuildingType() must stay cheap
// per call since it runs on hundreds of leads every 15 minutes.
// Most keywords are plain phrases, auto-wrapped in word boundaries. A few
// (the guarded "industrial" pattern above) need a RegExp of their own —
// those pass through untouched so this stays the one place to tune either kind.
const COMPILED = BUILDING_TYPE_KEYWORDS.map(({ type, keywords }) => ({
  type,
  res: keywords.map(k => (k instanceof RegExp) ? k : new RegExp(`\\b${escapeRegExp(k)}\\b`, 'i')),
}));

function classifyBuildingType(text) {
  try {
    const t = (text || '').toString();
    if (!t.trim()) return { buildingType: 'other', typeConfidence: 'low' };
    for (const { type, res } of COMPILED) {
      if (res.some(re => re.test(t))) return { buildingType: type, typeConfidence: 'high' };
    }
    return { buildingType: 'other', typeConfidence: 'low' };
  } catch {
    return { buildingType: 'other', typeConfidence: 'low' };
  }
}

const ALARM_WORD_NUM = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ALARM_ORDINAL_NUM = { second: 2, third: 3, fourth: 4, fifth: 5 };

const ALARM_DIGIT_RE = /(\d+)[\s-]*alarm/gi;
const ALARM_WORD_RE = /\b(two|three|four|five|six|seven|eight|nine|ten)-alarm\b/gi;
const ALARM_ORDINAL_RE = /\b(second|third|fourth|fifth)\s+alarm\b/gi;

function extractAlarmCount(text) {
  try {
    const t = (text || '').toString();
    if (!t.trim()) return null;
    let best = null;
    for (const m of t.matchAll(ALARM_DIGIT_RE)) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && (best === null || n > best)) best = n;
    }
    for (const m of t.matchAll(ALARM_WORD_RE)) {
      const n = ALARM_WORD_NUM[m[1].toLowerCase()];
      if (best === null || n > best) best = n;
    }
    for (const m of t.matchAll(ALARM_ORDINAL_RE)) {
      const n = ALARM_ORDINAL_NUM[m[1].toLowerCase()];
      if (best === null || n > best) best = n;
    }
    if (best === null) return null;
    if (best > 12) return null; // implausible — treat as a parsing error, not a real count
    return best;
  } catch {
    return null;
  }
}

const DEPT_RE = /(\d+)\s+(?:fire\s+departments?|departments?(?:\s+responded)?|agencies)\b/gi;

function extractDepartmentCount(text) {
  try {
    const t = (text || '').toString();
    if (!t.trim()) return null;
    let best = null;
    for (const m of t.matchAll(DEPT_RE)) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && (best === null || n > best)) best = n;
    }
    return best;
  } catch {
    return null;
  }
}

module.exports = { classifyBuildingType, extractAlarmCount, extractDepartmentCount, BUILDING_TYPE_KEYWORDS };
