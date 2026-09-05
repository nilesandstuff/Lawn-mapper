# Deploying to lawnanswers.online

Written to be followed top to bottom. Every step has a check — if the check
doesn't produce what it says, stop there rather than continuing, because each
step depends on the one before it.

Everything runs from the repo root. There is one deploy: the API and the
website ship together as a single Cloudflare Worker.

---

## Before you start

You need four things:

| | What | Where to get it |
|---|---|---|
| 1 | **Node.js 20 or newer** | <https://nodejs.org> — the "LTS" download |
| 2 | **A Cloudflare account** | <https://dash.cloudflare.com/sign-up> (free plan is fine) |
| 3 | **A Mapbox access token** | You have this. It starts with `pk.` |
| 4 | **A Replicate API token** | You have this. It starts with `r8_` |

Check Node is installed — this must print a number that starts with 20, 22, or higher:

```bash
node --version
```

---

## Step 1 — Get the code and its dependencies

```bash
git clone https://github.com/nilesandstuff/Lawn-mapper.git
cd Lawn-mapper
npm install
```

**Check:** a `node_modules` folder now exists and the command ended without
the word `ERR!`.

---

## Step 2 — Run the tests (no accounts or internet needed)

```bash
npm test
```

**Check:** the last line says `All checks passed.` twice — once for the area
maths, once for the lawn-tracing maths. If either says `FAILED`, something is
wrong with the code itself; don't deploy.

---

## Step 3 — Connect your Cloudflare account

```bash
npx wrangler login
```

A browser window opens; approve the request.

**Check:**

```bash
npx wrangler whoami
```

prints your Cloudflare email address.

---

## Step 4 — Create the quota database

This is the counter that stops one person (or a bot) from running up your
Replicate bill.

```bash
npx wrangler kv namespace create QUOTA
```

It prints something like:

```
[[kv_namespaces]]
binding = "QUOTA"
id = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
```

Open `wrangler.toml` and replace `REPLACE_WITH_KV_NAMESPACE_ID` with the `id`
value it printed. Keep the quotes.

**Check:** `grep id wrangler.toml` shows a long string of letters and numbers,
not the word `REPLACE`.

---

## Step 5 — Store your two keys

These are stored encrypted on Cloudflare's side. They never enter the repo.

```bash
npx wrangler secret put MAPBOX_TOKEN
# paste your pk.... token, press Enter

npx wrangler secret put REPLICATE_TOKEN
# paste your r8_... token, press Enter
```

> **Use a fresh Replicate token.** If the one you have has ever been pasted
> into a chat window, an email, or a commit, treat it as public: revoke it at
> <https://replicate.com/account/api-tokens> and generate a new one. This token
> can spend money.

**Check:** `npx wrangler secret list` shows both names (values are never shown).

---

## Step 6 — Verify the AI model name

The code calls a Replicate model called `meta/sam-2`. Model names on Replicate
do get renamed, and this one was written without internet access to confirm it.
**Check it before you deploy**, because a wrong name means lawn detection fails
for every visitor.

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer YOUR_r8_TOKEN_HERE" \
  https://api.replicate.com/v1/models/meta/sam-2
