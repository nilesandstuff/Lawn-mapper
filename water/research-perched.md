# Water perched on a slow layer and flowing downhill under the lawn: the methods, checked (2026-11-01)

A research agent for the water session. Question (the owner's): apply "pool or flow downhill" BELOW the surface --
where water drains through an upper layer faster than the layer below takes it (sand over clay), let it build a
perched water table on the boundary, flow downslope along the top of the slow layer once the layer above is full, and
come out as a seep where that layer meets the surface or the slope flattens; and estimate the SHAPE of the slow layer
across the lot. Tags: [read] = this agent opened the document and read the passage; [code] = read in a model's source;
[queried] = this agent queried the live database or service and read the rows; [abstract] = the abstract only, read
through the Crossref API (publisher sites refused this agent); [arith] = this agent's own arithmetic; [2nd] = from a
search summary or a citing source, not opened; [recalled] = from memory, not checked here. Nothing here has been
checked against a lawn: every recommendation below is SPECULATION until a probe or a well says otherwise.

## Bottom line

- **The right physics is a kinematic, layered bucket routed cell to cell along the slow layer's surface** -- the Soil
  Moisture Routing model's design (Frankenberger et al. 1999: daily, grid cells, Darcy with the slope as the gradient,
  multiple downslope neighbours, leakage through a fragipan) with SWAT's per-layer bookkeeping (percolation set by the
  layer's own Ksat; water above saturation pushed up a layer; lateral flow from the drainable water above field
  capacity) [read + code]. Boussinesq (hillslope-storage, Troch et al. 2003) and Richards (HYDRUS) are the references
  to check it against, not the model: their extra terms are smaller than the uncertainty in the layer's depth and Ksat,
  and an explicit Boussinesq step on 1 m cells of sand needs about 100 sub-steps a day [arith].
- **Equations (per cell, per day):** saturated thickness `h = P / (1000 phid)`; lateral outflow per unit area
  `q = T(h) * sum_j(w_j S_j) / A` with `T(h) = K_lat h` (layered: the sum of K x thickness over the saturated part);
  vertical leak through the slow layer `L = K_L (h + C) / C` (Jackson et al. 2014, unit gradient when h << C);
  solved as a linear reservoir `P_end = P0 e^(-a) + (In / a)(1 - e^(-a))`, `a = K_lat sum_j(w_j S_j) / (phid A)` per
  day, in uphill-first order on the slow layer's surface -- unconditionally stable and exactly mass-conserving; what
  exceeds the room between the roots and the slow layer goes up into the roots and then out of the ground (a seep).
- **The soil survey says "slow layer" in four places, none complete:** chorizon ksat_r (a drop of 10x or more to 1.0
  um/s or less -- "moderately low" or slower); corestrictions.reskind (Fragipan, Densic, Abrupt textural change,
  Strongly contrasting textural stratification, bedrock, ...); the family name's "sandy over clayey"
  (component.taxpartsize); and the Official Series Description's words "perched" vs "apparent". **SSURGO's tables have
  no perched/apparent field** [queried: cosoilmoist holds only depths and Dry/Moist/Wet/Frozen]; the OSD text does
  (Allendale: "The water tends to perch at the interface between the sandy and clayey materials") [read].
- **Kent County's survey lists no restrictive layers at all; Ottawa's lists eight** [queried]. In West Michigan the
  slow layer must come from the horizons: 27 of 107 major soils there drop 10x or more in Ksat within the profile, 11
  of them to 1.0 um/s or less [queried + arith].
- **On lawn slopes perched water mostly pools in place and leaks down.** The downslope travel distance before a
  parcel leaks through the slow layer (Jackson et al. 2014) is under 1 m for most West Michigan contrasts at 1-8%
  slope, 1-3 m for sandy loam over a Bt, and 2-17 m only for sand over clay (Allendale) [arith, survey Ksat]. Seventeen
  published hillslopes: 1 m to several hundred metres, most under 25-50 m (Klaus & Jackson 2018) [read].
- **The layer's shape:** a trend surface from the survey (each placed soil's depth to its slow layer, H62) with one
  parameter for how much of the ground's local relief sits in the upper layer (0: parallel to the ground; 1: a flat
  slow layer, thick mantle under the rises -- the owner's "6 ft at the top of the hill, 2 ft at the bottom"), corrected
  by simple kriging of the residuals at probed points. Few points cannot support a fitted variogram; Wellogic's
  drillers' logs are too coarse (first interval median 15-20 ft) and call loam till "clay" to place a layer 1-2 m deep
  [queried].
- **How much to trust it:** survey Ksat spans 1-3 orders of magnitude between ksat_l and ksat_h; hillslope-scale lateral
  Ksat ran 3-14x the core values above one fragipan (Brooks et al. 2004) [abstract]; one 0.5 ha fragipan hillslope had
  the pan 0.3-0.8 m deep (Dahlke et al. 2010) [read]; and the bedrock (layer) surface, not the ground, steered subsurface
  flow at Panola (Freer et al. 2002) [abstract]. The model can say where perching is likely and roughly how long it
  lasts; where a seep appears depends on a surface nobody has measured, so the page should show it as a hypothesis and
  ask for a probe there.

## 1. How it is done: the models and the practice

### 1a. SWAT (Neitsch, Arnold, Kiniry & Williams 2011, SWAT 2009 theory) and SWAT+'s code

Source opened: Neitsch S.L., Arnold J.G., Kiniry J.R., Williams J.R. (2011). *Soil and Water Assessment Tool
Theoretical Documentation, Version 2009.* Texas Water Resources Institute TR-406.
https://swat.tamu.edu/media/99192/swat2009-theory.pdf, sections 2:3.2 Percolation (p. 151-152), 2:3.4 Perched water
table (p. 158-159), 2:3.5 Lateral flow (p. 160-164) [read]. Code opened: SWAT+ (swat-model/swatplus),
https://raw.githubusercontent.com/swat-model/swatplus/main/src/swr_percmicro.f90, swr_percmain.f90, swr_satexcess.f90 [code].

