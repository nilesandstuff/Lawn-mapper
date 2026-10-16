# The lawn water tool

Rain, irrigation and drainage on one lawn (water session; see CLAUDE.md,
"The water session"). Its own folder, its own tests, its own workflow
(.github/workflows/water-deploy.yml, "W. Water tool") and, later, its own
Worker at water.<home domain>.

**Read water/FINDINGS.md first.** It holds what has been measured, the bar
each step has to pass, and what is still only a theory.

## Step 1: the low-spot map

    lib/ept.js las.js laz.js datum.js   the shade map's lidar readers, copied
                                        from public/shade/ (features session)
                                        unchanged; vendor/ is its laz-perf
    lib/node-io.js                      the same readers' I/O in Node
    lib/surface.js                      ground points -> 1 m surface with an
                                        error bar; roofs found from the points
    lib/hydro.js                        Priority-Flood low spots, D8 runoff,
                                        the ground's fall beside each building
    lib/lowspots.js                     all of it, plus the per-flight noise floor
    lib/render.js                       the map as pixels
    lib/synthetic.js                    made-up ground for tests and limits
    tools/lowspots.mjs                  run it on lots (WATER_LOTS; never committed)
    tools/limits.mjs                    what it can find (FINDINGS H8)
    test/lowspots.test.js               node water/test/lowspots.test.js

Data: USGS 3DEP point clouds (public Entwine octrees on AWS), picked by the
live shade map's public /api/shade/lidar. No keys, nothing paid.

## The site (water.<home domain>)

    src/index.js        the Worker: the page, and five of Lawn Mapper's public
                        GET routes asked server-side (geocode, parcel, imagery,
                        county-imagery, shade/lidar)
    public/             the page (app.js) and its Web Worker (analyse.js)
    lib/browser-io.js   laz-perf in a Web Worker
    lib/site.js         one property end to end (also the corpus run's)
    tools/prepare.mjs   the build: water/build + water/wrangler.toml, the domain
                        derived from CUSTOM_DOMAIN (never written in the repo)
    test/site.test.js

Deploy: workflow "W. Water tool", task deploy.
