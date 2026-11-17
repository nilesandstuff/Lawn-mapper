# Water map: to do

The owner's queued work, in the order asked. Each item names what is to be found
out before anything is built; findings go in FINDINGS.md (HARD apart from
SPECULATION), as always.

## In progress (2026-10-27)

(nothing)

## Queued

22. **Nearby stream levels through the year** (owner, 2026-10-31): for a lawn on or near a flood plain, the nearest
    stream gauge's water level by month (USGS's water data API, free and keyless, national), against the lawn's own
    ground: how high the stream, and the water table beside it, rises in spring. Beside the streams card (H63).

21. **The water table under the lawn** (partly done 2026-10-31: soils placed, H62; streams and flood maps, H63; wells
    dropped, not available in most places. Still open: a stream gauge's yearly level for flood-plain lawns) (owner, 2026-10-31: "a big missing piece of the puzzle"; FINDINGS H61, S17,
    research-groundwater.md). Researched, not built. For the owner to choose: the soil survey read by component share
    (and a fallback on Urban land); Wellogic's drift wells within 1-2 km as a page note and check (never its owner
    fields); EGLE's water-table contours or the Ma 30 m model less the lot's lidar ground as a flag; the measured
    seasonal swing; NHDPlus HR perennial streams for the hillside reading. 3DHP: nothing yet; recheck about 2028.

20. **From the sanity checks (FINDINGS H58), for the owner to decide:** (a) the reference ET 15-20% above Michigan's
    stations: NOT POWER's sunlight (H60, no correction); next, find out Enviroweather's own method and data; (b) fences: DONE 2026-10-29 (H59); (c) normal watering's drainage: KEPT AS IS (owner,
    2026-10-29: morning watering drains before the day's draw; drainage rates are per soil; H58 point 9).

