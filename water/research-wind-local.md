# Localized wind in a lawn: research for a per-cell, per-direction shelter model

Tags: [read] means I read the source (full text unless noted). [2nd] means I saw it only through another source or a search summary. "Computed" means my own arithmetic from the formulas given. Heisler 1990, Brandle 2009 Fig. 5-3, Angelou 2022 and Cleugh 2002 are already in water/research-shade-wind.md (A1, A2, A4) and are not repeated here except where used.

## HARD FINDINGS

### 1. Porous barriers (fences, hedges, rows)

**WEPS barrier function.** Source: USDA-ARS 2020, *WEPS Technical Documentation*, Agric. Handbook 727, eqs. 56-66 [read]. It is a fitted curve built from Hagen et al. 1981, van Eimern et al. 1964, Raine & Stevenson 1977 and Heisler & DeWalle 1988. It gives the fraction of open-field friction velocity at distance x (in barrier heights, measured **along the wind direction**). Negative x is upwind.

    fu* = 1 - exp(-m x^2) + n exp(-0.003 (x + s)^t)
    m = 0.008 - 0.17 p + 0.17 p^1.05,   n = 1.35 exp(-0.5 p^0.2)
    s = 10 (1 - 0.5 p),                 t = 3 - p
    p = pbr + (1 - exp(-0.5 xbr))^0.3 (1 - pbr)     (effective porosity)

Here pbr is the optical porosity and xbr is the barrier width divided by its height.

Rules that come with it:
- It is valid up to p = 0.8.
- The upwind effect is applied to cells within 5 H of the barrier, using the minimum distance as a negative x.
- Cells are tested within 35 H.
- Each cell has a factor for each of 8 directions.
- **"When two or more barriers shelter the same area, the lowest fraction calculated for an individual barrier shelter is selected."**

The curve tabulated (computed):

| p | −3H | −1H | 0 | 2H | 5H | 10H | 15H | 20H | 30H | minimum (at) | back to 0.9 at |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 (solid) | 0.55 | 0.16 | 0.07 | 0.04 | 0.18 | 0.55 | 0.83 | 0.96 | 1.00 | 0.03 (1.3H) | 17H |
| 0.2 | 0.64 | 0.35 | 0.23 | 0.10 | 0.13 | 0.42 | 0.70 | 0.88 | 0.99 | 0.09 (3H) | 21H |
| 0.4 | 0.77 | 0.56 | 0.46 | 0.29 | 0.20 | 0.39 | 0.67 | 0.86 | 0.99 | 0.20 (4.8H) | 22H |
| 0.5 | 0.81 | 0.64 | 0.55 | 0.40 | 0.29 | 0.42 | 0.68 | 0.87 | 0.99 | 0.28 (5.6H) | 21H |
| 0.8 | 0.87 | 0.76 | 0.72 | 0.65 | 0.62 | 0.70 | 0.84 | 0.94 | 1.00 | 0.62 (4.9H) | 17H |

As porosity rises, the minimum gets shallower and moves downwind. This matches Brandle et al. 2009 Fig. 5-3 (solid fence 25/70/90% of open at 5/10/15H). The WEPS solid curve gives 18/55/83%, so it is somewhat stronger.

**Perera 1981**, *J. Wind Eng. Ind. Aerodyn.* 8:93-104 [read, full text]. Wind tunnel, fences 40 mm tall, porosity 0-0.5.
- The construction (slats or holes) does not matter; only the porosity does.
- The recirculation bubble moves downwind and shrinks as porosity rises, and is undetectable above about 0.3. Re-attachment for the solid fence is near 10h.
- A solid fence shelters best close behind it. Porosity 0.1 shelters best in the far wake.
- His far-wake fit, eq. 1, holds from about 7.5h downwind (fitted 7.5-25h):

      (Δu(z)/U_R(h)) · X = 9.75 (1 − φ) η exp(−0.67 η^1.5)
      η = [z/(h − d)] (1/(K X))^(1/(n+2)),  X = x/(h − d),  K = 2k²/ln((h − d)/z0)

  Here n is the approach-profile exponent (WAsP uses 0.14).

**WAsP obstacle model "Shelter"**: Astrup & Larsen 1999, Risø-R-1107(EN) [read].
- It is "based solely upon the correlation of Perera 1981 plus some reasoning … not a flow model". At small x/h "the Perera formula is far from reality".
- **Finite length:** the infinite-fence deficit is multiplied by a geometric factor G from a tanh lateral distribution. G is tuned so the half-deficit line spreads at **5-6°** from the centreline, like a free jet.
- **Buildings** are replaced by ≤10 m 2-D pieces placed at their downwind faces.
- **Several obstacles:** the deficits add, each scaled by the wind reaching that obstacle. One obstacle's influence is cut when another stands within 5h_i + 2h_j of it.

