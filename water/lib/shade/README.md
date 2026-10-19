# The shade map's lidar modules, copied unchanged

From public/shade/ (the features session's shade map) at commit 64670eb on the
default branch, 2026-10-17, for the water map's roof finder (water/lib/roofs.js),
on the features session's advice (water/FINDINGS.md H13): grid.js, canopy.js,
seasonal.js, crowns.js, ground.js (the ground both maps share), and the ept.js
and las.js they import. Do not edit
here; take a newer copy from public/shade/ instead.

2026-10-18, for the watering plan (water/lib/plan.js; owner's vision, water/VISION.md):
light-worker.js, rays.js, sun.js and climate.js, unchanged from public/shade/ on the
default branch at commit 36b00b9, and public/lib/mask.js (which light-worker.js imports
as ../lib/mask.js) as water/lib/lib/mask.js. The water map runs the shade map's light
worker over the traced lawn for the summer days of the growing season and takes each
cell's daily light against the open sky's as its share of sunlight (FINDINGS S9), and
takes the growing season itself from climate.js's growingSeason (the owner's 20% GP
rule), so both maps use one season.

2026-10-19, for drawing a saved map on the photo it was saved with (owner: "If a county
photo is saved, use the county photo, if mapbox is saved, use that"): traced.js,
unchanged from public/shade/ on the default branch at commit f070fb0 -- which photo a
saved map was traced on (Mapbox, or a county service and the editor's line-up).
