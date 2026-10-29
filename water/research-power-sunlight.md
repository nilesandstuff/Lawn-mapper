# Does NASA POWER overestimate sunlight? USCRN and SURFRAD, 2018-2024, April-October

A research agent for the water session, 2026-10-29; its key numbers re-checked by the session from its own tables.
Data and scripts were kept in the session's scratchpad (power-bias/), not in the repository. Owner's question: "if
you're sure that nasa power overestimates light, can you apply an offset that corrects that? Be really sure about this
before doing it, especially be sure to find out if there's regional trends to how much it's off, like based on latitude."

## HARD (measured)

Corpus: 115 CONUS stations of NOAA's Climate Reference Network (USCRN) with 300 or more paired days (167,540 days),
against NASA POWER API v2.10.1 (community AG; MERRA-2 and CERES SYN1deg). ET0 worked out as water/lib/et.js does
(RH mean, FAO-56 eq. 19; Rs capped at Rso), the station's elevation and POWER's wind on both sides.

H1. USCRN itself reads low. Four USCRN stations stand beside NOAA SURFRAD research radiometers:

| site | months | USCRN / SURFRAD | POWER / SURFRAD |
|---|---|---|---|
| Bondville IL | 41 | 0.946 | 0.975 |
| Desert Rock NV | 44 | 0.942 | 0.981 |
| Fort Peck MT (2018-22) | 32 | 0.935 | 0.985 |
| Sioux Falls SD | 42 | 0.952 | 1.007 |
| pooled | | 0.944 | |

USCRN / SURFRAD by year 2018-2024: 0.940, 0.953, 0.949, 0.949, 0.949, 0.935, 0.923.

H2. POWER against SURFRAD, all seven sites: pooled 0.991; sites 0.975-1.007; months April-October 0.984-0.999; years
2018-2024 0.979-1.001. The newest months (POWER's provisional FLASHFlux source) 0.93-0.97: a little low, never high.

H3. POWER against USCRN by region (medians): CONUS 1.080 (IQR 1.062-1.093); West 1.080; East 1.084; Great Lakes
(MI WI MN OH IN IL IA, 10 stations) 1.063; Gaylord MI 1.086, Chatham MI 1.078. With USCRN's sunlight divided by its
0.944 against SURFRAD: CONUS 1.019, Great Lakes about 1.003.

H4. No geography: the station ratio against latitude R2 0.05 (slope -0.002 per degree), longitude 0.00, elevation
0.03, East/West 0.002, all three 0.08. Eight pairs of stations inside one POWER cell differ by a median 1.4% (up to
21% at Asheville): station scatter is the size of the effect left. Outliers are fog and mountain sites (Brunswick
1.31, Quinault 1.26, Santa Barbara 1.19, St. Mary 0.85).

H5. What each input does to POWER's ET0, one swapped for the station's at a time (points of station ET0):

| | sunlight (USCRN as is) | sunlight (USCRN / 0.944) | temperature | humidity |
|---|---|---|---|---|
| CONUS | +3.8 | +1.0 | +2.0 | -0.6 |
| Great Lakes | +3.4 | 0.0 | +1.4 | -4.3 |
| Michigan | +4.1 | +0.9 | -2.1 | -6.4 |

POWER's humidity reads about 7 points high in Michigan and its daily high 0.4-2.9 C cool, both pulling its ET0 DOWN;
its wind is 1.0-2.1 times the stations' 1.5 m wind brought to 2 m (0 to +6 points; a weak benchmark).

H6. Michigan in inches, June / July, 2022-24: POWER's inputs; the station's with POWER's wind; the station's all:

| | June | July |
|---|---|---|
| Gaylord | 4.56 / 5.11 / 4.83 | 4.88 / 5.10 / 4.69 |
| Chatham | 3.69 / 4.37 / 4.19 | 4.48 / 4.87 / 4.66 |

FAO-56 on the stations' own measured weather gives 4.8-5.9 in in June and 4.7-5.7 in in July across the nearest
stations, at or above the app's 5.09 / 5.39 and well above Enviroweather's 4.0-4.4 / 4.4-4.8. RH from max and min
(FAO-56 eq. 17) instead of the mean adds 6-8%.

## Published

- POWER's own validation (Energy Fluxes page, read): SYN1deg Ed4.1 against BSRN, daily +0.3% bias, RMSE 13.5%;
  monthly +0.03%, 5.7%. Global; no US breakdown.
- White et al. 2011, Agron. J. 103:1242 (abstract and first page read): POWER 1.1 MJ/m2/day LOW at 295 US stations,
  worse at low latitudes and in summer (an older POWER source).
- Rosa et al. 2023 (Brazil; second-hand): sunlight overestimated in most climates. Not borne out here.
- No POWER-USCRN, POWER-SURFRAD, USCRN-SURFRAD or Great Lakes study was found.

## SPECULATION

- USCRN's low reading and its yearly decline would fit a silicon-cell pyranometer's spectral and angle response,
  soiling and drift; its sensor model was not confirmed.
- Why Enviroweather is lower: its own pyranometers, a different formulation or time step, siting, wind height, or
  different years. Not checked; the Enviroweather figures are second-hand (FINDINGS H21).

## Recommendation (adopted)

No sunlight correction: not a factor, not by month, not by latitude or region. POWER is within about 1% of the
research radiometers; its +8% against USCRN is mostly USCRN reading low; what is left has no geography. Sunlight
explains about one point of the 15-20% gap to Enviroweather; POWER's inputs do not make the gap (measured weather
gives as much ET0 or more). The next thing to find out is Enviroweather's method.