**Perera near the ground.** η → 0 at z → 0, so Perera's deficit vanishes at the ground. Computed for a 15 m obstacle at 5H: u/u0 = 0.55 at 2 m but about 0 at h/2. **Peña, Bechmann, Conti & Angelou 2016**, *Wind Energ. Sci.* 1:101-114 [read] measured this with lidar behind a full-scale 3 m × 30 m fence, solid and then porosity 0.375:
- "Perera's estimations result in a general overestimation of the wind-speed ratio below h."
- Shelter is strongest below about 1.46h and was sometimes seen out to 11h.
- **Oblique wind:** "the larger the relative direction, the lower the effect of the shelter". At −60 ± 15° there was "no sheltering effect … in the far wake (≳ 6 fence heights)".

**Oblique wind and finite length, other sources.**
- Brandle 2009 [read]: the protected zone shrinks as wind turns oblique. A barrier should be ≥ 10 H long "to minimize the effect of wind flow around the ends". Gaps and ends "concentrate wind flow", which raises speed in their lee.
- Wang & Takle 1996, *Agric. For. Meteorol.* [2nd, abstract]: shelter distance falls faster or slower than cos(angle), depending on height and density.

**Optimum porosity.**
- Cornelis & Gabriels 2005, *J. Arid Environ.* 61:315 [2nd]: 20-35%.
- Cornelis, Gabriels & Lauwaerts, WEPS symposium [read]: optimum "about 25%". A screen cut wind 99% at 2H and was still 90% at 8H (z = 0.5H). Trees with **a porous lower part** lost shelter right behind them. With no canopy (stems only), the reduction was under 10%.

### 2. A single house (Röckle-type zones)

Source: **QUIC-URB user's guide** (LANL, LA-UR-07; Röckle 1990) [read; the equation layout is partly garbled in extraction].
- Upwind eddy (Hosker 1984): **Lf/H = 2(W/H)/(1 + 0.8 W/H)**. It is an ellipsoid of height 0.6H with u = v = 0 inside.
- Lee cavity (Fackrell 1984): **Lr/H = 1.8(W/H) / [(L/H)^0.3 (1 + 0.24 W/H)]**, with W = cross-wind width and L = along-wind length.
- Near wake: a half-ellipsoid of length Lr·√(1−(z/H)²) with reversed flow, u = −u(H)(1 − x/d_N)².
- Far wake: out to **3Lr**·√(1−(z/H)²), with **u = u(z)[1 − (d_N/x)^1.5]**. Here d_N is the cavity edge on that streamline and x is the distance from the lee wall. This is the Kaplan & Dinar 1996 form. The guide's garbled text is consistent with it, because it is 0 at the cavity edge and 0.81 at 3Lr.
- Sidewall vortex: Hayati et al. 2017, *BLM* (LA-UR-17-27285) [read]. R = Bs^(2/3) Bl^(1/3), Lc = 0.9R, Wc = 0.22R, with reversed flow along the side walls.

Wake length falls monotonically as approach turbulence rises (Hearst, Gomit & Ganapathisubramani 2016, *JFM* 804:513, abstract [read]). Wakes in a gusty suburb are therefore likely shorter than these wind-tunnel lengths.

**Corner speed-ups.** I found **no measured amplification factor for a low isolated house**. The pedestrian-wind reviews describe corner speed-ups growing with building height (Mittal et al. 2018, *J. Build. Eng.* 18:154 [read]; no numbers for low buildings). The only house-scale figure is still Heisler's isolated building: 0.37-1.11 of the approach wind at 1 H.

### 3. Trees

**Mayaud, Wiggs & Bailey 2016**, *ESPL* 41:1421 [read, full text]. A 3.7 m tree with crown porosity 6%:
- At 0.30 m, the wind was **above the upwind value from the crown's downwind edge to about 4 h**. This is the bottom-gap jet.
- At 1.5 m (0.8 m below the crown), it was slower under the crown and again at 2-5 h.
- In summary: "decreased sheltering up to three tree heights downwind, but the surface became increasingly protected … over a further eight tree heights".
- A grass clump (porosity 53%) cut wind 70% and a shrub (69%) cut it 40%. Both recovered exponentially by about 9 heights.

