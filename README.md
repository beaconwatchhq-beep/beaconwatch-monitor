# beaconwatch-monitor

Automated large-loss lead monitoring for restoration sales — tornado, hurricane,
flood, hail, fire, and structural collapse — tracked from NWS, NASA FIRMS, and
Google News, surfaced on a dashboard and delivered as a periodic email digest.

## How it works

Two GitHub Actions workers:

| Worker | Schedule | Job |
| --- | --- | --- |
| `watch.yml` → `scripts/check-alerts.js` | every 15 min | **Monitor + log only.** Polls NWS/FIRMS/News, appends new matches to `state/alerts-log.json` (which the dashboard reads). Sends nothing. |
| `digest.yml` → `scripts/send-digest.js` | daily 12:00 UTC | **Delivery.** Sends each subscriber a single report of activity in their window. Nothing is sent per-event. |

The dashboard lives at `docs/index.html` (GitHub Pages → `main` → `/docs`) and reads
`state/alerts-log.json` live. Per-device browser push notifications are opt-in/out
from the dashboard itself; the **email digest** is driven by the subscriber list below.

## Notifications

- **No per-event blast.** The old "up to 15 emails per run" firehose is gone.
- **No SMS.** Carrier email-to-SMS gateways are dead/unreliable; removed entirely.
- **One digest per subscriber**, at the cadence they choose.

## Subscribers (email digest)

The list lives **only** in the `SUBSCRIBERS_JSON` GitHub Actions secret — never
committed (the repo is public; no PII in git). `subscribers.json` stays `[]`.

```json
[
  {
    "name": "Caston",
    "email": "you@example.com",
    "frequency": "daily",
    "active": true,
    "nationwide": true,
    "hazards": ["tornado","hurricane","flood","hail","fire","collapse","stormdamage"]
  }
]
```

- `frequency`: `daily` | `everyother` | `weekly` | `monthly` | `off`
  - `daily` sends every day; `everyother` on even days; `weekly` on Mondays;
    `monthly` on the 1st. Each report covers that window (1 / 2 / 7 / 31 days).
- **Unsubscribe** by setting `"frequency": "off"` (or `"active": false`).
- Scope with `"nationwide": true` **or** `"watchLocation": "TX"`; optional
  `"fireRadiusMiles"` for FIRMS satellite fires.

## Secrets (Settings → Secrets and variables → Actions)

- `GMAIL_USER`, `GMAIL_APP_PASSWORD` — Gmail sender for the digest.
- `SUBSCRIBERS_JSON` — the subscriber list above.
- `FIRMS_MAP_KEY` — optional NASA FIRMS satellite fire key.

## Manual runs

`digest.yml` supports **Run workflow** with inputs:
- `force`: `daily` | `everyother` | `weekly` | `monthly` | `all` — send now regardless of schedule.
- `send_empty`: `true` to send even with no matching activity.

Without `GMAIL_*` set the digest runs in **dry-run** mode and just logs what it would send.
