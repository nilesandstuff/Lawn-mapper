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

**Documents** (`lib/doc.js`): Word `.docx`, old `.doc`, `.odt`, `.rtf`,
`.txt`, `.csv`, read in the browser. A table is read by its header row
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