**Leaf-on against leaf-off** [2nd, search summaries of the papers, not read]:
- Slovak windbreak: optical porosity about 10% in leaf and up to 50% leafless.
- Czech windbreaks: 5% in the season and 23% out of it. Another site: 50% in April, 20% in October.
- Korea (*J. Ecol. Environ.* 37(2):91, 2014): with leaf loss, the reduction at 2H fell from 83% to 48% but **rose** at 6H from 26% to 43%.

Heisler 1990 Table 3 [read, A1]: the trees' share of the yard reduction in winter against summer was 0.14 against 0.28 (low cover), 0.37 against 0.39 (medium) and 0.41 against 0.46 (high).

### 4. Combining obstacles; the suburban background

- WEPS takes the **minimum** of the individual barrier factors [read].
- WAsP **sums the deficits**, scaled by the wind at each obstacle and damped for close spacing [read].
- Heisler 1990 [read, A1]: the yard wind is the "approach wind", **with the house's own effect removed** using an isolated-building survey. Within 0-91 m, buildings alone cut it 22% and 77% tree cover cut it 70%. The fit is 1 − x/(24 + 1.1x), with residuals up to 40 points.
- Urban z0 and d from morphometry (Grimmond & Oke 1999, *JAM* 38:1262; Macdonald et al. 1998) [2nd, not re-read: I could not verify the residential table values this round, so I give none]. Below d the log law does not hold. At 2 m in a yard, Heisler's measurement is the only direct number.

## SPECULATION: an algorithm for the tool

**Principle: explicit shape, calibrated mean.**
- Near obstacles make the pattern.
- Heisler's measured yard mean sets the level.
- One multiplier B per lot absorbs everything not modelled explicitly, so nothing is counted twice.

**Inputs per cell**
- Ground, roofs (porosity 0), crowns with top, base and season porosity, and user fences (height and porosity).
- Default porosities: deciduous crown 0.2 in leaf and 0.5 bare (from the [2nd] ranges above); evergreen 0.2; fences as drawn. A shadowbox's optical porosity is about 0, but it flows like about 0.2, so use the user's value.

