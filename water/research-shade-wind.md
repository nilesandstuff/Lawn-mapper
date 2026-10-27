# Wind, shade and turf ET: research for etToday (round 2)

Tags: [read] = I read the source (full text unless it says abstract); [2nd] = seen only through another source or a search summary; [trade] = trade-press summary of unpublished work. "Computed" = my arithmetic, using water/lib/et.js unless stated. Not repeated from research-shade-air.md: Danielson & Feldhake 1981 (D&F), Ziter 2019, Souch 1993, Rahman 2018, Litvak k_mc.

## HARD FINDINGS

### A1. Wind in residential yards: Heisler 1990, *ASHRAE Trans.* 96(1):1389-1396 [read, full text, USFS Treesearch 37282]

- **Method.** Cup anemometers at 2 m, ½-1 building height from 15 houses, in four State College PA neighbourhoods. The reference (U0) was **an anemometer at 2 m at the local airport**. Seven summer days and seven winter days, daytime only. Hours with U0 < 1.6 m/s were dropped. Values are the "approach wind" toward the house, corrected for the house's own effect using measurements around an isolated building. Building cover was 6-12% and tree cover 0-77%. Cover was measured in the 0-91 m and 91-305 m bands upwind.
- **Total reduction, buildings plus trees** (abstract and Fig. 6):
  - no trees: **22%**;
  - 77% tree cover: **70% in summer, 65% in winter**;
  - low tree cover (about 24%): about 50% in summer and about 40% in winter (read off Fig. 6).
- **Table 3, reductions from the regression models:**

  | tree density | by buildings | by trees, summer | by trees, winter |
  |---|---|---|---|
  | Low | .24 | .28 | .14 |
  | Medium (67% cover) | .21 | .39 | .37 |
  | High (77% cover) | .24 | .46 | .41 |

- **Fig. 8, fitted to the summer means:** reduction % = **100x / (24 + 1.1x)**, where x = building cover % + tree cover %. Summer points sit within 12 points of the curve. Only hours with U0 of 3.1-5.4 m/s were used.
- **Other results:**
  - Tree cover alone explains R² = 0.62 of the reduction. The best building variable explains 0.15. The full stepwise model reaches R² 0.73-0.82, with residuals up to 40 points.
  - Reductions were **4-12 points larger** when U0 was 3.1-5.4 m/s than when it was 1.6-3.1 m/s.
  - Even upwind of an obstacle, wind can be reduced up to about 5 heights away.
  - Dense tree stands can cut wind below the canopy by up to about 90% (Heisler & DeWalle 1988, as cited).

### A2. Behind barriers and single trees

- **Brandle, Hodges, Tyndall & Sudmeyer 2009**, *North American Agroforestry* 2nd ed., ch. 5, Fig. 5-3 [read]. Wind as % of open (10 m/s), by distance downwind in barrier heights H:

  | barrier | 5H | 10H | 15H | 20H | 30H |
  |---|---|---|---|---|---|
  | deciduous row, 25-35% dense | 50 | 65 | 80 | 85 | 100 |
  | conifer, 40-60% dense | 30 | 50 | 60 | 75 | 95 |
  | multi-row, 60-80% dense | 25 | 35 | 65 | 85 | 95 |
  | solid fence | 25 | 70 | 90 | 95 | 100 |

  Wind is also reduced 2-5H upwind of the barrier.
- **Heisler & DeWalle 1988**, *Agric. Ecosyst. Environ.* 22/23:41-69 [2nd, abstract]. Reductions of 20% or more reach about 25H downwind, and measurable reductions about 50H.
- **Single trees** are much weaker than rows:
  - **Mayaud et al. 2016**, *ESPL* [2nd]. Under and just behind an isolated tree, a "bottom-gap" jet *reduced* the shelter for up to about 3 tree heights. Shelter then built up over about 8 more heights.
  - **Angelou, Mann & Dellwik 2022**, *ACP* 22:2255 [read, via page summary]. An open-grown oak 6.5 m tall, measured at 1.3H downwind and at crown height: the slowest wake wind was 27% of upwind in late October. The cited summer minimum is about 10% of upwind. The paper gives no number below the crown.
- **No measured table** of wind below an isolated house's height against distance in building heights turned up. Heisler's isolated building gave a relative wind of 0.37-1.11 at 1H; corners and sides can be faster than the approach wind.

### A3. NASA POWER wind against the airport, and the yard against the airport

- **Computed here.** Pairs of NASA POWER WS2M (the cached power10.csv used by the tool) with Iowa Environmental Mesonet daily ASOS mean wind at 10 m, converted to 2 m with FAO-56 eq. 47 (×0.748), 2022-25:

  | station | season | days | POWER WS2M | airport, 2 m equivalent | POWER / airport |
  |---|---|---|---|---|---|
  | the nearest major airport | Jun-Aug | 368 | 2.31 m/s | 2.41 m/s | **0.96** |
  | the nearest major airport | May-Sep | 612 | | | 0.99 |
  | the nearest major airport | year | 1461 | | | 1.07 |
  | a small airfield nearer the lot | Jun-Aug | 92 | | 1.72 m/s | 1.35 |

  So in summer, POWER's wind is **open-airport wind**, the same reference Heisler used. Note that **u2 = 3 is a windy day here: the summer mean is about 2.3**.
