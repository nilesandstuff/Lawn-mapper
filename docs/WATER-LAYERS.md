# Water layers for the water map

The core session owns this route and its catalogue. The water map reads it.
Since 2026-10-23 (owner: "adding new layers that we collect from county gis
servers, to make them available to the water map").

## The route

    GET https://lawnmap.<home>/api/water/layers?lng=<lng>&lat=<lat>&m=<half-width metres>
    GET https://lawnmap.<home>/api/water/layers?box=<west>,<south>,<east>,<north>

- `m` defaults to 150. One answer covers at most 1,200 m across.
- It is public, like the shade map's lidar route. It is told only the box and stores nothing per address.
- The water Worker reaches it the same way it reaches `/api/maps*`: forward the path over the service binding. Cross-origin calls from the browser are not allowed.
- The answer goes out within about 15 seconds. A source still working then is listed under `pending`, and the server keeps asking it. Ask again a minute later for the whole answer. USGS's hydrography server is the usual one: it answered the same small box in under a second and in a minute, minutes apart.
- A whole answer is cached for a week, by its box. One with a source that failed is cached for a day.
- Every shape is cut to the box, with a 2% margin, and simplified to about half a metre.

The answer:

    {
      "box": [w, s, e, n],
      "kinds": { "storm_inlet": "Storm inlet or catch basin", ... },
      "asked": { "national": 4, "county": 9 },
      "layers": [
        { "kind": "storm_inlet", "label": "...", "from": "county" | "national",
          "source": "Kent County, MI", "title": "Storm Inlets", "url": "<the ArcGIS layer>",
          "truncated": false, "type": "FeatureCollection", "features": [ GeoJSON, degrees ] }
      ],
      "failed": [ { "kind", "title", "source", "url", "reason" } ],
      "pending": [ { "kind", "title", "source", "url" } ]      (only when some are)
    }

Codes come as names (2026-10-24, the water session's ask): a value a layer
names, in its subtypes, its fields' coded-value domains or, failing both,
the labels its own map style gives the values of the field it is styled by,
is sent as the name. Kent's pipes say "StormMain", "Culvert", "OpenChannel",
"Underdrain"; its inlets "Double Catch Basin", "Flared End Section", "Yard
Drain" (and "Various Inlets" for the rest, which is all Kent's style says);
`MATERIAL`, `OWNER`, `JURISDICTION` and `STATUS` are named from their domains.
A value no layer names stays a number.

Layers are listed areas first, then lines, then points. A layer with nothing
in the box is left out. A source that did not answer is in `failed`, never
silently missing. Each feature keeps its service's own attributes, minus ids,
shapes and empties. For Kent County's storm network those include pipe
`DIAMETER`, `MATERIAL`, inflow and outflow invert elevations, inlet
`TOP_OF_CASTING`, `SUMP_DEPTH`, `OWNER` and `DRAIN_NAME`. They are in feet
where the county works in feet. Read each service's own field list before
trusting a unit.

## The kinds

| kind | what |
|---|---|
| flood_zone | FEMA flood hazard zone (`FLD_ZONE`, `SFHA_TF`), from Esri's public copy of FEMA's layer (FEMA's own server refuses the Worker), or a county's own |
| wetland | USFWS National Wetlands Inventory (`WETLAND_TYPE`), or a county's own |
| water_body | lake or pond: the inventory's open water (lakes, ponds, river channels), or a county's own. USGS NHD water bodies were dropped on 2026-10-24: they almost never answered in time |
| watershed | a county's watersheds or sub-basins |
| drain_district | the area a county drain serves |
| drain_easement | a drain or storm easement |
| detention_basin | detention or retention basin, stormwater pond, rain garden |
| stream | stream or river: USGS NHD flowlines, or a county's own |
| open_drain | open county drain, ditch, swale, channel |
| storm_main | storm sewer pipe or lateral |
| culvert | culvert |
| storm_inlet | storm inlet or catch basin |
| storm_manhole | storm manhole |
| outfall | outfall, headwall, end section |

## Where the county layers come from

`tools/water-layers.js` (workflow 44, nightly) walks every ArcGIS server in
the parcel registry. It keeps each layer whose name and geometry say it is
one of the kinds above, with its feature count and its box, in the
`water_layers` table. A "Lakes" layer of points, drinking-water mains,
sanitary sewers, inspections, complaints, drafts and dated layers are never
kept. About 730 servers; each night takes the next 60, those under people's
saved maps first.

Before the sweep, each night searches ArcGIS Online near every saved map
(2026-10-24): by the spot, and by its county's, city's and township's names
(from the Census Bureau's free geocoder), for storm and drainage services
whose own extent covers a saved map. The servers they live on, often a
city's that the registry never knew (Grand Rapids' own: 13,376 storm
manholes, 21,699 catch basins, 17,147 gravity mains), are swept first. On
each server a layer published many times over (Grand Rapids' catch basins
are in 13 services) is kept once, the fullest copy, and maintenance subsets
(abandoned, lined, cleaned, televised) are never kept.

Coverage is patchy by nature. Storm sewers are often a city's or a
township's, not the county's, and some are not public. Kent County, MI
publishes its drain commission's whole network.
