# Lawn water balance: parameter reference (sourced)

Compiled 2026-10-18 for the lawn watering tool. Every number below comes with its source.
Tags: **[read]** means I read the number in the primary document (or an official copy of it).
**[2nd]** means it came from a secondary copy or an abstract only. **[unverified]** means I know
it from memory or it is commonly quoted, but I could not confirm it in a source during this pass;
check it before you hard-code it. Unit helpers: 1 in = 25.4 mm; 1 in/h = 25.4 mm/h; 1 cm/h = 10 mm/h.

---

## 1. Hardscape: concrete, asphalt, roofs

### 1a. Runoff from pavement

| Parameter | Value | Source |
|---|---|---|
| SCS CN, paved parking lots, roofs, driveways (all HSG) | **98** | USDA-SCS (1986) TR-55 *Urban Hydrology for Small Watersheds*, 2nd ed., Table 2-2a [read, from a UMich copy of the table: https://ehs.umich.edu/wp-content/uploads/2017/01/TR-55_curve_numbers.pdf] |
| Same, "in some warmer climates" | **95** | Rossman (2015) *SWMM 5.1 User's Manual*, EPA/600/R-14/413b, App. A.4 footnote 5 [read] https://www.epa.gov/sites/default/files/2019-02/documents/epaswmm5_1_manual_master_8-2-15.pdf |
| Depression storage, impervious surfaces | **0.05–0.10 in (1.3–2.5 mm)** | ASCE (1992) *Design & Construction of Urban Stormwater Management Systems*, as tabulated in the SWMM 5.1 manual, App. A.5 [read] |
| Depression storage, lawns | **0.10–0.20 in (2.5–5 mm)** | same [read] |
| Measured water holding of brick, asphalt, cement and concrete | **0.4–1 mm (mean ≈ 0.56 mm)**; asphalt held the most | Zhou et al. (2021) "Mechanisms and empirical modeling of evaporation from hardened surfaces in urban areas", *IJERPH* 18:1790 [read, abstract and results] https://pmc.ncbi.nlm.nih.gov/articles/PMC7917919/ |
| Initial loss for impervious surfaces (Chinese design guide) | **H0 = 2 mm** (rain below this all evaporates) | quoted in Zhou et al. (2021) from *Technical Guide for Sponge City Construction* [read, secondhand] |
| Rational-method C, asphalt streets | **0.70–0.95** | FHWA (2009, rev. 2013) HEC-22 *Urban Drainage Design Manual*, 3rd ed., Table 3-1 [read] https://www.fhwa.dot.gov/engineering/hydraulics/pubs/10009/10009.pdf (the 4th ed., 2024, supersedes it; I did not check whether the table changed) |
| C, concrete | **0.80–0.95** | same [read] |
| C, brick | 0.70–0.85 | same [read] |
| C, drives and walks | **0.75–0.85** | same [read] |
| C, roofs | **0.75–0.95** | same [read] |
| C, lawns on sandy soil: flat (2%), average (2–7%), steep (>7%) | 0.05–0.10, 0.10–0.15, 0.15–0.20 | same [read] |
| C, lawns on heavy soil: flat, average, steep | 0.13–0.17, 0.18–0.22, 0.25–0.35 | same [read] |

The sources disagree. The ASCE table puts impervious depression storage at 1.3–2.5 mm, while
the measured values (Zhou 2021) are 0.4–1 mm. Rational C values are peak-flow design
coefficients for design storms ("higher values for steep slopes and longer return periods",
HEC-22 footnote). They are not daily volume ratios. For a daily balance, the more defensible
approach is an initial loss (≈0.5–2 mm) followed by about 95–100% runoff.

### 1b. Evaporation from pavement after rain
- Commonly assumed: whatever sits in depression storage evaporates, up to its capacity H.
  Zhou et al. (2021) model it exactly that way (E = min(P + stored, H)) and find that rainfall
  interception accounts for >70% of hardened-surface evaporation [read]. Per event, then, the
  evaporated depth is roughly the depression-storage depth (≈0.5–2 mm), provided the gap before
  the next rain is long enough.
- Ramamurthy & Bou-Zeid (2014) "Contribution of impervious surfaces to urban evaporation",
  *Water Resour. Res.* 50:2889–2902: impervious evaporation was intermittent, **peaked in the
  48 h after rain**, and supplied **~18% of total latent heat flux over one wet 10-day period**
  [2nd, abstract].
- Ramier, Berthier & Andrieu: over 38 months on two Nantes streets, **infiltration plus
  evaporation were 20–30% of rainfall** (Ramier et al. 2006, *Water Sci. Technol.*). A 2015
  Cerema slide deck puts **evaporation alone at ≈19–20%** of annual rain [2nd]. Ramier et al.
  (2011) *Hydrol. Process.* 25:2161–2178 is the long-term paper. Caveat: on real streets some
  "loss" is seepage through joints and cracks, not evaporation.
- Zhou (2021): hardened-surface evaporation was **16–29% of total urban ET** in five Chinese
  cities, or 40–210 mm/yr [read].

### 1c. Pavement next to turf: edge, advection and oasis effects
| Finding | Number | Source |
|---|---|---|
| Irrigated turf block (70 × 45 m) inside a fallow desert field, Tucson | Edge facing **afternoon** advection: ET **+10.8% (summer), +8.2% (winter)** vs field centre. Morning/evening edges: **+6.8% / +4.7%** | Brown, P.W. (2005) "Evapotranspiration of turfgrass located adjacent to a fallow desert soil: a quantitative assessment of the 'edge effect'", *World Water Congress 2005*, ASCE, doi:10.1061/40792(173)529 [2nd, abstract] |
| Reach of the effect | Microlysimeters **7 m in from the edge were within ~5% of centre ET** ("diminishes rapidly with distance") | same |
| Irrigated park, Sacramento | Greatest evaporative enhancement at the **upwind edge**. The microscale leading-edge effect is confined to **~20 m of fetch**, with an oasis effect beyond it. Park evaporation was roughly 3× the suburban area and >1.3× an irrigated rural grass site (the abstract's wording is ambiguous) | Spronken-Smith, Oke & Lowry (2000) "Advection and the surface energy balance across an irrigated urban park", *Int. J. Climatol.* 20:1033–1047 [2nd, abstract] https://blogs.ubc.ca/toke/?p=269 |
| Trees over asphalt vs over turf | Asphalt surface **20–25 °C hotter** in the afternoon. Flowering pear (humid site) lost **~⅓ more water** over asphalt; ash and maple (arid site) lost **equal or less** because of stomatal closure | Kjelgren & Montague (1998) "Urban tree transpiration over turf and asphalt surfaces", *Atmos. Environ.* 32:35–41 [2nd, abstract]. These are trees, not turf |
| Landscape microclimate factor | Kmc **0.5–1.4**: low (shaded, sheltered) 0.5–0.9; average (open, park-like) 1.0; **high 1.1–1.4** ("medians, parking lots, adjacent to south- or southwest-facing walls", reflective glass). Worked example: next to a SW wall 1.2; reflective glass plus wind 1.4; parking-lot trees 1.2 | Costello, Matheny, Clark & Jones (2000) *A Guide to Estimating Irrigation Water Needs of Landscape Plantings in California* (WUCOLS III), UCCE / Calif. DWR, pp. 18–21 [read] |
| Same guide | "Experiments in Seattle … a planting in a paved area can have **50% greater water loss** than … in a park setting. Other studies in California found plants in **shaded areas lost 50% less water**." | same, p. 17 [read]. No primary citation is given for either figure |

No study I found measures turf a few metres from a driveway or patio by orientation. The
closest real numbers are Brown's +5–11% at the edge, decaying to <5% within 7 m. WUCOLS's
1.1–1.4 is expert judgement for plantings surrounded by hardscape, not a measured turf edge. A
defensible model is an ET multiplier of about 1.05–1.10 within ~2–5 m of hardscape on the
downwind or afternoon side (south and west in the northern hemisphere), tapering to 1.0 by
about 7 m.

### 1d. Roofs
| Parameter | Value | Source |
|---|---|---|
| CN, roofs | 98 | TR-55 Table 2-2a [read] |
| Rational C, roofs | 0.75–0.95 | HEC-22 Table 3-1 [read] |
| Rainwater-harvesting collection efficiency | "Most installers assume **75–90%**". The worked example uses **85%**. Losses come from first flush, evaporation, gutter splash-out and overflow | Texas Water Development Board (2005) *Texas Manual on Rainwater Harvesting*, 3rd ed., p. 29–31 [read] https://www.twdb.texas.gov/publications/brochures/conservation/doc/RainwaterHarvestingManual_3rdedition.pdf |
| First-flush diversion | **10 gal per 1,000 ft² of roof** (= **0.41 mm**) | same, p. 17 [read] |
| Initial loss, pitched roofs (UK Wallingford/WASSP practice) | **0.4 mm** where data are scarce | Innovyze InfoWorks ICM help, "Depression Storage (Initial Losses) Model" [2nd] https://help2.innovyze.com/infoworksicm/Content/HTML/ICM_ILCM/Depression_storage_initial_losse.htm |
| Asphalt shingles specifically | **No authoritative measured value found.** Rainwater guides use about 0.85–0.9 without data | — |

Model suggestion: roof initial loss 0.5 mm, then C ≈ 0.9 to the downspout outlet, routed to
the cell where the downspout discharges.

---

## 2. Turf: root zone, MAD, application limits

### 2a. Root depth
| Source | Cool-season | Warm-season |
|---|---|---|
| FAO-56 (Allen et al. 1998) Table 22, *maximum* effective rooting depth Zr [read] http://www.fao.org/4/x0490e/x0490e0e.htm | **0.5–1.0 m** (bluegrass, ryegrass, fescue) | **0.5–1.0 m** (bermuda, buffalo, St Augustine) |
| FAO-56 Table 22 footnote 5 [read] | "Grasses are variable in rooting depth. Some root below 1.2 m while others have shallow rooting depths. The deeper rooting depths … represent conditions where careful water management is practiced with higher depletion between irrigations." | |
| IA (2008) SWAT smart-controller test protocol, virtual landscapes, as tabulated in Dukes & Davis (2009) UF/EPA report [read] https://www.epa.gov/sites/production/files/2017-02/documents/ws-background-irr-controllers-university-of-fl-report.pdf | **Tall fescue: 10 in (254 mm)**, loam | **Bermuda: 8.1 in (206 mm)**, silty clay |
| Crookston (2014) "Conserve water by irrigating deeply and less frequently", IA Technical Paper (Northern Water, CO) [read] | **Kentucky bluegrass Zr = 12 in (305 mm)**, p = 0.4 (modelled) | — |
| Upham et al. (2008) *Watering Established Lawns*, K-State MF-2803 [read] https://bookstore.ksre.ksu.edu/download/watering-established-lawns_MF2803 | "Moisten the soil to a depth of **6 to 8 inches**" (150–200 mm), which takes **1–1.5 in of water**. Roots are deeper in spring and fall than in midsummer | — |
| Qian, Fry & Upham (1997) *Crop Sci.* 37:905–910 [2nd, abstract] | Tall fescue had 33–60% deeper max rooting (greenhouse) and extracted >50% more water at 90 cm than bermuda or zoysia | |

**FAO's 0.5–1.0 m is a maximum, not a typical lawn value.** Practitioner and test-protocol
values for an established lawn are **0.15–0.30 m**. On a 4-inch (100 mm) imported topsoil over
compacted native soil, the effective depth may be ~0.10–0.20 m. I found no measurement for
that case; it is my inference.

### 2b. MAD / FAO p
| Source | Cool | Warm |
|---|---|---|
| FAO-56 Table 22 [read] | **p = 0.40** | **p = 0.50** |
| FAO-56 ET adjustment [read] | p = p_table + 0.04 (5 − ETc), limited to 0.1 ≤ p ≤ 0.8, ETc in mm/d. Reduce p by 5–10% for clays and raise it 5–10% for sands | |
| IA (2008) SWAT protocol [read, via Dukes & Davis] | tall fescue **50%** | bermuda **40%** |
| Florida simulation (St Augustine) | — | 0.5 (IA 2007 technical paper, [2nd]) |
| Crookston (2014) [read] | p 0.4; modelled MAD 0.51–0.80 under managed deficit | |

### 2c. Maximum application rate by texture and slope (cycle-and-soak)
"Maximum Precipitation Rates for Slopes" (USDA/NRCS, reproduced by the irrigation industry),
in in/h. Source: Hunter Industries, *Irrigation Notes: Scheduling Irrigation*, Table 3 [read]
https://redesign.hunterindustries.com/sites/default/files/tech_irrigation_notes_scheduling_irrigation.pdf.
Rain Bird SpecNews cites the same USDA chart (2.00 in/h flat coarse sand; 0.06 in/h heavy clay
at 12%) [read].

| Soil texture | 0–5% cover / bare | 5–8% | 8–12% | ≥12% |
|---|---|---|---|---|
| Coarse sandy | 2.00 / 2.00 | 2.00 / 1.50 | 1.50 / 1.00 | 1.00 / 0.50 |
| Coarse sandy over compact subsoil | 1.75 / 1.50 | 1.25 / 1.00 | 1.00 / 0.75 | 0.75 / 0.40 |
| Uniform light sandy loam | 1.75 / 1.00 | 1.25 / 0.80 | 1.00 / 0.60 | 0.75 / 0.40 |
| Light sandy loam over compact subsoil | 1.25 / 0.75 | 1.00 / 0.50 | 0.75 / 0.40 | 0.50 / 0.30 |
| Uniform silt loam | 1.00 / 0.50 | 0.80 / 0.40 | 0.60 / 0.30 | 0.40 / 0.20 |
| Silt loam over compact subsoil | 0.60 / 0.30 | 0.50 / 0.25 | 0.40 / 0.15 | 0.30 / 0.10 |
| Heavy clay or clay loam | 0.20 / 0.15 | 0.15 / 0.10 | 0.12 / 0.08 | 0.10 / 0.06 |

A narrower version comes from Schwankl, Prichard & Hanson (2007), UC ANR Pub. 8216, Table 1,
citing NRCS (1984) NEH-15 ch. 11 [read]. Coarse sand: 1.5–2.0 / 1.0–1.5 / 0.75–1.0. Light
sandy: 0.75–1.0 / 0.5–0.8 / 0.4–0.6. Silt loam: 0.3–0.5 / 0.25–0.4 / 0.15–0.3. Clay loam and
clay: 0.15 / 0.10 / 0.08 (0–5 / 5–8 / 8–12%).

These are **rates**. A per-cycle **depth** limit uses the IA's "allowable surface accumulation"
(ASA): RtMAX = ASA·60/(PR − IR) and minimum soak = Rt·Ea·PR/IR (IA 2008 SWAT protocol, as given
in Dukes & Davis 2009, eqs. 5–6) [read]. **I could not find the ASA values by soil and slope**
(they are in the IA protocol itself). KSU MF-2803: "On slopes, water may have to be applied in
increments, letting it soak in between cycles", aiming for 6–8 in wetting within 24 h [read].

### 2d. "Deep and infrequent"
- KSU MF-2803 [read]: wait for drought signs (dull blue-green colour, footprinting), then wet
  6–8 in (1–1.5 in water). Midsummer root recession means tall fescue may need **¾ in twice a
  week** and Kentucky bluegrass **½ in three times a week**. Watering daily is neither necessary
  nor desirable.
- Crookston (2014) [read]: in a model, irrigation limited to every 3rd/4th/5th day shrinks the
  effective root zone from 12 in to 7/8.8/10.4 in. Note that **the root shrinkage was assumed in
  the model, not measured**.
- Dissent: Watson (1996, Toro; *Sports Turf Newsletter*, MSU archive) says the advice "is not
  valid for many putting greens" or shallow-rooted turf. Its scope is golf greens [read, partial].
- Danielson & Feldhake (1981, Colorado WRRI Report 106) [read]: adequately fertilized bluegrass
  showed **minimal quality loss down to 70% of maximum-ET irrigation**, with a rapid decline below
  that.

---

## 3. Curve numbers for lawns, and the slope adjustment

TR-55 (USDA-SCS 1986) Table 2-2a, open space (lawns, parks), AMC II, Ia = 0.2S [read]:

| Condition | A | B | C | D |
|---|---|---|---|---|
| Good (>75% grass cover) | **39** | **61** | **74** | **80** |
| Fair (50–75%) | 49 | 69 | 79 | 84 |
| Poor (<50%) | 68 | 79 | 86 | 89 |
| Impervious (paved lots, roofs, driveways) | 98 | 98 | 98 | 98 |
| Newly graded, no vegetation | 77 | 86 | 91 | 94 |

Footnote: "CN's shown are equivalent to those of pasture."

**Slope adjustment** (Williams 1995), as given in Neitsch, Arnold, Kiniry & Williams (2011),
*SWAT Theoretical Documentation, Version 2009*, eq. 2:1.1.12, p. 106 [read]
https://swat.tamu.edu/media/99192/swat2009-theory.pdf:

    CN2s = (CN3 − CN2)/3 · [1 − 2·exp(−13.86·slp)] + CN2
    CN3  = CN2 · exp[0.00673 · (100 − CN2)]                       (eq. 2:1.1.5)
    CN1  = CN2 − 20(100 − CN2) / {100 − CN2 + exp[2.533 − 0.0636(100 − CN2)]}   (eq. 2:1.1.4)

- slp is the **fractional** slope (m/m). Tabulated CN2 values "are assumed to be appropriate for
  **5% slopes**". At slp = 0.05 the bracket is 0 and CN2s = CN2. Below 5% the adjustment
  *lowers* CN, by at most (CN3 − CN2)/3. SWAT itself does not apply the adjustment; users do.
- Initial abstraction: TR-55 uses Ia = 0.2S. Hawkins et al. (2002, 2nd Fed. Interagency
  Hydrologic Modeling Conf.) argue for **Ia = 0.05S**. As of 2020 NRCS had not changed λ
  (Ponce, SDSU) [2nd]. The commonly quoted conversion S0.05 = 1.33·S0.20^1.15 (S in inches) is
  **[unverified]**. For small daily rains on lawns this choice matters more than the CN itself.

---

## 4. Soil hydraulic properties by texture

### 4a. Rawls Green-Ampt table (two published versions disagree on Ks)
| Texture | Ks, Rawls et al. 1983 (in/h) | Ks, Rawls et al. 1993 Handbook (in/h) | Porosity | FC (1983) | WP (1983) | FC − WP |
|---|---|---|---|---|---|---|
| Sand | 4.74 | 9.28 | 0.437 | 0.062 | 0.024 | 0.038 |
| Loamy sand | 1.18 | 2.35 | 0.437 | 0.105 | 0.047 | 0.058 |
| Sandy loam | 0.43 | 0.86 | 0.453 | 0.190 | 0.085 | 0.105 |
| **Loam** | **0.13 (3.3 mm/h)** | **0.52 (13.2 mm/h)** | **0.463** | **0.232** | **0.116** | **0.116** |
| Silt loam | 0.26 | 0.27 | 0.501 | 0.284 | 0.135 | 0.149 |
| Sandy clay loam | 0.06 | 0.12 | 0.398 | 0.244 | 0.136 | 0.108 |
| Clay loam | 0.04 | 0.08 | 0.464 | 0.310 | 0.187 | 0.123 |
| Silty clay loam | 0.04 | 0.08 | 0.471 | 0.342 | 0.210 | 0.132 |
| Sandy clay | 0.02 | 0.05 | 0.430 | 0.321 | 0.221 | 0.100 |
| Silty clay | 0.02 | 0.04 | 0.479 | 0.371 | 0.251 | 0.120 |
| Clay | 0.01 | 0.02 | 0.475 | 0.378 | 0.265 | 0.113 |

Sources:
- The 1983 columns come from Rawls, Brakensiek & Miller (1983) *J. Hydraul. Eng.* 109:1316
  [verified only through the copy in the SWMM 5.1 manual, App. A.2]. The SWMM table also gives
  suction head; loam ψ = 3.50 in.
- The 1993 column comes from Rawls et al. (1993) in Maidment's *Handbook of Hydrology*, as
  reproduced in the TxDOT Hydraulic Design Manual, Table 4-27 [read]
  https://www.txdot.gov/manuals/des/hyd/chapter-4--hydrology/section-13--hydrograph-method/green-and-ampt-loss-model.html.
  For loam, that table gives θs 0.463 (0.375–0.551) and ψ 3.50 in.
- The 1993 Ks values (loam 1.32 cm/h) match the widely quoted Rawls, Brakensiek & Saxton (1982,
  *Trans. ASAE* 25:1316) class means. The 1983 values are a Green-Ampt "effective" K, about
  ¼–½ of Ks. **Pick one on purpose.** For ponding and infiltration with Green-Ampt under turf,
  the lower effective K is the conservative choice.
- The FC/WP values often attributed to Rawls 1982 (loam −33 kPa 0.270, −1500 kPa 0.117) are
  **[unverified]**.

### 4b. FAO-56 Table 19 ranges [read] (http://www.fao.org/4/x0490e/x0490e0c.htm)
Loam: θFC 0.20–0.30, θWP 0.07–0.17, **AW 0.13–0.18**; REW 8–10 mm; TEW (Ze = 0.10 m) 16–22 mm.
Sandy loam: AW 0.11–0.15. Silt loam: 0.13–0.19. Clay: 0.12–0.20. Sand: 0.05–0.11.

### 4c. Saxton & Rawls (2006), *SSSAJ* 70:1569–1578, doi:10.2136/sssaj2005.0117
I computed these values myself from the paper's eqs. 1–5 and 16. I took the equations from
USDA-ARS's WEPP implementation (`saxpar.for`, infosys.ars.usda.gov) [read]. Inputs are a texture
centroid and organic matter of 2.5%; the values in brackets use OM = 1%.

| Texture (sand/clay %) | WP | FC | Sat | AW | Ks (mm/h) |
|---|---|---|---|---|---|
| Sand (88/5) | 0.05 | 0.10 | 0.46 | 0.05 | 108 |
| Sandy loam (65/10) | 0.08 | 0.18 | 0.45 | 0.10 | 50 [42] |
| **Loam (40/20)** | **0.14 [0.13]** | **0.28 [0.26]** | **0.46 [0.42]** | **0.14** | **15.5 [10.6]** |
| Silt loam (20/15) | 0.11 | 0.31 | 0.48 | 0.20 | 16 [9] |
| Clay loam (30/35) | 0.22 | 0.36 | 0.48 | 0.14 | 4.3 [2.7] |
| Clay (25/50) | 0.30 | 0.42 | 0.50 | 0.12 | 1.1 |

The paper also has a density-factor (compaction) adjustment, eqs. 6–10. I could not obtain the
text of those equations, so I have not reproduced them.

**For a 100 mm loam topsoil:** AW ≈ 0.12–0.16, so it holds about **12–16 mm** of plant-available
water. Ks is 13–15 mm/h (Rawls 1993 / Saxton–Rawls) or 3.3 mm/h (Rawls 1983 effective).

### 4d. Compaction and urban lawn infiltration (measured)
| Study | Finding |
|---|---|
| Pitt & Lantrip (2000) "Infiltration through disturbed urban soils", in James (ed.) *Applied Modeling of Urban Water Systems*, Monograph 8, CHI, Table 1.2 [read] https://www.chijournal.org/Content/Files/R206-01.pdf | 153 double-ring tests, Alabama. **Non-compacted sandy: 13 in/h** (n = 36, COV 0.4). **Compacted sandy: 1.4 in/h** (n = 39), about −90%. **Non-compacted dry clayey: 9.8 in/h** (n = 18). **All other clayey (compacted, or wet): 0.2 in/h** (n = 60). Non-compacted urban sands ran ~350 mm/h, against "published rates … less than 25 mm/h". Field rates exceed survey or texture values when soils are undisturbed, and fall far below them when compacted or wet |
| Gregory, Dukes, Jones & Miller (2006) *J. Soil Water Conserv.* 61(3):117–124 [2nd, abstract] | Construction and compaction cut infiltration **70–99%** (Florida sands). Maximum compaction at 20–30 cm depth. *Whether* the soil was compacted mattered more than equipment weight |
| Legg, Bannerman & Panuska (1996) USGS WRIR 96-4194, 20 Madison WI lawns, silt loam [read] https://pubs.usgs.gov/wri/1996/4194/report.pdf | Mapped Ks **1.6–5.1 cm/h**. Measured Green-Ampt K by lawn: **0.84, 5.9, 3.5 cm/h**. By lawn age: **1–3 yr old 1.1 cm/h (bulk density 1.6)**, older lawns **4.3–5.4 cm/h** (1.2–1.4). K did not vary significantly *within* a lawn but did *between* lawns |
| Kelling & Peterson (1975), 9 urban lawns, Wisconsin [2nd, via synapse/abstract] | Where distinct textural or compaction layers from construction exist, intake is **~35%** of an undisturbed lawn's. This is directly relevant to imported topsoil over native soil |

Rule of thumb: **new or compacted lawns ≈ 0.1–0.35× the survey Ks; old, undisturbed lawns ≈ 1×
or more**. The spread is large.

---

## 5. Drainage class, and how to read SSURGO's wtdepannmin

Soil Survey Manual (Soil Survey Staff 1993), definitions as reproduced in Franzmeier & Kladivko
(2001) *Drainage and Wet Soil Management: Wet Soils of Indiana*, Purdue AY-301, Table 1 [read]
https://extension.purdue.edu/extmedia/AY/AY301.PDF. The 2017 wording, via Data Basin [2nd], adds
the "internal free water" clauses.

| Class | Definition (abridged) | Morphology marker, Purdue Table 2 |
|---|---|---|
| Excessively / somewhat excessively | Water removed very rapidly / rapidly. Internal free water very rare or very deep | — |
| Well | Removed readily but not rapidly. Internal free water deep or very deep | B horizon brownish to 40 in |
| Moderately well | Removed somewhat slowly *during some periods*. Wet for only a short time within the rooting depth during the growing season | **Gray mottles between 18 and 40 in** (46–100 cm) |
| Somewhat poorly | Wet at a shallow depth **for significant periods** of the growing season | **Gray mottles above 18 in** (<46 cm) |
| Poorly | Wet at shallow depths periodically, or remains wet for long periods | Upper 10 in of B almost entirely gray |
| Very poorly | Free water at or above the surface much of the growing season | Olive-gray subsoil |

- The classes are **qualitative and refer to natural (undrained) conditions**. I found **no
  official translation into hours or days saturated after a rain**. Purdue's monitoring shows
  water tables in well and moderately well drained soils "almost as high" as in poorly drained
  ones in some years. They differ mainly in *duration*. Soils with fragipans or dense till sit
  near field capacity much of the year: only **0.04 ft of water per ft (~13 mm per 30 cm)** brings
  them to saturation, against ~0.4 ft/ft for sands. That explains why perched wetness appears
  after a few rains [read].
- Internal free water depth classes (very shallow <25, shallow 25–50, moderately deep 50–100,
  deep 100–150, very deep >150 cm) are **[unverified]**. They are from memory of the Soil
  Survey Manual, ch. 3.
- **wtdepannmin** (SSURGO `muaggatt`): "the shallowest depth to a wet soil layer (water table)
  at any time during the year expressed as centimeters from the soil surface" (USGS ScienceBase
  layer metadata quoting NRCS [read]). It is "the annual minimum as well as the component
  minimum": the nearest the water table gets to the surface "of any significant component" in
  the map unit. **Null is common; often more than half of polygons have no value** [read]. It
  is therefore a *worst-case, wettest-month, wettest-component* number, not a typical depth. A
  value of, say, 46 cm means some component is saturated at 46 cm in its wettest month (usually
  spring), not that the lawn's root zone is wet most of the time. To get timing, use
  `wtdepaprjunmin` (April–June) or the month-by-month `cosoilmoist` table. My understanding is
  that SSURGO's "wet" layers include perched as well as apparent water tables **[unverified]**.
  I could not confirm the component-percentage threshold (some describe "≥15%") or whether
  values are capped at ~200 cm (the NRCS site was unreachable).

---

## 6. Topographic wetness index, TWI = ln(a / tanβ)

| Study | Resolution finding | Threshold |
|---|---|---|
| Buchanan et al. (2014) "Evaluating topographic wetness indices across central New York agricultural landscapes", *HESS* 18:3279–3299 [read] | 400+ TWI variants against field soil moisture. **3 m lidar beat 10 m** in every pairwise comparison. Multiple-flow-direction algorithms help; a 3 × 3 mean filter helps single-flow-direction methods. Adding soil (Ks, depth) to make a soil-topographic index usually helped. Best R² = 0.61 | No universal threshold. TWI is relative |
| Ågren et al. (2014) "Evaluating digital terrain indices for soil wetness mapping – a Swedish case study", *HESS* 18:3623–3634 [read] | **The opposite:** TWI from a **2 m DEM predicted poorly**. The best TWI came from a DEM **smoothed to 24 m (or 50 m)**. The cartographic **depth-to-water index (DTW) was scale-robust** and best overall | Wet if **DTW ≤ 1 m** (elevation above the nearest flow channel). Flow-initiation area 1–2 ha (till), 8–16 ha (floodplain). "Toe slopes" ranked low as a predictor |
| Sørensen & Seibert (2007) "Effects of DEM resolution on the calculation of topographical indices: TWI and its components" (journal and volume [unverified]; probably *J. Hydrol.* 347) [2nd] | TWI from 5 m lidar differs substantially from TWI resampled to 10/25/50 m. Coarser DEMs give higher mean TWI | — |
| Mercer Island, WA municipal wetland model (GIS metadata) [2nd] | 3-ft lidar grid | Treated **TWI > 6** as high wetness potential. This is local and not transferable |

- **No published lawn-scale or residential-lot TWI threshold was found.** Thresholds depend on
  cell size, flow algorithm and units of a (per unit contour width or cell area), so a number
  from another study is meaningless. Use a **percentile within the lot or catchment** (e.g. top
  10%), or DTW.
- For toe-of-slope seepage under a hillside, the upslope area *a* lies mostly **outside the
  lot**, so the DEM must cover the whole contributing hillside. Pair the index with soil
  drainage class and wtdepannmin rather than using TWI alone.
- Practical resolution: 1–3 m lidar (USGS 3DEP), lightly smoothed (3 × 3), with an MFD or D∞
  flow algorithm. This follows Buchanan; Ågren's result warns that unsmoothed 1–2 m TWI is noisy.

---

## 7. Reference ET and turf Kc

### 7a. FAO-56 Penman-Monteith, daily (Allen, Pereira, Raes & Smith 1998, *FAO Irrigation & Drainage Paper 56*, eq. 6) [read]

    ET0 = [0.408 Δ (Rn − G) + γ (900/(T + 273)) u2 (es − ea)] / [Δ + γ (1 + 0.34 u2)]

- Reference crop: h = 0.12 m, rs = 70 s/m, ra = 208/u2, albedo **α = 0.23**.
- **Cn = 900, Cd = 0.34** (the ASCE-EWRI 2005 standardized short-reference daily values are the
  same) [read for FAO; ASCE from memory].
- **G ≈ 0** for daily steps (eq. 42).
- λ = 2.45 MJ/kg; cp = 1.013e-3 MJ kg⁻¹ °C⁻¹; ε = 0.622.
- **γ = 0.665e-3 · P** (kPa/°C), where **P = 101.3 [(293 − 0.0065 z)/293]^5.26** (z in m)
  (eqs. 7–8).
- e°(T) = 0.6108 exp[17.27 T/(T + 237.3)].
- Rnl = σ[(Tmax,K⁴ + Tmin,K⁴)/2](0.34 − 0.14√ea)(1.35 Rs/Rso − 0.35), with Rs/Rso ≤ 1 and
  σ = 4.903e-9 MJ K⁻⁴ m⁻² d⁻¹.
- **Rso = (0.75 + 2×10⁻⁵ z) Ra**; Gsc = 0.0820 MJ m⁻² min⁻¹.
- If u2 is missing, use 2 m/s. Limit u2 ≥ 0.5 m/s. Convert 10 m wind with
  u2 = uz · 4.87 / ln(67.8 z − 5.42) (≈ 0.748 · u10).

**Rs when only sky cover is known (NWS forecasts):**
- FAO-56 has no cloud-cover method. Its options are Angström, Rs = (0.25 + 0.50 n/N) Ra
  (eq. 35), and the temperature method, **Rs = kRs √(Tmax − Tmin) Ra with kRs ≈ 0.16 interior,
  0.19 coastal**, capped at Rso (eq. 50) [read].
- Cloud-cover model: **Kasten & Czeplak (1980)**, *Solar Energy* 24:177–190:
  **Rs = Rs,clear · (1 − 0.75 (N/8)^3.4)**, N in oktas. The form is confirmed via Ahamed, Guo &
  Tanino (2017) CSBE17057 [read; the exponent was garbled in the PDF text, so 3.4 is from
  memory]. It is fitted to *hourly* data and is weak at intermediate cover. For a daily value,
  apply it to Rso with the day's mean sky cover. That use is an approximation.
- Substituting n/N ≈ 1 − sky-cover fraction into Angström is a common shortcut **[unverified]**.
- NWS's own FRET product (Penman-Monteith from NDFD temperature, humidity, wind and sky cover)
  does this conversion internally. **I could not find its documented sky-cover-to-Rs formula.**
  Validation studies report that its Rs is the weakest input [2nd]. If FRET is available for the
  lot, using it directly may beat recomputing.
- NASA POWER provides measured or modelled Rs (ALLSKY_SFC_SW_DWN) for history, so the problem
  only arises for forecasts.

**Hargreaves-Samani** (Hargreaves & Samani 1985, *Appl. Eng. Agric.* 1:96–99), FAO-56 eq. 52 [read]:

    ET0 = 0.0023 (Tmean + 17.8) (Tmax − Tmin)^0.5 · Ra      (Ra in mm/d equivalent = 0.408 × MJ m⁻² d⁻¹)

FAO-56: it "has a tendency to underpredict under high wind conditions (u2 > 3 m/s) and to
overpredict under conditions of high relative humidity". Calibrate it against Penman-Monteith
(ET0 = a + b·ET0,HS). FAO prefers Penman-Monteith with estimated Rs, ea and u2 over
Hargreaves-Samani.

### 7b. Turf Kc
| Source | Cool-season | Warm-season | Reference ET basis |
|---|---|---|---|
| FAO-56 Table 12, single Kc (ini/mid/end) [read] | **0.90 / 0.95 / 0.95** | 0.80 / 0.85 / 0.85 | FAO-56 grass ET0 |
| FAO-56 Table 12 footnote 15 [read] | "0.95 … represent a 0.06 to 0.08 m mowing height under general turf conditions. **Where careful water management is practiced and rapid growth is not required, Kc's for turf can be reduced by 0.10**", so 0.85 | 0.75 | |
| FAO-56 Table 17, Kcb [read] | 0.85 / **0.90** / 0.90 (same −0.10 note) | — | |
| UC (Meyer et al. 1985, Proc. 5th Int. Turfgrass Res. Conf., Avignon, pp. 357–364), via UC Center for Landscape & Urban Horticulture [read] https://ucanr.edu/site/center-landscape-urban-horticulture/turfgrass-crop-coefficients-kc | **Annual mean 0.80**. Monthly: Jan 0.61, Feb 0.64, Mar 0.75, **Apr 1.04**, May 0.95, Jun 0.88, Jul 0.94, Aug 0.86, Sep 0.74, Oct 0.75, Nov 0.69, Dec 0.60 | annual 0.60 (0.54–0.79) | ETo (CIMIS-type) |
| WUCOLS III (Costello et al. 2000) Table 1 [read] | **0.8 year-round** | 0.6 year-round | CIMIS ETo |
| Hunter *Scheduling Irrigation* Table 2 [read] | 0.60–0.80 | 0.50–0.70 | unspecified |
| Crookston (2014) IA [read] | Kcb ini 0.81, mid/end 0.86 (bluegrass) | — | ASCE ETos |

The owner's **0.8** matches UC/WUCOLS's annual cool-season value, which is conventionally taken
as the "acceptable quality" level. It sits 0.15 below FAO's 0.95 for well-watered turf. The UC
monthly curve shows spring (Apr–May) above 0.9 and winter near 0.6. A constant 0.8 under-waters
in spring flush and over-waters in late fall.

### 7c. Shade
- **Danielson & Feldhake (1981)**, *Urban Lawn Irrigation and Management Practices for Water
  Saving with Minimum Effect on Lawn Quality*, Colorado WRRI Completion Report 106, Colorado
  State Univ. (lysimeters, Kentucky bluegrass, Fort Collins) [read]
  https://mountainscholar.org/bitstreams/07927fa0-2934-4c55-b20a-fa476ef41c0c/download:
  - Shade cloth gave 100, 73, 54 and 33% of possible radiation. **ET was linear in incident
    radiation.**
  - Extrapolated ET at zero radiation was **~2 mm/d**, the advective component. It averaged
    **30% of full-sun ET**.
  - "A decrease in radiant energy of 50% resulted in an average decrease in ET of about 30%."
  - So **ET_shade ≈ ET_sun · [0.3 + 0.7 · (fraction of radiation received)]**. This fits
    one semi-arid site, and the advective share will vary with wind and humidity.
  - Grass preconditioned to shade did not change its ET when moved to full sun (also Feldhake
    et al. 1983, *Agron. J.* 75:824–830).
  - Authors' caveat: shade from *trees* may not save water, because the tree's own ET can
    offset it.
- WUCOLS III: shaded plantings Kmc **0.5–0.9**. "Plants in shaded areas lost 50% less water"
  (California studies, uncited) [read].
- Hunter: "in extremely shady areas the ET rate is reduced", with no number [read].

---

## Not found / still open
- ASA (allowable surface accumulation) values by soil and slope: they are in the IA SWAT
  protocol (2008), which I did not obtain.
- A measured initial loss or runoff coefficient specifically for asphalt-shingle roofs.
- Measured turf ET within a few metres of pavement, by orientation. Only the desert-edge
  (Brown 2005) and park (Spronken-Smith 2000) analogues exist.
- An official conversion of drainage class into saturation duration. The 2017 Soil Survey Manual
  internal-free-water class limits and the SSURGO wtdepannmin aggregation details still need
  checking: the NRCS website returned 503 during this pass.
- Saxton & Rawls 2006 density-factor equations.
- The NWS FRET sky-cover-to-Rs algorithm.
