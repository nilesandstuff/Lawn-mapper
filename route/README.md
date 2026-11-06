# Route planner

route.<home domain> (route.nilesandstuff.com). A long screenshot of the day's
job list in, the fastest drive between the jobs out, ending at the shop.

1. **Read** -- the screenshot is read in the browser with Tesseract (never
   uploaded), in 2400 px slices. `lib/parse.js` turns the words into stops by
   position: address (one or two lines), "name • city", and the job's minutes
   on the right.
2. **Check** -- the stops are shown for fixing before anything is routed.
3. **Route** -- the Worker (`src/`) asks Mapbox for each address, then the
   drive time between every pair; `lib/solve.js` picks the order (exact up
   to 15 stops, iterated local search above), start and end fixed.
4. **Totals** -- job minutes, driving, and the two together.

**Documents** (`lib/doc.js`): PDF (by pdf.js), Excel `.xlsx`, Word `.docx`,
old `.doc`, `.odt`, `.rtf`, `.txt`, `.csv`, HTML and `.eml`, read in the browser.
Service Autopilot prints or emails route sheets and exports its Dispatch Board
to a spreadsheet; there is no public API (checked 2026-10-27). A table is read by its header row
(Address, Customer, Est. Time, Sq Ft...) or, without one, field by field; a
list is read job by job from each address. Square footage is kept and
totalled. Written before any real document was seen: the first document
anyone opens is kept once in the Worker's KV (`/api/catalog`, readable only
with the route session's key) so the reader can be tuned against it.

The shop's address is never in the repository: the Shop button reads it from
the Worker's KV (`/api/shop`, set with the key), or it is typed once and kept
in the browser, or arrives in the link as `#end=...`.

Its own Worker (`route-planner`), its own deploy:
`.github/workflows/route-deploy.yml` ("R. Route planner"), which runs on any
push that changes `route/`. Tests: `node route/test/all.js`. Nothing here
touches Lawn Mapper, the shade map, the water tool or the home page.

## Route sheets by email (`src/inbox.js`, `lib/mail.js`)

Mail to the planner's address reaches the Worker's `email` handler through
Cloudflare Email Routing; it is kept in KV (14 days, the 20 newest) and the
page, holding the inbox key, loads the newest unseen one and reads it like a
picked file. The address (KV `inbox-address`) and the key's SHA-256 (KV
`inbox-key-sha256`) are set with the route key (`PUT /api/inbox/config`) and
are not written here: this repository is public.

The deploy's last step (`tools/email.mjs`) switches Email Routing on for the
domain and makes the rule "that address -> route-planner Worker" when its
Cloudflare token may. When it may not, the log's last lines say so, and it is
done once by hand, from a phone:

1. dash.cloudflare.com -> the domain -> **Email** -> **Email Routing** ->
   **Get started** / **Enable** (it adds the MX and SPF records; the domain
   had none on 2026-10-27).
2. **Routing rules** -> **Create address** -> custom address: the inbox
   address's part before the @ -> action **Send to a Worker** ->
   **route-planner** -> **Save**.

## Splitting a day between people (`lib/split.js`, `src/share.js`, `public/share.html`)

With People set above 1, the stops are split so each person's day -- driving
from their first stop to the shop, plus job time -- comes out as even as it
can: the longest day as short as possible, then the least driving overall.
Getting to the first stop is not counted (everyone comes from somewhere
else); every route ends at the shop. One route through everything is cut
evenly (exact for its order), then improved by moving and swapping stops and
by shaking and trying again; on small days it finds the best split there is.

## Shared days, live (`lib/live.js`, `src/share.js`, `public/share.js`)

**Share** (a split, or one route with "Share / get help") makes a live day,
kept in the planner's D1 for 30 days from its last change under a random
12-character id: `/s/<id>` for everyone (and helpers), `/s/<id>?p=2` for the
second person's own phone.

- Ticks are shared: anyone's tick shows on every phone holding the link
  (pages check every 25 s while open).
- Helpers need nothing loaded: they open the link, give a name, **Now** or the
  time they'll be free, and where from (their location, or an address).
  Every stop not yet done is then shared out again among everyone working
  (`split.js` rebalance) so all get back to the shop at about the same
  time. The stop each working person is on stays theirs; a stop is moved
  only when it gains real time.
- "I'm free to help now" / "I'll be free at..." for anyone already on the
  day; "Your list changed" when someone else's re-split moved your stops.
- Optional, while the page is open: near your next stop for a while and
  then leaving it, "Done at ...?" -- never a tick by itself. (Phones stop a
  web page's location when it is not on screen, so ticks are the record.)

A re-split is worked out on the phone that asks for it and saved only over
the version it read (`PUT`, 409 if anything changed), so two phones never
overwrite each other.