```

**Check:** it prints `200`.

- `200` — good, nothing to do.
- `404` — the model has moved. Search for "SAM 2" at
  <https://replicate.com/explore>, find the current `owner/name`, and change the
  URL in `worker/src/index.js` (search for `models/meta/sam-2`).
- `401` — the token is wrong or revoked. Go back to step 5.

---

## Step 7 — Verify the county property-line servers

Kent, Ottawa, Allegan and Muskegon each run their own map server. The addresses
of their data layers were written from published documentation, not tested
live. This script tests them for real:

```bash
npm run probe:counties
```

**Check:** section 3 prints an acreage for each county, like
`kent (Grand Rapids): 0.31 ac / 13,500 sq ft`.

If a county says `NO PARCEL RETURNED` or `WARNING: configured layer ... is not a
parcel layer`, section 1 of the output lists the layers that county actually
publishes. Update that county's `layer` number (and any `MISSING` field names
from section 2) in `worker/src/counties.js`, then run it again.

**This is not a blocker for deploying.** A county that fails just means
addresses there fall back to "draw it yourself", which works fine. But you'll
want it fixed, since the property line is most of the value.

> Newaygo County has no known public server at all. Addresses there always fall
> back to drawing by hand. Closing that gap means phoning their GIS office.

---

## Step 8 — Try it on your own machine first

```bash
npm run dev
```

Open <http://localhost:8787> and measure your own address end to end.

**Check all of these:**

- [ ] The address box finds your house
- [ ] The confirm step shows *your* roof
- [ ] A dashed yellow property line appears (if you're in a covered county)
- [ ] Tapping your lawn, then "Detect my lawn", outlines actual grass
- [ ] The square footage looks believable for your lot
- [ ] Dragging a white dot changes the number
- [ ] "Save image" downloads a PNG with the number on it

**Also tick "Show the raw AI mask".** The translucent mask should sit exactly
on top of the grass it traced. If it's visibly shifted or the wrong size, stop
and see *Troubleshooting* below — the number will be wrong.

Press `Ctrl+C` in the terminal to stop.

---

## Step 9 — Deploy

```bash
npm run deploy
```

**Check:** it prints a URL ending in `.workers.dev`. Open it. The site should
work exactly as it did locally.

At this point you are live — just not on your own domain yet.

---

## Step 10 — Point lawnanswers.online at it

**10a. Add the domain to Cloudflare.** In the Cloudflare dashboard: *Add a
site* → type `lawnanswers.online` → choose the **Free** plan. Cloudflare gives
you two nameservers.

**10b. Change the nameservers at your registrar** (wherever you bought the
domain) to the two Cloudflare gave you. This is the slow part — it usually
takes under an hour but can take up to 24. Cloudflare emails you when the
domain becomes *Active*.

**Check:** the domain shows **Active** in the Cloudflare dashboard. Don't
continue until it does.

**10c. Attach the domain to the Worker.** Open `wrangler.toml`, remove the `#`
from the last three lines so it reads:

```toml
[[routes]]
pattern = "lawnanswers.online"
custom_domain = true
```

Then:

```bash
npm run deploy
```

**Check:** <https://lawnanswers.online> loads the site over HTTPS. The
certificate is issued automatically; give it a couple of minutes if the first
load warns about security.

---

## Step 11 — Lock down your Mapbox token

Your `pk.` token is visible in the browser — that is normal and expected for
Mapbox, but it means anyone could copy it and spend your quota. Restrict it:

1. Go to <https://account.mapbox.com/access-tokens/>
2. Click your token → **URL restrictions**
3. Add `https://lawnanswers.online/*`

**Check:** the site still works after a hard refresh (Ctrl+Shift+R).

---

## Step 12 — Final check on the real site

Measure a property you know the size of. Compare against what the county
assessor's website says the lot is. They should be in the same ballpark —
your *lawn* will be smaller than the *lot*, because the lot includes the house
and driveway.

---

## What it costs

Three services can charge you. Check each one's current pricing yourself —
rates change.

| Service | What triggers cost | Notes |
|---|---|---|
| **Replicate** | Every "Detect my lawn" press | The only per-use cost of real size. This is what the daily quota protects. |
| **Mapbox** | Geocoding, map tiles, satellite images | Generous free tier; a low-traffic site typically stays inside it. |
| **Cloudflare** | Requests and quota writes | Free plan covers a low-traffic site comfortably. |

The built-in limits are **10 detections per browser per day** and **40 per IP
address per day**. To change them, edit `DAILY_LIMIT_PER_CLIENT` and
`DAILY_LIMIT_PER_IP` at the top of `worker/src/quota.js` and redeploy.

Failed detections are refunded automatically, so a broken configuration won't
silently eat everyone's daily allowance.

---

## Troubleshooting

**"The map didn't load"**
The Mapbox library couldn't be fetched, or `MAPBOX_TOKEN` isn't set. Re-run
step 5, then `npm run deploy`.

**Everything works but no property line appears**
Either the address is outside the four covered counties, or that county's
server config is stale. Run step 7.

**"Detect my lawn" always fails**
Almost always the Replicate model name (step 6) or an expired token. To see the
real error, run `npx wrangler tail` in a terminal and try again on the live
site — the actual message from Replicate is printed there.

**The detected lawn is offset, or the number is ~4x too big or small**
Open the browser console (F12). If there's a message starting
`[lawn-mapper] Projection mismatch`, change `TILE_SIZE` in
`public/lib/mercator.js` (512 ↔ 256), run `npm test`, and redeploy. Hand-drawn
shapes are unaffected by this, so the tool is still usable meanwhile.

**Numbers look wrong but the shape looks right**
Check you're comparing lawn to lawn. The tool measures grass; the assessor
measures the whole parcel.

**Rolling back a bad deploy**
`npx wrangler deployments list`, then
`npx wrangler rollback [deployment-id]`.
