# Groundwater and the water table under a lawn: what exists, tested (2026-10-30/31)

A research agent for the water session; the 3DHP coverage, the Wellogic counts near Hudsonville and the soil survey
there re-checked by the session. Test points, public places only: Grand Rapids centre (GR, 42.963,-85.668),
Hudsonville area (HUD, 42.87,-85.86), Rockford area (ROCK, 43.12,-85.56), Denver (contrast). Tags: [tested] fetched,
numbers from the answer; [read] document read; [second-hand] from a summary. The owner: "Look into the potential to
use 3dhp for ground water/water table data. And see if there's any older programs that may also be of use."

## Bottom line

- 3DHP (USGS's 3D Hydrography Program) holds NO groundwater or water-table data, and no lidar-derived lines in Michigan
  yet: its service fills Kent and Ottawa with the old NHD lines (every vertex Z = 0); 10 lidar-derived work units exist
  nationally, none in Michigan [tested; the session re-checked: 10 units, 0 over Hudsonville]. Michigan has a grant to
  finish the state by 2028 (G25AC00485) [second-hand]. Its "Spring" points (151,063, all from NHD) include one in the
  box round Grand Rapids, none within 10 km of a test point.
- What does exist, free and keyless: Michigan's Wellogic well records (static level at drilling), EGLE's regional
  water-table contours (Kent 2021, Ottawa from GWIM 2005), EGLE's Allegan monitoring wells (daily since 2023), and
  national models (Ma et al. 2026 at 30 m by range reads; Fan 2017 monthly about 1 km, Worker only; Zell & Sanford
  2020 250 m, download only).
- No source answers "is the water table within 1-2 m of this lawn, and in which months". At Hudsonville they disagree
  by metres: soil survey 0.54 m (a 25% minority soil; the main soil lists none), EGLE contours 2.7 m, nearby wells'
  median 3.7 m, Zell 4.0, Fan 4.15, Ma 4.85.
- The seasonal swing in shallow unconfined wells is small: monthly medians move 0.3-1.2 m, shallowest March-June,
  deepest August-October (USGS Kalamazoo-area wells; EGLE Allegan wells) [tested]. How deep it is matters far more
  than the month.

## 1. 3DHP [tested unless noted]

Service https://hydro.nationalmap.gov/arcgis/rest/services/3DHP_all/MapServer (CORS *): HydroLocations (sink, spring,
outlet), headwaters/confluences, flowlines, waterbodies, catchments, metadata. No water-table, groundwater, permanence
or baseflow field anywhere; the program page names linking to groundwater only as a future aim [read]. In West Michigan
the flowlines within 1 km of the test points (Grand River, Rush Creek, Rogue River) carry workunitid 'NHD' and Z = 0;
an Ohio lidar-derived line carries real heights (278 m). When Michigan's lands (about 2028), its lidar-height flowlines
would be a better drainage target for the hillside reading. Recheck then.

## 2. NHDPlus HR [tested]

https://hydro.nationalmap.gov/arcgis/rest/services/NHDPlus_HR/MapServer layer 3 (CORS *; 504s and a timeout before
answering at GR: needs caching in the Worker). Fields: fcode (perennial 46006, intermittent 46003, ditch 33600),
stream order, drainage area, smoothed min/max elevation. Within 1 km: Rogue River (206.71 m, 630 km2) and Rum Creek
(perennial) at ROCK, Rush Creek (perennial, 185.28 m) at HUD, Grand River (183.94 m) at GR. Its elevations come from
the same 10 m 3DEP ground the tool reads [second-hand]: no gain in height, but it says which channels are real and
perennial -- height above a perennial stream bounds the depth to the regional water table from above (reasoning; Zell
& Sanford used perennial streams as water-level targets [read]). Crude heights above the nearest line: GR 11.0 m, HUD
9.1 m, ROCK 7.6 m.

## 3. Wells

- USGS Water Data OGC API (https://api.waterdata.usgs.gov/ogcapi/v0/, CORS *, no key; the old gwlevels service is
  decommissioned) [tested]: within 10 km, GR 13 sites with 2 readings (1950), HUD 630 sites with 38 single readings
  (1966-74), ROCK none. Active wells nearest Grand Rapids: 12 round Kalamazoo/Portage/Battle Creek (73-82 km) and one
  near 43.53,-86.14. The shallow unconfined ones (13-38 ft deep) swing 0.28-0.39 m month to month (shallowest
  March-May); deep ones near pumping 2-3.6 m. Little use near the lots; the best evidence of the seasonal swing.