4. **Heat from paving into the grass beside it.** Research how concrete and
   blacktop spread heat to the grass next to them and how that raises its water
   use, then apply it day by day by the sun's strength and the shade over the
   paving (the shade map's light). Fences, too (the shade part, v 3): each keeps its surface's solar reflectance
   and emissivity (typical values, not measured). Needs blacktop told apart from concrete on
   the map: their surfaces heat differently (asphalt's albedo about 0.05-0.10
   new, concrete's 0.25-0.40: to be confirmed). Today the plan adds a flat
   estimate, up to 8% at the edge fading to nothing by 7 m (FINDINGS S8).
   A lead from the features session (2026-10-26): Halverson & Heisler 1981, USDA
   Forest Service Research Paper NE-481, "Soil Temperatures under Urban Trees
   and Asphalt" (New Brunswick NJ): at 15 cm the summer maximum under asphalt was
   34.2 C, up to 5 C over the control; no difference in winter minimums. It is
   the soil UNDER asphalt, not the grass beside it. The features session wants
   the numbers when found, for the shade map's soil-temperature view.
6. **Cooling the soil with water.** An area may not need water for its own sake,
   but if its soil gets too hot, water could prevent heat stress by cooling it:
   from the water's own temperature and from evaporation. Not syringing
   (a midday mist on the leaves), which the owner expects to matter only in
   extremes unlikely in Michigan. Research the size of the effect on soil
   temperature, then decide whether the plan should water for it.
   Soil temperature now: IEMRE (FINDINGS H41; the features session's year at 16
   stations: mean error +0.1 C against NASA POWER's -1.6, winter -0.6 against
   -3.2). Shade's cooling: the shade map uses 0.2 C cooler (daily mean) per
   MJ/m2 of daily sun lost, from one study (Edmondson et al. 2016, Sci. Rep.
   6:33708, 1.5 cm, Leicester). The features session then measured it at 114 NOAA
   reference stations over ten years (SHADE-FINDINGS 30): about 0.13 C cooler
   (daily mean, 5-10 cm) per MJ/m2/day of sun lost, nearly all of it through the
   air the sun warms; natural rain about 0 to -0.01 C per mm/day over a fortnight
   to a month -- on turf watered by rain, not irrigation. Its scripts:
   docs/shade-research/soil/ (fetch_yrs.py and clim.py; README).
10. **The GPS jumps around** (owner, 2026-10-27: "gps is really bad, jumps around all over the place. Maybe
    augmented reality might be better?"). Placing heads by walking to them: look at averaging, the phone's
    reported accuracy, and an AR way of marking a spot (the camera and the ground plane) instead.
    Owner, 2026-10-31, on a Galaxy S21 Ultra: "I can calibrate, walk 25 feet, and then the dot is still 10 feet away.
    Then I walk around some more and the dot is just all over the place... Drifting in different directions that a
    simple offset couldn't fix." Asked how feasible an AR tool would be (point a cursor at a head, tap, a pin), first on
    a separate admin-only page. Feasibility answered 2026-10-31; the admin test page built the same day
    (water.<home>/ar?map=<id>, FINDINGS H64): references marked on the photo and in AR line the two up, then each
    head is a pin; check points say how far off. First walk 2026-10-31: fine in front, ~20 ft off in the back (drift);
    re-marking references as you walk, anchors and warnings added (H65). Second walk: AR ~4% short, sway counted as
    walking; scale held, slide-aware fit, edges, head spread in the copy (H66). Not built: corners from the lidar (S21).
    One head placed seven times: ~0.5 m from close by; one anchor jump of 21 m now ignored; far placing confirmed (H67).
    Owner: it must be easier and faster than placing dots by hand: a passive "you are here" from the lidar and the
    camera (S22). Chrome gives the depth on the owner's phone; matching it to the lidar is built (H68): next walk.
15. **Hose-end sprinklers placed by hand** (owner: "add specific recs for manually placing sprinklers. Which will
    require pressure calculations (same as the existing workflows for inground, but obviously simplified)"):
    where to set each sprinkler, how long, from the hose and the tap's pressure.
16. **A simple view and an advanced view** (owner: "Simplified should just show the actionable info, advanced
    should show the reasoning.").

17. **Wind on the sheltered side of a house** (owner, 2026-10-27): BUILT as each spot's own wind (FINDINGS H50,
    S14; research-wind-local.md): the lee of houses, fences, hedges and crowns by direction, the local station's
    wind rose (H48), held to Heisler's yard figure. Left: a corner and gap speed-up (nothing measured for low
    houses), and checking it with an anemometer in the calmest and windiest spots of the Wind view.
18. **Cooler air, more local, especially in still air** (owner, 2026-10-27: "fine tuning cooling effect of shade to
    get more localized cooling, especially in still air"). Today the trees' cooler air is the crown cover within
    30 m on sunny days (FINDINGS H43, H46), the same at any wind. Under a crown, on a calm day, the air near the
    grass may be cooler than the 30 m figure says (Souch & Souch 1993: 0.7-1.3 C under single trees, early
    afternoon); in wind it mixes away. Research how the cooling under and beside a crown depends on the wind, then
    tie it to each spot's own shade and the day's wind.

23. **Roots stopped or thinned by the soil's layers** (owner, 2026-11-02: "root depth variability due to changing soil
    layers in the rootzone"). Today the roots' depth follows the species and the soil's temperature, and the water
    they can use is read layer by layer down to that depth; but a dense, cemented, compacted or waterlogged layer
    (and a sand that dries hard) also stops or thins roots, which the model does not know. Research how turf roots
    respond to a slow, dense or saturated layer and cap or reshape the root zone from the survey's layers (and the
    perched water, H71-H72).
24. **Soil spread from the foundation onto the lawn** (owner, 2026-11-02: "spreading soil from the foundation out onto
    the lawn"). Digging a basement leaves subsoil (often clay or sand from several feet down) spread round the house and
    across the yard, under whatever topsoil went back: the top layers there are not the survey's. Research how to
    estimate it (the house's footprint and age, the basement's depth, the lidar's raised pads round houses, the survey's
    deeper horizons as the likely spread soil) and how far from the house it reaches.

25. **One way to read lidar** (owner via the core session, 2026-11-03; CLAUDE.md "One way to read lidar"): when the
    features session's tree-versus-building module lands, retire the water map's own rules onto it -- roofs.js
    coreRoofs (a port of the detector's Python rule) and shadeRoofs, surface.js buildingMask, ar-lidar.js roofMask,
    and obstacles.js's coarse vegetation/building cells -- and the NOISE lists and near-copy readers (ept.js, las.js,
    datum.js) onto shared ones as they exist. The ground hollows and spot kinds stay the water map's. The full list
    went to the core session 2026-11-03. DONE 2026-11-04: shadeRoofs reads structures.js (H77). The owner: no
    re-measure on the Chesapeake squares. Still the water map's own: coreRoofs, buildingMask, roofMask, obstacles.js.

26. **Never drop a lidar return** (owner via the features session, 2026-11-04: "We should never, under any
    circumstances, remove a lidar return"; merged ad5afce, then c84abc1: what no rule names is UNKNOWN (structures.js
    kind 5), kept with the laser's own light, not a tree; the water map's kinds input is unchanged). SETTLED the same day (owner via the features session: "Yes
    ignore 80m and noise"): the LAS noise classes 7 and 18, and returns over 80 m above the ground, stay out. The
    water map's code (lib/roofs.js, lib/trunks.js, lib/obstacles.js, lib/lowspots.js perCell) already does exactly
    that; nothing to change.

27. **The finished lidar model** (CLAUDE.md "The lidar is built once, in the shade map; every tool reads the
    finished file", owner 2026-11-04; the features session, 28fd65d: GET /api/maps/model?id=&tool=shade, format
    public/lib/lidar-model.js: per column the ground, kind/why after erasures, top, and the canopy's cubes mu, on
    the shade map's grid with the shift applied; the core says when it is live). TO ASK THE OWNER: the water map
    could read ground, kind, top and mu from it for the parts it shares with the shade map (roofs, trees, the
    canopy the light worker builds, the structures the wind and the built-cover counts use) and stop re-running
    those rules; it still needs the points for what is its own and not in the file: the ground hollows (the fine
    surface and its noise floor), the trunks' stems (returns 0.5-3 m up), paving (intensity and the photo), and the
    wider box round the lot for the wind's obstacles and the water from uphill. Not started; wait for "live" and
    the owner's word on the split. The features session (2026-11-04, night) is adding `returns` (each column's own
    returns per cube, not pooled) and `low` (the lowest own return over the grass) to the file: the honest stem
    signal for trunks.js, whose stems then come from the file rather than the points. LIVE since 2026-11-04 23:50
    (a4fe4ef): `returns`, `low` and the header's `own`; a map gets them the next time it is opened in the shade
    map; `returns` may be left out over 24 MB, `low` always stays. THE OWNER'S SPLIT (2026-11-05): "Use the shade
    map for things like tree canopies, buildings/other structures and their effect on wind. But you do your own
    thing for the things on the ground and the wider area beyond what the shade map gives." And: "still display
    the aerial image that the lawn map was traced on. The user doesn't need to see NAIP." NEXT, before the root
    draw.
28. **Admin saves on the readings page** (owner via the core session, 2026-11-11: "it's not needed yet, but the
    water map will also need this for its measurements page"). The core's admin saves (docs/MAPS.md "Admin
    saves", 784369b): test maps the administrator makes in one press, Turf Trace landing in them by itself.
    GET /api/maps?admin=1 lists only them (the water Worker already forwards /api/maps*), each with
    `adminSave: true` and `trace: { status }`; /api/maps/one opens one like any map; lawnmap's
    /admin-saves.html links into each tool. For the readings page: let the administrator pick an admin save
    instead of a property found by GPS. DONE 2026-11-16 (FINDINGS H87): the readings page and the water map's menu
    take the test maps first; the measurements page moves readings onto them and keeps them up to date.
29. **Thermal walks: the lawn's surface temperature mapped on an AR walk** (owner via the core session,
    2026-11-15: "take ground truth measurements to verify the surface temperature predictions of the water model").
    The core and a thermal session build the capture (a USB-C thermal camera in the Yard AR app's development build;
    a private runner turns frames into temperatures, emissivity 0.98, a sky shot for the sky's reflection). The
    water session answered the shape (2026-11-15): 0.5 m cells in the map's local metres; one record per cell per
    pass and angle band (0-60, 60-70, 70-80 degrees off straight down, out to 10 m; t0, t1, tm, T, sd, k, view angle,
    distance), the cut to be set from the data, with an optional "angle check" walk-up; per walk the sky shot, the
    owner's air readings at start and end, wet grass, sprinklers, cloud; one private JSON per walk, read at
    GET /api/maps/thermal?id=&walk= (and a list without walk). THE WATER SIDE'S PART: a "surface at this minute"
    model (lib/heat.js's balance with the beam at the reading's own time through the shade map's canopy, the sky
    shot as a cloud index at night: it is an 8-14 um brightness temperature, NOT the broadband sky, the thermal
    session's correction), and a comparison card like the readings page's. BUILT on the thermal side (2026-11-15):
    the bands, angleCheck: [{ t0, t1 }], about 1-2 MB per 10-minute walk. ITS CAVEAT: position coarsens at steep
    angles (a 0.7 degree aim error moves the spot 3 cm at 30, 14 cm at 70, about 50 cm at 80 degrees), so a 70-80
    record's place is good to about one cell: compare those over 1 m cells or a neighbourhood. THE SKY (owner's
    wish, 2026-11-15): a ~10 s sweep of the dome; grid.json sky: { kind: sweep|shot, T, T_zenith, T_by_elevation
    (5 degree bins 10-90), cloud_fraction (above 45 degrees; its thresholds PROVISIONAL, in sky.rules), cloud_T,
    clear_T, below_range_share, at, band, n_pixels, elev_covered, high_share, label, rules }; cloud_fraction is the
    night cloud to use (still band brightness, not longwave); the typed cloud is an optional override. A walk's
    twins/<walk>/thermal/status.json says ok or its error; the runner looks for new walks every 2 hours. THE WATER
    SIDE BUILT 2026-11-15 (FINDINGS H85): lib/surfacenow.js, src/truth.js (walks by property, frozen weather, results
    per model version), lib/momentweather.js (station, satellite sunshine, HRRR), the walk card. Waits for the core's
    /api/maps/thermal and the first real walk. THE LIVE APP'S WEATHER (owner: finer, kept cheap): Open-Meteo is the
    upgrade while the site is free (non-commercial terms); about $29-99 a month once it is a product, or NOAA's
    URMA from AWS in a scheduled workflow to stay free. An on-site Ecowitt station (about $205, the WH51L joins its
    gateway) would give the lawn's own sunshine minute by minute. Both for the owner to decide.
    NO PAGE OPEN (2026-11-16, H89): the water builder Container scores a walk as soon as it is converted. NEXT:
    stage 2 with to-do 27 (the light worker loading the shade map's finished model: asked of the features session).
    FIRST WALKS (H91) 4-5 F warm; SOIL COLUMNS (2026-11-17, H92): each spot's own soil spun up over 45 days, tied both
    ways to the surface, version 1 kept beside it. Later, if the walks still ask for it: a stable night's still air
    (ra), sideways heat between spots, thatch thicker than half an inch.

30. **The model explorer for everyone** (owner, 2026-11-17: "I will also want a view in the public model that allows
    that same view-all-variables behind the predictions... we can add that part to the todo list so that you aren't
    overextended (and so I'm not overextended in terms of verifying the live site)"). THE ADMIN'S VERSION IS BUILT
    (2026-11-17): /explore?map=, opened from the measurements page; views thermal surface, soil temperature (2 and
    4 in), wind and moisture; measured / model / measured minus model over the photo; a tapped spot's reading, the
    model's prediction and every factor behind it. BUILT TO CARRY OVER: the numbers and words are lib/explain.js
    (pure, tested), the model's side is the analysis worker's own messages (moment, explain, moistureAt; walkCheck
    for a walk), the photo is public/frame.js (shared with the water map), and the page assumes no readings (their
    routes answer the admin only, so a public visitor gets the model side alone). WHAT IS LEFT: (1) src/index.js
    serves /explore to anyone who can open the map (the site's own ADMIN_ONLY rule, as the water map); (2) a way in
    from the water map itself (a "What's behind this?" button beside the views, or tapping a spot on the Heat view
    opening this page at that spot and month); (3) the words checked for a reader who is not the developer (the
    group notes are written for the owner); (4) the public moment's cost: each one fetches Open-Meteo's archived
    hours (one call) and traces about 400,000 rays in the visitor's browser (2-10 s), fine on a phone but worth a
    note; (5) the moisture view's model side for a visitor with no readings: the date picker reaches the 60 days of
    weather the plan holds. Ask the owner which entry point before building it.

## Rules (owner, 2026-10-27)

- **The white paper stays true to the live model** (owner, 2026-11-02: "remember to continuously add to it if
  something in the live model changes from the information already in the paper"). public/paper.html, served at
  /paper. Any change to the live model that changes a statement there is edited there in the same commit, with a
  line in its change log; any new check against real data goes into its section 11, results against the model
  included. Its section 6's second half is the shade session's own file, docs/SHADE-FOR-WATER-PAPER.md, put in at
  each build (tools/md.mjs): never edited here; when the shade session says it changed, deploy. Plain language, no "we", for homeowners and a turf scientist alike; addresses never, the owner's lot
  only as "the developer's lawn".

- **Shade is the shade map's.** "You should follow the output of the shade map. If we need to make adjustments to how
  shade actually works, that goes through the shade map. Re use the shade map's work, for uniformity... we don't
  want to start any tree models or shade calculations from scratch here." The water map runs the shade map's own
  files (lib/shade/ links to public/shade/), takes its light, its trees (its kinds) and its erased trees, and asks
  the features session for any change to them. A "light through leaves" point was passed to it on 2026-10-27 and withdrawn the same day: the shade map is
  already held to light measured under real canopy (FINDINGS S12). Read docs/SHADE-FINDINGS.md before claiming
  anything about how the shade map works. What the WATER map makes of the shade map's light for the grass's water
  use -- the near and far infrared, the skylight, the night sky (owner, 2026-10-27: "this part belongs to the water
  map") -- is the water map's (FINDINGS H47), from the shade map's output, with no shade calculation of its own.

## Declined

- **Former wetlands from old maps** (USGS historical topographic maps from the 1880s on; Michigan's map of vegetation
  about 1800). Owner, 2026-11-02: "I'm not sure if we should use information from that long ago... in many other
  conditions I'm sure it could be a red herring... A lot can change in 200 years." Not used.

## Shelved (owner, 2026-10-26: "shelve the tree thing to the todo list")

- **Trees using the lawn's water**: researched (FINDINGS H40, research-trees.md),
  nothing built. The proposal: shade as now, plus each tree's root draw (its
  water use x the share from the turf's depth) spread over a disc about twice its
  crown, every number uncertain about threefold. A soil-moisture probe transect
  beside a maple and a spruce would settle the numbers.

## Done

- **Temperatures on the readings page** (owner, 2026-11-09): "surface temperature, F" with the air read then; the
  water map checks each visit on that day's own weather (H84). Waiting on the owner's thermometer and camera.

- **Trees drinking from the lawn** (owner, 2026-11-09: "Do we even need trunks? It's really the canopy that
  matters"): the draw centred on each crown (H83; three guesses, S29); the trunk finder shelved. On the owner's lawn
  +16% watering. Next to settle it: the probe transect (research-trees.md), or more readings.

- **Heat, finished** (owner, 2026-11-07: "Add all of the missing things..."; "add the surface model"): sun-facing
  slopes, pavers, cooling from any shade (H81); the surface temperature, afternoon and before dawn, kept watered or
  rain alone, with each square's wind and wetness (H82); the paper's section 7 and change log.

- **The heat view** (owner, 2026-11-07): Heat on the map's views: the ground's 24-hour energy against open lawn,
  the night sky's pull, the trees' cooling of the air, by month, a tapped spot's own breakdown (lib/heat.js, H80).
  Found and fixed on the way: the live plans had run without the shade since 2026-11-04 midday (H80).

- **Tree trunks** (owner, 2026-11-04: "Yes let's do tree roots. A pre requisite to that is knowing where tree
  trunks are"): lib/trunks.js, from the shade map's crowns (unchanged) plus the stem returns 0.5-3 m up under
  each crown (H78). Trunks drawn on the water map (solid: a stem seen; hollow: the crown's top). The readings
  page marks trunks by hand (moisture_marks), the water map's card scores the finder against them. NEXT: the
  owner marks the trunks on the lot; score; offer the module to the shade session (one home for the rule); then
  the root draw (H40's model) and the readings check again (S26).

- **The readings against the model** (owner, 2026-11-04): the water map ranks a visit's readings against the
  model's wetness on that day (moistureCard) and keeps the scores; a key-gated export lets the water session run
  it itself (src/moisture.js; key in the session's scratchpad, stops 2026-12-05). First visit, corrected the same
  day (the owner: all 27 were on traced lawn; the dots had been placed on Mapbox's photo, the trace on the
  county's, half a meter apart): rho 0.31 over 27 spots, p 0.11 (H76); the shaded area reads drier than the model
  has it (S26). The readings page now shows the traced-on photo with the trace drawn over it. Next: a visit a day or two
  after real rain, and the trees' draw on the lawn's water (S26).
- **Growing season start** (owner, 2026-11-04): asked whether to start it on soil temperature (45 or 55 F): "No".
  It stays as it is: the start at 20% growth potential on air temperature, the end on soil temperature.

- **Soil moisture readings in the field** (owner, 2026-11-02): the /moisture page and the water database's
  moisture tables (H74). Next: the model run on each visit's property and day, set against the readings by rank.

- **Water perched on slow layers** (owner, 2026-11-02: "Yes build it"): the store on a slow layer, its leak, its
  flow downhill along the layer to seeps, flat ground kept wet, the layer's shape from the ground, the survey's wet
  months as the check on the layer's speed, cemented bands, and the capillary barrier under topsoil on sand (H73).
  Open: probe readings to fix the layer's depth, a neighbour's water from uphill, drains (S25).

- **The water table under each square metre** (owner, 2026-11-01: "build all 3... as true to life as possible"):
  the height above the nearest water, water rising into the roots, seeps; calibrated on 227 wells (H70). Open:
  perched seeps at slope feet and sump discharge (S24).

(moved here with the date and the FINDINGS entry when finished)

- 2026-10-25: a 3D view of the ground beside the top-down one (FINDINGS H38).
- 2026-10-25: the rate of the recent rains, hour by hour, in this week's plan (FINDINGS H39).
- 2026-10-26: shade's effect on the air: the day's own air share, and cooler air near trees (FINDINGS H43, S11).
- 2026-10-27: shade again -- the trees in summer leaf, the trees erased on the shade map, the yard's wind (FINDINGS H44, S12).
- 2026-10-27: shade through the year -- each month's light from the shade map's worker (FINDINGS H45).
- 2026-10-27: each spot's own radiation -- near-infrared through crowns, skylight, the sky it loses heat to (FINDINGS H47, S13).
- 2026-10-27: fences (shade, radiant heat, wind), the local wind's records, and each spot's own wind (FINDINGS H48, H49, H50, S14).
- 2026-10-27: pressure-regulated heads -- the model was right; the map, the tables and the details now show the nozzle's pressure (FINDINGS H51).
- 2026-10-27: one kind of zone -- the plan's parts of the lawn are "watering areas"; with sprinklers mapped, the report leads with each sprinkler zone's run times.
- 2026-10-27: the report as a PDF -- "Save as PDF" prints the report with the map (the browser's own print).
- 2026-10-27: Finish -- once every sprinkler step is done, going back offers Finish: on to the next step a change needs (a head on no valve, without a nozzle, or with its arc not fitted), then the schedule.
- 2026-10-27: rain intensity in the ten-year plan, from the station's hours (FINDINGS H52).
- 2026-10-28: the roots by species (a checklist) and through the season from the soil's warmth, each year its own (FINDINGS H53, S15; research-roots-brief.md, research-roots-ryegrass.md).
- 2026-10-28: how much to water -- normal, deficit or dormancy, chosen just before the sprinklers question and kept with the map (FINDINGS H54, S16).
- 2026-10-31: streams and the flood plain: the nearest streams and the lawn's height above their water, FEMA's zones and 1% flood water against the lawn's own ground (FINDINGS H63, S19).
- 2026-10-31: each soil of a map unit in its own place, by the lie of the land; urban land borrows its neighbour's (FINDINGS H62, S18).
- 2026-10-29: fences: each face its own temperature, the board lit through the trees (FINDINGS H59).
- 2026-10-29: deficit and dormancy show their stress: the grass draws at its own coefficient while the schedule waters for the level's (FINDINGS H57).
- 2026-10-29: the lidar's leaf state point by point, as the shade map now reads it, in the water map's own reader (FINDINGS H56).
- 2026-10-29: the owner's per-species crop coefficients (kc-table.md) in: each level's Kc is the middle of the species' range, averaged over the grasses checked (FINDINGS H54).
- 2026-10-28: dew, looked into and not added: rain gauges leave it out, it evaporates off the blades, and it is largest in the open, not in shade (FINDINGS H55; research-dew.md).
