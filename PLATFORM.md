# BeaconWatch Platform — v3 Architecture Plan

**From free lead feed → paid property-intelligence platform.**
A lead comes in → BeaconWatch enriches the property (owner of record, parcel
facts, satellite + street imagery, damage assessment) → the salesman prints a
complete **Job Dossier** and knocks on the door knowing more than anyone else.

---

## 1. What we're building

```
                        ┌─────────────────────────────────────────────┐
                        │                SUPABASE                     │
  NWS ──┐               │  ┌──────────┐  ┌─────────┐  ┌────────────┐  │
  FIRMS ─┼─▶ Monitor ──▶│  │ Postgres │  │  Auth   │  │  Storage   │  │
  News ──┘   (cron)     │  │ events   │  │ logins  │  │ photos     │  │
                        │  │ jobs     │  │ seats   │  │ blueprints │  │
  Stripe ◀──webhooks───▶│  │ contacts │  └─────────┘  │ reports    │  │
  (billing)             │  │ media    │   RLS: every  └────────────┘  │
                        │  │ reports  │   row scoped                  │
  Enrichment APIs ─────▶│  └──────────┘   to org+plan                 │
  (parcel/owner,        └───────────────────┬─────────────────────────┘
   imagery, weather)                        │
                                            ▼
                              App (login-gated dashboard)
                              Marketing site (GitHub Pages)
                              Job Dossier PDF (print/export)
```

**Stack:** Supabase (Postgres + Auth + Storage + Edge Functions + RLS) ·
Stripe (Checkout + Customer Portal) · existing single-file app re-pointed at
Supabase · GitHub Pages keeps the public marketing site · Resend for
transactional + digest email (replaces Gmail app-password — real deliverability,
DKIM, no 500/day cap).

Why Supabase: one vendor covers database, login, file storage, and scheduled
functions; row-level security gives us per-team data isolation without writing
an API server; free tier to prototype, ~$25/mo in production.

---

## 2. Data model (Postgres)

### Identity & billing
| Table | Purpose |
|---|---|
| `orgs` | A company/team (name, logo, territory settings) |
| `users` | Supabase auth users |
| `memberships` | user ↔ org, role (`owner` / `manager` / `rep`) |
| `subscriptions` | org ↔ Stripe (customer id, plan, seat count, status, period end) |
| `territories` | org → list of states/counties or a GeoJSON polygon (exclusivity, Enterprise) |

### The feed (replaces `state/alerts-log.json`)
| Table | Purpose |
|---|---|
| `events` | One row per real-world event: hazard, severity, title, area, lat/lon, source, first/last seen, cluster key |
| `event_articles` | Every article/alert attached to an event (the "related coverage") |

### The money tables — jobs
| Table | Purpose |
|---|---|
| `jobs` | org_id, optional event_id, address, status pipeline (`new → scouted → contacted → quoted → won/lost`), assigned rep, created_by |
| `properties` | One per address: parcel id, **owner name + mailing address**, year built, sqft, stories, construction type, roof type, assessed value, building footprint (GeoJSON) |
| `contacts` | job_id, name, role (owner / property manager / adjuster / tenant), phone, email, source, notes |
| `media` | job_id, kind (`satellite` / `streetview` / `aerial_pre` / `aerial_post` / `photo` / `photo360` / `blueprint` / `doc`), storage path, caption, captured_at, uploaded_by |
| `damage_assessments` | job_id, hazard, checklist (JSONB: roof/siding/windows/water intrusion/…), severity estimate, est. loss range, assessor notes |
| `reports` | job_id, generated PDF path, version, generated_by, generated_at |
| `activity` | job_id, who did what when — the logbook becomes a real audit trail |

**Row-level security:** every job/contact/media/report row carries `org_id`;
policies allow access only to active-subscription members of that org. `events`
are readable by any active subscriber. Nothing is public anymore.

The current per-device localStorage logbook migrates in: on first login the app
offers "import this device's logbook" → rows in `jobs`/`contacts`. From then on
the whole team shares one logbook — the feature we couldn't do without a backend
becomes the Team tier's headline.

---

## 3. Property intelligence pipeline (the enrichment)

Triggered when a rep converts a lead → job (or enters any address by hand):

1. **Geocode** — Mapbox Geocoding (address → lat/lon + normalized address).
2. **Parcel + owner lookup** — **Regrid API** (or ATTOM): returns the county
   assessor record — *owner of record, owner mailing address, parcel boundary,
   year built, sqft, construction class, assessed value*. ~$0.02–0.10/parcel,
   pay-per-use. This is the "who owns this building" answer.
3. **Imagery** (multiple angles, stored to `media` so the dossier keeps them):
   - **Satellite/aerial:** Mapbox Static Images (cheap, licensed for export) and
     **NAIP** (free USDA aerials, public domain).
   - **Post-disaster aerials:** **NOAA Emergency Response Imagery** — free,
     public, flown days after hurricanes/tornadoes. Before/after pairs of the
     actual storm = the single most persuasive page in the dossier.
   - **Street-level:** Google Street View Static API (~$7/1k) for the curb shot.
   - **Premium (Enterprise later):** Nearmap/EagleView subscriptions for
     high-res historical captures + roof measurements.
4. **Building footprint** — Microsoft Building Footprints (free, open data) or
   the parcel geometry; drawn on the map + used for area estimates.
