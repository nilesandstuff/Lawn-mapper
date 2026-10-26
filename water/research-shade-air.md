# Shade, cooler air and turf ET: research for water/lib/balance.js shadeFactor

Tags: [read] means I read the source (full text, or the abstract where it says so). [2nd] means I saw it only through another source. Numbers marked "computed" are mine, from the source's tables or from water/lib/et.js.

## HARD FINDINGS

### 1. Danielson & Feldhake 1981 (Colorado WRRI Completion Report 106, Colorado State Univ.) [read, full report]

- **How the shade was made.** Black polypropylene shade cloth on conduit hoops, held about 62 cm above the ground. Each cloth shaded a 1.85 x 3.65 m rectangle. The hoops were designed "to have minimal disturbance of air flow across the lysimeters." Two weighing lysimeters sat under each cloth, inside a sprinkler-irrigated bluegrass field. The site was Fort Collins, 1979-80. The turf was Kentucky bluegrass mowed at 2 cm, kept unlimited in water and fertilised. Lysimeters were weighed three times a week, and rainy periods were dropped. No trees and no buildings were used.
- **The radiation axis is not the sunlight share.** The cloths let through 71, 51 and 27% of measured solar radiation (2% under a full cover). The authors then added calculated long-wave radiation from the hot black cloth, about 50 °C under the full cover. That gave the labels 73, 54 and 33% (16% for the full cover). Every published "fraction" includes this cloth infrared.
- **Result.** "The linearity is apparent." ET extrapolated to zero radiation is "approximately 2 mm per day", described as "the component resulting from advective energy". It was the same for all treatments and was "approximately 30 percent of maximum ET". The report gives no fitted a and b, only Figure 17. On days when the lysimeters were fully covered, ET was **42-46% of the maximum** for all sixteen.
- **a and b, computed from the report's Appendix F tables** (Tables F-1 and F-6; 39 rain-free periods, mm/d):

  | x-axis | a | b | a/(a+b) | range per period |
  |---|---|---|---|---|
  | report's corrected radiation (1, .73, .54, .33) | 2.08 | 3.72 | 0.36 | 0.21-0.58 |
  | measured sunlight (1, .71, .51, .27), which is what the tool's L is | 2.37 | 3.42 | **0.41** | 0.27-0.61 |

- **Is cooler air already in the 0.3? No.** Each cloth was a small, open-sided, raised patch in an open irrigated field, and the "ambient air" was the field's own air. In Appendix G the shaded grass canopy read **20-24 °C at midday against ambient air of 30-34 °C** (infrared thermometer, July 1980). That means the shaded grass sat 8-10 °C below the air, and heat flowed from the air down into the grass. That is the "advective" 2 mm/d, and it came from open-field air at full open-field wind.
- **The authors' own caveat** (p. 37): shade from trees "cannot be related to water savings from the shade produced by trees", because the tree's own ET may offset it.
- **Feldhake, Danielson & Butler 1983**, *Agron. J.* 75:824-830: not obtained. A secondary abstract snippet gives the advective term as **about 35% of ET**, with ET linear in solar radiation once that term is removed [2nd]. I did not find Part II. Feldhake, Butler & Danielson 1985, *Irrig. Sci.* 6:265-270, on shade preconditioning: title only [2nd].

### 2. Air under and near tree canopies (temperate)

- **Ziter et al. 2019**, *PNAS* 116:7575-7580 (Madison WI) [read, full text].
  - Method: a bicycle sensor at 1.5 m. Rides were 1:30-7 PM, mostly 4-6 PM. Tmax on sampling days averaged 29 °C (range 22-34).
  - Going from 0 to 100% canopy cover lowered the day's air temperature by **0.7 °C within 10 m, 1.3 °C within 30 m, and >1.5 °C within 60-90 m**.
  - Where impervious cover was low, 1 °C of cooling took about 60% canopy (10 m scale). Within 90 m, >75% canopy gave >2.5 °C.
  - In a grassy park, 0 to 40% canopy within 90 m gave about 0.3 °C; 40 to 80% gave about 0.8 °C more. Cooling grows non-linearly above about 40% canopy.
  - Hottest days (>30 °C): cooling was 0.2-0.6 °C larger.
  - Night: going from 0 to 100% canopy lowered the temperature by only 0.3-0.5 °C.
