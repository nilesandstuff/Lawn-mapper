# Water rising from a shallow water table into the roots: the methods, checked (2026-11-01)

A research agent for the water session. Question: how much water a shallow water table feeds up into a 10-30 cm lawn
root zone per day, as a function of the depth of the table below the roots and the soil survey's soil (texture class,
ksat_r). Tags: [read] = this agent opened the document and read the passage; [code] = read in a model's source code;
[digitized] = read off a printed graph by this agent (pixel scan of FAO's own PDF, tick marks calibrated); [arith] =
this agent's own arithmetic; [2nd] = from a search summary or a citing source, not opened; [recalled] = from memory, not
checked here. No number below is invented; every computed table can be re-run from the formulas given.

## Bottom line

- **AquaCrop's formula is the one to use** [read: FAO AquaCrop v7.1 reference manual, ch. 3, Eq. 3.7j-l, Tab. 3.7b]:
  `CR = exp((ln z - b) / a)`, CR in mm/day, z in metres, a < 0, so it is a power law `CR = z^(1/a) * e^(-b/a)`.
  a and b come from the soil's class (four classes of USDA textures) and its Ksat in mm/day. It is cheap (two logs and
  an exp per cell), keyless, and the only method of the three with published coefficients for every texture.
- **Units:** ksat_r (micrometres/s) x 86.4 = mm/day. The tool already converts ksat_r x 3.6 = mm/h (lib/soil.js);
  x 24 again gives mm/day [arith].
- **The answer is roughly proportional to Ksat** (d lnCR / d lnKsat = 0.75 sandy, 1.09 loamy, 1.05 sandy clayey, 1.18
  silty clayey at mid-range [arith]), and SSURGO's ksat_r often sits at or above the top of AquaCrop's class ranges.
  Fed raw survey Ksat, the formula gives large rises (loam at 9 um/s: 11 mm/day from 1 m below the roots). Clamp Ksat
  to the class range (AquaCrop v6 did; OSPy v7 does not), and see the clay warning in section 1.
- **Sanity check against FAO-24:** for the loams (sandy loam, loam, silt loam) the two agree in magnitude -- a few
  mm/day from 0.5 m, about 1 mm/day from 1 m, a few tenths from 1.5-2 m. They disagree for coarse sand (FAO-24's
  loamy sand gives almost nothing below 0.5 m; AquaCrop gives 13 mm/day at 0.5 m), for clay (FAO-24's clays reach
  about zero by 1 m; AquaCrop keeps 0.2-0.6 mm/day to 2 m), and for fine and very fine sandy loams (FAO-24 far
  higher at depth than anything AquaCrop gives at the Ksat values asked).
- **The daily supply is limited** by (i) how much room the root zone has below its "adjusted field capacity", (ii) a
  steep wetness factor (power 16) that shuts the rise off as the roots near that point, (iii) a conductivity factor
  in dry soil, and (iv) no rise on a day the root zone is draining. AquaCrop does all four [read + code]. Liu et al.
  (2006) also cap the rise at the transpiration demand, k x ETm [code: simET; 2nd for the paper itself].