5. **Weather verification** — NOAA storm reports + the event's own record:
   *"1.75-in hail reported 0.4 mi from this address on Aug 3, 6:41 PM."*
   Adjusters and owners take a printed weather-verification page seriously.
6. **Damage likelihood score (v1: honest rules, not fake AI)** —
   `hazard severity × distance from event × building age/type × roof type`.
   Later: computer-vision damage detection on post-event imagery (partner API
   such as CAPE-style analytics) — flagged as Phase D, not promised sooner.
7. **Rep uploads** — site photos straight from the phone camera, 360° photos,
   blueprints/floor plans (PDF/image), any document → Supabase Storage bucket
   per org, listed on the job, embedded in the dossier.

---

## 4. The Job Dossier (printable report)

One tap on a job → **Generate report** → branded PDF:

1. **Cover** — company logo (white-label per org), address, date, rep.
2. **Property profile** — owner of record + mailing address, parcel facts,
   year built, sqft, construction, assessed value.
3. **Event page** — what happened, when, severity, map of event vs. property,
   weather verification data.
4. **Imagery** — satellite, street view, before/after disaster aerials, then
   the rep's own site photos, captioned.
5. **Damage assessment** — checklist results, severity, estimated loss range.
6. **Contacts & activity** — everyone attached to the job, timeline of touches.
7. **Next steps / notes** page.

**Build order:** v1 is a print-optimized HTML view (`@media print` stylesheet,
`window.print()`) — instant, free, works offline, prints or saves-as-PDF from
any phone. v2 adds server-side PDF generation (Gotenberg/Playwright in an Edge
Function) so reports can be emailed and archived to `reports` automatically.

---

## 5. Billing & gating

- **Stripe Checkout** for signup (card → active subscription webhook → row in
  `subscriptions`), **Customer Portal** for self-serve upgrades/cancel.
- Seats = Stripe quantity; app blocks adding a 6th member on a 5-seat plan.
- RLS policies check subscription status — lapsed card = read-only, then locked.
- Trials: 14 days, no card, feed slightly delayed (30 min) until paid.

| Tier | Price (launch) | Gets |
|---|---|---|
| Solo | $79/mo | Live feed, map, filters, digests, personal jobs, print dossier (basic) |
| Team | $59/seat/mo (min 3) | + shared logbook, assignment, full dossier w/ owner lookup + imagery |
| Enterprise | custom ($500+) | + territory exclusivity, white-label reports, premium imagery, API |

Enrichment API costs (parcel lookups, street view) are metered per job —
either soft-capped per tier (e.g. 50 enriched jobs/mo on Team) or passed
through at cost+margin. Soft caps are simpler; start there.

---

## 6. What changes for the current system

| Today | v3 |
|---|---|
| `alerts-log.json` committed to public repo | Monitor **dual-writes** to Supabase, then JSON retired |
| GitHub Actions cron (fine) | Keeps running; just POSTs to Supabase with a service key — no re-platforming of the monitor |
| One shared client-side password | Real email login per user (magic link), Stripe-gated |
| Gmail app-password digests | Resend with your domain (DKIM/SPF), per-user digest prefs stored in DB |
| Per-device localStorage logbook | Shared org logbook in Postgres (one-time import from device) |
| Public GitHub Pages app | Marketing site stays public; the app moves behind login (still deployable as static files — Supabase is called from the browser with RLS enforcing access) |

**Also fix before charging:** replace Google News RSS (ToS gray zone in a paid
product) with **GDELT** (free, open) and/or a licensed news API; keep NWS/FIRMS
(public domain — free to build a business on). Respect imagery license terms in
stored PDFs (Mapbox/NAIP/NOAA are safe to embed; Google Street View has
restrictions — review before v2 PDFs).

**Legal hygiene:** LLC + Terms of Service ("leads compiled from public
sources, no guarantee"), owner-contact data is public record but calls/texts
must respect DNC/TCPA basics, trademark search on "BeaconWatch."

---

## 7. Phased build

| Phase | Time | Ships | Revenue effect |
|---|---|---|---|
| **A — Gate it** | 2–3 wks | Supabase, auth, Stripe, private feed, shared team logbook, digest via Resend | Can charge Solo/Team from day one |
| **B — Job dossier** | 3–4 wks | Jobs pipeline, parcel/owner lookup, imagery pull, photo/blueprint uploads, print-CSS dossier | Justifies Team pricing; the demo that closes sales |
| **C — Enterprise** | 2–3 wks | Territories, white-label PDF, before/after NOAA imagery, weather-verification page, server PDFs | $500+/mo accounts, franchise deals |
| **D — Intelligence** | later | CV damage scoring, roof measurements, CRM integrations (JobNimbus, AccuLynx), mobile push | Moat |

## 8. Running costs

| Item | Monthly |
|---|---|
| Supabase Pro | $25 |
| Resend | $20 |
| Mapbox + Street View (early volume) | $20–75 |
| Regrid parcel lookups | ~$0.05/job, metered |
| Domain/misc | ~$5 |
| **Fixed total** | **< $125/mo** |

Stripe takes 2.9% + 30¢. Ten Solo subscribers cover all infrastructure;
everything after is margin. Premium imagery (Nearmap) only when Enterprise
revenue pays for it.

---

*This document is the build contract for v3. Phase A is fully specified and
can start immediately; nothing in it discards the current monitor, dashboard,
or digest work — they all carry forward.*
