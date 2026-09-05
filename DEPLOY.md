# Deploying from a phone

No computer needed. Everything here happens in a mobile browser, and the parts
that need a real machine run on GitHub's servers when you press a button.

**Use a browser (Safari/Chrome) at github.com, not the GitHub mobile app** —
the app can't run workflows.

You'll do these once, in order. Steps 1–5 get you a working site; step 6 puts
it on your own domain.

---

## What you need

- Your **Mapbox token** (starts with `pk.`)
- Your **Replicate token** (starts with `r8_`)
- A **Cloudflare account** — free: <https://dash.cloudflare.com/sign-up>

---

## Step 1 — Make a Cloudflare API token

This lets GitHub deploy on your behalf.

1. Go to <https://dash.cloudflare.com/profile/api-tokens>
2. **Create Token**
3. Find **Edit Cloudflare Workers** → **Use template**
4. Leave the defaults. Scroll down → **Continue to summary** → **Create Token**
5. **Copy the token now.** Cloudflare shows it exactly once.

> This template includes the two permissions the deploy needs: editing Workers
> and editing Workers KV storage.

---

## Step 2 — Put your three keys into GitHub

Go to:
<https://github.com/nilesandstuff/Lawn-mapper/settings/secrets/actions>

Tap **New repository secret** and add these three, one at a time. The names
must match exactly (capitals and underscores included):

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `MAPBOX_TOKEN` | your `pk.…` token |
| `REPLICATE_TOKEN` | your `r8_…` token |

**Check:** the page lists all three names. (Values are hidden forever — that's
normal. To change one, tap it and enter a new value.)

> **Use a fresh Replicate token.** If the one you have has ever been in a chat,
> an email, or a screenshot, treat it as public: delete it at
> <https://replicate.com/account/api-tokens>, make a new one, and use that.
> This token can spend money.

---

## Step 3 — Run the preflight checks

This is the step that replaces everything I couldn't verify. It runs on
GitHub's servers, which have the internet access my environment didn't.

1. Go to <https://github.com/nilesandstuff/Lawn-mapper/actions>
2. Tap **1. Preflight checks** in the left list
3. Tap **Run workflow** → **Run workflow**
4. Wait ~1 minute, then tap into the run to read the results

It costs nothing and deploys nothing — it only reads.

**What you're looking for:**

- **Maths tests** — must be a green tick. If this fails, don't deploy.
- **Does the AI model still exist?** — must be a green tick. If it's red, open
  it: the log tells you exactly which model name to look up and which file to
  change. This is the single most likely thing to be wrong.
- **County property-line servers** — open this one and read it. Ottawa,
  Allegan and Muskegon should each print an acreage. Kent and Newaygo have no
  public parcel server and are *expected* to be missing; addresses there fall
  back to "draw it yourself", which measures just as accurately. **This step is
  allowed to fail; it won't block you.**

---

## Step 4 — Deploy

1. Same **Actions** page → **2. Deploy**
2. **Run workflow** → type `deploy` in the confirmation box → **Run workflow**
3. Wait ~2 minutes

It runs the tests again, creates the quota database automatically, deploys, and
then applies your two API keys to the Worker.

**Check:** the run is a green tick, and the **Where it went** step at the bottom
prints your site's address (something like
`https://lawn-mapper.<your-subdomain>.workers.dev`).

If it's red, open the failed step — each one says what to fix.

---

## Step 5 — Try it on your phone

Open that workers.dev address and measure your own house.