- Nothing here has been checked against a measured rise under a lawn. The FAO-24 graph is for named Dutch soils
  (Rijtema's data [recalled]), not the soil survey's series.

## 1. AquaCrop (Raes, Steduto, Hsiao & Fereres; Janssens 2006 fits; UPFLOW, Raes & De Proost 2003)

Source opened: Raes D., Steduto P., Hsiao T.C., Fereres E. (2023). *AquaCrop Version 7.1 Reference Manual, Chapter 3:
Calculation procedures.* FAO, Rome. https://www.fao.org/3/BR248E/br248e.pdf, section 3.7.6 "Capillary rise", pp. 3-62
to 3-70 [read]. Code opened: AquaCrop-OSPy (the official Python port),
https://raw.githubusercontent.com/aquacropos/aquacrop/master/aquacrop/entities/soil.py (a, b and class logic) and
https://raw.githubusercontent.com/aquacropos/aquacrop/master/aquacrop/solution/capillary_rise.py (daily procedure) [code].
Raes & De Proost 2003 (UPFLOW) and Janssens 2006 were not opened: the manual cites them as the origin of the fits.

### The equation [read]

    CR = exp( (ln z - b) / a )                                     (Eq. 3.7j)

- CR: expected (maximum) capillary rise, mm/day.
- z: depth of the water table, m. In the manual's bare-soil plot (Fig. 3.7h) z is below the soil SURFACE; in the
  daily procedure it is the depth of the table below the NODE (centre) of each soil compartment (Eq. 3.7p ff.;
  OSPy evaluates `z_gw - zBotMid`, the table's depth below the centre of the bottom compartment) [read + code].
- a, b: soil parameters, from the class and Ksat:

| Class (manual's grouping of the 12 USDA textures) | Ksat range, mm/day | a (Eq. 3.7k) | b (Eq. 3.7l) |
|---|---|---|---|
| I. Sandy soils: sand, loamy sand, sandy loam | 200 - 2000 | -0.3112 - 1e-5 Ksat | -1.4936 + 0.2416 ln(Ksat) |
| II. Loamy soils: loam, silt loam, silt | 100 - 750 | -0.4986 + 9e-5 Ksat | -2.1320 + 0.4778 ln(Ksat) |
| III. Sandy clayey soils: sandy clay, sandy clay loam, clay loam | 5 - 150 | -0.5677 - 4e-5 Ksat | -3.7189 + 0.5922 ln(Ksat) |
| IV. Silty clayey soils: silty clay loam, silty clay, clay | 1 - 150 | -0.6366 + 8e-4 Ksat | -1.9165 + 0.7063 ln(Ksat) |

[read: Tab. 3.7b, "Janssens, 2006"; R^2 of the a and b fits "always > 0.96"; the same numbers in OSPy soil.py [code].]
Units checked: ln of Ksat in mm/day, ln of z in metres, CR out in mm/day. Note the silty clayey a uses 8e-4 (ten
times the others' scale) -- that is in both the manual and the code, not a typo here.

How a and b were made [read]: one representative water retention curve per class; K-h curves generated across each
class's Ksat range; capillary rise simulated with UPFLOW (steady state) for many table depths; a and b fitted against
Ksat. So the formula is a fit to steady-state Darcy simulations, not to field measurements.

How AquaCrop picks the class [read: Tab. 3.7c] from water contents (vol %), when no texture is given:

| Class | Saturation | Field capacity | Wilting point |
|---|---|---|---|
| I sandy | 32-51 | 9-28 | 4-15 |
| II loamy | 42-55 | 23-42 | 6-20 |
| III sandy clayey | 40-53 | 25-45 | 16-34 |
| IV silty clayey | 49-58 | 40-58 | 20-42 |

OSPy v7 turns this into a decision tree [code]: if th_s > 0.55 -> IV; else if th_wp >= 0.20 -> IV when th_s >= 0.49
and th_fc >= 0.40, otherwise III; else if th_fc < 0.23 -> I; else if th_wp > 0.16 and Ksat < 100 -> III; else if
th_wp < 0.06 and th_fc < 0.28 and Ksat > 750 -> I; else II. For the lawn tool, the soil survey's texture class name
maps straight onto Tab. 3.7b's grouping and is simpler.

Out-of-range Ksat [code]: OSPy v6 (left in the source, commented out) CLAMPED Ksat to the class range before computing
a and b; OSPy v7 does not clamp. OSPy also caps CRmax at 99 mm/day and sets it to 0 when the table is 4 m or more below
the compartment centre (`(z_gw - zBotMid) < 4`) [code; the 99 and 4 m were not found in the manual text].

AquaCrop's own default Ksat per texture (OSPy soil.py [code], mm/day): sand 3000, loamy sand 2200, sandy loam 1200,
loam 500, silt loam 575, silt 500, sandy clay loam 225, clay loam 125, sandy clay 35, silty clay loam 150, silty clay
100, clay 35. The manual's Fig. 3.7h uses "typical" 500 (sandy), 250 (loamy), 100 (sandy clayey), 25 (silty clayey)
[read].

### Warnings found while computing [arith]

- **Class IV at high Ksat runs away.** Clay with Ksat 121 mm/day (ksat_r 1.4 um/s, common for a structured clay in
  SSURGO) gives 15 mm/day from 1 m and 4.2 from 2 m; silty clay loam at AquaCrop's own default 150 gives 23 mm/day from
  1 m. A clay loam (class III) at the same 121 mm/day gives 0.22 mm/day from 1 m: a factor of 70 across a class
  boundary. Survey Ksat in clays reflects cracks and pores that carry water down, not up. Suggestion (speculation,
  the session to decide): cap Ksat for this purpose at the class's lower-middle values (e.g. 25-35 mm/day for class
  IV, as the manual's Fig. 3.7h and AquaCrop's default clay do), or use AquaCrop's default Ksat by texture rather
  than ksat_r.
- **Very shallow tables blow up.** The power law has no ceiling: loamy sand (800 mm/day) gives 113 mm/day at 0.25 m.
  OSPy's 99 mm/day cap is no real limit; the room-to-FCadj and wetness limits below (section 4) are what bound it.
- **Silt loam at 50 mm/day is below class II's range.** Raw it gives half the clamped value (2.4 vs 4.7 mm/day at 0.5 m).

## 2. FAO-24 Fig. 18 (Doorenbos & Pruitt 1977), digitized

Source opened: Doorenbos J., Pruitt W.O. (1977, reprinted 1992). *Guidelines for predicting crop water requirements.*
FAO Irrigation and Drainage Paper 24 (revised). FAO, Rome. https://www.fao.org/3/s8376e/s8376e.pdf, p. 75-76 (PDF page
86), "(ii) Groundwater contribution (Ge)" and "Fig. 18 Contribution of groundwater to moist root zone in mm/day" [read].

Text [read]: "The contribution from the groundwater table is determined by its depth below the root zone, the capillary
properties of the soil and the soil water content in the root zone. For heavy soils, distance of movement is high and
the rate low; for coarse textured soils the distance of movement is small and the rate high." The curves are "for
different depths of groundwater below the root zone and various soil types assuming the root zone is relatively
moist". Worked example: sandy loam, table 80 cm below the roots -> "some 1.5 mm/day". The page names no source for the
curves; they are usually credited to Rijtema (1965/1969, Dutch soils) [recalled], and Rijtema is listed among FAO-24's
consultants [2nd]. The y axis is depth BELOW THE ROOT ZONE, cm, 0-450; the x axis upward flow, 0-6 mm/day.

Digitized [digitized: rendered at 200 dpi, axes calibrated on the tick marks 0/100/200/300/400 cm and 0-6 mm/day,
dark-pixel crossings read at fixed depths and rates, curves assigned by their labels and right-hand ends; read error
about +-0.2 mm/day or +-5 cm; this reading gives 2.0 mm/day where FAO's own example says 1.5 for sandy loam at 80 cm]:

| FAO-24 curve | 0.25 m | 0.5 m | 0.75 m | 1.0 m | 1.5 m | 2.0 m | 3.0 m | 4.0 m |
|---|---|---|---|---|---|---|---|---|
| 1 sticky clay | 1.2 | 0.46 | 0.15 | <0.1 | <0.1 | <0.1 | - | - |
| 2 loamy sand | 1.9 | 0.46 | 0.15 | <0.1 | <0.1 | <0.1 | - | - |
| 3 clay | 4.0 | 0.75 | <0.2 | <0.2 | <0.2 | <0.2 | - | - |
| 4 peat | >5.5 | 1.2 | 0.43 | <0.2 | <0.2 | <0.2 | - | - |
| 5 clay | >5.5 | 2.1 | 0.88 | 0.14 | <0.1 | <0.1 | - | - |
| 6 humus loamy sand | >5.5 | 5.0 | 1.1 | 0.58 | <0.1 | <0.1 | - | - |
| 7 sandy loam | >5.5 | 4.3 | 2.3 | 1.4 | 0.46 | <0.2 | - | - |
| 8 fine sandy loam | >5.5 | >5.5 | >5.5 | 4.0 | 1.1 | 0.42 | <0.1 | - |
| 9 very fine sandy loam | >6 | >6 | >6 | >6 | >6 | 5.6 | 3.1 | 2.1 |

"<0.1" / "<0.2": the curve has ended (each starts at 0.1-0.25 mm/day; FAO draws nothing below). ">5.5": off the
graph to the right. The raw points (rate mm/day, depth cm), for re-use:

    1 sticky clay      (0.1,80)(0.3,58)(0.5,48)(0.75,38)(1,28)(1.5,19)(3,12)(4,10)(5,9)
    2 loamy sand       (0.1,80)(0.3,58)(0.5,48)(0.75,38)(1,34)(1.5,27)(3,19)(4,17)(5,15)
    3 clay             (0.2,73)(0.3,67)(0.5,58)(0.75,50)(1,44)(1.5,35)(3,27)(4,25)(5,22)
    4 peat             (0.2,90)(0.3,82)(0.5,71)(0.75,61)(1,54)(1.5,43)(3,34)(4,31)(5,28)
    5 clay             (0.1,102)(0.2,97)(0.3,93)(0.5,86)(0.75,78)(1,72)(1.5,61)(2,51)(3,42)(4,38)(5,34)
    6 humus loamy sand (0.1,133)(0.2,127)(0.3,119)(0.5,104)(0.75,91)(1,79)(1.5,65)(2,61)(3,55)(4,52)(5,50)
    7 sandy loam       (0.25,175)(0.3,168)(0.5,145)(0.75,127)(1,114)(1.5,95)(2,81)(3,62)(4,52)(5,45)
    8 fine sandy loam  (0.1,249)(0.2,233)(0.3,215)(0.5,191)(0.75,172)(1,155)(1.5,137)(2,127)(3,108)(4,100)(5,95)
    9 v. fine s. loam  (2,421)(2.5,348)(3,304)(3.5,277)(4,255)(4.5,235)(5,218)(5.5,203)(6,190)

Curves 1 and 2 overlap below 0.75 mm/day and could not be separated there.

Same page, Table 31 note [read]: minimum water-table depth for maximum yield "for sand, rooting depth + 20 cm; for
clay, rooting depth + 40 cm; for loam, rooting depth + 80 cm" -- the capillary fringe; relevant to when the table
drowns the roots rather than feeds them.

A physics cross-check for one soil [read]: Tanji K.K., Kielen N.C. (2002). *Agricultural drainage water management in
arid and semi-arid areas.* FAO Irrigation and Drainage Paper 61, Annex 5 "Capillary rise",
https://www.fao.org/4/y4263e/y4263e0i.htm, Table A5.5: steady-state Darcy profiles for a Staring-series silty subsoil
(O8, Van Genuchten parameters from Woesten et al. 2001). Height above the table at which the suction reaches 400 cm
(a fairly dry root zone): 50 cm for 10 mm/day, 59 cm for 7.5, 74 cm for 5, 105 cm for 2.5, 158 cm for 1 mm/day.
That is, a silty soil can deliver about 5 mm/day from 0.75 m and 1 mm/day from 1.6 m -- between FAO-24's sandy loam
and fine sandy loam, and above AquaCrop's silt loam at 50 mm/day (1.05 mm/day at 0.75 m) [arith comparison].

Doorenbos & Pruitt's quoted range elsewhere, "about 2 to 6 mm per day for water-table depths of 2 to 4 m below the
root zone" [2nd, a citing paper on core.ac.uk; not found in the FAO-24 text read here, and it matches only curve 9].

## 3. Liu, Pereira & Fernando (2006): the parametric functions in ISAREG / SIMDualKc

Paper: Liu Y., Pereira L.S., Fernando R.M. (2006). Fluxes through the bottom boundary of the root zone in silty soils:
Parametric approaches to estimate groundwater contribution and percolation. *Agricultural Water Management* 84(1-2):
27-40. Paywalled; NOT opened. Abstract [2nd, via https://econpapers.repec.org/RePEc:eee:agiwat:v:84:y:2006:i:1-2:p:27-40
search summary]: a silty soil in the North China Plain; parametric functions fitted to the WAVE model; validated against
soil water (average relative error 1.38%); three-month upward flux 27 mm (ISAREG) vs 31 mm (WAVE).

The equations, from the CRAN package simET 1.0.5 (Liu M., 2026), R/calculate_soil.R, function cal_capillaryRise, which
cites the paper [code: https://cran.r-project.org/src/contrib/simET_1.0.5.tar.gz]:

    Wc  = a1 * Dw^b1                         critical storage, mm   (no rise above it)
    Ws  = a2 * Dw^b2  (Dw <= 3 m), else 240  steady storage, mm     (full rise below it)
    Dwc = a3 * ETm + b3  (ETm <= 4), else 1.4 m                     critical table depth
    k   = 1 - exp(-0.6 LAI)  (ETm <= 4), else 3.8 / ETm             share of ETm that is transpiration
    CRmax = k * ETm          if Dw <= Dwc   (the table is shallow enough to meet the whole transpiration demand)
          = a4 * Dw^b4       if Dw >  Dwc
    CR = CRmax                          if Wa < Ws
       = CRmax * (Wc - Wa) / (Wc - Ws)  if Ws <= Wa <= Wc
       = 0                              if Wa > Wc

Dw in m, ETm (= ETc) and CR in mm/day, Wa the actual root-zone storage in mm. simET's own note: in the paper Dw is the
table's depth from the soil SURFACE; simET uses depth below the roots as a package convention [code comment].

Coefficients [code comments + read in Wu et al. 2015]: defaults b1 = -0.17, b2 = -0.27, a3 = -1.3; "b3: 6.7 for clay
and silty clay loam soils, decreasing to 6.2 for loamy sands"; "a4: 4.6 for silty loam and silty clay loam soils,
decreasing to 3 for loamy sands and probably for sticky clay soils (Liu et al., 2006)"; "b4: -0.65 for silty loam
soils and decreasing to -2.5 for loamy sand soils". a1 = storage to the maximum root depth at field capacity (mm), a2 =
storage above the midpoint of field capacity and wilting point (mm) -- both scale with root depth.
One full applied set [read]: Wu Y., Liu T., Paredes P., Duan L., Pereira L.S. (2015). Water use by a groundwater
dependent maize in a semi-arid region of Inner Mongolia: Evapotranspiration partitioning and capillary rise. *Agric.
Water Manage.* 152: 222-232, Table 5, https://repositorio.ulisboa.pt/server/api/core/bitstreams/ebfdf164-e1f5-4878-b26b-5c438a6dee54/content
-- a sandy loam, initial a1 = 220, b1 = -0.17, a2 = 160, b2 = -0.27, a3 = -1.3, b3 = 6.2, a4 = 3.0, b4 = -2.5; calibrated
a1 = 320, a2 = 270 (the rest unchanged). Wu et al. say Liu et al. proposed "sets of parameter values for silty, silt
loam and sandy loam soils ... as default values to initiate the parameters' calibration", and that capillary rise
"does not contribute to soil evaporation but to roots extraction only" in this scheme [read].

CRmax = a4 Dw^b4 [arith]: silt loam (4.6, -0.65) 11.3 / 7.2 / 5.6 / 4.6 / 3.5 / 2.9 mm/day at 0.25 / 0.5 / 0.75 / 1 /
1.5 / 2 m; loamy sand (3.0, -2.5) 96 / 17 / 6.2 / 3.0 / 1.1 / 0.53. But below Dwc the rise is k ETm, and Dwc =
-1.3 ETm + 6.2..6.7 is 4.9-5.4 m at ETm 1, 2.3-2.8 m at 3, 1.0-1.5 m at 4 mm/day: for a silty soil, any table within
a couple of metres meets the whole transpiration demand.

Verdict for the lawn: the structure (an ET cap and a linear taper with storage) is useful; the coefficients are for
one silty soil and maize-depth root zones (a1, a2 of 200-300 mm against a lawn's 20-60 mm of TAW), have to be
calibrated, and only three textures exist. Not recommended as the main formula.

## 4. How the actual daily supply is limited

### AquaCrop [read: manual pp. 3-65 to 3-70; code: capillary_rise.py]

1. **Adjusted field capacity.** Over a shallow table the soil holds more than FC at equilibrium (Eq. 3.7m-o):

       FCadj_i = FC + (SAT - FC) / x^2 * (x - z_i)^2      for z_i <= x   (z_i: height of the node above the table, m)
       x = 10^(2 + 0.3 (FC% - 10) / 20) / 100             (FC% clamped 10-30: x = 1.00 m at 10%, 1.19 at 15,
                                                            1.41 at 20, 1.68 at 25, 2.00 m at 30%)

   Drainage stops at FCadj, and capillary rise can only fill up to FCadj. For a lawn this matters as much as the rise
   itself: a table 0.5 m under a loam's roots (FC 30%, x = 2 m) raises the "full" point by (SAT-FC)(1.5/2)^2 = 0.56
   of the gap to saturation [arith].

2. **Room.** `Wstored_i = 1000 (FCadj_i - theta_i) dz_i`, at most `fCR_i * CRmax_i`; the remainder carries up to the
   next compartment, never more than that compartment's own CRmax (the most restrictive layer limits the flux).

3. **Driving force** (relative wetness w = (theta - PWP) / (FCadj - PWP)): `fCR = 1 - w^x`, x = 16 by default
   (adjustable 5-30; OSPy `fshape_cr=16`). fCR = 1.00 at w 0.5, 0.97 at 0.8, 0.82 at 0.9, 0.56 at 0.95, 0.28 at 0.98,
   0.15 at 0.99 [arith]: full rise until the roots are quite wet, then a sharp shut-off.

4. **Conductivity in dry soil.** Below theta_thr = (PWP + FC) / 2 the rise falls linearly to 0 at PWP. OSPy multiplies
   `Krel = (theta - PWP) / (theta_thr - PWP)` (1 above theta_thr) with fCR: `dthMax = Krel * fCR * MaxCR / (1000 dz)`.

5. **No rise while draining.** Upward flow stops at the first compartment that drained that day; if the bottom one is
   draining (theta > FCadj) none starts. After a soaking, rise only resumes once ET has pulled the roots below FCadj.

AquaCrop does NOT cap the rise at the day's ET explicitly; the room-to-FCadj limit does it over time, because rise can
only replace what ET (or drainage) took. The manual's UPFLOW background assumes steady state, under which capillary
rise "can never exceed the evapotranspiration demand" [2nd, search summary of the UPFLOW manual].

### FAO-24 and Liu

FAO-24's curves are for "a relatively moist" root zone [read]: they are a supply ceiling, not what arrives when the
roots are already full. Liu et al. cap at k ETm when the table is shallow and taper linearly from Ws to Wc [code].

## 5. Sanity check: the AquaCrop formula at the Ksat values asked [arith]

z = depth of the table below the bottom of the root zone (the depth FAO-24 uses). mm/day.

| Soil (class, Ksat mm/day) | a | b | 0.25 m | 0.5 m | 1.0 m | 1.5 m | 2.0 m |
|---|---|---|---|---|---|---|---|
| loamy sand (I, 800) | -0.3192 | 0.1214 | 113 | 12.8 | 1.46 | 0.41 | 0.17 |
| sandy loam (I, 300) | -0.3142 | -0.1156 | 57 | 6.3 | 0.69 | 0.19 | 0.08 |
| loam (II, 100) | -0.4896 | 0.0684 | 19.5 | 4.7 | 1.15 | 0.50 | 0.28 |
| silt loam (II, 50, raw, below range) | -0.4941 | -0.2628 | 9.7 | 2.4 | 0.59 | 0.26 | 0.14 |
| silt loam (II, clamped to 100) | -0.4896 | 0.0684 | 19.5 | 4.7 | 1.15 | 0.50 | 0.28 |
| clay (IV, 10) | -0.6286 | -0.2902 | 5.7 | 1.9 | 0.63 | 0.33 | 0.21 |

Against FAO-24 at the same depths below the roots (section 2):

| | 0.5 m | 1.0 m | 1.5 m | 2.0 m |
|---|---|---|---|---|
| FAO-24 loamy sand / humus loamy sand | 0.46 / 5.0 | <0.1 / 0.58 | <0.1 | <0.1 |
| FAO-24 sandy loam / fine sandy loam | 4.3 / >5.5 | 1.4 / 4.0 | 0.46 / 1.1 | <0.2 / 0.42 |
| FAO-24 clays (curves 3, 5) / sticky clay | 0.75-2.1 / 0.46 | <0.2 / <0.1 | <0.1 | <0.1 |

Agreement: same order for sandy loam, loam and silt loam from 0.5 to 1.5 m (AquaCrop 0.5-6 mm/day; FAO-24 0.5-5).
AquaCrop falls off faster with depth for sandy soils (power 3.1-3.2) than the loams (2.0) and clays (1.6) -- the
right ordering ("heavy soils, distance high, rate low") -- but its clay tail (0.2-0.6 mm/day at 1-2 m) is longer than
FAO-24's clays, and its loamy sand at 800 mm/day is far higher near the roots than FAO-24's loamy sand (whose curve is
nearly the sticky clay's). FAO-24 has nothing below 0.1 mm/day; AquaCrop's tenths of a mm at 2 m are at most
2-8 mm a month and hardly matter to a lawn. The very fine sandy loam (5.6 mm/day from 2 m) has no AquaCrop analogue.

The same formula at other Ksat inputs, clamped to the class range (mm/day at 0.25 / 0.5 / 1.0 / 1.5 / 2.0 m) [arith]:

| Input | Ksat mm/day | 0.25 | 0.5 | 1.0 | 1.5 | 2.0 |
|---|---|---|---|---|---|---|
| lib/soil.js preset sand (210 mm/h) | 5040 -> 2000 | 185 | 22.8 | 2.81 | 0.83 | 0.35 |
| preset sandy loam (25.9 mm/h) | 622 | 95 | 10.7 | 1.21 | 0.34 | 0.14 |
| preset loam (13.2 mm/h) | 317 | 71 | 16.3 | 3.73 | 1.58 | 0.85 |
| preset silt loam (6.8 mm/h) | 163 | 33 | 7.8 | 1.87 | 0.81 | 0.45 |
| preset clay loam (2.3 mm/h, class III) | 55 | 1.1 | 0.32 | 0.09 | 0.05 | 0.03 |
| preset heavy clay (0.6 mm/h, class IV) | 14 | 8.7 | 2.9 | 0.95 | 0.50 | 0.31 |
| AquaCrop default loam / silt loam | 500 / 575 | 135 / 168 | 29 / 36 | 6.3 / 7.6 | 2.6 / 3.1 | 1.4 / 1.6 |
| survey-like loam, ksat_r 9 um/s | 778 -> 750 | 272 | 55 | 10.9 | 4.3 | 2.2 |
| survey-like clay, ksat_r 1.4 um/s | 121 | 199 | 55 | 15.2 | 7.2 | 4.2 |

The last two rows are well above every FAO-24 loam and clay curve: raw survey Ksat over-drives the formula.

## Recommendation (the agent's; the session to decide)

For each cell, each day, after ET and drainage:

1. z = water-table depth below the bottom of the root zone, m (the balance's month-by-month table, lib/groundwater.js
   / lib/soil.js). z <= 0: the roots are in the table -- no rise, the cell is wet (existing tableBlockCm logic).
   z >= 4 m: no rise (OSPy). Floor z at about 0.05 m to keep the power law finite.
2. Class from the soil survey's texture class of the layer(s) between the roots and the table, by Tab. 3.7b. Ksat =
   the smallest ksat_r of those layers x 86.4 (mm/day), clamped to the class range (v6 rule); for class IV consider a
   lower cap (section 1 warning). If the texture is missing, AquaCrop's own water-content tree (section 1).
3. CRmax = exp((ln z - b) / a), capped at 99 mm/day.
4. If the bucket drained today (above FCadj), CR = 0. Otherwise, with w = relative wetness against FCadj and Krel as in
   section 4: `CR = min( Krel * (1 - w^16) * CRmax,  1000 (FCadj - theta) Zr )`. In FAO-56 depletion terms
   (TAWadj = 1000 (FCadj - WP) Zr, w = 1 - Dr / TAWadj): `CR = min(Krel * (1 - w^16) * CRmax, Dr)`, then Dr -= CR.
5. Optionally also cap at the day's ETc (UPFLOW's steady-state assumption; Liu's k ETm), so a long-dry bucket over a
   table is not refilled in a single day -- a judgement, not in AquaCrop.
6. Use FCadj (Eq. 3.7m-o, z_i = height of the root-zone middle above the table) as the bucket's "full" point when the
   table is within x of the roots: it changes drainage and TAW, and is the cheapest part to add.
7. Treat FAO-24's curves as the sanity envelope in tests (e.g. loam at 1 m: 0.5-5 mm/day), not as the model.

What would make this true to life: one measured comparison -- a lawn over a known shallow table (soil survey wet
months, Wellogic levels) whose soil moisture is logged through a dry spell -- to see whether the roots really stay wet.
