# Soil temperature research scripts (shade findings 27-30)

These are the scripts behind docs/SHADE-FINDINGS.md findings 27-30
(2026-10-26), kept so the numbers can be rerun. The water session asked for
them for its TODO item 6. They are research, not part of the site. Each one
downloads public data into the folder it is run from, then caches it there.
Run them in an empty working folder with `python3 -I <script>`; they need
numpy.

| script | finding | what it does |
|---|---|---|
| fit.py | 27 | NASA POWER soil minus air against sunlight at five places; expects `{mi,tx,az,de,ga}.json`, POWER daily ALLSKY_SFC_SW_DWN, T2M, TSOIL1, 2015-2025 |
| crn.py | 28 | IEMRE and NASA daily soil against 16 NOAA USCRN stations' measured 5 and 10 cm, 2025 |
| om.py | 28 | the same for Open-Meteo's archive (rate-limited per IP; four stations answered); reads crn.py's output |
| fetch_all.py | 29 | every USCRN station's 2025 daily file, with IEMRE and NASA at each; needs `stations.txt`, the file names listed at ncei.noaa.gov/pub/data/uscrn/products/daily01/2025/ |
| dorm.py | 29 | the dormancy day (climate.js's rule) on measured, IEMRE and NASA soil at every station |
| dwd_score.py | 29 | IEMRE and NASA against German DWD stations; needs DWD's daily soil temperature zips unpacked into `x/` and `EB_Tageswerte_Beschreibung_Stationen.txt` as `stations.txt` |
| fetch_yrs.py | 30 | ten years (2015-2024) of every USCRN station's daily file |
| clim.py | 30 | the soil's response to sun at each station, air held and free, rain held, over 7, 15 and 30-day spans |

Sources: NOAA USCRN daily01 (ncei.noaa.gov/pub/data/uscrn/products/daily01),
Iowa State's IEMRE (mesonet.agron.iastate.edu/iemre), NASA POWER
(power.larc.nasa.gov), DWD open data (opendata.dwd.de), Open-Meteo archive.
All free and keyless.
