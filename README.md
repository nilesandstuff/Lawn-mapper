# Lawn Mapper

Measures a lawn's square footage from an address: geocode → confirm location
→ pull the parcel boundary from county GIS (or let the user draw it) → AI
proposes the lawn shape inside that boundary → user corrects it → export.

Standalone project for now; intended to fold into lawn-answers.com later.

## Repo layout

```
worker/     Cloudflare Worker -- the API. DEPLOYABLE AS-IS.
tools/      Node scripts for local verification. Not deployed.
frontend/   NOT YET BUILT. See "What's left" below.
```

## Status: backend built, frontend not started

**Done, in `worker/`:**
- `src/area.js` — geodesic area math (sq ft / acres), verified against a
  known-size reference rectangle. Ground-truth tested — see `tools/area.test.js`.
- `src/counties.js` + `src/parcel.js` — parcel boundary lookup across 5
  county GIS servers (Kent, Ottawa, Allegan, Muskegon; Newaygo has no
  confirmed public endpoint yet — see Known Gaps).
- `src/quota.js` — per-client + per-IP daily measurement cap, tested at the
  boundary condition.
- `src/index.js` — the API itself: `/api/geocode`, `/api/parcel`,
  `/api/imagery`, `/api/segment` (SAM 2 via Replicate), `/api/quota`.

**Not built yet:**
- The frontend. Needs: address input, a confirm-location step showing the
  pin on the map before any paid call fires, Mapbox GL JS + Mapbox GL Draw
  for the editable polygon, a "detecting your lawn..." state while SAM runs,
  and a PDF/PNG export of the final map + square footage.
- Converting the SAM mask (returned as an image) into an editable Mapbox GL
  Draw polygon. This is real, non-trivial work — mask-to-polygon tracing
  plus reprojecting mask pixel coordinates back to lng/lat using the `frame`
  object `/api/segment` returns.
- Wiring a real SAM prompt point. Right now `/api/segment` defaults to the
  image center, which is usually the house roof, not the lawn. The frontend
  needs to send the parcel centroid (nudged off the building) or a
  user-tapped point instead.

## Known gaps (not bugs — documented limitations)

- **Newaygo County**: no confirmed public ArcGIS REST endpoint. Addresses
  there fall through to manual boundary drawing — same path as anywhere
  outside the 5-county footprint, so nothing breaks, but it's a gap worth
  closing by calling their GIS office directly.
- **Layer indexes/field names for Kent, Allegan, Muskegon** are educated
  starting values from published service metadata, not live-verified (the
  environment that wrote this code has no network access). Run
  `npm run probe:counties` before trusting them.
- **Replicate model slug** (`meta/sam-2`) needs a live check against
  Replicate's current catalog before deploy — model identifiers do get
  renamed, and this was written without network access to confirm it.

## Setup order

1. `cd worker && npm install` (just installs wrangler)
2. `npx wrangler kv namespace create QUOTA` → paste the returned id into
   `worker/wrangler.toml`
3. `npx wrangler secret put MAPBOX_TOKEN`
4. `npx wrangler secret put REPLICATE_TOKEN` — get a **fresh** token from
   Replicate; do not reuse one that has ever appeared in a chat log or commit
5. `npm run probe:counties` from the repo root — confirms the parcel layer
   config actually matches what the county servers return today
6. `npm run test:area` — should print "All checks passed."
7. Update `ALLOWED_ORIGINS` in `worker/src/index.js` to your real Pages URL
8. `cd worker && npx wrangler deploy`

## The one rule that matters most

Never compute area from projected map coordinates (Web Mercator / EPSG:3857).
At Michigan's latitude that inflates area by ~1.88x, silently. `area.js`
takes WGS84 lng/lat only — `tools/area.test.js` has a test that reproduces
this exact error mode so it can't regress unnoticed.
