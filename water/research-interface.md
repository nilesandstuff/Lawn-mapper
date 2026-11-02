# Build-up at a layer boundary, and the capillary barrier: the evidence, the survey's records, and how to add both (2026-11-02)

A research agent for the water session. It extends research-perched.md (the daily layered bucket on a 1 m grid,
per-horizon Ksat from SSURGO, a perched store P with leak `L = K_L (h + C) / C` and lateral routing). The owner raised
two cases that design does not handle:

- **A. Build-up at the interface.** Clay, organic matter, iron and aluminium collect at or just above a boundary
  (lamellae, clay films, spodic Bh/Bs, cemented ortstein, placic pans) and may slow water more than either layer's own
  Ksat says.
- **B. The capillary barrier.** A fine layer over a coarse one (topsoil or sod over sand or gravel) holds water until
  the interface is nearly saturated, because the coarse layer conducts almost nothing until its suction drops.

Tags, as in research-perched.md: [read] = this agent opened the document and read the passage; [code] = read in source
code; [queried] = this agent queried Soil Data Access live (2026-11-02) and read the rows; [abstract] = the abstract
only, read through the Crossref API or a publisher page; [arith] = this agent's own arithmetic; [2nd] = from a search
summary or a citing source, not opened; [recalled] = from memory, not checked here. Nothing here has been checked
against a lawn. Every recommendation below is SPECULATION until a probe, a ring infiltrometer or a soil-moisture sensor
says otherwise. Units: 1 um/s = 86.4 mm/day = 3.6 mm/h.

## Bottom line

- **The survey usually resolves the band already, or the band does not matter.** In Kent and Ottawa counties the four
  ortstein horizons (Bhsm) carry their own low Ksat in 3 of 4 cases (Saugatuck 0.5 um/s under 50; Jebavy 5 under 50).
  Spodic Bs/Bhs horizons without the cemented "m" suffix get the same Ksat as the sand above in 97% of cases. Lamellae
  ("E and Bt") get the same Ksat as the horizon above in 52% of cases and are never 10x slower [queried]. The OSDs say
  why: lamellae in these soils are "moderately rapid or rapid", one permeability class under the sand (Coloma) [read].
  So **an extra "interface resistance" should be added only where a band is named but given no Ksat contrast**, and
  only for cemented or pan-like kinds. Clay films, Bs/Bhs, B/E and lithologic discontinuities get nothing extra: the
  survey's horizon Ksat already includes them.
- **Measured magnitudes span orders of magnitude, and most of them are not lawn data.** Ortstein: clods 0.28-86 um/s
  (Wang et al. 1978) [abstract]; in situ in a Florida ortstein Bh 0.0085-1.42 um/s, 13 tests at 5 sites (Pepper OSD)
  [read + arith]. Aggregate skins: unsaturated K about 12x lower than the aggregate interior, up to 70x near
  saturation (Gerke & Köhne 2002) [abstract]. Lamellae: Ksat of the lamella-bearing part of the horizon 30-70% lower,
  lamellae 0.71 cm thick on average (Degioanni et al. 2024) [2nd]. Spodic horizons Ks "significantly lower" (Jačka et
  al. 2018) [abstract]. Placic pans: no measured Ksat found. Thickness: lamellae 0.3-13 cm each and under or over 15 cm
  in total (OSDs) [read]; ortstein 10-36 cm and 75-100% continuous, with breaks where E-horizon tongues pass through
  (Mokma et al. 1990, Michigan) [read].
- **The right representation is a series resistance, R = thickness / K, in days.** It is what MODFLOW's "quasi-3D"
  confining bed does (a bed added only to the vertical conductance) [read], and what Hillel & Gardner's crust
  resistance does [read, via Alagna et al. 2013]. HYDRUS instead meshes the thin layer as its own material [read].
  The leak becomes `L = (h + C) / R_total` with `R_total = sum(thk_j / K_j) + R_band`. With one slow horizon and no
  band this is exactly research-perched.md's `K_L (h + C) / C`.
- **Scale makes the case.** A 10 cm ortstein at the survey's 0.5 um/s is R = 2.3 days and leaks 170 mm/day under
  30 cm of perched water. Allendale's clay is R = 37 days. A few-mm clay crust measured in Sicily was 80 minutes
  (0.056 d) [arith; read]. So **a thin band matters only where no slow horizon exists below it**: it can make perching
  where none would be. That is the ortstein and placic case, not the lamellae case.