**Per cell, per direction (16 sectors × 3 rays at −7.5°, 0, +7.5°)**
1. March upwind in 1 m steps to R = min(20 × local obstacle height, 150 m).
2. Group consecutive obstacle cells into objects, each with its downwind-edge distance x, height H, along-ray depth (for WEPS xbr), and cross-wind width (from the 3 rays and the footprint).
3. Apply the shelter rule for the object type:
   - **Long barrier** (fence, hedge, tree row; length ≥ 5H across the wind): WEPS fu*(x/H, p_eff). Its along-wind distance already lengthens oblique paths. Set S = 1 if the wind is more than 60° off the barrier normal and x > 6H (Peña). Upwind cells within 5H take the negative-x branch.
   - **Building:** Röckle zones as given. Lf and Lr use W = the cross-wind footprint width and L = the along-wind depth, evaluated at z = 2 m. Cavity: S = 0.1 (reversed, slow; the floor stands in for it). Far wake: S = 1 − (d_N/x)^1.5 out to 3Lr. Lateral extent: ±W/2. Upwind eddy: S = 0.3 inside the 2 m section of the Lf ellipsoid (u = 0 in Röckle; 0.3 is a guess that keeps it from being worse than the lee).
   - **Corner band:** cells within 0.5H outside the side-wall lines, from the front face to the rear face plus Lr, get S = 1.1. This is capped at Heisler's 1.11 and applied only where no other object shelters the cell.
   - **Single crown, or crowns covering under a third of the rays:**
     - If the crown base is above 2 m: S = 1.0 from the trunk to 3H (Mayaud's bottom gap). Beyond 3H, use WEPS with (x − 3H)/H and p_eff.
     - If the crown reaches the ground: use WEPS directly.
     - In either case, scale the deficit (1 − S) by the WAsP-style finite-width factor G = W/(W + 2x·tan 6°).
4. Combine: **S_dir = minimum over objects** (the WEPS rule; it avoids stacking a row and the house in front of it). Average the 3 rays.

**Per cell, per month**

    F_cell = Σ_d w_d · S_cell,d / Σ_d w_d

- w_d is the sum of daytime hourly speeds in sector d over that month's years. Speed-weighting follows the wind's roughly linear weight in the aerodynamic term.
- Calm hours (< 0.5 m/s) are spread evenly over the sectors.

**Calibration to Heisler (per lot, per month or season)**

    B = H(x90) / ⟨F⟩,   clamped to [H(x90), 1]
    u2_cell = WS2M × B × F_cell        (keep FAO-56's 0.5 m/s floor)

- H(x90) is the present curve, from the cover within 90 m.
- ⟨F⟩ is the mean F over open ground in the same 90 m disc.

The yard mean then equals Heisler's figure by construction. A purist variant mirrors his "own house removed" correction: compute ⟨F⟩ without each cell's nearest building. That gives a larger ⟨F⟩, a smaller B and slightly more shelter overall.

**Lidar extent.** The explicit march needs obstacle heights within 150 m of every lawn cell. Heights only, at 1-2 m. Fetch **200 m around the lot**, which also gives Heisler's full 90 m disc and stops the clipping noted in H46.

**Cost.** About 3,000 cells × 48 rays × 150 steps ≈ 2 × 10⁷ steps per season: seconds in a worker.

**Height question (open).** WEPS is near-surface friction velocity, while Röckle is evaluated at 2 m. Behind low fences the near-surface number is the one that governs the turf's exchange. Cleugh 2002 still warns that fixed-T, fixed-ea Penman-Monteith overstates the ET cut in the quiet zone.

### Worked examples: wind straight on, local factor S before B

These were computed with the defaults above. As an illustration only, take B = 0.42/0.8 ≈ 0.53, assuming ⟨F⟩ = 0.8 on a lot like the owner's (not computed).

| cell | rule | S | × B ≈ share of open wind |
|---|---|---|---|
| 3H (18 m) behind a 6 m house, W 12 m, L 10 m | Lr = 12.5 m (2.09H), d_N at 2 m = 11.8 m; far wake 1 − (11.8/18)^1.5 | **0.47** (0.02 at 2H, 0.66 at 4H, 1 past about 6H) | 0.25 |
| 2H (3.6 m) behind a 1.8 m solid fence | WEPS p = 0 | **0.04** | 0.02, so the 0.5 m/s floor applies |
| 2H behind a spaced-board fence | WEPS p = 0.5 | **0.40** | 0.21 |
| 2H behind a shadowbox | WEPS p = 0.2 | **0.10** | 0.05 |
| 2 crown-heights (30 m) downwind of a 15 m deciduous tree in leaf, crown base about 4 m | bottom gap (Mayaud) | **1.0** | 0.53 |
| the same tree with the crown to the ground (or a conifer), crown 12 m wide | WEPS p = 0.2 at 2H = 0.10; G = 12/(12 + 6.3) = 0.66 | **0.41** | 0.22 |

The house's upwind eddy at 2 m reaches about 7.7 m (Lf = 9.2 m).

**Wind-rose effect.** Suppose the house lies upwind for 20% of the weighted daytime wind and the cell is open otherwise (S = 1). Then the house cell's F = 0.2 × 0.47 + 0.8 = 0.89. A single-direction lee therefore matters only where the rose is strongly directional, as Michigan's summer south-west wind may be. Check the rose before expecting large contrasts.

**What would test it.** A handheld anemometer at 1-2 m, at 3H behind the house and in the open yard, against the airport wind over a few windy afternoons. The model predicts a ratio of about 0.47 straight-on, falling to about 0.9 once wind-rose weighted.

## Sources
- Perera 1981, JWEIA 8:93 (aivc.org PDF) [read]
- Peña et al. 2016, WES 1:101 [read]
- Astrup & Larsen 1999, Risø-R-1107(EN), osti.gov/etdeweb/servlets/purl/700466 [read]
- USDA-ARS 2020, WEPS Tech. Doc., AH-727 (nrcs.usda.gov) [read]; WEPS 1996 beta eqs. E-20/21 [read]
- Brandle et al. 2009, *North American Agroforestry* ch. 5 (UNL PDF) [read]
- Cornelis, Gabriels & Lauwaerts (infosys.ars.usda.gov/WindErosion/symposium/proceedings/cornelis.pdf) [read]
- QUIC-URB user's guide (cdn.lanl.gov) [read]
- Hayati et al. 2017, BLM (osti.gov/pages/servlets/purl/1392886) [read]
- Mayaud et al. 2016, ESPL 41:1421 (ORA) [read]
- Hearst et al. 2016, JFM 804:513 [abstract]
- Mittal et al. 2018, J. Build. Eng. 18:154 [read]
- Wang & Takle 1996; Cornelis & Gabriels 2005; the leaf-off porosity studies [2nd]