- NGWMN (WFS https://www.usgs.gov/apps/ngwmn/geoserver/wfs and its water-level cache, CORS *; the documented SOS is
  404) [tested]: 112 Michigan sites; EGLE's 17 are all in Allegan County, unconfined glacial sand and gravel, read
  about daily 2023-2026, monthly-median ranges 0.08-1.16 m (Gun Lake Park 2.55-4.62 ft; Overisel 2.55-7.22 ft).
  Nearest: HUD 15.8 km, GR 26.8, ROCK 45.3. No Kent County wells; Ottawa's network aims at the bedrock aquifer.
- Wellogic (EGLE; https://gisagoegle.state.mi.us/arcgis/rest/services/EGLE/DwOpenData/MapServer/3, a browser may call
  it) [tested]: 1,176,747 records statewide, 1,124,503 with a static level; fields SWL (ft below ground at
  completion), well depth, construction date, drift or rock, screen interval, glacial landsystem. Within 2 km: HUD 66
  levels, median 12 ft (3.7 m), tenth percentile 4 ft, 18 within 2 m [re-checked by the session]; ROCK 267, median 60
  ft; GR centre 4. Each level is one day at drilling, and in a confined drift well a pressure head, not the water
  table. THE SAME SERVICE CARRIES OWNERS' NAMES AND WELL ADDRESSES: the tool must never request, show or keep them
  (ask for outFields by name, never *).
- EGLE regional water-table contours [tested]: Kent County, upper glacial drift, 2021 (from Wellogic's drift wells,
  Great Lakes shores and connected waters; 10 ft contours; CORS *):
  https://services1.arcgis.com/FNjlrOFR0aGJ71Tg/arcgis/rest/services/Kent_County_Regional_Water_Table_Surface_Contours_Upper_Glacial_Drift/FeatureServer/1
  Ottawa County (GWIM's first-water surface): https://gis.miottawa.org/arcgis/rest/services/HostedServices/WaterTable/MapServer/0
  Depth (contours interpolated, minus the 3DEP ground): GR about 9.4 m, HUD about 2.7 m, ROCK about 0 m -- not
  credible 7.6 m above the Rogue River: 10 ft contours fail near incised valleys. Its metadata says the whole Lower
  Peninsula was mapped; only the Kent clip was found public.

## 4. Modelled surfaces [tested]

| | grid | how checked | point access | GR | HUD | ROCK |
|---|---|---|---|---|---|---|
| Ma, Condon, Defnet & Maxwell 2026 (Zenodo 10.5281/zenodo.18504963) | ~24 m | random forest on >1 million wells; test RMSE 14.9 m, r 0.79 | 3 range reads (~460 KB), CORS *; licence CC BY-NC-ND | 10.67 m | 4.85 | 6.10 |
| Zell & Sanford 2020 (doi 10.5066/P91LFFN1) | 250 m | 75 MODFLOW models, wells, perennial streams, wetlands | 918 MB download only | 5.77 | 3.99 | -0.05 (river cell) |
| Fan et al. 2017, monthly | ~1 km | global model | THREDDS point query, HTTP only: Worker | 0.00 (river cell) | 3.88-4.23 | 0.63-0.89 |

ParFlow CONUS needs a HydroData PIN (not keyless) [second-hand].

## 5. The soil survey [tested; re-checked]

GR and ROCK fall on "Urban land" units: no water table at all. HUD, Spinks-Fern complex: the map unit's annual minimum
54 cm comes from Fern (25%); Spinks (50%, the main soil) lists none; Brems (8%) 69 cm, Capac (7%) 15 cm. The water
map's balance reads the MAIN component's month-by-month wet layers (lib/soil.js), so here it sees no water table at
all, where a quarter of the unit has one at 54 cm in wet months. The soil survey is the only source that sees a
perched table over till.

## Recommendation (the agent's; the owner to decide)

1. The soil survey stays the water-table input in the balance; consider a component-weighted reading (the share of
   the unit wet within the roots, by month) in place of the main component alone, and a fallback where the unit is
   Urban land.
2. Wellogic within 1-2 km, drift wells only, as a page note and check: count, median, tenth percentile, share within
   2 m, years, drift/rock. Never the owner fields.
3. A regional water-table height (EGLE Kent / Ottawa contours, Ma 30 m elsewhere) less the lot's 1 m lidar ground, as
   a flag only: under about 2 m, and only where the soil survey or the wells agree. Limits: +-1.5 m or worse; fails
   near incised rivers; Ma's error 14.9 m nationally.
4. The seasonal shape as a measured constant (0.3-1.2 m, highest March-June), and optionally a wet- or dry-year note
   from the nearest EGLE monitoring well.
5. NHDPlus HR perennial streams as a second drainage target for the hillside reading (cached in the Worker).
6. Skip for now: 3DHP (recheck about 2028), USGS wells near the lots, Zell, Fan, ParFlow.

Nothing here has been checked against a real water table at a lawn.