- [ ] The address box finds your house
- [ ] The confirm step shows *your* roof
- [ ] A dashed yellow property line appears (Ottawa, Allegan or Muskegon only —
      in Kent you'll be asked to draw it, which is expected)
- [ ] **Detect my lawn** is pressable straight away — there is nothing to tap
      on the map first
- [ ] It outlines actual grass, and finds *every* separate patch at once —
      front, back, the strips down the side
- [ ] The square footage is believable for your lot
- [ ] Grass under your trees is included (that's the tick box above the button;
      turn it off and the number should drop)
- [ ] Dragging a white dot changes the number, and a piece it got wrong can be
      deleted
- [ ] **Extend to road** → tap the boundary by the street → the slider adds the
      easement strip without twisting the line. You can do this *before*
      detecting, which is what you want when your lawn runs past the property
      line to the kerb.

**Then tick "Show the raw AI mask".** A translucent shape appears over the map.
It should sit *exactly* on the grass it traced. If it's visibly shifted or
obviously the wrong size, see *the lawn is in the wrong place* below — the
number can't be trusted until that's fixed.

Detecting a lawn costs a couple of cents. Everything else is free.

---

## Step 6 — Put it on lawnanswers.online

Only do this once step 5 works.

**6a. Add the domain to Cloudflare.** In the Cloudflare dashboard: **Add a
site** → type `lawnanswers.online` → pick the **Free** plan. Cloudflare shows
you two nameservers — leave that page open.

**6b. Point the domain at them.** Log in wherever you bought the domain and
replace its nameservers with the two Cloudflare gave you. Every registrar words
this differently ("Nameservers", "DNS settings", "Custom DNS").

This is the slow part: usually under an hour, occasionally up to 24. Cloudflare
emails you when it's done.

**Check:** the domain shows **Active** in Cloudflare. Don't continue until it
does — deploying early just fails.

**6c. Tell the deploy to use it.** Go to:
<https://github.com/nilesandstuff/Lawn-mapper/settings/variables/actions>

Tap **New repository variable**:

| Name | Value |
|---|---|
| `CUSTOM_DOMAIN` | `lawnanswers.online` |

> A *variable*, not a secret — different tab, same page. Variables are for
> non-secret settings.

**6d.** Run **2. Deploy** again (step 4).

**Check:** <https://lawnanswers.online> loads over HTTPS. Give the certificate
a few minutes if the first try warns about security.

---

## Step 7 — Lock down your Mapbox token

Your `pk.` token is visible in the browser. That's normal for Mapbox, but it
means someone could copy it and burn your quota. Restrict it to your domain:

1. <https://account.mapbox.com/access-tokens/>
2. Tap your token → **URL restrictions**
3. Add `https://lawnanswers.online/*`

**Check:** the site still works after a hard refresh.

---

## Making changes later

You can edit any file from your phone: open it on github.com, tap the pencil
icon, edit, then **Commit changes**. Then run **2. Deploy** again.

To change the daily limits, edit `worker/src/quota.js` —
`DAILY_LIMIT_PER_CLIENT` (default 10 per browser) and `DAILY_LIMIT_PER_IP`
(default 40 per network).

---

## What it costs

| Service | What triggers cost |
|---|---|
| **Replicate** | Each "Detect my lawn" press. The only per-use cost of real size — this is what the daily quota exists to cap. |
| **Mapbox** | Geocoding, map tiles, satellite images. Generous free tier. |
| **Cloudflare** | Requests and quota writes. Free plan covers a low-traffic site. |
| **GitHub Actions** | Free — this repo is public. |

Check current prices on each site; they change. Failed detections are refunded
automatically, so a misconfiguration won't quietly eat everyone's allowance.

---

## Troubleshooting

Everything below is doable from a phone.

**A workflow is red**
Tap the run, then the red step. The last lines say what happened. Every check
in this project is written to say what to do, not just that it failed.

**"The map didn't load" on the site**
`MAPBOX_TOKEN` didn't get applied. Confirm the secret name is spelled exactly
right in step 2, then run **2. Deploy** again.

**"Detect my lawn" always fails**
Almost always the AI model name. Run **1. Preflight checks** — the model step
names the fix. To see the raw error from Replicate, go to your Worker in the
Cloudflare dashboard → **Logs** → **Begin log stream**, then try again on the
site.

**No property line appears**
Expected in Kent and Newaygo, which have no public parcel server. Elsewhere it
means that county republished its service. Run **3. Find county servers** — it
searches for the new endpoint and prints a config block to paste into
`worker/src/counties.js`. The site keeps working either way; you draw by hand.

**The lawn is in the wrong place, or the number looks ~4x off**
Open `public/lib/mercator.js` on GitHub, change `TILE_SIZE` from `512` to `256`
(or back), commit, and redeploy. The app also logs a specific message about
this in the browser console when it detects the mismatch itself. Hand-drawn
shapes are never affected, so the site stays usable meanwhile.

**Numbers look wrong but the shape looks right**
Check you're comparing like with like. This measures *grass*; your county
assessor measures the *whole lot*, including the house and driveway.

**Undo a bad deploy**
Cloudflare dashboard → **Workers & Pages** → `lawn-mapper` → **Deployments** →
find the previous one → **Rollback**.
