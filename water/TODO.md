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
   paving (the shade map's light). Needs blacktop told apart from concrete on
   the map: their surfaces heat differently (asphalt's albedo about 0.05-0.10
   new, concrete's 0.25-0.40: to be confirmed). Today the plan adds a flat
   estimate, up to 8% at the edge fading to nothing by 7 m (FINDINGS S8).
   A lead from the features session (2026-10-26): Halverson & Heisler 1981, USDA
   Forest Service Research Paper NE-481, "Soil Temperatures under Urban Trees
   and Asphalt" (New Brunswick NJ): at 15 cm the summer maximum under asphalt was
   34.2 C, up to 5 C over the control; no difference in winter minimums. It is
   the soil UNDER asphalt, not the grass beside it. The features session wants
   the numbers when found, for the shade map's soil-temperature view.
5. **Roots shorter in summer, deeper in spring and fall.** Simulate the root
   zone's depth through the season from the growth potential (GP, the shade
   map's growing-season model): cool-season roots die back in summer heat. The
   plan holds roots at a fixed depth today.
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
7. **Rain intensity in the ten-year plan too** (after 3): the typical-year plan
   runs on daily totals, so it cannot tell a cloudburst from a soak.

10. **The GPS jumps around** (owner, 2026-10-27: "gps is really bad, jumps around all over the place. Maybe
    augmented reality might be better?"). Placing heads by walking to them: look at averaging, the phone's
    reported accuracy, and an AR way of marking a spot (the camera and the ground plane) instead.
11. **A "Finish" button when going back** (owner): once every step is done and a change is made on an earlier
    one, a Finish button skips ahead to the next step the change makes necessary (a new head: check its arc),
    then to the summary -- or straight to the summary when nothing else is needed. Otherwise, explore other
    navigation that makes it easier to go back and forth between steps.
12. **One kind of zone in the words** (owner: "seperate the terminology for the watering zones and sprinkler
    zones. Its confusing to have 2 seperate types of zones. Recommendations should be based on sprinkler
    zones."). The plan's soil-and-sun areas need another name; the recommendations go by the sprinkler zones
    (valves).
13. **Are pressure-regulated heads working?** (owner: "A user had a 30 psi regulated sprinkler body that was
    showing up as 35 psi, not sure if that's actually accurate or not.") A regulated body should hold its
    nozzle at the regulator's pressure once the supply is above it. Check the pressure model's regulator handling.
14. **The final summary as a PDF** (owner): export the summary pages to a PDF.
15. **Hose-end sprinklers placed by hand** (owner: "add specific recs for manually placing sprinklers. Which will
    require pressure calculations (same as the existing workflows for inground, but obviously simplified)"):
    where to set each sprinkler, how long, from the hose and the tap's pressure.
16. **A simple view and an advanced view** (owner: "Simplified should just show the actionable info, advanced
    should show the reasoning.").

17. **Wind on the sheltered side of a house** (owner, 2026-10-27). The yard's wind is Heisler's neighbourhood
    figure from the roofs and crowns within 90 m (FINDINGS H44), much the same over the whole lawn; the lawn just
    downwind of a house (and of a hedge, a fence or a row of trees) is calmer than that, and its corners can be
    windier. Heisler measured the "approach wind" with the house's own effect taken out, and no measured table of
    wind behind a single house was found. Research it (wind-tunnel and field studies of a house's wake, the summer
    wind's direction here), then a per-cell lee from the roofs (and crowns) upwind, the buildings from the shade
    map's kinds. Also: the cover is counted only as far as the grid reaches, 30 m past the lot, not Heisler's 90 m.
    Fences (features session, 2026-10-27): the shade part (v 3) keeps each fence's line, height, style and a wind
    porosity (solid 0, spaced 0.5 -- Zhou et al. 2004 for slat fences --, shadowbox 0.2, an estimate): a fence's lee
    is the same calculation as a house's. The water map already passes the fences to the light worker for their shade.
    What is known so far: FINDINGS H46 (which effects are averaged, and why the wind's average does not hold spot
    by spot), H44 (the wind as built), S12, and research-shade-wind.md (Brandle's windbreak curves, Heisler's houses).
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
