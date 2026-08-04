// BeaconWatch — digest worker.
// Runs once a day on a GitHub Actions schedule. Instead of a per-event blast,
// it sends each subscriber a SINGLE periodic report summarizing all activity
// in their window. Subscribers pick a cadence and can opt out entirely.
//
// Subscriber schema (from the SUBSCRIBERS_JSON secret — never committed):
//   {
//     "name": "Caston",
//     "email": "you@example.com",
//     "frequency": "daily" | "everyother" | "weekly" | "monthly" | "off",
//     "active": true,                       // false or "off" == unsubscribed
//     "nationwide": true,                   // or set "watchLocation": "TX"
//     "hazards": ["tornado","hurricane","flood","hail","fire","collapse","stormdamage"],
//     "fireRadiusMiles": 25                 // optional, for FIRMS satellite fires
//   }
//
// SMS is intentionally gone — email digest only.

const fs = require('fs');
const path = require('path');
// nodemailer is required lazily inside main() so dry-runs (no credentials)
// don't need the dependency installed.

const ALERTS_LOG_PATH = path.join(__dirname, '..', 'state', 'alerts-log.json');
const SUBSCRIBERS_PATH = path.join(__dirname, '..', 'subscribers.json');

const FREQ = {
  daily:      { label: 'Daily',          windowDays: 1,  due: () => true },
  everyother: { label: 'Every-other-day', windowDays: 2, due: d => epochDay(d) % 2 === 0 },
  weekly:     { label: 'Weekly',         windowDays: 7,  due: d => d.getUTCDay() === 1 },   // Monday
  monthly:    { label: 'Monthly',        windowDays: 31, due: d => d.getUTCDate() === 1 },  // 1st of month
};

const HAZARD_LABEL = {
  tornado: 'Tornado', hurricane: 'Hurricane', flood: 'Flood', hail: 'Hail',
  fire: 'Fire', collapse: 'Collapse', stormdamage: 'Storm damage', other: 'Other',
};

function epochDay(d) { return Math.floor(d.getTime() / 86400000); }

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function matchesSubscriber(event, sub) {
  if (!Array.isArray(sub.hazards) || !sub.hazards.includes(event.hazard)) return false;
  if (sub.nationwide) return true;
  if (event.source === 'FIRMS') {
    if (sub.lat == null || sub.lon == null || event.lat == null || event.lon == null) return false;
    return haversineMiles(sub.lat, sub.lon, event.lat, event.lon) <= (sub.fireRadiusMiles || 25);
  }
  if (!sub.watchLocation) return false;
  return (event.area || '').toLowerCase().includes(sub.watchLocation.toLowerCase());
}