- **The capillary barrier is large, simple to compute, and local.** With Carsel & Parrish's class-average curves
  [code], every finer class over sand or loamy sand reaches equal conductivity at a suction of only 10-18 cm. This is
  the "breakthrough suction" h* (Lima et al. 2018's definition [read]). At equilibrium the fine layer holds
  `theta(h* + z)` at height z above the interface. Over the survey's field capacity (theta at 330 cm) that is **+22 mm
  for 10 cm of loam over sand, +31 mm for 15 cm, +40 mm for 20 cm**, and the same order for sandy loam [arith]. That
  is about as much again as the topsoil's whole available water. Field and model work in layered coarse soils found
  110-330 mm more storage at field capacity per metre than a uniform profile of the same mean texture (Zettl et al.
  2011) [abstract].
- **Represent it as a raised field capacity and a percolation threshold, never as a water source.** It is AquaCrop's
  FCadj (research-caprise.md) with the "table" at `h*` below the interface, but **without capillary rise**: the coarse
  layer is dry and nearly non-conducting. On lawn slopes the diverted water travels tens of centimetres at most, by
  Ross's (1990) bound Ks tan(phi) / (q alpha) [abstract + arith]. No lateral routing is needed.
- **Detection.** About half the mapped area of both counties (Kent 49%, Ottawa 46%) has components whose horizons are
  only "H1, H2, H3", with no designation [queried + arith]. For those the taxonomic name and the OSD text are the only
  clues. Rules for both cases are in section C. Fine-over-sand pairs by texture class within 1.5 m cover 2-3% of the
  area; a looser sand-jump rule covers 7-10%. But the lawn's most important barrier, **imported topsoil or sod over
  native sand, is in no dataset**: the page has to ask for it.

## A. Build-up at the interface

### A1. Measured magnitudes

| Feature | Setting | Thickness | K of the band vs the neighbours | Method | Source | Tag |
|---|---|---|---|---|---|---|
| Ortstein (cemented Bhsm) | Maritime Provinces, Canada; two sites, trenches | not in abstract | clods 0.1-31 cm/h = 0.28-86 um/s; "most ortstein clods were permeable"; roots did not enter; continuous where poorly drained, intermittent where well drained | lab, clods | Wang, McKeague & Beke 1978, *Can. J. Soil Sci.* 58: 405-420, doi:10.4141/cjss78-048 | [abstract] |
| Ortstein (Bh, weakly cemented, 60-90% of horizon) | Pepper series, Florida flatwoods | Bh1+Bh2 23-33 in (25 cm) | "In situ saturated hydraulic conductivity rates of 13 tests at 5 sites show permeability to range from 0.2012 to 0.0012 in/hr" = 1.42-0.0085 um/s; the water table "is perched above the spodic horizon early in the summer rainy season" | in situ | Pepper OSD, https://raw.githubusercontent.com/ncss-tech/OSDRegistry/main/OSD/P/PEPPER.txt | [read + arith] |
| Ortstein, Florida | Salerno series | Bh 10-20 in | "Hydraulic conductivity studies show these soils to have Bh horizons that severely restrict the downward movement of water and that have the characteristics of ortstein" | not given | Salerno OSD (same registry) | [read] |
| Ortstein, Michigan | Saugatuck, Mason County, GPR transects + pits | Bhsm 10-30 cm (OSD) | "generally strongly cemented and continuous ... appeared to occupy 75 to 100% of each pedon"; breaks are "weakly cemented materials or vertical tongues of E horizon material that extended through the ortstein"; "may have low hydraulic conductivities" (no K measured) | GPR, pits | Mokma, Schaetzl, Doolittle & Johnson 1990, *SSSAJ* 54: 936-938, https://people.geo.msu.edu/schaetzl/PDFs/GPR%20study.pdf | [read] |
| Ortstein, Michigan (survey estimate) | Saugatuck, Ottawa Co. | 33-43 cm, resthk 10 cm, "Strongly coherent" | Bhsm ksat_r 0.5 um/s (0.11-1) under E 50 um/s; OSD: "moderately low in the ortstein and high or very high in the rest of the profile"; Jebavy: Bhsm 5 vs 50, OSD "moderately high in the ortstein" | NRCS estimate | SDA chorizon/corestrictions; OSDs | [queried; read] |
| Ortstein-type horizons, Canada | Agriculture Canada bulletin | -- | 0.02-2.5 cm/h (0.056-6.9 um/s); "do not seriously restrict water movement except in some periods of very intensive rainfall" | -- | https://publications.gc.ca/collections/collection_2015/aac-aafc/agrhist/A54-6-1980-1-eng.pdf (downloaded; no text layer) | [2nd] |
| Spodic horizon (undifferentiated) | mountain podzol, Czechia | -- | Ks "significantly lower than the Ks values for the other tested horizons"; cause "an accumulation of fine particles and various substances"; water accumulated in the eluvial layer and moved laterally | Guelph permeameter, dye | Jačka et al. 2018, *J. Hydrol. Hydromech.* 66: 348-356, doi:10.2478/johh-2018-0014 | [abstract] |
| Aggregate skins (clay/clay-organic coatings) | C horizon of a clay-loam till, Germany | skin (thickness not in the abstract) | "interior/skin ratio in unsaturated hydraulic conductivity was about 12 ... up to 70 near water saturation and dropped below unity for soil water potentials smaller -1000 cm"; diffusivity of intact aggregates 4.5x smaller than cut ones | tension imbibition, intact vs cut | Gerke & Köhne 2002, *SSSAJ* 66: 26-36, doi:10.2136/sssaj2002.2600 | [abstract] |
| Lamellae | Haplustolls, west-central Córdoba, Argentina; 54 profiles | 1-4 lamellae per profile, mean 0.71 cm, at 18-48 cm | Ksat "of the portion of the horizon containing the lamella" reduced 30-70% in sandy loams; clay +13% in the lamella | not seen | Degioanni et al. 2024, *Ciencia del Suelo* 42(1): 80-90, https://doaj.org/article/778dd45576ed4d0b91ec37aeda032154 (page refused this agent) | [2nd] |
| Lamellae, survey words | Coloma (Lamellic Udipsamments) | lamellae 0.3-4 cm, total 13 cm in the type pedon; total < 15 cm; first at 51-152 cm | "Permeability is rapid in the Bw and E parts and moderately rapid or rapid in the lamellae" = at most one class (about 3x) slower | NRCS description | Coloma OSD | [read] |
| Lamellae, survey words | Chelsea; Spinks; Thetford | Chelsea 1-5 cm lamellae at 109, 125, 135, 150, 170 cm; Spinks 3 mm-13 cm, cumulative > 15 cm, first at 38-102 cm; Thetford 6 mm-8 cm bands, total >= 15 cm | Spinks "Saturated hydraulic conductivity is high"; Thetford "high" | NRCS description | OSDs | [read] |
| Texture bands in outwash | northern Lower Michigan outwash sands | thin and thick bands | "Roots of forest trees tend to branch and proliferate in the region immediately above thin bands"; better tree growth where bands are prominent (a water-holding effect, i.e. case B, not a K measurement) | field | Hannah & Zahner 1970, *SSSAJ* 34: 134-136, doi:10.2136/sssaj1970.03615995003400010036x | [abstract] |
| Clay bands at sand/gravel interface | 9-yr-old USGA-type putting greens, Mississippi | thin; one band at 14 in | "These layers had formed at the interface of sand and gravel", clay 1.7-3.8%; reduced infiltration, waterlogging, thinning turf; no K reported | field, XRD | Obear & Kreuser 2016, Golfdom, https://www.golfdom.com/?p=21810; USGA summary https://archive.lib.msu.edu/tic/ressum/2017/202.pdf; paper: Obear, Pedersen & Kreuser 2017, *Catena*, doi:10.1016/j.catena.2016.10.019 | [read; paper 2nd] |
| Surface crust (analogue of a thin skin) | clay soil, Sicily | few mm | crust resistance "practically independent of the crust thickness and varied between 78 and 81 min"; none detected in 10 of 11 sandy-loam tests | mini-disk infiltrometer, crust removed | Alagna et al. 2013, *J. Agric. Eng.* 44(s2): e14, https://cris.unibo.it/retrieve/e1dcb333-b7f8-7715-e053-1705fe0a6cc9/Alagna%20et%20al.%20AIIA%202013.pdf | [read] |
| Placic horizon | -- | thin, mm-scale (Soil Taxonomy: roughly 1-25 mm, typically 2-10 mm) | no measured Ksat found; described as nearly impermeable | -- | Soil Taxonomy (the NRCS site did not answer this agent) | [recalled] |

Lamellae in the national survey: 118 series with lamellae, 3.6 million ha, 30 states; mostly sandy (59%); first
lamella at 72 cm on average (Bockheim & Hartemink 2013, *Geoderma* 206: 92-100, doi:10.1016/j.geoderma.2013.04.014)
[2nd].

What the table says, read together [the agent's judgment]:
- No study found here measures a lamella's or an argillan's Ksat directly in a permeameter. Even the best numbers
  (Gerke's ratio, Degioanni's 30-70%) come from intact-versus-disturbed or with-versus-without comparisons.
- Cemented bands span four orders of magnitude between studies (0.0085-86 um/s). Within one horizon the leak is set by
  its breaks (Mokma's E tongues; Wang's "intermittent" ortstein where well drained), as for fragipans
  (research-perched.md, Parlange et al. 1989).
- In the West Michigan soils, the survey's words agree with its numbers. Lamellae are one class slower at most, and
  ortstein is "moderately low" (Saugatuck) or "moderately high" (Jebavy).

### A2. How established models represent a thin resistive layer

1. **As a thin layer with its own K, meshed (HYDRUS).** HYDRUS-1D has no interface-resistance term. A thin
   resistive layer is a material with its own nodes: its manual's outflow example models a ceramic plate below the soil
   as "a two-layered system ... The soil profile was discretized into 50 nodes with five nodes representing the ceramic
   plate" [read: Šimůnek et al., HYDRUS-1D Technical Manual v4.17, section 11 example,
   https://www.pc-progress.com/Downloads/Pgm_hydrus1D/HYDRUS1D-4.17.pdf]. Material boundaries are smoothed: "the finite
   element algorithm will assume that the material properties will change linearly over the element" (section 10.2)
   [read]. A 5 mm band therefore needs mm-scale elements. The one place HYDRUS has a skin term is between the two pore
   domains of its dual-permeability model: a mass-transfer coefficient from an "effective hydraulic conductivity Ka of
   the fracture-matrix interface", lumped as a calibration input Ka* (eq. 2.101-2.103, after Gerke & van Genuchten)
   [read]. Gerke & Köhne's skins feed that parameter. It is a lateral, macropore-to-matrix exchange term, not a
   vertical series resistance.
2. **As a series resistance with no layer of its own (MODFLOW quasi-3D).** MODFLOW-2005: the vertical conductance
   between two cells is "the equivalent conductance of two half cells in series" (eq. 5-23/5-24). A semiconfining bed
   that adds nothing to storage or horizontal flow "can be simulated without using a separate layer ... by including
   the semiconfining unit in the calculation of vertical conductance": `1/CV = (Δv_k/2)/(A VK_k) + Δv_CB/(A VKCB) +
   (Δv_k+1/2)/(A VK_k+1)` (eq. 5-25) [read: Harbaugh 2005, USGS TM 6-A16,
   https://pubs.usgs.gov/tm/2005/tm6A16/PDF/TM6A16.pdf, p. 5-7 to 5-8]. That is the form recommended here: a band adds
   `thk/K` to the vertical resistance only, and never to the lateral transmissivity.
3. **As a hydraulic resistance in time units (soil physics, crusts).** "Hillel and Gardner (1969) accounted for the
   crust effect through the hydraulic resistance which is the ratio between the crust thickness and the corresponding
   conductivity". The flux across the crust is `q = Kc (h0 - hs + Lc) / Lc` (h0 pond depth, hs the pressure head below
   the crust). With no pond and Lc negligible, `q = -hs / Rc` [read: Alagna et al. 2013, eq. 1-2; original Hillel &
   Gardner 1969, *Soil Sci.* 108: 137, doi:10.1097/00010694-196908000-00010, not opened]. Dutch groundwater practice
   calls the same quantity the "c-value" of an aquitard, in days [recalled].
4. **As an effective conductivity of the whole restrictive layer (SMR, SWAT).** SMR: "An 'effective conductivity' of
   the bedrock and fragipan is specified", 1 mm/day for a fragipan. SWAT drains each layer by its own Ksat
   (`TT_perc = (SAT - FC)/Ksat`), so a thin layer is just another layer, and its own travel time sets the leak [both
   read in research-perched.md]. Neither has an interface term. A band thinner than a SWAT layer is averaged away
   unless the user splits the layer.
5. **As a reduction factor.** No model consulted here uses a multiplicative "interface factor" on a horizon's Ksat.
   research-perched.md notes that the tool's own drainage-class factor is one, and recommends dropping it in perching
   cells. A factor has no thickness and no gradient. For a thin band that is wrong in both directions, since a 5 mm
   pan with 30 cm of head over it sees a gradient of 60 [arith].

The physics behind items 2-4 is the same: one-dimensional saturated flow in series, `R_total = sum(thk_j / K_j)`, an
effective vertical K of `sum(thk_j) / R_total` (the thickness-weighted harmonic mean), and lateral flow in parallel,
`T = sum(K_j thk_j)` (arithmetic) [recalled physics, the textbook result].

### A3. What the soil survey records, and what Kent and Ottawa actually contain

All [queried] from Soil Data Access (https://sdmdataaccess.sc.egov.usda.gov/tabular/post.rest), 2026-11-02, areasymbol
MI081 (Kent; saved 2026-08-27) and MI139 (Ottawa; 2026-09-01). Area shares are component percent x map-unit acres
[arith].

**Fields that encode designations.** chorizon.hzname is the text, e.g. "2Bt2", "E and Bt", "Bhsm". It is parsed into
desgndisc (the discontinuity numeral, '2'), desgnmaster ('B', 'E and B', 'B/E', 'H'), desgnmasterprime and desgnvert
(the vertical subdivision). **The chdesgnsuffix table exists**: one row per suffix per horizon (desgnsuffix, chkey).
Bhsm gives three rows, h, m and s. National suffix counts: t 519,809; g 275,038; s 51,961; d 29,282; x 27,242; h
20,158; m 6,718. Note that "E and Bt" carries suffix t, so `t` alone does not separate lamellae from an ordinary Bt.
Meanings [read: SSSA Glossary of Soil Science Terms, Appendix II, 2022,
https://agronomy.org/files/publications/soils-glossary/appendix-2.pdf]:
- Arabic numeral prefix: "Arabic numerals are used ... as prefixes to indicate discontinuities", i.e. a different
  parent material.
- `t`: "Accumulation of silicate clays (i.e., clay films, lamellae, or clay bridging in some part of the horizon)".
- `h`: "illuvial, amorphous, dispersible organic matter-sesquioxide complexes that coat sand grains and silt particles
  and may fill pores". `s`: "Significant illuvial accumulation of amorphous, dispersible sesquioxides and organic
  matter complexes".
- `m`: "Continuous or nearly continuous pedogenic cementation or induration of the soil matrix (> 90% cemented, even
  if fractured); physically root restrictive ... iron (sm)".
- `x` fragipan; `d` "Physical root restriction due to high bulk density, either natural (e.g., dense lodgment till) or
  human-induced (e.g., plow pan)"; `g` strong gley.
- **"E and Bt – Presence of thin, heavier textured lamellae (Bt material) within a predominantly E horizon with less
  clay"; "B and E" the reverse.** E/B and B/E (with a virgule) are "discrete, intermingled bodies" of the two
  (tongues, interfingering), the first named dominant.

Nationally the lamellae notation varies: "E and Bt" 5,381 horizons, "E and Bt1" 494, "E&Bt" 381, "2E and Bt" 307, "Bt
and E" 195, older "A&B", "B&A" [queried]. A rule must accept `/\b[AE]\d?\s*(and|&)\s*B/i` and `/\bB\w*\s*(and|&)\s*E/i`,
or desgnmaster 'E and B' / 'B and E'.

**What the two counties hold.**

| | Kent MI081 | Ottawa MI139 |
|---|---|---|
| components / major (with horizons) | 550 / 139 | 424 / 135 |
| horizons | 1,954 | 1,538 |
| major components with only generic H1/H2/H3 names | 87 of 139 | 81 of 135 |
| area in components with generic H names | 49.4% | 45.6% |
| suffix rows (both counties together) | t 245, p 188, g 179, s 82, h 12, m 4, d 2, x 0 | |
| corestrictions rows | none | Ortstein 4 (Saugatuck x3 at 33-43 cm, 10 cm thick, "Strongly coherent"; Jebavy 43-79), Densic 2 (Conover, 113 cm), Strongly contrasting textural stratification 1 (Elston, 183 cm), Abrupt textural change 1 (Sickles) |

Ksat across the designated interfaces (the horizon above divided by the named horizon; ksat_r) [queried + arith]:

| Named horizon | n | median ratio | ratio = 1 | ratio >= 10 | examples |
|---|---|---|---|---|---|
| E and Bt (lamellae) | 67 | 1.0 | 52% | 0% (max 6) | Chelsea E 55 / E and Bt 55 (73-203 cm); Coloma Bw 55 / 55; Spinks Bw 50 / 50, one version 282 / 77.6; Thetford E2 233 / 82; Oshtemo sits under a Bt (11 / 55) |
| B/E, E/B, 2B/E | 74 | 2.5 | 19% | 24% | Capac Ap 11 / B/E 0.2 (Ottawa); Onekama E/B 1 / B/E 0.0555; Gowdy E 50 / 2B/E 0.5; Fern E 282 / 2E/B 59 / 2B/E 22 / 2Bt 2.8 |
| Bs, Bhs (no m) | 78 | 1.0 | 97% | 0% | Grattan, Pipestone, Covert, Kaleva, Plainfield, Thompsonville: all equal to the E |
| Bhsm (ortstein) | 4 | 55 | 25% | 75% | Saugatuck E 50 / Bhsm 0.5 / Bs 50; Jebavy 50 / 5; **one Saugatuck component 282 / 282 although its corestrictions row says Ortstein** |
| Bt (first Bt below a non-Bt) | 161 | 1.0 | 64% | 12% | Marlette Ap 11 / B/E 5 / Bt 0.1 |

Lithologic discontinuities (a horizon with prefix 2 under one without): 80 boundaries. Ksat drops 10x or more at 29
(Sickles S 92 over 2Bw SIC 0.205; Tustin 92 / 0.91; Metea 55 / 1.0; Fern 92 / 2.7). It rises at least 2x, coarse below,
at 20 (Sebewa Btg2 CL 5.5 over 2Cg S 55; Matherton Btg 5.5 / 92; Kalamazoo Bt2 SL 5.5 / 55; Boyer GR-SL 28 / GRV-S 92;
Bronson 10 / 55). Neither, at 31 [queried + arith]. The prefix alone predicts neither direction.

Areas [queried + arith]: lamellae (an "E and B" horizon or a Lamellic subgroup) **Kent 13.3%, Ottawa 4.9%** (Spinks,
Chelsea, Coloma, Oshtemo, Thetford); spodic (Bs/Bhs or a Spodosol name) Kent 0.8%, Ottawa 19.1%; ortstein Kent 0%,
Ottawa 0.8%; a Ksat drop of 10x or more within 150 cm, Kent 11.4%, Ottawa 18.5%.

**Taxonomic names as the fallback for generic-H components** (component.taxclname / taxsubgrp / taxpartsize)
[queried]. "Lamellic" (Chelsea, Coloma, Spinks): 19 major components, only 2 with generic names. "Alfic" Spodosols
(a Bt under the spodic horizon: Allendale, Iosco, Montcalm, Thompsonville, Wixom): 5 major, all 5 generic. "ortstein"
family or a Dur- great group (Saugatuck, Jebavy: "Sandy, mixed, mesic, shallow, ortstein Typic Duraquods" in the OSD)
[read]. Strongly contrasting families "X over Y" (Allendale, Iosco, Fox, Matherton, Sebewa, Newaygo, Lacota, Scalley,
...): 21 major, 20 of them generic. Older names differ from current ones: the generic-H Spinks is "Psammentic
Hapludalfs", the current one "Lamellic Hapludalfs". So the subgroup word is missing exactly where the horizon names are.

**Thin features in the tables.** Horizon thickness (hzthk_l/r/h, hzdept, hzdepb) describes the whole "E and Bt",
86-162 cm thick, never a lamella. chstructgrp says "structureless single grain" for the Coloma and Chelsea "E and Bt"
[queried]. No column records lamella thickness, count or spacing. Those live only in the OSD text: "several wavy and
discontinuous lamellae 0.3 to 4 cm ... total thickness equal to 13 cm" (Coloma); "lamellae at 109, 125, 135, 150, and
170 centimeters" (Chelsea); "Ortstein content: 90 to 100 percent" (Saugatuck); "Ortstein content ... up to 10%, and
occurs as chunks" (Grattan); "0 to 30 percent ... present in less than 50 percent of the pedons" (Pipestone) [read].
The OSD registry is plain text with CORS open (research-perched.md), so a page can fetch it.

### A4. Recommendation: setting an interface resistance from the data

1. **Use the survey's own Ksat when it resolves the band.** If the named horizon's ksat_r is 0.1x or less of the
   horizon above (Saugatuck's Bhsm, Capac's B/E), it is already a slow horizon. It enters `R_total` as `thk / ksat_r`,
   and **no extra interface term is added**. Adding one is double counting.
2. **Add a band term only where a pan-like kind is named and not resolved.** The cases: an `m` suffix or a
   corestrictions reskind of Ortstein, Placic, Cemented horizon, Duripan, Petroferric, or Densic/Fragipan; or an
   "ortstein"/"Dur"/"Plac" word in the taxonomic name, or "ortstein"/"placic"/"cemented" in the OSD with a content of
   50% or more. In each case the horizon's ksat_r must be more than 0.1x the horizon above. Defaults:

   | Kind | Thickness default | K_band default | Range to report | Basis |
   |---|---|---|---|---|
   | ortstein (Bhsm, Bsm) | resthk_r, else the horizon's thickness, else 10 cm | 0.5 um/s | 0.01-5 um/s (and 86 for clods) | Saugatuck survey and OSD "moderately low" [queried; read]; Pepper in situ 0.0085-1.42 [read]; Wang clods 0.28-86 [abstract] |
   | placic | 0.5 cm | 0.01 um/s | 0.001-1 | none measured; SPECULATION [recalled] |
   | fragipan / densic with unreduced ksat | as listed | 1 mm/day (0.012 um/s) | 0.1-7 mm/day | SMR [read in research-perched.md] |
   | user-reported engineered layer (clay band at a sand/gravel contact, compacted subgrade) | 1 cm | 0.1 um/s | 0.01-1 | golf-green bands [read], value SPECULATION |

   Ortstein continuity: the defaults treat the band as continuous. As a sensitivity, give 5% of the area the E
   horizon's K (Mokma's tongues): `K_eff = 0.95 K_band + 0.05 K_E`, which is 3.0 um/s for Saugatuck, 6x the
   default [arith]. Report it as the upper end.
3. **Lamellae get no band term and no perched store**, only the storage of case B. The survey gives them the sand's K
   (52%) or close to it. The OSD says one class slower. Degioanni's 30-70% is a factor of 1.4-3.3. Even at K_E/3 the 13 cm of
   lamellae in Coloma add 0.055 days of resistance to the E's 0.027 [arith], which is invisible next to any daily
   input. A lamella perches water only when it is the top of a genuinely slow layer. Spinks and Thetford "high"
   (OSDs) agree.
4. **Clay films (t on a Bt), Bs/Bhs without m, B/E, E/B and the numeral prefix get no extra term.** Films are part of
   the Bt that the Ksat estimate describes, and Gerke's skin effect is a macropore-matrix exchange term, not a
   vertical resistance. Bs/Bhs is 97% equal to the sand, and the OSDs call its cement "chunks" (Grattan) or under 50%
   of pedons (Pipestone). The interface build-up at a discontinuity is already drawn as a transitional horizon with an
   intermediate Ksat (Fern's 2E/B 59 and 2B/E 22 between E 282 and 2Bt 2.8). Use these designations to *place* the
   boundary (the perched store sits on top of the first horizon whose ksat drops, which may be a 2B/E rather than the
   2Bt), not to slow it again.
5. **The equation.** For each cell's slow zone, top-down, `R_total = sum over slow horizons (thk_j / K_j) + R_band`,
   K in m/day, R in days. Leak `L = (h + C_tot) / R_total` (m/day), with `C_tot` the slow zone's thickness, including
   the band. Under a high H70 table, use the head form of research-perched.md with `C/K_L` replaced by `R_total`. For
   Jackson's travel distance and the page, report `K_L,eff = C_tot / R_total`. **Never** put R_band into the lateral
   transmissivity T(h) above the band.
6. **When a band makes a store.** Give a cell a perched store wherever `R_total >= 1 day` [judgment]. That is where a
   soaking can outrun the leak for at least part of a day. Saugatuck's ortstein (2.3 d) gets one and drains it within a
   day or two. Allendale (37 d) holds it for weeks. Saugatuck's OSD calls its water table "apparent", not perched
   [read], which fits: its wetness is groundwater, not the pan.
7. **Uncertainty to state.** Band K is known to 1-3 orders of magnitude, and continuity is unknown without GPR or a pit
   (Mokma et al. 1990 found breaks that "would have been difficult to locate with normal auger observations"
   [read]). Run the band at its range and show the result as a band of outcomes. A probe hitting a hard layer at the
   listed depth is the cheapest check.

What NOT to do:
- Do not multiply a horizon's Ksat by a factor for being a Bt, Bs, or below a discontinuity. The survey's estimate
  already reflects it.
- Do not add a band term to a horizon that already has a low ksat_r. Do not stack the drainage-class factor on top of
  either.
- Do not take the harmonic mean across the whole profile for lateral flow. Series is for vertical leak only.
- Do not treat a corestrictions row as authoritative over the horizon, or the reverse, without the rule above. One
  Saugatuck component lists Ortstein in corestrictions but gives its Bhsm the sand's 282 um/s [queried]. The
  restriction row should win, with the default K.
- Do not read lamellae as perching layers. Their effect is storage (B), and in these soils it sits at 56-203 cm, below
  turf roots.

## B. The capillary barrier

### B1. Physics and criteria

"The increase in moisture content in the fine-grained soil causes a decrease in suction and an increase in its
hydraulic conductivity. However, the hydraulic conductivity of the underlying granular layer may remain lower than that
of the fine-grained soil over a comparatively wide range of suction. Thus, water will not yet flow into the granular
layer and will instead build up at the interface ... Eventually ... the hydraulic conductivity of the coarse- and
fine-grained soils will reach the same value. This suction value is termed the breakthrough suction" [read: Lima,
Azevedo, Zornberg & Palmeira 2018, *Environmental Geotechnics*, doi:10.1680/jenge.16.00038,
https://www.caee.utexas.edu/prof/zornberg/pdfs/AJ/Lima_Azevedo_Zornberg_Palmeira_2018.pdf]. Their silty soil had a
water-entry suction of 1 kPa (about 10 cm); non-woven geotextiles about 0.1 kPa [read].

Stormont & Anderson (1999, *J. Geotech. Geoenviron. Eng.* 125(8): 641-648,
doi:10.1061/(ASCE)1090-0241(1999)125:8(641)) ran columns of silty sand over pea gravel, concrete sand over pea gravel,
and silty sand over concrete sand [abstract, https://www.osti.gov/biblio/680121]. Water crossed when the interface
suction reached the coarse layer's breakthrough head. That head depended on the coarse layer, not on the infiltration
rate or the fine soil. The barrier re-formed after infiltration stopped, and the head was unchanged over eight cycles
with pea gravel. Concrete sand broke through at a higher suction than pea gravel: "more uniform, coarser" lower layers
make better barriers. A numerical study put breakthrough at 0.4 kPa (about 4 cm) for a gravelly sand and 3.5 kPa
(about 36 cm) for a fine sand [2nd].

Criterion used here [arith]: **breakthrough suction h* = the suction at which K_fine(h) = K_coarse(h)** (Lima's
definition), from van Genuchten-Mualem curves. With Carsel & Parrish (1988, *Water Resour. Res.* 24: 755-769)
class means, read from medfate's source (https://raw.githubusercontent.com/cran/medfate/master/src/soil.cpp, which
cites Leij et al. 1996 after Carsel & Parrish) [code]:

| Fine over coarse | h* (cm) | K there (mm/day) | coarse layer's Se at h* | theta_fine at h* | theta_fine at 330 cm |
|---|---|---|---|---|---|
| loam / sand | 13.0 | 39 | 0.31 | 0.398 | 0.165 |
| sandy loam / sand | 10.4 | 123 | 0.42 | 0.339 | 0.085 |
| silt loam / sand | 14.9 | 19 | 0.25 | 0.432 | 0.240 |
| clay loam / sand | 18.1 | 6 | 0.19 | 0.394 | 0.270 |
| sandy clay loam / sand | 15.9 | 13 | 0.23 | 0.335 | 0.169 |
| loamy sand / sand | 10.2 | 138 | 0.43 | 0.259 | 0.060 |
| loam / loamy sand | 14.5 | 34 | 0.41 | 0.393 | 0.165 |
| sandy loam / loamy sand | 10.6 | 119 | 0.55 | 0.338 | 0.085 |

So any finer class over sand or loamy sand breaks through only at 10-18 cm of suction, near saturation for the fine
layer. With class means, even the van Genuchten alpha contrast of LS/S (0.124 vs 0.145) crosses at 10 cm. That says
more about class averages than about real sands: within-class spread is large. A defensible threshold for "barrier
present" is an alpha ratio of 1.5-2 or more with the coarse layer sand, loamy sand, coarse sand or gravelly
[judgment]. A sand-percentage jump of 20 points or more into a horizon of 85% sand or more is the same test in survey
units. Gravel, coarser than any class here, gives a smaller h* and a stronger barrier (Stormont & Anderson).

On a slope the barrier diverts water down-dip only until the contact wets through. Ross's upper bound on the
diversion length is `Ks tan(phi) / (q alpha)`, with Ks and alpha of the fine soil and q the infiltration rate [abstract:
Ross 1990, *Water Resour. Res.* 26: 2625-2629, doi:10.1029/WR026i010p02625]. Anisotropy along the contact lengthens it
(Stormont 1995, doi:10.1029/94WR03001) [abstract]. For a lawn at 2-5% slope and 10 mm/day: 0.28-0.71 m for sandy loam,
0.14-0.35 m for loam, 0.11-0.27 m for silt loam [arith]. That is under a grid cell: **no lateral routing for case B**.

### B2. How much extra water a fine layer holds above a coarse one

At drained equilibrium (no flux) the suction rises 1 cm per cm of height above the interface, so the fine layer holds
`theta_f(h* + z)`. The extra over a free-draining layer at the survey's field capacity (theta at 330 cm, wthirdbar, which
lib/soil.js uses as fc) is `dS = integral over 0..D of [theta_f(h* + z) - theta_f(330 cm)] dz` [arith; Carsel &
Parrish curves]:

| Fine layer over sand | 10 cm | 15 cm | 20 cm | 30 cm | 50 cm |
|---|---|---|---|---|---|
| loam (h* 13) | +22 mm | +31 | +40 | +56 | +83 |
| sandy loam (h* 10) | +21 | +30 | +37 | +48 | +65 |
| silt loam (h* 15) | +18 | +27 | +35 | +51 | +77 |
| clay loam (h* 18) | +12 | +18 | +23 | +33 | +51 |
| loamy sand (h* 10) | +14 | +18 | +22 | +27 | +33 |
| sandy loam over loamy sand | +21 | +29 | +36 | +48 | +64 |

Against theta at 100 cm instead of 330 cm, the extra is about two thirds of these (loam over sand, 15 cm: +20 mm)
[arith]. For scale, 15 cm of loam holds 20-27 mm of available water by FAO-56's 0.13-0.18 (PARAMS-SOURCES.md): the
barrier roughly doubles it.

Lamellae work the same way, each band a small fine-over-coarse contact with the E sand below it. Five 2.6 cm loamy-sand
lamellae 20 cm apart in sand hold about +81 mm over the survey's FC across 113 cm; ten 1.5 cm lamellae 10 cm apart
about +114 mm [arith, equilibrium, an upper bound]. This is Hannah & Zahner's roots proliferating "immediately above
thin bands" [abstract].

Measured and modelled in the field:
- Zettl, Barbour, Huang, Si & Leskiw 2011, *Can. J. Soil Sci.* 91: 133-147, doi:10.4141/cjss09117 [abstract].
  Double-ring infiltration and drainage tests with real-time water content at seven coarse-textured sites:
  "higher water storage at FC values are associated with increased textural heterogeneity"; modelling: "a texturally
  heterogeneous site can have water storage at FC within 1 m profile that is between 110 to 330 mm higher than a
  homogeneous profile with the same average texture."
- Huang et al. 2011, *Can. J. Soil Sci.* 91: 199-210, doi:10.4141/cjss10012 [abstract]: calibrated HYDRUS-1D over 60
  years; "layering of coarse-textured soils can provide more plant available water and support a higher maximum
  sustainable LAI than homogeneous soils of a similar texture."
- Prettyman & McCoy 2003, *Crop Sci.* 43: 985-994, doi:10.2135/cropsci2003.9850 [abstract]: 1.2 x 7.3 m putting greens,
  root zone over gravel (two-tier) vs over subgrade, 0-4% slope. "The presence of a gravel layer beneath the root zone
  yielded reduced and more uniform water contents than in its absence"; "Slope-induced lateral water movement was
  apparent ... in all greens", with upslope drying after 27-45 h. A sand root zone over gravel is the engineered
  version of the barrier; the one-tier greens over subgrade were the wetter ones.
- The USGA specification is a designed capillary barrier: 12 in (300 mm) of root zone over 4 in of gravel. "For
  bridging to occur, the D15 (gravel) must be less than or equal to five times the D85 (root zone)" and "To maintain
  adequate permeability across the root zone/gravel interface, the D15 (gravel) shall be greater than or equal to five
  times the D15 (root zone)"; root-zone capillary porosity at 40 cm tension 15-25%; Ksat 6-12 in/h normal [read: USGA
  1993 revision, https://gsrpdf.lib.msu.edu/ticpdf.py?file=/1990s/1993/930301.pdf]. The document read does not use the
  words "perched water table"; that the gravel exists to hold water up in the root zone is [2nd].
- Sod over sand: "Water moves through the finer-textured layer and then backs up once it reaches the coarser-textured
  layer below" [read: Fry 2022, Golf Course Management, https://gcmonline.com/research/news/sod-tricky-transition].
  Anderson et al. 2014, *Agron. J.* 106: 351-358, doi:10.2134/agronj2013.0266 [abstract]: sod on sand-capped root zones
  "often leads to layering of contrasting soil textures ... causing adverse effects on soil drainage and moisture";
  washed sod lowered VWC 3-4%; core aeration raised infiltration 13% and cut end-of-study VWC 44% on the sand cap.
- Twarakavi, Sakai & Šimůnek 2009, *Water Resour. Res.* 45, doi:10.1029/2009WR007944 [abstract]: "using
  benchmark pressure heads to estimate field capacity from the retention curve leads to inaccurate results"; a
  flux-based field capacity from HYDRUS-1D. Field capacity is a property of the profile, not of a horizon. The barrier
  is the extreme case of that.

### B3. How layered bucket models represent it

- **SMR** sets the field capacity of the layer above a fragipan to "the average profile moisture content when the soil
  is just saturated at the fragipan interface (Steenhuis et al., 1988)" [read in research-perched.md]. That is a raised
  FC from a boundary condition at the interface.
- **AquaCrop** raises FC over a shallow table: `FCadj_i = FC + (SAT - FC)/x^2 (x - z_i)^2`, drainage stops at FCadj
  [read in research-caprise.md]. A capillary barrier is the same boundary condition with the "table" at depth h* below
  the interface. FCadj is a fitted curve; for a barrier, `theta_f(h* + z)` from the retention curve is the direct form.
- **SWAT** drains each layer on its own excess over its own FC (research-perched.md, 1a). A fine layer drains to its FC
  whatever lies below, so **SWAT cannot represent a capillary barrier** [arith from the equations read there].
  Neither can the tool's present `drainDay`.
- **HYDRUS-1D** (Richards) produces it with no special treatment. Zettl and Huang used it. It is the check.
- A percolation threshold is the bucket form: the layer above the interface passes nothing down until its storage
  exceeds the raised FC, then drains at its own rate [judgment; the same logic as SWAT's excess-over-FC with a
  different FC].

### B4. Detecting it from SSURGO and from the lawn

From the survey [queried; rules in section C]:
- Texture class pairs (finer over S or LS, alpha ratio 2 or more, coarse layer starting within 150 cm): CL/S 24
  boundaries (Matherton, Newaygo, Scalley, Sebewa), SCL/S 9 (Fox, Lacota, Mancelona), L/S 6 (Landes), SICL/S 3
  (Woodbeck), CL/LS 2 (Kalamazoo), SCL/LS 1 (Ormas). Area: **Kent 2.0%, Ottawa 3.1%**. The looser rule (a sand jump
  of 20 points or more into 85% sand or more) gives Kent 7.3%, Ottawa 10.2%.
- Families "fine-loamy over sandy or sandy-skeletal" (Fox, Lacota, Matherton, Newaygo, Scalley, Sebewa): 9 major
  components, 8 of them with generic H names. Their H horizons still show the jump: Fox H2 GR-SCL 9 um/s over H3 COS 92
  at 96 cm; Matherton H2 CL 9 / H3 GR-S 92 at 76 cm; Kalamazoo H2 CL 9 / H3 GRV-LS 92 at 96 cm [queried].
- A Ksat rise downward (ksat_r below 3x or more the horizon above) at a texture coarsening, often with a prefix 2 and a
  gravel modifier (GR-, GRV-, COS) in chtexturegrp.texture. corestrictions "Strongly contrasting textural
  stratification" (Elston, 183 cm) can be either direction; read the horizons.
- Depth matters. These native barriers sit at 76-109 cm, under the Bt and below turf roots. They raise storage in the
  subsoil, delay recharge and keep the Bt wetter, but feed the grass only through deep roots.

**The lawn's own barrier is not in the survey.** Topsoil spread over a sandy subsoil or fill, or sod grown on a finer
soil laid on sand, sits in the root zone, where the effect is largest (+20-40 mm for 10-20 cm). The native Ap in SSURGO
is the farm-era surface, not what a builder spread. Ways to know, best first:
1. Ask: "Was topsoil brought in? About how deep? Is the ground under it sand?" with a default of "don't know" (off).
2. A probe or a trowel: a sharp change from dark loam to loose sand at a depth. One reading per lawn sets D.
3. A hint, never a rule: where the native surface horizon is S or LS (Plainfield, Grattan, Spinks, Chelsea, Coloma)
   and the lawn is lush without much irrigation, offer the question. Sod in Michigan is commonly grown on finer or muck
   soils [recalled], so a sodded lawn on native sand is a likely barrier.

## C. Recommended additions to the design in research-perched.md

### C1. Data rules, per component (both cases)

Fetch per horizon: hzname, desgndisc, desgnmaster, hzdept_r, hzdepb_r, ksat_l/r/h, sandtotal_r, claytotal_r,
wthirdbar_r, wsatiated_r, chtexturegrp.texture (rvindicator 'Yes'), and the chdesgnsuffix rows. Per component:
taxclname, taxpartsize, taxsubgrp, corestrictions (reskind, resdept_r, resthk_r, reshard). lib/soil.js already reads
hzname, ksat, sand, clay, fc, wp. Optionally fetch the OSD text once per series name.

**Case A, an interface band** (for each horizon i, from the top):
1. *Resolved slow horizon*: `ksat_r(i) <= 1.0 um/s` and `<= 0.1 x` the fastest horizon above (research-perched.md's
   rule). It enters R_total with its own thk/K. No band term.
2. *Named, unresolved band*: `ksat_r(i) > 0.1 x ksat_r(i-1)` AND one of: suffix m; desgnmaster with "m" in hzname;
   corestrictions reskind in {Ortstein, Placic, Cemented horizon, Duripan, Petroferric, Fragipan, Densic material}
   overlapping horizon i; or (generic H names) a taxonomic name with "ortstein", "Dur", "Plac" or "Fragi", or an OSD
   regex `/(ortstein|placic|cemented)[^.]{0,80}(\d+) (to (\d+) )?percent/i` giving 50% or more. Add R_band from the
   A4 table, at the top of that horizon (or at resdept_r).
3. *Ignored for resistance*: "E and B"/"E&B"/"B and E" (lamellae), suffixes t, h, s without m, B/E and E/B, and the
   numeral prefix. These are used only to place boundaries and to flag case B.

**Case B, a capillary barrier**: a boundary between horizon u (above) and c (below), with c's top within 150 cm, where
1. c's texture class is S, LS, COS or any gravelly sand (strip GR-/GRV-/CB- modifiers; "COS", "S", "FS", "LCOS", "LS",
   "LFS"), AND
2. alpha_c / alpha_u >= 1.5 by the class table (B1), or sand_c - sand_u >= 20 with sand_c >= 85; AND
3. u is not itself sand (the class differs).
Supporting evidence (not needed, but shown on the page): taxpartsize "... over sandy" or "... over sandy-skeletal";
ksat_r(c) >= 3 ksat_r(u); a 2 prefix on c. Every "E and B" horizon is also case B internally, with lamellae as the
fine bands. Use the OSD's lamella count, thickness and depths when it gives them. Otherwise assume a total of 7.5 cm
for Lamellic Psamments (under 15 cm) or 20 cm for Lamellic Alfisols (over 15 cm), in bands 2 cm thick [judgment from
the OSDs].
**User layer**: if the owner reports topsoil of depth D over sand (or the probe finds it), insert a layer u of class
"loam" (or the class the owner picks) from 0 to D over the native profile's first coarse horizon. This is the one
case-B layer inside the root zone.

### C2. Equations

Case A (replaces step 4 of research-perched.md section 2):

    R_total = sum_j (thk_j / K_j) + R_band            (days; thk in m, K in m/day; j over the slow horizons)
    L = (h + C_tot) / R_total                          (m/day; C_tot = sum thk_j + band thickness)
    head form under a high H70 table: L = max(0, (Z - zL + h) - max(Z_wt, Z - zL - C_tot)) / R_total
    K_L,eff = C_tot / R_total                          (for Jackson's L_D and for the page)
    store exists where R_total >= 1 day

Ortstein sensitivity: `K_band,eff = (1 - f) K_band + f K_above`, f = 0 by default and 0.05 as the upper case.

Case B (new; per cell, at static equilibrium):

    h*            from the class pair: the h solving K_u(h) = K_c(h) (van Genuchten-Mualem, Carsel & Parrish), or the B1 table
    theta_u(z)    = theta_vG,u(h* + z), z = height above the interface (cm)
    dS(a, b)      = 10 * integral from a to b of max(0, theta_vG,u(h* + z) - theta_vG,u(330)) dz      (mm; a, b in cm above the interface)
    cap           dS <= 10 * (wsatiated_r - wthirdbar_r)/100 * thickness, so the survey's saturation is never exceeded

- **Interface below the roots** (native subsoil barriers, lamellae): the layer between the roots and the interface
  holds an extra `dS(0, z_int - Zr)` before anything passes. In the existing bucket this is a store `B` (mm) that the
  root zone's drainage fills first. Percolation past the interface is `max(0, B_in - (B_max - B))`. B drains only by
  slow downward flow at breakthrough, roughly the fine layer's K(h*) of 6-140 mm/day (B1 table), and by ET only if
  roots reach it.
- **Interface inside or at the base of the roots** (the topsoil case): raise the root zone's holding capacity.
  With the interface at depth d_i and roots to Zr, `TAW_cb = TAW + dS(max(0, d_i - Zr), d_i)` (heights in cm above
  the interface, over the part of the fine layer the roots occupy), i.e. FCadj in place of FC.
  The root zone drains only above FCadj. `satRoom` (gravity water room) shrinks by the same dS.
- **No capillary rise across a barrier.** A dry coarse layer at h* or drier conducts almost nothing (Se 0.2-0.4 at h*;
  far less at the suctions a drying root zone reaches) [arith]. When the H70 table lies below a coarse layer, compute
  rise with the coarse layer's class through its thickness (the slowest link), not with the topsoil's.
- **Interaction with case A**: the same thin band can be both, a resistance on its top when water arrives saturated and
  a barrier on its underside once drained. The A store and the B store are separate states: A holds water above the
  layer's field capacity (gravity water), B holds water below it. Nothing is counted twice if B's dS is defined against
  theta(330) and A's against wsatiated - wthirdbar.

### C3. Defaults and sources

| Parameter | Default | Source |
|---|---|---|
| unresolved ortstein K_band, thickness | 0.5 um/s; resthk_r, else 10 cm | Saugatuck SSURGO/OSD [queried; read] |
| ortstein range | 0.01-5 um/s; gaps f = 0.05 as the high case | Pepper OSD in situ [read]; Wang 1978 [abstract]; Mokma 1990 [read] |
| placic | 0.01 um/s over 0.5 cm | SPECULATION [recalled] |
| fragipan/densic, unresolved | 1 mm/day | SMR [read in research-perched.md] |
| lamellae resistance | none (K_lam = K_E/3 if a check is wanted) | Coloma OSD [read]; Degioanni 2024 [2nd]; survey [queried] |
| clay films, Bs/Bhs, B/E, prefix 2 | none | survey ratios [queried]; SSSA designations [read] |
| store threshold | R_total >= 1 day | [judgment] |
| van Genuchten class parameters | Carsel & Parrish 1988 | medfate soil.cpp [code] |
| h* by class pair | 10-18 cm (B1 table) | [arith] |
| barrier present | coarse class S/LS/COS/gravelly; alpha ratio >= 1.5, or sand jump >= 20 pts to >= 85% | [judgment]; Stormont & Anderson 1999 [abstract] |
| lamellae geometry | OSD if given; else 7.5 cm total (Lamellic Psamments) or 20 cm (Lamellic Alfisols), 2 cm bands | OSDs [read]; [judgment] |
| user topsoil | off; if on: class loam, D from owner or probe (10-15 cm typical guess) | [judgment] |

### C4. What to report

- Per soil, next to its name: "a hard pan (ortstein) at 33-43 cm, slows water to about X mm/day, from the survey" or
  "from a default; could be 10x either way"; "lamellae from 85 cm: hold extra water below the roots, do not perch".
  For each band: its R_total in days, its leak at 30 cm of perched water, and where the number came from (survey Ksat,
  restriction row, taxonomic name, OSD, default).
- For case B: "the topsoil over sand holds about +N mm more after a soaking than the same topsoil over loam (N =
  dS)", and the interface depth. Native barriers below the roots: "the subsoil holds +N mm above the sand at Y cm".
- In the water balance: `tot.cbStore` (the barrier store's change) and the extra ET it supported, so the mass balance
  line stays closed.
- The spread: band K at its range; h* +-5 cm; the topsoil depth at the owner's value +-5 cm.
- When generic H names forced the taxonomic or OSD fallback, say so: "the survey's horizons here are unnamed".

### C5. Checks to build in

- Static column, loam 15 cm over sand, drained, no ET: the bucket's root-zone storage should equal `10 * integral of
  theta(h* + z) dz` (56 mm by the B1 numbers) to a millimetre. Without the barrier flag it should equal the FC
  storage.
- Leak through a band alone (no slow horizon): `L = (h + b) / (b / K_b)`. For Saugatuck at h = 0.3 m: 173 mm/day.
- Mass balance to rounding, with the new stores.
- Offline, once: a HYDRUS-1D column per case (Saugatuck with a 10 cm ortstein, Coloma with five lamellae, loam over
  sand), mesh mm-scale through bands (the manual: coarse soils need finer discretization, and properties change linearly across an element that straddles a material boundary [read]), compared with the
  bucket's daily storage after a 25 mm rain.
- The survey as a target: Pepper-like soils whose OSD says "perched above the spodic horizon" should perch in the
  model. Saugatuck's "apparent" table should come from H70, not from the pan.

### C6. Caveats

- **Thin-band K is the least-known number in the model.** The cemented-band studies span 0.0085-86 um/s. No placic,
  lamella or argillan Ksat was found measured directly. Treat every default as SPECULATION with its range on the page.
- **Continuity rules a pan's leak** (ortstein breaks, E tongues). A 1 m grid cannot know where they are. GPR finds them
  (Mokma 1990), and an auger mostly does not.
- **Class-average retention curves** stand in for real horizons. Within-class spread in alpha is large, so h* and dS
  are good to perhaps a factor of 2 [judgment]. Rosetta-type pedotransfer from sand/silt/clay/bulk density per horizon
  would be better, but it is not in the tool.
- **Hysteresis**: breakthrough happens on wetting, at the coarse layer's water-entry suction, which is lower than its
  air-entry. Equilibrium storage after drainage is set by drying curves. The static dS is an upper bound for a lawn
  that is never fully drained between waterings [recalled physics].
- **Equilibrium takes time, and roots and ET keep pulling.** dS is the most a soaking leaves behind, not a daily
  supply.
- **Bypass**: worm and root channels, aeration cores and cracks short-circuit a thin topsoil barrier. Anderson et al.
  (2014) cut the sand cap's VWC 44% with core aeration [abstract]. Unstable fingered flow below a barrier in sand moves
  water past it in columns (Kung 1990, *Geoderma* 46: 51-58, funnel flow in Wisconsin's Plainfield sand) [recalled].
- **Engineered interfaces build up fast**: clay collected at a sand/gravel contact in under 10 years in Mississippi
  greens (Obear & Kreuser) [read]. A lawn's topsoil/sand boundary may gain its own band, which no dataset will show.
- **The survey's vintage**: about half the area has unnamed H horizons and older taxonomic names (Spinks as
  "Psammentic Hapludalfs"), so lamellae and ortstein can hide there. The OSD is the national backstop.
- **Depth vs roots**: almost every native lamella or subsoil barrier in these counties sits at 56-203 cm. Report its
  storage separately from the root zone's, so it is not mistaken for water the grass can use.

What would make this true to life: a soil-moisture sensor pair (just above and just below the topsoil/sand contact) in
one lawn with imported topsoil, read through a summer. It would show directly whether the topsoil holds the predicted
+20-40 mm after watering, and how fast ET takes it. Add a probe line on a Saugatuck lawn to find whether the ortstein
is continuous there.

## Sources opened (tags as above)

- Soil Data Access, live queries, MI081/MI139: chorizon, chdesgnsuffix, chtexturegrp, chstructgrp, component,
  corestrictions, mapunit, sacatalog [queried].
- OSDs from https://raw.githubusercontent.com/ncss-tech/OSDRegistry/main/OSD/{letter}/{NAME}.txt: Coloma, Chelsea,
  Spinks, Thetford, Oshtemo, Saugatuck, Jebavy, Grattan, Pipestone, Fox, Matherton, Sebewa, Kalamazoo, Capac, Pepper,
  Salerno [read].
- SSSA Glossary Appendix II, designations: https://agronomy.org/files/publications/soils-glossary/appendix-2.pdf [read].
- Mokma et al. 1990 SSSAJ 54: 936-938: https://people.geo.msu.edu/schaetzl/PDFs/GPR%20study.pdf [read].
- MODFLOW-2005, Harbaugh 2005: https://pubs.usgs.gov/tm/2005/tm6A16/PDF/TM6A16.pdf [read].
- HYDRUS-1D Technical Manual v4.17: https://www.pc-progress.com/Downloads/Pgm_hydrus1D/HYDRUS1D-4.17.pdf [read].
- Alagna et al. 2013: https://cris.unibo.it/retrieve/e1dcb333-b7f8-7715-e053-1705fe0a6cc9/Alagna%20et%20al.%20AIIA%202013.pdf [read].
- Lima et al. 2018: https://www.caee.utexas.edu/prof/zornberg/pdfs/AJ/Lima_Azevedo_Zornberg_Palmeira_2018.pdf [read].
- USGA 1993 recommendations: https://gsrpdf.lib.msu.edu/ticpdf.py?file=/1990s/1993/930301.pdf [read].
- Obear & Kreuser 2016: https://www.golfdom.com/?p=21810 [read]; USGA 2017 summary:
  https://archive.lib.msu.edu/tic/ressum/2017/202.pdf [read].
- Fry 2022: https://gcmonline.com/research/news/sod-tricky-transition [read].
- Carsel & Parrish parameters in medfate: https://raw.githubusercontent.com/cran/medfate/master/src/soil.cpp [code].
- Crossref abstracts (https://api.crossref.org/works/{doi}): Wang et al. 1978; Gerke & Köhne 2002; Hannah & Zahner
  1970; Ross 1990; Stormont 1995; Zettl et al. 2011; Huang et al. 2011; Prettyman & McCoy 2003; Twarakavi et al. 2009;
  Anderson et al. 2014 [abstract]. Publisher page: Jačka et al. 2018 [abstract]. OSTI record: Stormont & Anderson 1999
  [abstract].
- Search summaries only: Degioanni et al. 2024; Bockheim & Hartemink 2013; Obear et al. 2017 Catena; Agriculture
  Canada ortstein bulletin; the 0.4/3.5 kPa breakthrough values [2nd].