Percolation, layer by layer, by storage routing [read, Eq. 2:3.2.1-4]:

    SW_excess = SW - FC   (mm, 0 if SW <= FC)
    w_perc = SW_excess * (1 - exp(-dt / TT_perc)),   TT_perc = (SAT - FC) / Ksat     (hours; Ksat mm/h)

TT_perc uses THE LAYER'S OWN Ksat, not the layer below. A slow layer perches water because it drains slowly itself,
fills to saturation, and then cannot accept more: SWAT+ moves water above a layer's saturation (`ul`) up into the layer
above, bottom to top, and out of the top layer as surface runoff (swr_satexcess) [code]. So the limit on what enters
the slow layer is its own drainage plus its remaining room -- the lower layer's Ksat limits percolation, but only
through the fill-and-back-up. With a seasonal high water table flagged, "percolation is not allowed when SW(ly+1) >
FC(ly+1) + 0.5 (SAT(ly+1) - FC(ly+1))... The water will instead stay ponded in the upper layer" [read].

Impervious layer (DEP_IMP) [read, Eq. 2:3.4.1-2]: inside the profile, no percolation out of the profile; below it,
percolation out of the profile is cut by `depth_diff / (depth_diff + exp(8.833 - 2.598 depth_diff))` (depth_diff in m,
bottom of profile to the impervious layer). SWAT+ has "switched to linear relationship for dep_imp and seepage": the
bottom layer's percolation is multiplied by `perco_lim` [code comment]. Perched table height:

    h_wtbl = (SW - FC) / ((POR - FC)(1 - phi_air)) * depth_imp

Lateral flow -- the kinematic storage model of Sloan et al. (1983), summarized by Sloan & Moore (1984) [read, Eq.
2:3.5.1-9]. A hillslope of length L_hill on an impermeable bed at angle alpha; "lines of flow in the saturated zone are
parallel to the impermeable boundary and the hydraulic gradient equals the slope of the bed":

    SW_excess = 1000 H_o phid L_hill / 2          (drainable storage, mm; H_o saturated thickness at the outlet, fraction)
    phid = phi_soil - phi_fc                      (drainable porosity)
    Q_lat = 24 H_o v_lat,   v_lat = Ksat sin(alpha) ~= Ksat slp
    Q_lat = 0.024 * (2 SW_excess Ksat slp) / (phid L_hill)      (mm/day; Ksat mm/h, L_hill m)

SWAT+ [code]: `ho = 2 * sw_excess / ((ul - fc) / thick)`, `latlyr = latq_co * ho * k * slope / lat_len * 0.024`, NONE
from layer 1 (the surface layer), capped at sw_excess; if percolation + lateral exceed the excess they are split in
proportion. Lateral flow leaves the HRU for the channel, lagged by `TT_lag = 10.4 L_hill / Ksat,mx` days [read]; it is
not routed onto the next field.

For the lawn: the per-layer bookkeeping (excess over FC drains; saturation backs up; percolation and lateral share the
excess) is the right skeleton. The geometry is not: one idealized hillslope per HRU, and no interflow run-on.

### 1b. Sloan & Moore (1984)

