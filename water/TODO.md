# Water map: to do

The owner's queued work, in the order asked. Each item names what is to be found
out before anything is built; findings go in FINDINGS.md (HARD apart from
SPECULATION), as always.

## In progress (2026-10-27)

(nothing)

## Queued

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

## Rules (owner, 2026-10-27)

- **Shade is the shade map's.** "You should follow the output of the shade map. If we need to make adjustments to how
  shade actually works, that goes through the shade map. Re use the shade map's work, for uniformity... we don't
  want to start any tree models or shade calculations from scratch here." The water map runs the shade map's own
  files (lib/shade/ links to public/shade/), takes its light, its trees (its kinds) and its erased trees, and asks
  the features session for any change to them. A "light through leaves" point was passed to it on 2026-10-27 and withdrawn the same day: the shade map is
  already held to light measured under real canopy (FINDINGS S12). Read docs/SHADE-FINDINGS.md before claiming
  anything about how the shade map works. What the WATER map makes of the shade map's light for the grass's water
  use -- the near and far infrared, the skylight, the night sky (owner, 2026-10-27: "this part belongs to the water
  map") -- is the water map's (FINDINGS H47), from the shade map's output, with no shade calculation of its own.

## Shelved (owner, 2026-10-26: "shelve the tree thing to the todo list")

- **Trees using the lawn's water**: researched (FINDINGS H40, research-trees.md),
  nothing built. The proposal: shade as now, plus each tree's root draw (its
  water use x the share from the turf's depth) spread over a disc about twice its
  crown, every number uncertain about threefold. A soil-moisture probe transect
  beside a maple and a spruce would settle the numbers.

## Done

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
- 2026-10-29: the owner's per-species crop coefficients (kc-table.md) in: each level's Kc is the middle of the species' range, averaged over the grasses checked (FINDINGS H54).
- 2026-10-28: dew, looked into and not added: rain gauges leave it out, it evaporates off the blades, and it is largest in the open, not in shade (FINDINGS H55; research-dew.md).