- **Souch & Souch 1993**, *J. Arboric.* 19(5):303-312 (Bloomington IN) [read, abstract]. Under-canopy air was cooler and more humid under every tree. The greatest cooling was **0.7-1.3 °C, in the early afternoon**. They found no consistent relation with LAI. Trees over grass cooled more than street trees. The abstract gives no humidity number.
- **Rahman, Moser, Gold, Rötzer & Pauleit 2018**, *Sci. Total Environ.* 633:100-111 (Munich) [read, abstract]. Air was measured at 1.5, 3 and 4.5 m under *Tilia* and *Robinia*. The outside-to-inside canopy difference fell from **1.8 to 1.3 °C (Tilia)** and from **1.5 to 0.5 °C (Robinia)** as days got hotter. The cooling was about 1 °C weaker at 1.5 m than up in the canopy.
- **Armson, Stringer & Ennos 2012**, *Urban For. Urban Green.* 11:245-255 (Manchester) [2nd, abstract as reproduced]. Tree shade cut globe temperature by 5-7 °C and surface maximum by up to 19 °C. Grass "had little effect upon local air or globe temperatures."
- **Wind, Heisler 1990**, *ASHRAE Trans.* 96(1):1389-1396 [read, abstract]. Wind was measured at 2 m in residential streets and compared with the airport. With no trees it was **22% lower** (buildings alone). At 77% tree cover it was **70% lower in summer** (65% in winter).
- **Not verified:**
  - Bowler et al. 2010 (*Landscape Urban Plan.* 97:147-155): I could not reach the "0.94 °C" park figure. A secondary summary says "about 1 °C" [2nd].
  - Shashua-Bar & Hoffman 2000 (*Energy Build.* 31:221-235; 11 wooded sites in Tel Aviv, 714 hourly observations) [read, summary]: the "2.8 K" did not appear in anything I could read.
  - Spronken-Smith & Oke 1998 and Grimmond: not obtained.
- **No VPD or vapour-pressure numbers under canopy** turned up. There is only Souch's qualitative "humidities are elevated."

### 3. Turf ET under shade

- **Litvak & Pataki 2016**, *J. Arid Environ.* 134:87-96 [read, abstract]. Chambers on 8 Los Angeles lawns (4 shaded). The model, as used in Litvak, Manago, Hogue & Pataki 2017 (*Water Resour. Res.*, doi:10.1002/2016WR020254) [read]: **k_mc = 0.90 (±0.09) - 0.35 (±0.13) x tree canopy fraction over the turf**. Plot ET ranged from 10% to over 110% of CIMIS ET0 because of different shading.
  - Full canopy gives k_mc 0.55, which is **61% of an open lawn**.
  - These are real trees, so any air cooling is included. The reduction is no larger than D&F's cloth would predict (D&F gives about 0.44 at L = 0.2).
  - Caveats: canopy *cover* is not light share, and the climate is semi-arid.
- **Cheary, Fontanier, Amgain & Harris** (Oklahoma State), *Golf Course Management* summary, Dec. 2020 [2nd, trade summary]. Shade cloth cut radiation by about 42%. ET of bermudagrass and zoysiagrass fell **37-55%**. The summary gives no air-temperature data.
- **I found no study that separates radiation from air temperature or VPD for turf under real trees.** Litvak, Bijoor & Pataki 2014 (*Ecohydrology* 7:1314-1330, "Adding trees to irrigated turfgrass lawns may be a water-saving measure…"): title only [2nd].

### 4. Sensitivity of FAO-56 ET0 to air temperature with vapour pressure held

The July day, computed with water/lib/et.js:

- **Inputs:** Tmax 28 °C, Tmin 16 °C (my assumption), RH 60% so ea = 1.68 kPa, u2 = 2 m/s, Rs = 26 MJ/m²/d, 42.5°N, 15 July, 200 m elevation.
- **Result:** ET0 = **5.36 mm/d**. The aerodynamic term is **1.65 mm, or 31%**, about the same as D&F's 0.3. That is a coincidence of this day: the share is 25% at u2 1.5 and 40% at u2 3.