Sloan P.G., Moore I.D. (1984). Modeling subsurface stormflow on steeply sloping forested watersheds. *Water Resour.
Res.* 20(12): 1815-1822. Paywalled, not opened. The fuller report, Sloan P.G., Moore I.D., Coltharp G.B., Eigel J.D.
(1983), KWRRI Research Report 142, https://uknowledge.uky.edu/kwrri_reports/61 -- record page seen; the PDF refused
this agent. What it did [read, in Paniconi et al. 2003's introduction]: compared 1- and 2-D finite-element Richards
models, a kinematic wave model and two simple storage-discharge models against the Coweeta soil trough (Hewlett &
Hibbert 1963); the simple storage models matched about as well at far less cost [2nd for the result].

### 1c. DHSVM (Wigmosta, Vail & Lettenmaier 1994; Wigmosta, Nijssen & Storck 2002)

Source opened: Wigmosta M.S., Nijssen B., Storck P. (2002). The Distributed Hydrology Soil Vegetation Model. Ch. 2 in
*Mathematical Models of Small Watershed Hydrology and Applications* (Singh & Frevert, eds.) [recalled for the book],
https://www.pnnl.gov/sites/default/files/media/file/The-distributed-hydrology-soil-vegetation-model.pdf, sections 2.6-2.8
(p. 24-29) [read].

- "DHSVM employs a cell-by-cell approach to route saturated subsurface flow ... using either a kinematic or diffusion
  approximation ... On steep slopes with thin, permeable soils, hydraulic gradients may be approximated by local ground
  surface slopes (kinematic assumption). In areas of low relief, hydraulic gradients must be approximated by local
  water table slopes (diffusion assumption)." Eight directions [read].
- `q_s,k = w_k beta_k T(z, D)` (Eq. 2.47), w flow width, beta the water-table slope in direction k, and with lateral
  Ksat decaying exponentially, `T(z, D) = (K / f)(e^(-f z) - e^(-f D))` (Eq. 2.48), z depth to the water table, D soil
  depth [read].
- Return flow: after lateral flow is added, "each layer is then checked ... If [moisture > porosity], v_ex = theta -
  phi ... added to the overlying layer ... Any excess water in the surface layer represents the return of subsurface
  water to the surface and is available for overland flow routing" [read]. The same bottom-up push as SWAT+.
- Roads and channels intercept subsurface flow where the water table is above the cut (Eq. 2.49-2.51) [read] --
  relevant to a lawn's utility trenches and foundation drains (section 5, pitfalls).

### 1d. SMR, the Soil Moisture Routing model (Frankenberger, Brooks, Walter, Walter & Steenhuis 1999)

Source opened: Frankenberger J.R., Brooks E.S., Walter M.T., Walter M.F., Steenhuis T.S. (1999). A GIS-based variable
source area hydrology model. *Hydrol. Process.* 13: 805-822.
https://typeset.io/pdf/a-gis-based-variable-source-area-hydrology-model-2zf0jmbvp2.pdf [read]. Built for shallow soils
over a fragipan or bedrock in the New York Catskills; the closest published analogue to this design.

- Daily, cell by cell, "cells are typically of dimension 10 m to 30 m"; inputs per soil: depth to the restrictive
  layer, its type (fragipan, bedrock, impervious), Ksat, saturated moisture, field capacity, rock fragments [read].
- Water balance, Eq. 1: `D_i dtheta_i/dt = P - ET_i + (sum Q_in,i - Q_out,i) / A - L_i - R_i` [read].
- Lateral flow, Eq. 4, "Darcy's Law and the kinematic approximation; i.e. the hydraulic gradient is equal to the land
  slope": `Q_out,i = w K_i D_i (dh/dL)_i`. Above field capacity "a saturated layer of thickness D_i (theta_i -
  theta_fc) / (theta_s - theta_fc) forms" and Eq. 5 `K_i = (K_s - K(theta_fc)) (theta_i - theta_fc) / (theta_s -
  theta_fc) + K(theta_fc)` -- the same as `K_s h` plus a small unsaturated term [read].
- Multiple flow directions, Eq. 7: `P_ij = ((Z_i - Z_j) / L_j) / sum_n ((Z_i - Z_j) / L_j)` over downhill neighbours;
  single-direction routing "tends to lead to downslope accumulation of moisture into channels or gullies much more
  quickly than is actually seen in the field" [read].
- Leakage: "An 'effective conductivity' of the bedrock and fragipan is specified ... Typical reported fragipan
  conductivities range between 0.1 and 7 mm/day; SMR uses a value of 1 mm/day ... the SMR effective bedrock
  conductivity is 2 mm/day" [read].
- Field capacity of the layer above the pan is "the average profile moisture content when the soil is just saturated at
  the fragipan interface (Steenhuis et al., 1988)" [read] -- the same idea as AquaCrop's FCadj (research-caprise.md).
- The survey's depths came from the typical pedon; auger-hole Ksat averaged 2 m/day, "somewhat higher than the
  permeability range of the soil survey (0.4 to 1.2 m/day)", put down to macropores [read].
- Checked on a 14% transect: modelled downslope wetting +31% vs measured +26% on one date; "Large cell sizes will tend
  to remain wetter because cell slope will decrease" [read].

### 1e. TOPMODEL (Beven & Kirkby 1979)

Wetness index ln(a / tan b) from steady-state saturated flow with Ksat declining exponentially with depth, as
summarized in SMR's introduction, which notes that "where saturation ... soil conductivities decline exponentially with
depth, may not be appropriate in shallow soils" [read]; formulas [recalled]. Not suitable here: steady state, one
connected saturated zone draining to a stream, no perching layer. The tool already uses the index to place soils (H62).

### 1f. The hillslope-storage Boussinesq model (Troch, Paniconi & van Loon 2003) and Dupuit-Forchheimer

Sources opened: Troch P.A., Paniconi C., van Loon E.E. (2003). Hillslope-storage Boussinesq model for subsurface flow
and variable source areas along complex hillslopes: 1. Formulation and characteristic response. *Water Resour. Res.*
39(11), 1316. https://espace.inrs.ca/id/eprint/9474/1/P1127.pdf [read]. Paniconi C., Troch P.A., van Loon E.E.,
Hilberts A.G.J. (2003). ... 2. Intercomparison with a three-dimensional Richards equation model. *Water Resour. Res.*
39(11), 1317. https://espace.inrs.ca/id/eprint/9470/1/P1107.pdf [read].

The Dupuit-Forchheimer/Boussinesq equation for a sloping bed (h normal to the bed, x along it from the outlet, i the bed
angle, k conductivity, f drainable porosity, N recharge) [read, Eq. 1]:

    dh/dt = (k/f) [ cos(i) d/dx( h dh/dx ) + sin(i) dh/dx ] + N/f

The first term is the diffusive (water-table slope) part, the second the kinematic (bed slope) part. With storage
`S = f w h` (w the hillslope width function) [read, Eq. 3-6]:

    dS/dt = -dQ/dx + N w,     Q = -(k S / f) [ cos(i) d/dx( S / (f w) ) + sin(i) ]      (signs restored for x upslope)

Tests used k = 1 m/h, f = 0.3, 2 m soil, 100 m slopes at 5% and 30% [read]. Against 3-D Richards: "able to capture the
broad shapes of the storage and outflow profiles"; best for drainage, worse under recharge (the unsaturated zone);
"the bedrock slope angle was not found to greatly influence the quality of the agreement" [read].

### 1g. HYDRUS (Simunek & Sejna), the reference to check against

Source opened: Simunek J., Sejna M. (2011). *HYDRUS Technical Manual, Version 2.* PC-Progress, Prague.
https://www.pc-progress.com/Downloads/Pgm_Hydrus3D2/HYDRUS3D%20Technical%20Manual.pdf, sections 2.7.2.2 and 5.3.6 [read].
Richards' equation in 2-D/3-D variably saturated media, "arbitrary degree of local anisotropy". The seepage face:
"the length of the seepage face is not known a priori. HYDRUS assumes that the pressure head is always uniformly
equal to zero along a seepage face ... water leaving the saturated zone across a seepage face is immediately removed
by overland flow"; nodes that may seep are listed in advance, and the saturated part (h = 0) and unsaturated part
(Q = 0) are re-split each iteration [read]. That is the exact statement of "comes out where the layer meets the
surface". A check would be a 2-D vertical slice (say 30 m x 2 m, sand over clay, 3% slope) run once offline: perched
depth along the slice and outflow at the face against the bucket's. HYDRUS-2D/3D is commercial Windows software
[recalled], so the routine checks below (section 5) use analytical solutions instead.

### 1h. Engineering practice and hillslope experiments

- Seepage faces in civil practice are the same h = 0 condition (Dupuit with a seepage face; dam and slope seepage)
  [recalled]; perched water against foundations is handled with curtain (interceptor) drains across the slope
  [recalled] -- on a residential lot, trenches and drains may matter more than the soil (section 5).
- **Downslope travel distance** (Jackson, Bitew & Du 2014, *Hydrol. Process.* 28: 3195-3200,
  https://research.fs.usda.gov/download/treesearch/46484.pdf) [read]: slope-parallel flow above, flow normal to the slope
  through a leaky impeding layer (pressure zero at its base):

      q_x' = K_u sin(theta),   q_n = K_L (N + C_n) / C_n        (Eq. 1-2; N saturated thickness, C_n impeding layer thickness)
      L_D = (K_u / K_L) * sin(theta) / ((N + C_n) / C_n) * N      (Eq. 5)

  "Downslope travel distances are driven by the conductivity ratio, not the absolute value of the impeding layer
  conductivity"; on "flatter parts of the hillslope or in areas with little contrast between the conductivities ...
  lateral flow distances will be negligible" [read].
- **Fill and spill** (Tromp-van Meerveld & McDonnell 2006, *Water Resour. Res.* 42, W02411, doi:10.1029/2004WR003800)
  [abstract]: at Panola, little subsurface stormflow below 55 mm of rain; above it, "bedrock depressions on the
  hillslope were filled, water spilled over microtopographic relief in the bedrock surface", flow rose more than
  fivefold, totals 75x. **Freer et al. 2002** (*Water Resour. Res.* 38(12), 1269, doi:10.1029/2001WR000872) [abstract]:
  "DTA of the ground surface did not capture the observed spatial patterns of trench flow ... bedrock surface
  topographic indices significantly improved the estimation". The layer's surface, not the ground, routes the water.

### Which level of physics, and why [the agent's judgment]

| | per cell state | gradient | cost on 50k cells x 3650 days | verdict |
|---|---|---|---|---|
| SWAT lateral (one hillslope per unit) | layer storages | bed slope | trivial | right bookkeeping, no routing |
| SMR / DHSVM-kinematic cascade | one perched store | layer (bed) slope | one sweep a day | **use** |
| DHSVM-diffusion / hsB / Dupuit-Boussinesq | perched store | water-table slope | 100 explicit sub-steps a day in sand at 1 m [arith] | gentle-slope accuracy, not worth it |
| HYDRUS (Richards) | pressure head on a mesh | full | hours per slice | the offline check |

The deciding facts: (1) the slow layer's depth and both conductivities are known to factors of 3-1000 (section 3),
far larger than the error of dropping the diffusive term; (2) on gentle slopes DHSVM's own text asks for the
water-table slope -- handled cheaply by taking, for the rate only, the larger of the layer slope and the perched
water-surface slope (section 2), which also makes perched pools spill; (3) a linear-reservoir cascade in uphill-first
order needs no sub-steps.

## 2. Forming and draining a perched water table in a layered bucket

Layers per cell, top down: the root zone R (the existing FAO-56 bucket, depth Zr); the transmitting layer U, from the
roots to the top of the slow layer at depth zL; the slow layer L, thickness C; below it free drainage, or the H70
water table if that is higher.

1. **Percolation into U is set by U's (and R's) Ksat, not L's.** The balance today drains the root zone at the slowest
   layer below the roots times a drainage-class factor (lib/balance.js `drainDay`). In a perching cell that double-
   counts the restriction: the drainage-class factor already describes the perched water this model now makes. Use
   the slowest layer between the roots and zL, factor 1, limited by the room left in U.
2. **Water above field capacity in U collects at the bottom** (SWAT: "Water builds up in the soil profile from the
   bottom"; SMR: a saturated layer forms above field capacity) [read]. Perched store P (mm of water); saturated
   thickness `h = P / (1000 phid)` m, layered by inverting the cumulative drainable storage cm by cm above zL;
   perched water table depth below ground `zL - h`.
3. **Drainable porosity** `phid = theta_s - theta_fc` (SWAT Eq. 2:3.5.3; SMR's theta_s - theta_fc) [read], from the
   survey's `wsatiated_r - wthirdbar_r` per horizon (vol %). West Michigan [queried]: sands 26-27% (Allendale H2 43 -
   15.9; Iosco H2 38 - 12.3), loamy topsoils 12-24% (Conover E 39 - 27.3; Marlette Ap 41 - 17.4), clayey B 5% (Capac
   B/E 38 - 32.6).
4. **Vertical leak through the slow layer** (Jackson Eq. 2): `L = K_L (h + C) / C` per day, K_L the harmonic mean of
   the slow horizons' ksat_r (series resistance) [recalled physics], C their thickness. Where the H70 water table is above
   the slow layer's base, use heads: `L = K_L max(0, (Z - zL + h) - max(Z_wt, Z - zL - C)) / C` (Z ground, Z_wt
   the H70 table's elevation); with no table above the base this is `K_L (h + C) / C`. SWAT and SMR use
   no gradient (the layer's travel time; a constant 1 mm/day for a fragipan) [read].
5. **Lateral flux** (Darcy, Dupuit): per unit width `q = T(h) S`, `T(h) = integral of K_lat(z) dz` over the saturated
   thickness (= K_lat h for one horizon; DHSVM's exponential decline is one form of this) [read]. Per cell, to each
   downslope neighbour j with flow width w_j: `Q_j = w_j T(h) S_j`; weights as SMR Eq. 7 on the slow layer's surface.
6. **Which slope.** Direction: the slow layer's surface `Z_L = Z_ground - zL` (the bed), as SWAT ("the hydraulic
   gradient equals the slope of the bed") and the kinematic DHSVM; SMR used the land slope because its pan parallels
   the ground [read]. Rate: the larger of the bed slope and the perched water-surface slope to that neighbour, floored
   at about 0.001 (DHSVM's diffusion assumption for low relief, cheaply; the floor is a judgment).
7. **Anisotropy (K_lat vs K_vert).** SWAT, SMR and Jackson use one Ksat [read]. Dabney & Selim (1987, *SSSAJ* 51: 3-6,
   doi:10.2136/sssaj1987.03615995005100010001x) [abstract]: in an Ap "conductivity did not differ in horizontal and
   vertical sampling directions"; in a fragipan (Btx1) vertical was three times horizontal. Brooks, Boll & McDaniel
   (2004, *Water Resour. Res.* 40, W04208, doi:10.1029/2003WR002858) [abstract]: hillslope-scale lateral Ks above a
   restrictive layer was "13.7, 4.1, and 3.2 larger than small soil core measurements in the A, B, and E horizons",
   with "a sharp decrease in K_s within the first 0.1 m". Default K_lat = ksat_r; run a sensitivity at 4x.
8. **Routing cell to cell.** In uphill-first order on the (filled) slow-layer surface, each cell's perched store is a
   linear reservoir: `dP/dt = In - a P`, `a = K_lat sum_j(w_j S_j) / (phid A)` per day, exact over the day:
   `P_end = P0 e^(-a) + (In / a)(1 - e^(-a))`, outflow `P0 + In - P_end`, shared by the weights. A cascade of such
   reservoirs moves water at the kinematic celerity `c = K_lat S / phid` on average (one reservoir per cell, mean delay
   1/a = phid dx / (K S)) [arith], with no stability limit. Leak and lateral are computed as potentials and, if they
   exceed the store, split in proportion (SWAT+'s rule) [code].
9. **Exfiltration (return flow, seeps).** The store's room is `Pmax = 1000 phid (zL - Zr)`. Above it, the excess goes
   up into the root zone (fills its gravity water to satRoom, zeroes the depletion), and what the root zone cannot hold
   leaves the ground -- next day's run-on from that cell (DHSVM's and SWAT+'s bottom-up push; HYDRUS's h = 0 face)
   [read]. Where the slow layer meets the surface (zL -> 0) Pmax -> 0 and everything arriving seeps; where the slope
   flattens, a falls, P rises to Pmax and seeps. If zL is inside the root zone, R itself perches: route R's gravity
   water laterally the same way.
10. **Capillary rise from a perched table** feeds the roots by the existing AquaCrop rule (research-caprise.md) with
    z = depth of the perched table below the roots and U's soil class, whenever it is shallower than the H70 table.

## 3. The slow layer from the soil survey and logs, and its shape across the lot

### What the survey's tables say [queried, Soil Data Access, 2026-11-01]

- **corestrictions** (columns: reskind, reshard, resdept_l/r/h, resdepb_l/r/h, resthk_l/r/h, cokey). reskind values
  nationwide, rows: Lithic bedrock 166,283; Paralithic bedrock 109,623; Densic material 29,923; Fragipan 27,117;
  Strongly contrasting textural stratification 16,144; Duripan 10,310; Natric 10,073; Abrupt textural change 8,597;
  Permafrost 5,532; Petrocalcic 3,902; Densic bedrock 3,803; Undefined 3,084; Manufactured layer 980; Ortstein 780;
  Cemented horizon 454; Sulfuric 166; Salic 165; Plinthite 137; Petrogypsic 102; Petroferric 49; Placic 37. Sulfuric and
  Salic are chemical, not hydraulic, restrictions; "Strongly contrasting textural stratification" may be fine over
  coarse, which holds water above it as a capillary barrier while unsaturated rather than perching a saturated table
  [recalled physics] -- read the horizons to tell which.
- **Kent County (MI081): no corestrictions rows. Ottawa (MI139): eight** (Ortstein 4 at about 35 cm, Densic material 2
  at 113 cm, Abrupt textural change 1, Strongly contrasting textural stratification 1).
- **chorizon**: hzdept_l/r/h (Conover's C horizon from 46 to 120 cm, r 81; Marlette's Bt 25-66, r 46; the older
  Allendale and Iosco data have no l/h), ksat_l/r/h (Capac B/E 0.02 / 0.2 / 10 um/s; Allendale clay 0.01 / 0.205 /
  0.42), wsatiated_r, wthirdbar_r, dbthirdbar_r, clay/sand; horizon name suffixes x (fragipan), d (densic), m
  (cemented), Cr / R (bedrock), and a leading 2 (a different parent material) [recalled].
- **A drop of 10x in ksat_r** in the 107 distinct major soils (name and drainage class) of Kent and Ottawa: 27; of these, 11 to 1.0 um/s or
  less (Allendale 0.205 at 86 cm under 92; Capac 0.2 at 20 cm; Conover 0.55 at 31; Edwards 0.55; Marlette 0.1 at 46;
  Onekama and Perrinton 0.0555 at 31 and 20; Pinconning 0.205 at 91; Rimer 0.91 at 81; Saugatuck 0.5 (ortstein) at 33;
  Warners 0.91) [queried + arith].
- **component.taxpartsize / taxclname**: strongly contrasting families say it directly -- "Sandy over clayey"
  (Allendale, Pinconning), "Sandy over loamy" (Iosco, Belleville). taxgrtgroup's Epi- (perched) vs Endo- (from below)
  would too, but older names don't use them (Allendale is an Alfic Haplaquod) [queried].
- **cosoilmoist** (soimoistdept/depb l/r/h, soimoiststat, comonthkey): status values Wet 3,509,270, Moist 4,557,063,
  Dry 418,778, Frozen 1, null 816,909. **No perched/apparent field.** In principle a Wet layer above a Moist layer in the
  same month is perched (episaturation is saturation with an unsaturated layer below it within 200 cm [recalled]);
  about 465,000 Wet-row/lower-Moist-or-Dry-row pairings exist nationally in the same month (of 3.5 million
  Wet rows; a pair count, not a soil count). But it does not sort the cases: Allendale
  (OSD: perched) shows Wet 46-76 over Moist 76-183 in April; Iosco (OSD: apparent) shows the same pattern, Wet 31-76
  over Moist 76-183; Capac (OSD: apparent) shows Wet 30-203 -- the 76/183 split looks like an old data conversion. Weak
  evidence only.
- **muaggatt**: wtdepannmin, wtdepaprjunmin, brockdepmin (bedrock only), drclasswettest -- unit summaries, no kind.
- **Official Series Descriptions** (ncss-tech OSDRegistry, plain text, browser-readable: access-control-allow-origin *
  [queried]; e.g. https://raw.githubusercontent.com/ncss-tech/OSDRegistry/main/OSD/A/ALLENDALE.txt) [read]: Allendale
  "a perched seasonal high water table ... 15 to 61 cm ... The water tends to perch at the interface between the sandy
  and clayey materials"; Conover and Rimer "perched"; Iosco and Capac "apparent"; Selfridge, Marlette, Perrinton
  unstated. This is the only national place the kind is written down.

### Thresholds in practice

- NRCS Ksat classes, um/s: very low < 0.01; low 0.01-0.1; moderately low 0.1-1; moderately high 1-10; high 10-100;
  very high >= 100 [2nd: two secondary sources agree; consistent with OSD wording read here, e.g. "0.01 - 1.0
  micrometers per second" = "very low to moderately low"; NRCS's own site did not answer this agent].
- The older permeability classes (in/h; the names [recalled]) convert to the boundaries OSDs still print [arith,
  1 in/h = 7.056 um/s]: very slow < 0.06 (< 0.42 um/s); **slow 0.06-0.2 (0.42-1.41)**; moderately slow 0.2-0.6
  (1.41-4.23); moderate 0.6-2 (4.23-14.1); moderately rapid 2-6 (14.1-42.3); rapid 6-20 (42.3-141); very rapid > 20.
  OSDs pair them: Wyanet "moderately high (1.41 to 4.23 micrometers per second) ... moderately slow" [read].
- A perching rule for the tool [judgment from the arithmetic]: a horizon perches if its ksat_r is 1.0 um/s or less
  (86 mm/day; a day's soaking after heavy rain is tens of mm) AND a tenth or less of the fastest horizon above it; or a
  corestrictions row of a hydraulic kind; or a taxpartsize "coarse over fine". Against the OSDs: Allendale (0.205),
  Conover (0.55), Rimer (0.91) perched -- yes; Iosco (2.7) apparent -- correctly not; Capac (0.2) apparent -- a miss.

### The shape across the lot

1. **Where each soil is.** H62 already places each map unit's soils by wetness index; each placed soil carries its own
   depth to the slow layer (hzdept_r of the first perching horizon, or resdept_r), its range (hzdept_l-h or resdept_l-h)
   and its K_L.
2. **A trend surface tied to the land** (soil scientists predict depths from terrain: Tesfa et al. 2009, *Water Resour.
   Res.* 45, W10438, doi:10.1029/2008WR007474, explained "about 50% of the soil depth spatial variation" from terrain and
   land cover at 819 points, "an important improvement over the soil depth extracted from the SSURGO" [abstract]).
   One parameter, beta, for how much of the ground's local relief sits in the upper layer:

       Zs = the ground smoothed over 30-50 m;   zL(x) = d0 + beta (Z(x) - Zs(x))      (depth below ground, m)

   beta = 0: the layer parallels the ground; beta = 1: the layer is as smooth as Zs and the mantle is thick under the
   rises and thin in the hollows (the owner's example). d0 = the placed soil's depth, beta chosen so the lot's spread of
   zL matches the soil's hzdept_l-h range, default 0.5 where no range is given [judgment]. Smooth the ground first (5 m)
   so lidar noise does not become slow-layer slope.
3. **Refined with points** (a probe or auger: "clay at 18 in here"; a test pit): simple kriging of the residuals
   r_k = observed - trend, with a fixed exponential covariance (no fitted variogram: a handful of points cannot support
   one; geostatisticians want on the order of 100 [recalled]):

       r(x) = c(x)^T (Cov + s_n^2 I)^-1 r,   var(x) = s^2 - c(x)^T (Cov + s_n^2 I)^-1 c(x),   Cov_kl = s^2 exp(-d_kl / lambda)

   s = (hzdept_h - hzdept_l) / 4, lambda about 30 m (Dahlke et al. found the pan 0.3-0.8 m deep across one 0.5 ha
   hillslope [read]), s_n about 0.1 m for a probe. Far from points it returns to the trend; the variance map is the
   page's "how sure" and points to where to probe next. With 1-20 points this is a 20 x 20 solve.
4. **Wellogic** (Michigan only; the lithology table, https://gisagoegle.state.mi.us/arcgis/rest/services/EGLE/DwOpenData/MapServer/4,
   fields WELLID, SEQ_NUM, PRIM_LITH, LITH_MOD, DEPTH (bottom of the interval, ft), THICKNESS, AQTYPE; CORS allowed
   [queried]; the wells layer carries owners' names -- never request them, as research-groundwater.md says). 1.7 km
   boxes at three public places [queried + arith]:

   | | wells with logs | first interval, median | first "clay"/till top, ft (p10 / p25 / p50 / p75 / p90) | clay within 2 m |
   |---|---|---|---|---|
   | Allendale | 155 | 15 ft | 2 / 9 / 15 / 18 / 21 | 14% |
   | Byron Center | 311 | 15 ft | 0 / 0 / 0 / 6 / 22 | 72% |
   | Rockford | 112 | 20.5 ft | 0 / 0 / 13 / 40 / 58 | 42% |

   Around Allendale, where the survey puts clay at 86 cm, the logs' median clay top is 15 ft; around Byron Center more
   than half the logs start in "clay" -- drillers call loam till clay. The logs cannot place a 1-2 m layer; they can
   say whether a clay or till sheet lies within about 3-6 m (which holds the H70 water table up), with a large nugget.

### How much to trust it

Ksat: factors of 3-1000 between ksat_l and ksat_h [queried]; hillslope vs core 3-14x (Brooks 2004) [abstract]; SMR's
auger-hole Ksat 1.7-5x the survey's (2 m/day against 0.4-1.2) [read]; Parlange et al. 1989 (*Soil Science* 148: 77-86; abstract at
https://research.monash.edu/en/publications/subsurface-flow-above-a-fragipan-horizon/) found "the cracks within the
fragipan carried significant portions of the interflow" and crack spacing "the main controlling factor" [read] -- a
leaky layer is the rule. Depth: one representative value per soil, placed by a wetness index (H62, unchecked);
0.3-0.8 m across one 0.5 ha hillslope. Shape: unknown without points. **Rule for the page:** say "perched water likely
here in these months" with confidence; say "a seep may appear here" as a hypothesis, with the probe that would test it.

## 4. Measured lateral flow above fragipans and clay layers: sanity checks

| Study | Setting | Measured | Tag |
|---|---|---|---|
| Klaus & Jackson 2018, *WRR* 54, doi:10.1029/2018WR022920, https://www.osti.gov/pages/servlets/purl/1572280 | 17 published hillslopes | travel distances "from around 1 m to several hundred meters"; 13 under 50 m, 11 under 25 m, 9 under 16 m; "leaky impeding layers ... are the norm" | [read] |
| ... their Table 1: Jamison & Peters 1967 | Missouri pasture, 0.28 m A over a claypan Bt | K 497 vs 0.106 mm/h (ratio 4700), slope 0.03: 39.5 m | [read] |
| ... McDaniel et al. 2008 | Palouse, 0.7 m silt loam over a Btxb fragipan | K 8.13 vs 0.38 mm/h (21), slope 0.16: 2.4 m | [read] |
| ... Whipkey 1965 | east-central Ohio, sandy loam over clay loam Bt at 1.2 m | K 286 vs 2 mm/h (143), slope 0.28 | [read] |
| ... Detty & McGuire 2010 | New Hampshire, Spodosols over glacial till | K ratio about 2, about 16 when perching reaches the surface | [read] |
| ... Jackson et al. 2014, 2016 | SE sandhills, loamy sand over Bt at 0.2-2 m | ratio 184, slopes about 0.08: typical 14.7 m, under 20 m mostly | [read] |
| Dahlke, Easton, Brown, Steenhuis 2010 (EGU2010-1008), https://meetingorganizer.copernicus.org/EGU2010/EGU2010-1008.pdf | central New York, fragipan, 12% slope, 12.5 m trench | storms: 56% surface runoff, 25% at the soil-fragipan interface, 19% from below the pan; dry periods: 52% interface, 30% below, 18% surface; pan 0.3-0.8 m deep; a sand lens through it | [read] |
| Frankenberger et al. 1999 | Catskills, fragipan/bedrock, 14% transect | SMR +31% vs measured +26% downslope wetting; fragipan leakage 0.1-7 mm/day in the literature | [read] |
| Brooks, Boll & McDaniel 2004 | 18 x 35 m plot over a restrictive layer, drains | hillslope lateral Ks 3.2-13.7x cores | [abstract] |
| Tromp-van Meerveld & McDonnell 2006 | Panola, Georgia, 20 m trench, 147 storms | threshold 55 mm; above it two orders of magnitude more subsurface flow | [abstract] |
| Day et al. 1998, *Soil Science* 163: 517-528, doi:10.1097/00010694-199807000-00001 | Pennsylvania fragipan, in situ soil block | 63% of input lateral above the pan, 10% through prism faces within it, 27% vertical | [2nd] |
| McDaniel et al. 2008, *Catena* 73: 166-173, doi:10.1016/j.catena.2007.05.011 | Palouse | lateral flow "as much as 90%" of early-spring precipitation and snowmelt | [2nd] |

**The same formula on West Michigan soils** (Jackson Eq. 5 with survey ksat_r, N = the whole upper layer, C = 1 m;
leak time = N phid / (K_L (N + C)/C)) [arith]:

| Soil (upper over slow layer) | K_u / K_L um/s | ratio | L_D at 1% / 3% / 8% | lens leaks in | lateral capacity at 3%, L per m width per day |
|---|---|---|---|---|---|
| Allendale (sand over clay at 86 cm) | 92 / 0.205 | 449 | 2.1 / 6.2 / 16.6 m | 7.0 d | 205 |
| Marlette (sandy loam over Bt at 46 cm) | 11 / 0.1 | 110 | 0.35 / 1.0 / 2.8 m | 7.3 d | 13 |
| Capac (loam over B/E at 20 cm) | 11 / 0.2 | 55 | 0.09 / 0.27 / 0.73 m | 2.1 d | 6 |
| Iosco (sand over loam at 79 cm) | 92 / 2.7 | 34 | 0.15 / 0.45 / 1.2 m | 0.5 d | 188 |
| Perrinton (loam over clay at 20 cm) | 1.0 / 0.0555 | 18 | 0.03 / 0.09 / 0.24 m | 4.9 d | 1 |
| Conover (loam over Bt at 31 cm) | 5.5 / 0.55 | 10 | 0.02 / 0.07 / 0.19 m | 0.6 d | 4 |

Read: on a lawn, perched water in most of these soils pools and drains down within its own square metre or two; only
sand over clay moves it metres to tens of metres (x4 with Brooks's scale factor: 8-66 m for Allendale) -- the case the
owner described. A model that showed interflow crossing a whole lot of silt loam over a Bt would be wrong by this check.

## 5. Recommended design for the balance (the agent's; the session to decide)

### State and inputs per cell

- New state: `P` (perched water, mm). Existing: `Dr`, `grav`, `pond`.
- Static: `zL` (m, the layer surface from section 3, with its variance), `Zr` (root depth, existing), `phidU` (and the
  cm-by-cm cumulative drainable storage and transmissivity tables of U per soil), `K_L` and `C`, the downslope
  neighbours and weights on the priority-flood-filled slow-layer surface `Z - zL`, and their uphill-first order (once,
  like the surface `order`).
- Only perching soils (section 3 rule) get the store; elsewhere the balance is as today.

### The daily steps, in order

1. Surface: rain, roofs, run-on, curve number, infiltration into R, low-spot ponds (unchanged); add yesterday's seep
   water as run-on from its cell.
2. Root zone drains into U: `d = min(grav * 0.6, K_RU * 24, Pmax - P)` (mm/day; K_RU in mm/h) where K_RU is the
   slowest layer from the roots to zL (no drainage-class factor); `grav -= d; P += d` (a judgment: water crosses U in the same day; for sand that is
   hours).
3. Perched store, uphill first on the layer surface: potentials `leak = K_L (h + C)/C * 1 day` (head form under a high
   H70 table) and lateral by the linear reservoir with today's inflow; split if they exceed the store; send the lateral
   share to the neighbours by weight; `tot.leak`, `tot.latOut`, `tot.latIn`.
4. Room: if `P > Pmax`, move the excess to R (`grav` up to satRoom, `Dr` to 0), the rest to `seep` (tomorrow's run-on;
   `tot.seep`).
5. Water use (unchanged), then capillary rise from the shallower of the perched table (z = zL - h - Zr) and the H70 table.
6. Frozen ground: no leak or lateral when the week's mean air temperature is at or below 0 C (SWAT stops all soil water
   movement in a layer at or below 0 C [read]; air temperature as the proxy is a judgment).

### Default parameters

| Parameter | Default | Source |
|---|---|---|
| perching horizon | ksat_r <= 1.0 um/s and <= 0.1 x the fastest above; or a hydraulic reskind; or taxpartsize coarse over fine | section 3 [judgment from arith] |
| K_L | harmonic mean of the slow horizons' ksat_r, floor 0.01 um/s; fragipan with no ksat: 1 mm/day; bedrock 2 mm/day | SMR [read] |
| C | the slow horizons' thickness to the bottom of the data, at least 0.3 m | [judgment] |
| K_lat | ksat_r of each horizon of U (layered T(h)); sensitivity x4 | SWAT, SMR [read]; Brooks 2004 [abstract] |
| phid | (wsatiated_r - wthirdbar_r)/100 per horizon, floor 0.02 | SWAT Eq. 2:3.5.3 [read]; [queried] |
| rate gradient | max(bed slope, perched water-surface slope), floor 0.001 | DHSVM's two assumptions [read]; floor [judgment] |
| flow weights | SMR Eq. 7 (slope over distance, all downhill neighbours) | [read] |
| layer trend | Zs = ground smoothed 30-50 m; beta from the hzdept range, else 0.5 | [judgment] |
| kriging | exponential, lambda 30 m, s = (hzdept_h - hzdept_l)/4, probe s_n 0.1 m | [judgment]; Dahlke 2010 for scale [read] |
| buffer round the lot | max(20 m, 4 x L_D of the soil) uphill | section 4 [arith] |

### What to report

Per cell: months with a perched table within 30 cm of the surface and within the roots; water arriving from uphill
below ground (mm/yr); seep water (mm/yr) and the days it ran; leak (mm/yr); the depth to the slow layer with its +- and
the points used. Per lot: the totals and a mass-balance line (rain + irrigation + rise = ET + runoff out + drainage +
leak + lateral out of the window + change in storage, to under 0.1 mm a year). Each soil's travel distance L_D next to
its name, so the reader sees whether sideways flow can matter there at all. The run at K_lat x 4 and at K_L's l and h
as the spread.

### Checks to build in (cheap, analytical)

- Steady recharge R on a uniform slope, uniform K, no leak: `h(x) = R x / (K S)` (x from the divide); the table
  reaches the roots at `x = K S (zL - Zr) / R` and the ground at `x = K S zL / R`, and beyond that all arriving water
  seeps [arith]. The cascade should reach it.
- With leak: the mean distance travelled before leaking should match Jackson's L_D within a cell or two.
- Mass balance to rounding, every run.
- The survey as a target: in a soil whose OSD says "perched", the modelled months with a table above the slow layer
  should roughly match its Wet months; never perching there means K_L is too high (it is the least known number).

### Pitfalls

- **Stability.** Explicit Boussinesq on 1 m sand cells needs `dt <= dx^2 / (4 K h / phid)`: about 100 sub-steps a day
  for Allendale or Iosco, 26 at 2 m, 5 at 5 m; the loams 1-9 [arith]. Explicit kinematic outflow `K h S dt` overshoots
  when the Courant number `K S dt / (phid dx)` exceeds 1: 2.4 for Allendale at 8% [arith]. The exact linear-reservoir
  update avoids both. If cost bites, run the subsurface on 2 m cells: the layer is not known to 1 m.
- **Mass.** Track every flux; leak, lateral and seep each a total; lateral in and out sum to zero inside the window.
- **Edges.** Perched water from the neighbours' yards uphill cannot be seen inside the lot: run on a buffer, or flag
  cells within L_D of an uphill edge. Edge outflow is a loss to report, not an error.
- **Layer-surface pits and flats.** Route on the filled surface; the water-surface gradient lets a perched pool fill and
  spill (Tromp-van Meerveld & McDonnell 2006). Without it, flats hold water forever and seep.
- **Lidar noise.** A layer drawn parallel to the 1 m ground inherits its noise as slope; smooth first.
- **Double counting.** The drainage-class factor, the "blocked" rule (table within 30 cm of the roots) and the survey's
  wet months in H70 all describe the same perched water. In a perching cell let the perched store do it; keep the
  survey's months for the apparent (groundwater) table only, and use them in perching soils as the check above.
- **Only 1.5-2 m of data.** No slow horizon within the data: no store. A slow horizon that is the last one: its
  thickness is unknown -- take what is listed, at least 0.3 m, gradient near 1. Below the data: free drainage unless
  H70 says the table is higher; in Michigan, Wellogic's logs can say whether clay continues (72% of Byron Center logs
  have clay within 2 m).
- **The lot itself.** Foundation drains, sump pits, sewer and water trenches backfilled with gravel, and imported
  topsoil over compacted fill intercept or create perched water (DHSVM's road-cut interception is the same physics
  [read]). None is in any national dataset; the page could let a user draw a drain line like a downspout, which would
  remove perched water crossing it.
- **Survey vintage.** Older survey areas (Ottawa's Allendale and Iosco) lack depth ranges, and their monthly wet layers
  repeat a 46/76/183 cm pattern that does not distinguish perched from apparent.

What would make this true to life: a probe transect down one sloping lawn on a sand-over-clay soil (depth to clay every
5 m), a few shallow wells (perforated pipe to the clay) read after rain for two seasons, and a note of where the lawn
stays soft. That one data set would test the layer shape, K_L (how long the lens lasts) and whether the seep shows up
where the model puts it.
