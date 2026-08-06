# Property lookup proxy

Holds real provider API keys server-side so they never ship in the BeaconWatch
dashboard's client bundle. The dashboard calls this proxy; this proxy calls
Mapbox, Regrid, and Google Street View with the real keys and returns a merged
`PropertyCard`. It has no other job — no database, no auth beyond one shared
secret, nothing persisted.

**This is not deployed anywhere yet.** Property lookups in the dashboard will
return `null` (fail-soft, per spec) until you deploy this and set
`PROPERTY_LOOKUP_URL` / `PROPERTY_LOOKUP_SECRET` in `docs/index.html`'s `CFG`.

## Deploy (Cloudflare Workers, free tier covers this easily)

1. `npm install -g wrangler` (one-time)
2. `wrangler login`
3. From this directory:
   ```
   wrangler secret put MAPBOX_TOKEN
   wrangler secret put REGRID_TOKEN
   wrangler secret put GOOGLE_STREETVIEW_KEY
   wrangler secret put APP_SECRET       # any random string you make up
   wrangler deploy
   ```
4. Wrangler prints a URL like `https://beaconwatch-property-lookup.<your-subdomain>.workers.dev`.
   Put that in `docs/index.html`'s `CFG.propertyLookupUrl`, and the `APP_SECRET`
   value in `CFG.propertyLookupSecret`.

## Getting the actual provider accounts

- **Mapbox** (geocoding + aerial imagery): mapbox.com — free tier, pay-as-you-go after.
- **Regrid** (parcel/owner/assessor facts): regrid.com — paid, ~$0.05–0.10/lookup per `PLATFORM.md`.
- **Google Street View Static API**: console.cloud.google.com, enable "Street View Static API" — ~$7/1,000 per `PLATFORM.md`. Respect Google's imagery attribution and usage terms; do not store the image bytes (the dashboard already doesn't).

## Why a proxy at all

BeaconWatch's dashboard is one static HTML file with no server. Any key placed
directly in that file is readable by anyone with the passcode via browser dev
tools. This Worker is the minimum thing that can hold a real secret safely
while still giving the dashboard a normal, synchronous `fetch()` to call.

## Field mapping

`worker.js` returns exactly the `PropertyCard` shape the dashboard expects —
see `services/property/index.js` for the client side of this contract. If you
swap a provider, keep the response shape identical and nothing else needs to
change.
