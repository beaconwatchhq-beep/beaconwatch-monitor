# beaconwatch-monitor

Live large-loss intelligence for commercial restoration sales — tornado, hurricane,
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

---

# Whitetail Deer Aging + Antler Scoring App

A Streamlit app for hunters to upload trail-cam / harvest photos and get an
instant AI-estimated age class and antler score. When a deer is harvested,
an admin enters verified actual age and score so estimate accuracy can be
tracked over time and training data exported for the next model version.

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env   # then edit values, or export the vars directly
streamlit run app.py
```

The SQLite database and `deer` table are created automatically on first run
(`db.init_db()`), in WAL mode.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEER_MODEL` | `stub` | `stub` for the deterministic dev estimator, `model` for the real one |
| `DEER_MODEL_WEIGHTS` | `./weights/model.pt` | Weights path used when `DEER_MODEL=model` |
| `DEER_UPLOAD_DIR` | `./uploads` | Where uploaded photos are saved (`{deer_id}.{ext}`) |
| `DEER_DB_PATH` | `./deer.db` | SQLite database file |
| `DEER_ADMIN_HASH` | *(none)* | bcrypt hash of the admin password — generate with `python auth.py "your-password"` |

No plaintext admin password is ever stored in source or env — only the bcrypt hash.

## App structure

- `app.py` — Streamlit UI: Upload, Lookup, Admin, and Reports tabs.
- `db.py` — schema (WAL-mode SQLite) and every SQL statement in the app; other
  modules never write raw SQL. Connections are opened per-operation via a
  context manager, never shared across Streamlit reruns.
- `estimator/` — pluggable estimator interface (`base.py`), the deterministic
  `StubEstimator` used for development (`stub.py`), and `ModelEstimator`
  (`model.py`) for the real model. `estimator.get_estimator()` picks between
  them based on `DEER_MODEL`.
- `auth.py` — bcrypt-based admin auth with a constant-time compare and a
  session-scoped rate limiter (5 failed attempts → 60s lockout). Also doubles
  as a CLI: `python auth.py "password"` prints a bcrypt hash.
- `reports.py` — age-class accuracy (exact match + within-one-class), score
  MAE and signed bias, broken out by `model_version`; CSV export of harvested
  deer for training the next model.
- `tests/` — pytest coverage for schema/migration, duplicate-hash rejection,
  the estimator contract, harvest updates, and accuracy math.

## Why age *class*, not an exact age

Photo-based aging is based on body characteristics (chest depth, belly sag,
neck swelling, leg-to-body ratio, etc.) which realistically only resolve to
half-year classes (`1.5`, `2.5`, `3.5`, `4.5`, `5.5+`), not an exact age in
years. The app treats this as ordinal classification with a confidence score
rather than pretending to a precision the input photo can't support.

## Swapping in a real model

1. Implement `ModelEstimator.predict()` in `estimator/model.py` to load your
   weights and return a `Prediction` (age_class, age_confidence, score,
   score_low, score_high, warnings).
2. Point `DEER_MODEL_WEIGHTS` at your weights file.
3. Set `DEER_MODEL=model`. If the weights file is missing, `ModelEstimator`
   raises immediately at construction time — it never silently falls back to
   the stub.
4. Use `reports.export_training_csv()` (or the "Generate training CSV" button
   on the Reports page) to pull harvested photos + verified labels as your
   training/validation set for the next version. Bump `ModelEstimator.version`
   (derived from the weights filename) so accuracy reports can compare model
   versions against each other.

## Training a real model

`train.py` is a standalone CLI that fits a baseline model from a training
CSV and writes weights `ModelEstimator` can load — no UI or DB changes
involved:

```bash
python train.py --csv training_export.csv --out weights/model.pt
```

It prints validation accuracy/MAE/bias so you can see immediately whether
the model beats "always predict the most common class." Point the app at
it with `DEER_MODEL=model` and `DEER_MODEL_WEIGHTS=weights/model.pt`.

**What `train.py` actually does today:** a deliberately simple baseline —
nearest-centroid age classification + linear least-squares score
regression — over a handful of cheap Pillow/numpy image features
(`estimator/features.py`: aspect ratio, channel means, brightness
variance, edge density). It is plumbing, not a biologically validated
aging model. Its purpose is to prove the train → weights → serve pipeline
end-to-end and give a non-random floor to compare future models against.

**When to move beyond the baseline** (no need to guess — these are the
thresholds that matter):
- **Under ~50 labeled photos**: the baseline is close to the realistic
  ceiling. Focus on collecting more harvested/verified data before
  investing in modeling.
- **Hundreds of labeled photos**: worth improving `estimator/features.py`
  with better hand-engineered features before reaching for deep learning.
- **1000+ labeled photos**: worth fine-tuning a real pretrained CNN
  (e.g. via `torch`/`timm`) instead of hand-engineered features. This
  needs new dependencies beyond the current requirements.txt — that's a
  deliberate ask, not something to add speculatively.

Train/serve feature extraction share `estimator/features.py` so they can
never drift apart; weights are a plain JSON file of centroids/coefficients
(no pickle, no new serialization dependency).

## Tests

```bash
pytest -q
```