function normalizeFrequency(sub) {
  let f = (sub.frequency || 'daily').toLowerCase();
  if (f === 'off' || sub.active === false) return 'off';
  return FREQ[f] ? f : 'daily';
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cleanTitle(e) {
  const raw = (e.title || e.headline || 'Untitled').replace('<![CDATA[', '').replace(']]>', '').trim();
  const cut = raw.lastIndexOf(' - ');
  return cut > 20 ? raw.slice(0, cut).trim() : raw;
}

function buildEmail(sub, events, freqKey, now) {
  const label = FREQ[freqKey].label;
  // group by hazard
  const groups = {};
  for (const e of events) (groups[e.hazard] = groups[e.hazard] || []).push(e);
  const order = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);

  const dateStr = now.toISOString().slice(0, 10);
  const subject = `BeaconWatch — ${label} Report · ${events.length} lead${events.length === 1 ? '' : 's'}`;

  const textLines = [`BeaconWatch ${label} Report — ${dateStr}`, `${events.length} matching lead(s) in the last ${FREQ[freqKey].windowDays} day(s).`, ''];
  let html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a">
    <h2 style="margin:0 0 4px">BeaconWatch — ${label} Report</h2>
    <p style="color:#666;margin:0 0 18px">${escapeHtml(dateStr)} · ${events.length} matching lead${events.length === 1 ? '' : 's'} in the last ${FREQ[freqKey].windowDays} day(s)</p>`;

  for (const hz of order) {
    const list = groups[hz];
    textLines.push(`== ${HAZARD_LABEL[hz] || hz} (${list.length}) ==`);
    html += `<h3 style="margin:18px 0 6px;border-bottom:1px solid #eee;padding-bottom:4px">${escapeHtml(HAZARD_LABEL[hz] || hz)} <span style="color:#999;font-weight:400">(${list.length})</span></h3>`;
    for (const e of list) {
      const title = cleanTitle(e);
      const when = new Date(e.timestamp).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
      const loss = e.estimatedLoss ? ` [${e.estimatedLoss}]` : '';
      textLines.push(`- ${title}${loss}\n  ${e.area || ''} · ${when}${e.link ? '\n  ' + e.link : ''}`);
      html += `<div style="margin:0 0 12px">
        <div style="font-weight:600">${escapeHtml(title)}${loss ? ` <span style="color:#0a7d33">${escapeHtml(e.estimatedLoss)}</span>` : ''}</div>
        <div style="color:#666;font-size:13px">${escapeHtml(e.area || '')} · ${escapeHtml(when)}</div>
        ${e.link ? `<a href="${escapeHtml(e.link)}" style="color:#c22;font-size:13px">Source</a>` : ''}
      </div>`;
    }
    textLines.push('');
  }

  html += `<p style="color:#999;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:12px">
    You're receiving the ${label.toLowerCase()} BeaconWatch report. To change cadence or unsubscribe,
    update your entry in the subscriber list (set "frequency":"off").</p></div>`;
  textLines.push(`--\nTo change cadence or unsubscribe, set "frequency":"off" in your subscriber entry.`);

  return { subject, text: textLines.join('\n'), html };
}

async function main() {
  const now = new Date();
  const forced = (process.env.DIGEST_FORCE || '').toLowerCase(); // '', a frequency, or 'all'
  const sendEmpty = process.env.DIGEST_SEND_EMPTY === 'true';

  const subscribers = process.env.SUBSCRIBERS_JSON
    ? JSON.parse(process.env.SUBSCRIBERS_JSON)
    : loadJSON(SUBSCRIBERS_PATH, []);
  const log = loadJSON(ALERTS_LOG_PATH, []);

  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

  if (!subscribers.length) { console.log('No subscribers configured — nothing to send.'); return; }

  let transporter = null;
  const canSend = GMAIL_USER && GMAIL_APP_PASSWORD;
  if (canSend) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      pool: true, maxConnections: 1, maxMessages: 50, rateDelta: 20000, rateLimit: 5,
    });
  } else {
    console.error('GMAIL_USER / GMAIL_APP_PASSWORD not set — running in dry-run mode (no email sent).');
  }

  let sent = 0, skipped = 0;
  for (const sub of subscribers) {
    if (!sub.email) { skipped++; continue; }
    const freqKey = normalizeFrequency(sub);
    if (freqKey === 'off') { console.log(`Skip ${sub.email}: unsubscribed.`); skipped++; continue; }

    const isDue = forced === 'all' || forced === freqKey || (!forced && FREQ[freqKey].due(now));
    if (!isDue) { console.log(`Skip ${sub.email}: ${freqKey} not due today.`); skipped++; continue; }

    const cutoff = now.getTime() - FREQ[freqKey].windowDays * 86400000;
    const seenIds = new Set();
    const events = log
      .filter(e => e.timestamp && new Date(e.timestamp).getTime() >= cutoff)
      .filter(e => matchesSubscriber(e, sub))
      .filter(e => (seenIds.has(e.id) ? false : (seenIds.add(e.id), true)));

    if (!events.length && !sendEmpty) { console.log(`Skip ${sub.email}: no ${freqKey} activity in window.`); skipped++; continue; }

    const mail = buildEmail(sub, events, freqKey, now);
    if (!canSend) { console.log(`[dry-run] Would send to ${sub.email}: "${mail.subject}"`); sent++; continue; }
    try {
      await transporter.sendMail({ from: GMAIL_USER, to: sub.email, subject: mail.subject, text: mail.text, html: mail.html });
      console.log(`Sent ${freqKey} report to ${sub.email} (${events.length} leads).`);
      sent++;
    } catch (err) {
      console.error(`Failed sending to ${sub.email}:`, err.message);
    }
  }

  if (transporter) transporter.close();
  console.log(`Digest run complete. Sent/queued: ${sent}, skipped: ${skipped}.`);
}

if (require.main === module) {
  main().catch(err => { console.error('Fatal error:', err); process.exitCode = 1; });
}

module.exports = { buildEmail, matchesSubscriber, normalizeFrequency, cleanTitle, FREQ };
