# Infrared under shade: near-IR through crowns, longwave by sky view, grass albedo (research, 2026-10-27)

Tags: [read] = full text, or the abstract where it says so, read this session. [2nd] = a search summary, a citing paper, or memory, with nothing checked. The arithmetic was run with the tool's own `pmParts` (scratchpad/calc/ex.mjs).

## HARD: what is measured

**1. Near-IR vs PAR through deciduous canopies**
- Baldocchi, Matt, Hutchison & McMillen 1984, *Agric. For. Meteorol.* 32:307-322 [read: abstract]. Oak-hickory forest in Tennessee, full leaf. PAR as a share of shortwave falls from **0.49 above the canopy to 0.27 at the forest floor**. So the floor's shortwave transmittance is **1.8x its PAR transmittance**. Beam light was not attenuated exponentially, which the authors put down to clumping and gaps.
- Hutchison & Matt 1977, *Ecol. Monogr.* 47:185-207 [read]. Pyranometers, nearby Liriodendron forest. In the summer full-leaf season the floor got about **2% of the shortwave above the canopy** (700 of 31,500 ly; the scanned table's columns are misaligned, so this figure is my reading of it). They say leaves "transmit green and near infrared wavelengths preferentially".
- Goodfellow & Barkham 1974, *Acta Bot. Neerl.* 23:225-230 [read]. 18 spots under beech, 380-1100 nm. Every spot transmitted relatively more beyond 700 nm. **The NIR excess was largest at the darkest spots and "flattened" towards the bright, gappy ones.** This is the gap caveat, measured. It also cites Federer & Tanner 1966 (*Ecology* 47:555), which I did not read.
- Heisler, Grant & Gao 2003, *Agric. For. Meteorol.* 120:113-126 [read: abstract]. In a single tree's shade, relative irradiance on a horizontal surface was **"about 0.1" for both PAR and total shortwave**. At the abstract's precision that shows little or no NIR excess under a single urban tree.
- Heisler 1986, *Urban Ecology* 9:337-359 [2nd]. A sugar maple's shade cut shortwave on a wall by about 80% in leaf. Brown & Gillespie 1990, *J. Arboric.* 16:158 [read: abstract], used pyranometer values only, "light meters... do not yield reliable estimates": summer transmissivity 0.08-0.38 by species.
- Campbell & Norman 1998, *Intro. Environmental Biophysics*, eqs 15.7-15.11 [read, as coded in pyTSEB `calc_spectra_Cambpell`]. Canopy transmission with scattering is τ = exp(−√a·K·L), where a is leaf absorptivity. With a ≈ 0.8 for PAR and 0.2 for NIR [2nd], this gives **τ_NIR = τ_PAR^0.5**.
- Spitters, Toussaint & Goudriaan 1986, *Agric. For. Meteorol.* 38:217-229 [read]. PAR is 0.50 of global radiation. Under a clear sky the diffuse fraction in PAR is **1.4x** the diffuse fraction of global (Rayleigh scattering), so **skylight is PAR-rich, about 0.7 PAR by energy**. Stoutjesdijk 1974 [read] measured the same thing north of hedges: "much blue... little near red".

**2. Turf reflectance.** Bremer, Lee, Su & Keeley 2011, *Crop Sci.* 51:2219-2227 [read]. Kentucky bluegrass, hybrids and tall fescue in good condition: **R661 3.6-10.7%, R935 44-59%**. These are narrow bands. Broadband PAR reflectance is a little higher than red because of green. Broadband NIR (0.7-3 µm) is lower than at 935 nm because water absorbs beyond about 1.3 µm. Taking FAO-56's α = 0.23 for an open spectrum (PAR 0.5) with ρ_PAR ≈ 0.06 implies **ρ_NIR ≈ 0.40**, which fits those bands.

**3. Longwave**
- Pomeroy et al. 2009, *Hydrol. Process.* 23:2513-2525 [read]. Below the canopy, L↓ = V_f·ε_sky·σT_sky⁴ + (1−V_f)·ε_c·σT_c⁴, with V_f the sky view.
  - At night and on cloudy days, needle and branch temperatures matched the air to within 0.1 °C.
  - In dense stands they stayed within about 0.5 °C even when sunny.
  - Sunlit elements in sparse stands ran **5-15 °C above the air**, and sunlit trunks more. That added up to **about 20-30 W/m² (6-15%)** of longwave in bright sun.
  - Trunks stayed 4.5-7 °C warm at night.
- Feldhake 2009, USDA-ARS conference paper [2nd]. Clear summer nights, surface minus air:
  - open pasture, 90% sky: **−6.7 °C**
  - two gap sites: −2.9 and −1.5 °C
  - closed forest, 10% sky: **−0.7 °C**

  −0.7/−6.7 = 0.10, against a sky ratio of 0.11: **night cooling scaled with sky view**. Under cloud there was no difference between sites.
- Stoutjesdijk 1974, "The open shade", *Acta Bot. Neerl.* 23:125-130 [read]. North of a hedge, no sun, a bright clear sky, 11:30, global 579 W/m²:

  | flux | W/m² |
  |---|---|
  | diffuse solar in | 70 |
  | longwave from the sky | 275 |
  | longwave from the surface | 365 |
  | **net radiation, measured** | **−21** |

  **Net radiation stayed at or below zero all day** in August-September. The surfaces held dew and ran 6-8 °C below the air.
- Oke 1981, *J. Climatol.* 1:237-254, and Spronken-Smith & Oke 1998, *IJRS* 19:2085 [2nd]: night cooling is governed by the sky view factor, and open parks with a high sky view cool most. Sicart et al. 2006 [2nd]: sub-canopy L↓ is more sensitive to the sky view than to the obstruction's temperature.

**4. Measured all-wave net radiation in shade.** Peterson, Bremer & Fry 2018, *KAES Res. Rep.* 4(6) [read]. Ten Kansas home lawns against open swards (n = 269/132 days): Rn **7.5 vs 12.2 MJ/m²/d (−39%)**, wind −63%, ET0 −41%. The lawns are mixes of shade types, and no shortwave split was given. I found no single-tree lawn Rn pair with numbers.

## SPECULATION: what the tool should do

**Is Rnl_cell ≈ SVF·Rnl_open fair? Yes, as a daily figure.** If leaves and walls are at air temperature (ε ≈ 0.95-1), the obstructed share of the sky returns what the grass emits, so net loss = SVF × the open loss. Feldhake's night ratio backs this.
- Biases:
  - By day, sunlit upper crowns and walls are warmer than the air, so the loss is a little smaller than this.
  - At night, walls and trunks stay warm, so the loss is smaller again.
  - The shade map's SVF uses PAR-fitted transparency, which counts leaf PAR transmission as sky. That makes the LW sky view slightly high.
  - All three make SVF·Rnl a small **overestimate** of the loss.
- Keep FAO's cloud factor (1.35 Rs/Rso − 0.35) on the **open** Rs. It describes the sky, not the spot.
- **The current scheme scales Rnl by L. Where L < SVF (sun blocked, sky still seen) it credits the obstruction with more longwave shelter than it gives.** Stoutjesdijk's open shade is the extreme case: the real Rn ≤ 0, but L·Rn_open is always positive. So the owner is right that trees and buildings block radiant cooling. It is the current scheme that over-credits that shelter, not under-credits it.

**Formula, per cell per day:**

    Rn_cell = (1 − α_cell)·Rs·Ls_cell − SVF_cell·Rnl_open
    Ls_cell = Ls_b · T_c^x            T_c = Lp / Lp_b (crown PAR transmission)
    α_cell  = p·0.06 + (1 − p)·0.40   p = PAR share of the cell's shortwave (0.5 in the open → 0.23)

- **x** is the NIR exponent.
  - 0.5 is Campbell & Norman's turbid-medium value with a_NIR = 0.2. Broadband NIR beyond 1.3 µm absorbs more than that.
  - Baldocchi's ratio of 1.8 at a 1-3% floor implies **x ≈ 0.7-0.8**. That is my inference across nearby but different forests.
  - Heisler et al. (single tree) point towards 1.
  - **Use x = 0.8, range 0.7-1.0.**
- **Gap caveat.** Applying the exponent to T_c as a whole was fitted on forest floors, sunflecks included, so it partly carries the gaps. If the shade map can give the share of rays that hit no leaf (g), the better form is T_NIR = g + (1−g)·((T_c−g)/(1−g))^x. That is Goodfellow & Barkham's flattening.
- **Ls_b, the building part, is NOT simply Lp_b.** The light left in building shade is mostly skylight, which is PAR-rich. Split the open day into beam and diffuse using Spitters' daily fd and fd_PAR, with diffuse seen = SVF_b and beam seen solved from Lp_b. That needs the **sky view with buildings only** from the shade map.
- Leave the PM denominator and the air term as they are. The wind and cooled-air factors (H43, H44) still apply to the air term.

**Worked example.** July 15, 42.9 N, 200 m, Tmax 28, Tmin 16, RH 60%, u2 2.3, Rs 24. Open: Rso 30.7, Rns 18.48, **Rnl 4.17**, Rn 14.31 MJ/m². PM sun term 0.236 mm/MJ → 3.38 mm, air 1.86, **ET0 5.24 mm**. The ET figures below keep the air term at the open value.

| cell | rad. term now (L × Rn) | (a) NIR / (d) skylight | (b) Rnl by SVF | (c) albedo | proposed | ET now → proposed |
|---|---|---|---|---|---|---|
| open | 14.31 MJ, 3.38 mm | 0 | 0 | 0 | 14.31 | 5.24 → 5.24 |
| crown Lp 0.25, SVF 0.3, x = 0.75 | 3.58 MJ, 0.84 mm | **+0.95 MJ** (Ls 0.30) | −0.21 | −0.21 (α 0.259) | 4.11 MJ, 0.97 mm | 2.70 → **2.83 (+5%)** |
| same, x = 0.85 | 3.58 | +0.53 (Ls 0.28) | −0.21 | −0.12 (α 0.248) | 3.78, 0.89 mm | 2.70 → 2.75 (+2%) |
| same, x = 0.5 (upper bound) | 3.58 | +2.31 (Ls 0.375) | −0.21 | −0.51 | 5.17, 1.22 mm | 2.70 → 3.08 (+14%) |
| north of house, Lp 0.5, SVF 0.7 | 7.15 MJ, 1.69 mm | **−0.96** (d: Ls 0.45, skylight) | **−0.83** | +0.22 (α 0.21) | 5.57 MJ, 1.31 mm | 3.55 → **3.17 (−11%)** |
| same, no skylight shift | 7.15 | 0 | −0.83 | 0 | 6.32, 1.49 mm | 3.55 → 3.35 (−6%) |

(Columns (a)-(c) are each the effect alone, against the current figure. The "proposed" column combines them, so it is not their straight sum.)

**How big each effect is.**
- **(a) NIR under crowns** is the largest effect under trees, at +15 to +27% of the radiation term (+5 to +8% of ET on its own) for x = 0.85-0.75. It is the least certain, because the only single-tree measurement shows almost none.
- **(b) Longwave by sky view** is small under a crown, because SVF is close to L there: −0.05 mm. In building shade it is −0.2 mm (−6% of ET), and it has the most evidence behind it (Feldhake, Stoutjesdijk).
- **(c) Albedo** offsets about a fifth of (a) under crowns, and adds a little back in skylight shade.
- **(d) Skylight**, which the brief did not list, is the size of (b) in building shade and points the same way.

Net result: crown shade gains a little and building shade loses about a tenth. All of these are smaller than the day-to-day swing in the air's share of ET (H43: 0.16-0.39 in June-August).

**Night and dew.** FAO's daily Rnl already holds the night. Under SVF scaling the open lawn's night loss, and with it its dew (negative ET), shrinks under crowns. That is inside the −0.05 mm above, not on top of it. I found no measured dew amounts, open against under-tree.

**What would settle it.** A pyranometer and a PAR sensor side by side under one of the owner's crowns, plus Ls/Lp at the shade map's NEON sites if NEON's ground shortwave product exists there (not checked). The shade map would also need to give g and the buildings-only sky view.