| change, ea held | VPD | aerodynamic term | ET0 |
|---|---|---|---|
| whole day -1 °C | -15% | **-11.6%** | -4.8% |
| whole day -0.5 / -1.5 / -2 °C | | -5.8 / -17.5 / -23.4% | -2.4 / -7.3 / -9.7% |
| Tmax only -1 °C | | -8.0% | -3.0% |
| -1 °C with RH held instead | | | -2.7% |
| wind x0.78 / x0.5 | | -19% / -46% | -3.3% / -7.8% |

Irmak et al. 2006 (*J. Irrig. Drain. Eng.* 132:564-578) [2nd, abstract]: ET0 was most sensitive to VPD at every US site and not sensitive to Tmin. I did not read Goyal 2004 or Gong et al. 2006, so I give no numbers from them.

## SPECULATION (nothing below is measured on a lawn)

**1. Form.** Keep D&F's split, but let the advective part respond to the cell's air:

    ET_cell = Kc x ET0 x [ 0.7 x L  +  0.3 x A ],   A = aero(T - dT, ea, u) / aero(T, ea, u)

Here aero is the second term of FAO-56 eq. 6, recomputed with ea held. A rule of thumb for this climate is A ≈ 1 - 0.12 dT for whole-day cooling, or 1 - 0.08 dT for Tmax only.

**2. Drive dT by tree canopy, not by 1-L.**
- Building shade does not transpire, and both Ziter and Souch tie the cooling to canopy.
- Proposed: dT = dTmax x C30 x clr, where:
  - C30 is the lidar canopy fraction within 30 m of the cell;
  - clr = Rs/Rso, because the cooling is a sunny-afternoon effect;
  - dTmax defaults to **1.3 °C** (Ziter, 30 m), with a range of 0.7-1.5 °C (Souch 0.7-1.3; Ziter 10-90 m).
- Apply it to Tmax only, since night effects are a few tenths of a degree.
- This also cools *sunny* cells near trees, which the light share cannot do.

**3. Size on the July day, cell at L = 0.4 under a tree.**
- Today: 0.8 x 5.36 x 0.58 = **2.49 mm/d** (full sun 4.29).
- With a whole-day dT of 0.5 / 1 / 1.5 °C: **-0.07 / -0.15 / -0.22 mm/d (-3 / -6 / -9%)**. As Tmax-only cooling it is about two-thirds of that.
- Wind, not temperature, is the big lever. At canopy wind x0.5 (Heisler), the cell drops by about 0.59 mm/d (-24%) with no cooling at all.
- But D&F's 0.3 was measured at open-field wind, and a backyard's wind is already 22-70% below a grid or airport wind (Heisler) in *sun and shade alike*. That is a separate correction for the whole lawn, not a shade one.

**4. Double counting.**
- *With D&F:* none for air temperature. The cloths could not cool the field air, and the "ambient" was open-field air.
- *Opposite-sign issue, bigger than the cooling:* against the sunlight share the tool uses, D&F's own data give an intercept of about **0.41, not 0.3**. Full covers gave 42-46%. Part of the 0.3 vs 0.41 gap is the hot cloth's infrared, which a cool leaf canopy gives much less of. At L = 0.4, switching to 0.41 would *add* about 0.26 mm/d, which outweighs a 1 °C cooling (-0.15 mm/d).
- The only real-tree turf data (Litvak) show shade cutting ET *less* than D&F's cloth, not more. That is no sign of a missing cooling term, though it is from another climate and uses cover rather than light.
- The per-period scatter of D&F's own advective share (0.21-0.58) is wider than anything air cooling could add.

**Bottom line (speculation).** Shade's air cooling is real (about 0.5-1.5 °C on summer afternoons, more where canopy within 30-90 m exceeds about 40%). It is worth only **about 3-9% of a shaded cell's ET**, which is smaller than the uncertainty in the 0.3 itself and opposite in sign to the 0.3 vs 0.41 question. If it is built, it should come with the intercept and wind questions, not alone.