- **Rosa, Souza & Santos 2023**, *Pesq. Agropec. Bras.* 58:e03261 [read]. Over 21 stations, wind was POWER's least reliable variable and was overestimated in four climate types. Their US station "u2" values (8-13 m/s) look unconverted, so I give no bias figure from them.
- **Height of the reference.** FAO-56 and the ASCE standard expect u2 measured over open clipped grass (Ley, Allen & Jensen 2013, *J. Irrig. Drain. Eng.* 139:463 [2nd, title and search summary]). I found **no published POWER-to-suburban-yard ratio** other than Heisler's airport-to-yard ratio.

### A4. Turf ET against wind

- **I found no measured turf ET response to wind or shelter** (no wind-tunnel series, no sheltered against open lysimeter).
  - D&F 1981 say only that the zero-radiation floor "would of course vary with the amount of wind received".
  - Their Appendix C wind run averages about **37 km/day (about 0.43 m/s)** over 253 June-September days (computed from the scanned text). The anemometer height is not stated, so this neither confirms nor refutes "open-field wind" behind the floor.
- **Cleugh et al. 2002**, *Aust. J. Exp. Agric.* 42:649-664 [read]:
  - Air in the sheltered quiet zone is warmer and more humid.
  - Turbulent fluxes are "greatly reduced" in the quiet zone but rise above upwind values where the wake begins.
  - "While soil evaporation is quite sensitive to wind shelter, this is not necessarily so for plant transpiration." Transpiration in the quiet zone is "relatively insensitive" to shelter, because the response depends on whether the open-field rate is above or below the equilibrium rate.

  So recomputing Penman-Monteith with a lower u2 **while holding T and ea fixed** is not a validated way to model sheltered turf. It probably overstates the cut.

### B5. Turf ET under shade, as a share of full sun

| study | grass, shade source | light | ET share of sun | climate, wind |
|---|---|---|---|---|
| D&F 1981 (earlier round) | KBG, raised cloth | 27% sun | ≈0.57 (fit); full cover 0.42-0.46 | Fort Collins, open field |
| Litvak & Pataki 2016, *J. Arid Environ.* 134:87 (earlier round) | lawns under trees, chambers | full canopy cover | **0.61** | Los Angeles |
| **Wilfong et al. 2024**, *JAWRA* 61(1):e13236 [read, abstract] | lawns, shade vs sun, chambers | "shade" (light not given) | **0.33-0.5** ("two to three times lower") | Salt Lake City, Los Angeles, Tallahassee; sunny-lawn ET only 0.7-3.3 mm/d |
| **Cheary, Fontanier, Amgain & Harris** (GCM 2020) [trade] | 4 bermudagrasses, 2 zoysias, cloth | radiation cut ~42% | **0.45-0.63** | Stillwater OK, mini-lysimeters, 2018-19 |
| **Duan & Fontanier 2022**, *ITSRJ* 14:262-265 [read, abstract] | 55% cloth, greenhouse | ~45% | **tall fescue 0.87**, zoysia 0.77, bermuda 0.71 | greenhouse, still air |
| Shashua-Bar, Pearlmutter & Erell 2009, *Landsc. Urban Plan.* 92:179 [2nd] | grass under trees or mesh, courtyard | not given | "<0.5" (">50% reduction" in total water use) | Negev, hot and dry |

A search summary credited an Israeli lysimeter study with "49% less under mesh, 72% less under trees". I could not trace the source, so I do not use it. Jiang et al. 2004 (Crop Sci. 44:587) measured quality and photosynthesis, not ET.

### B6. Does shade lower Kc by thinning the turf?

- **Feldhake, Butler & Danielson 1985**, *Irrig. Sci.* 6:265-270 [2nd, abstract via search]. KBG was preconditioned at 100/71/51/27% PAR and then all put in full sun or full shade for a day. Canopy dry weight differed "substantially", but **ET and canopy temperature were the same**, "as long as complete ground cover is maintained".
- **Gardner (Ohio State) [trade, Golfdom 2017]**. Tall fescue at about 9-10% of full-sun light under deciduous trees had **60% fewer tillers and about 50% less leaf area**. Under a neutral cover at the same light, tillers fell 30% and leaf area stayed about the same.
- **Cheary et al. [trade].** The largest ET cut was in U3 bermudagrass, "likely" because it lost canopy. Other cultivars kept their density.

So morphology lowers ET only where shade thins the cover, which means deep tree shade and the weaker species.

### B7. Humidity, VPD and shortwave under canopy

- **von Arx et al. 2013**, *J. Ecol.* 101:1201-1213 [read, abstract]. Eleven Swiss forests, 1998-2011, below the canopy against the open: daily Tmax up to **3.3 °C lower** and daily VPDmax up to **0.52 kPa lower**. These are closed forests, not yard trees.
  - Computed: on the July day, VPD at Tmax is about 2.1 kPa, so 0.52 kPa is about 25%.
  - Yard-tree cooling is smaller: 0.7-1.3 °C (earlier round).
- **Heisler 1986**, *Urban Ecology* 9:337-359 [read, full text]. Pyranometers measured total shortwave in the shade of single trees. In leaf, the reduction was **65-85% averaged over the shadow and 72-90% at its centre** on clear days. Leafless, it was 30-34%.
- **Hutchison & Matt 1977**, *Ecol. Monogr.* 47:185 [read]: "leaves transmit green and near infrared wavelengths preferentially", so much of the light inside a summer forest is not used in photosynthesis. No split was given.
- **Leaf absorptivity:** about 0.8 for PAR, 0.2 for NIR and 0.5 for total solar (Campbell & Norman 1998) [2nd]. Under Beer's law with extinction K·√a, NIR transmission ≈ (PAR transmission)^0.5.
- **The tool's L** (lib/shade/canopy.js) is a lidar **gap fraction**: leaves are treated as black and scattered light is ignored. Under crowns, the shortwave reaching the grass therefore exceeds L. Under buildings it does not.

## SPECULATION

**1. A wind factor per cell.**

    f = 1 - x / (24 + 1.1x)              (Heisler 1990, Fig. 8)
    x = building % + tree-crown %, from the lidar, within about 90 m
    u2_cell = WS2M x f

- 90 m is Heisler's inner band. The grid reaches only 30 m beyond the lot, so canopyAround's 30 m disc is a stand-in. Chesapeake or NLCD cover could fill out to 90 m.
- Limit x to 6-90%, the measured range.
- Penman-Monteith is then recomputed per day. Both terms change: a lower u2 shrinks the air term and slightly *raises* the radiation term.
- Leave out an extra per-cell "under the crown" factor. Under a single high crown the bottom-gap effect cancels it (Mayaud), and Heisler measured neighbourhoods, not crowns.
- A lee term (Brandle's deciduous row, *halved* for single trees, upwind in the summer wind direction, about 240° at the airport in the cached sample) is optional and unmeasured for yards.
- Keep FAO-56's 0.5 m/s floor.

**2. Other terms.**
- **Kc.** Leave it alone (Feldhake 1985). If anything, lower it only where L < about 0.15 and the turf is visibly thin (Gardner).
- **VPD.** Already in A through the cooling. von Arx's forest figures are too big for yard trees.
- **NIR.** For shade *cast by crowns*, the shortwave share ≈ 0.5·L^0.89 + 0.5·L^0.45. This raises the ET of shaded cells.

**3. The July day** (computed: Tmax 28, Tmin 16, RH 60%, Rs 24, lat 42.9, 15 July, WS2M 3). ET0 = 5.49 mm/d, and the air share s = **0.42**, not the 0.26 summer mean, because u2 = 3 is windy. The open-sun use at POWER wind is 4.39 mm/d.

| cell | x | f, u2 | today | wind | wind + NIR |
|---|---|---|---|---|---|
| L = 0.2 under a tree (canopy within 30 m 0.55) | 65 | 0.32, 0.96 m/s | 2.23 mm/d (**0.51**) | 1.26 (**0.33**) | 1.75 (**0.46**) |
| L = 0.5 beside a tree (0.40) | 50 | 0.37, 1.10 | 3.03 (0.70) | 2.25 (0.59) | 2.65 (0.69) |
| L = 1 open part of yard (0.25) | 35 | 0.44, 1.32 | 4.34 | 3.83 (−12%) | 3.83 |

- Shares in parentheses are against the open cell in the same yard.
- With one yard-wide f = 0.41 (the owner's lot median, x = 41), the L = 0.2 cell is at 0.37.
- At the summer-mean wind (2.3 m/s, s = 0.35), the L = 0.2 cell goes from 0.48 today to 0.31 with wind.

**4. Against the measurements.** The shares measured outdoors in deep shade run 0.33-0.61 (Wilfong, Litvak, D&F, Cheary). The model today gives 0.48-0.53 at L = 0.2, inside that range. The wind version (0.31-0.37) sits at its low edge. The wind + NIR version (0.46) is back in the middle.

**Verdict.**
- **The evidence does not establish "much less" water in shade.** Measured shares sit on both sides of the current model. The sources disagree from 0.33 (Wilfong) to 0.87 (tall fescue, Duan), and the one closest to the owner's grass (tall fescue) shows the *smallest* cut.
- Wind is the one measured mechanism large enough to move the numbers. Heisler's yard winds are 50-70% below the airport and POWER, which is real.
  - But it lowers **every** cell, the sunny ones 10-12% on this day. Its *extra* effect on shaded cells (0.51 → 0.33) depends on holding T and ea fixed, which Cleugh's shelter work says overstates the cut.
  - The NIR correction pushes the other way.
- The best-supported change is a **yard-wide wind factor** from Heisler, applied to all cells. A per-cell shade cut of more than a few points is not supported.
- The cheapest test is still the soil-moisture pair from S11, plus a handheld anemometer reading in the yard against the the airport airport's wind for a week.
