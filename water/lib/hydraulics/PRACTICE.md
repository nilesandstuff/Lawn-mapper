# How residential irrigation is actually laid out and sized (sourced)

Compiled 2026-10-20 for the pressure model (heads, backflow preventer and valve box mapped by the
user; pipes routed and sized by the tool; pressure and flow estimated at each head). Every claim
below names its source.

Tags, as in ../../PARAMS-SOURCES.md:
- **[read]**: I read it in the primary document (or an official copy of it) and quote or transcribe it.
- **[fig]**: my reading of a figure in a primary document. The document's text does not say it.
- **[2nd]**: from a secondary copy, a summary or a search snippet. I did not read the primary.
- **[unverified]**: commonly said, but no source found in this pass. Do not hard-code it.

Sections marked **SPECULATION** are my inferences for the model. Nothing measured them.

## The primary documents

| Short name | Document | Where |
|---|---|---|
| **RB-LIDM** | Rain Bird, *Landscape Irrigation Design Manual*, ©2000 Rain Bird Sprinkler Manufacturing Corp. | https://rainbird.com/media/4214 (the same file as rainbird.com/documents/turf/IrrigationDesignManual.pdf) |
| **Hunter-US** | Hunter Industries, *Residential System Design Guide*, LIT-226-US H 5/20 (©2020) | https://redesign.hunterindustries.com/sites/default/files/design_guide_Residential_System_LIT-226-US.pdf (the current 2025 Rev I copy on hunterirrigation.com returned 403 Access Denied) |
| **Hunter-EM** | The same guide, metric edition, LIT-226-EM (PDF created 2019) | https://redesign.hunterindustries.com/sites/default/files/design_guide_Residential_System_LIT-226-EM.pdf |
| **Hunter-2011** | Hunter, *Residential Sprinkler System Design Handbook*, LIT-226 H 9/11 (©2011), an older edition | https://stma.org/sites/stma/curriculum/Ln_4c/DG_ResidentialSprinklerSystemDesignHandbook_dom%20(2).pdf |
| **Toro-DIY** | Toro, *Do-It-Yourself Irrigation Planning & Installation Guide* (PDF created 2013) | https://images.homedepot-static.com/catalog/pdfImages/8a/8ab728fa-d9ba-4393-b13f-36f0b6c263ff.pdf |
| **Toro-gauge** | Toro, *Flow Gauge Model 995-01 and 53351, Operating and Service Instructions* (©1993, form 362-0015 rev D) | https://bwsr.state.mn.us/sites/default/files/2022-01/Toro%20Flowmeter%20Instructions%20and%20Parts%20List.pdf |
| **IA-BMP** | Irrigation Association & American Society of Irrigation Consultants, *Landscape Irrigation Best Management Practices*, March 2014, Practice Guideline 1 (Design), reproduced inside Spokane's *Model Efficient Irrigation and Landscape Design Standards* draft of 2019-03-12 | https://www.spokaneaquifer.org/wp-content/uploads/2019/03/Water-Efficient-Landscape-Guidelines-DRAFT-3.12.19.pdf (the City of Bend copy returned 403) |
| **NC-BMP** | North Carolina Irrigation Contractors' Licensing Board, *BMPs and Minimum Standards*, rev. 2009-07-21, "enforceable on July 1, 2009" | https://deq.nc.gov/watereducation/turf-irrig-bmps/download |
| **OSU-6617** | Moore, K. & Moss, J.Q., *Managing Pressure in the Home Irrigation System*, Oklahoma Coop. Ext. HLA-6617, March 2019 | https://pods.okstate.edu/fact-sheets/HLA-6617pod.pdf |
| **Stryker** | Jess Stryker, IrrigationTutorials.com (a practitioner's design tutorial) | pages cited where used |
| **Thornton** | City of Thornton, CO, *Private Irrigation System Design Checklist* | https://thorntonco.gov/media/file/private-irrigation-system-design-checklist |
| **FAO-PIT** | FAO, *Pressurized Irrigation Techniques*, chapter 4 "System design" (document a1336e) | http://www.fao.org/4/a1336e/a1336e04.pdf |

---

## 1. How laterals are laid out from the valve to the heads

### 1a. What the design guides say (HARD)

**Tree, fed from the middle, not a snake.**
- RB-LIDM p. 57 [read]: "The straight line lateral circuit, where the valve is located at the extreme end of the
  line, is the least optimum of all lateral designs." In that layout, "Pressure differences between the sprinklers on
  the extreme ends of the lateral are the greatest... This can cause large variations in discharge and performance."
- RB-LIDM p. 57 [read]: the split-length lateral, with the valve in the centre of the line of sprinklers, splits the
  flow in half. This "can often reduce the size of pipe required and balance the pressure losses throughout the
  circuit."
- RB-LIDM p. 57 [read]: "Where possible, the valve serving a group of sprinklers should be at the center of the group
  to balance the flow and size of lateral pipe."
- RB-LIDM pp. 57-58 [read]: two-row circuits "can be split." A deep "U" circuit reaches planters without the main
  entering them. The sample design uses an "H" pattern (area A) and a "U" (area C). The goals are "Minimizing pressure
  changes, balancing flows, minimizing pipe sizes and size changes, and locating the valve where it won't be in the
  way."
- Hunter-US p. 10 / Hunter-EM p. 10 [read]: "Draw a line connecting all of the sprinkler heads in each separate zone...
  draw the most direct route with the fewest turns or changes of direction as possible." Then "Draw a line from the
  sprinkler line to the zone valve. This should be the most direct line possible."
- Hunter-EM p. 10, figure "Connecting Sprinklers with PVC or Poly Pipe" [fig]. Two layouts of six heads (two columns of
  three) are labelled RIGHT:
  1. a central trunk with three short cross-branches, each feeding a pair of heads;
  2. two parallel row-lines joined at one end by a cross-piece that is fed in its middle.

  Two layouts are labelled WRONG. Each is a single serpentine that passes through every head in series, fed from one
  end. All four are trees. **None is a loop.** The difference is whether the flow splits near the feed.
- Hunter-EM p. 10, site plan [fig]: the laterals of the perimeter zones run along the lawn edges, parallel to the
  house, beds and lot line. The valves are grouped in manifolds near the house.

**Loops.**
- Looping is discussed for **mainlines**, not sprinkler laterals. Stryker, "How to Design a Looped Irrigation Mainline"
  (https://irrigationtutorials.com/using-a-looped-mainline-for-irrigation/) [read via fetch]: "For smaller sprinkler
  irrigation systems they often provide little or no advantages... if you have less than 10 valve zones you are not
  going to get much of an advantage."
- NC-BMP §14e [read] recommends looping the ends of **drip** laterals ("Connect (loop) the ends of individual laterals
  to improve system uniformity").
- I found no guide that recommends looping residential **sprinkler** laterals.

**One lateral with short stubs to each head.**
- Rain Bird, *Swing Pipe Installation Tips* (2008, https://rainbird.com/media/4516) [read]:
  - Swing pipe connects heads "(up to 10 gallons per minute) to lateral irrigation lines." You lay the lateral, then
    "Lay out swing pipe from head back to the point of lateral pipe connection (saddle tee, PVC, or poly fitting)."
  - "Design calculations for pressure loss should be considered when using lengths longer than 36 inches."
  - Where a machine is used: "plan to run the lateral as close to hardscape as the equipment permits and swing pipe the
    remaining distance."
- Hunter-US pp. 12-13 (system overview) [read]: heads sit on a "½" Swing Joint" (sprays) or a "¾" Swing Joint"
  (rotors). The metric overview labels the lateral fitting "PVC Reducing Tee (Slip x Slip x Thread)" (Hunter-EM
  pp. 12-13) [read].
- Hunter-US p. 21 (pipe sizing illustration) [read]: one line passes head to head. Its size steps up toward the valve:
  ½, ½, ¾, ¾ in for four 2 gpm heads in the US edition (13, 13, 20, 20 mm and 7.5-30 l/min in the metric one).
- IA-BMP §5.3e [read]: "Space sprinklers a minimum of 2 inches from hard surface edges."

**Mains and laterals.**
- RB-LIDM p. 57 [read]:
  - "Main line pipes are the most expensive pipes; minimize the length of the main line pipe route."
  - "the main line and lateral lines can share the same trench in some areas of the project to reduce labor costs."
- Hunter-US p. 11 [read]:
  - "Draw a line connecting all the manifolds together, and then draw a line connecting this line to the P.O.C."
  - "The main line should generally be one pipe size larger than the largest lateral line."
- Hunter-2011, glossary [read]: "install the low-voltage wires in the same trench below the main line pipe."

**Pipe material by region.** Travis Irrigation FAQ (https://watertips.com/info/FAQpipe.htm) [read via fetch]:
- poly "is used in colder climates since it is more flexible";
- "in warm climates, rigid PVC pipe is preferred."

Hunter-US p. 16 [read]: "If you are installing poly pipe, you may want to use a pipe puller." See also Rain Bird's
"vibratory plough" above.

### 1b. Depth (HARD, and the sources disagree)

| Source | Main | Lateral | Notes |
|---|---|---|---|
| Hunter-US p. 15-16 [read] | trench 10-12 in | trench 6-8 in | "If there are no established local codes" |
| Hunter-2011 glossary [read] | deeper than laterals | "at least 6" to 8" deep" | 6-8 in avoids damage "due to weeding or the planting of annual color" |
| Toro-DIY p. 10 [read] | trench 8-12 in | trench 8-12 in | |
| IA-BMP §7.3b [read] | 12 in **cover** (residential) | 8 in cover (residential) | Commercial 18/12. "Under vehicular paving" 24/24. |
| NC-BMP §D4 [read] | 12 in cover | 12 in cover | Enforceable in NC. 4 in allowed only inside a protective larger pipe where an obstacle makes 12 in impractical. |
| RB-LIDM p. 60 [read] | "often... about 12 in (30 cm) below the surface" (residential) | not given | Deeper, or drain valves, in freezing climates |

Trench depth (Hunter, Toro) and cover over the pipe (IA, NC) are not the same measurement.

### 1c. Sleeves and paving (HARD)

- **IA-BMP §7.4a** [read]:
  - Under vehicular paving, pipe goes in a rigid sleeve (PVC at least Sch 40 or Class 160).
  - The sleeve is "twice the size of the piping" (2 in pipe in a 4 in sleeve).
  - Pipe and wire go in separate sleeves.
  - The sleeve extends "a minimum of 2 feet beyond the edge of hard surfaces."
  - Sleeves "should be marked for future location."
- **Hunter-US p. 15** [read]: under an existing walkway or driveway, use the "Jetting Method" (hose plus pipe).
  Hunter-2011 also gives a "Hammering Method" (a capped galvanized pipe driven through).
- **Travis FAQ** [read via fetch]:
  - "it's probably smartest to route the main around the back yard";
  - "It is almost always far simpler to spend a few extra dollars to upsize the main by one pipe size" than to go
    under the drive;
  - asphalt "will probably eventually collapse if you tunnel under it."
- **RB-LIDM p. 60** [read]: in the sample design, the designer "would have preferred" to branch the main under a
  walkway. Because the walkway was already installed, "the designer was forced to nearly circle the property with the
  main line." **An existing walk or drive bends the route.**
- **NC-BMP §D1** [read]: avoid trenching across established tree roots. If you must, trench "at a right angle to the
  base of the tree."

### 1d. Which routing algorithm predicts real trenching?

**HARD (what exists):**
- No study compares an algorithm's layout with real residential trenches. Nor does any manufacturer guide. The guides
  give rules (above), not an algorithm.
- Agricultural and distribution-network layout literature uses spanning and Steiner trees:
  - Duin, C. & Voss, S. (1993), "Heuristic methods for the rectilinear Steiner arborescence problem," *Engineering
    Optimization* 21(2):121-145 [2nd, abstract via iaorifors.com/paper/11039]. They name irrigation and drainage
    network design as the application, and include "forbidden regions or obstacles."
  - Gonçalves, G.M. & Pato, M.V. (2000), *Annals of Operations Research* 94:163-179 [2nd, repository record and
    RePEc]. A three-phase procedure: a short-length Steiner forest for the links, then flows, then pipe and pump
    sizing by mixed binary linear programming.
  - Gajghate, P.W. et al. (2021), "Optimization of Layout and Pipe Sizes for Irrigation Pipe Distribution Network
    Using Steiner Point Concept," *Math. Problems in Engineering* 2021:6657459, doi:10.1155/2021/6657459 [2nd,
    abstract]. For a canal-command network: MST by Prim's algorithm from a looped network, then Steiner points. The
    Steiner tree was "12.21%" shorter than the MST.

  These are field-scale networks, not yard laterals.

**SPECULATION (for the model; untested):**
- Length alone cannot choose between the layouts Hunter calls RIGHT and WRONG [fig]. For six heads on a unit grid:
  - the trunk-and-branch tree is about 2 + 3 = 5 units;
  - the serpentine is also 5 units, and it is the minimum spanning tree of the heads.

  An MST over the heads therefore tends to produce exactly the series chain Hunter rejects. A rectilinear Steiner tree
  rooted at the valve can produce the trunk-and-branch shape. It needs a tie-break that prefers splitting the flow
  near the valve (lower cumulative flow × length, i.e. lower friction).
- A cost surface would encode the rules above:
  - cheap along the strip just inside lawn edges and hardscape (perimeter heads sit ≥2 in from hard edges, and
    machines run laterals "as close to hardscape as the equipment permits");
  - expensive or sleeved under walks and drives (go around if a detour is cheap);
  - forbidden through buildings;
  - penalised across tree root zones.
- Heads then hang off the trunk on stubs of at most about 3 ft (the 36 in swing-pipe figure).
- **Proposed bar:** compare against real as-built zone plans before trusting any of this. None is in hand.

---

## 2. Design rules and their sources

### 2a. Velocity

| Rule | Source |
|---|---|
| "The industry has established 5 ft/s (1,5 m/s) as an acceptable maximum velocity." Below it, damaging surges are less likely, and friction "increase[s] rapidly" above it. | RB-LIDM p. 6 [read] |
| V (ft/s) = gpm / (2.45 × ID²), ID in inches | RB-LIDM p. 6 [read] |
| ≤5 ft/s for PVC, PE and HDPE; ≤7 ft/s for metal pipe | NC-BMP §D3 [read] |
| ≤5 ft/s for plastic pipe ≤3 in | IA-BMP §7.2b(1) [read] |
| Service line: 5 to 7½ ft/s. 5 is "overly restrictive and impractical with the metallic pipe" of the purveyor. | RB-LIDM p. 28, rule 3 [read] |
| Service line: ≤7.0 ft/s | IA-BMP §3.2a(3) [read] |
| Copper service: "the accepted 7½ feet per second"; some designers go to 9 ft/s | Hunter-US p. 5 note [read] |

Rain Bird's quick flow limits for Class 200 PVC at 5 ft/s (RB-LIDM p. 72) [read]:

| Size | Flow limit |
|---|---|
| ¾ in | 10 gpm |
| 1 in | 16 gpm |
| 1¼ in | 26 gpm |

Hunter-US p. 10 pipe sizing chart [read], maximum gpm:

| Size | PVC thick wall | PVC thin wall | Polyethylene |
|---|---|---|---|
| ¾ in | 8 | 10 | 8 |
| 1 in | 13 | 16 | 13 |
| 1¼ in | 22 | 26 | 22 |

### 2b. Pressure variation within a zone (the sources disagree)

- **20%, Christiansen.** FAO-PIT ch. 4 p. 4.2 [read]: emitter discharge differences should "in no case exceed 10
  percent. These criteria were established by J. Christiansen for sprinklers and are now applied in all pressurized
  systems... the maximum permissible difference in pressure between any two emitters in operation should be no more
  than 20 percent."
- **Why 20%.** Sprinkler discharge goes as √P, so a flow ratio of 1.1 needs a pressure ratio of 1.1² ≈ 1.21.
  Source: *Irrigation Systems Management* (AET 021), §11.04 "Lateral Design," Workforce LibreTexts [read via fetch]:
  "10% discharge variation is equivalent to a maximum permissible pressure variation of 20%."
- **Stryker's version.** "maximum total pressure loss between the valve and the last sprinkler may NOT exceed 20% of
  the sprinkler head operating pressure... If in doubt, 3 PSI is a reasonably safe value." Source: "What Size Pipe for
  Sprinkler System Laterals?", https://irrigationtutorials.com/?p=376 [read via fetch]. This 20% caps the loss from the
  valve to the farthest head. It is not a max-minus-min spread, though the two are close when the zone is flat.
- **IA-BMP §7.2b(2)** [read]: "Pressure variation within a zone shall have less than 10 percent variation." This is
  **half** the Christiansen figure. IA does not say whether it means pressure or flow, nor which pressure it is measured
  against.
- **Model consequence.** Use 20% (≈10% flow) as the conventional limit for "is this zone balanced." Report the IA 10%
  as the stricter standard.

### 2c. Static vs working pressure, and how to measure each at a hose bib

**Definitions.**
- RB-LIDM p. 4 [read]: static pressure is "the pressure of a closed system with no water moving."
- RB-LIDM p. 6 [read]: dynamic ("working") pressure "is the pressure at any point in the system considering a given
  quantity of water flowing past that point."
- RB-LIDM p. 9 [read]: dynamic pressure "is a running total of friction losses and elevation losses or gains."

**Measuring static pressure.**
- RB-LIDM p. 13 [read]: "hook it up to a hose bib or garden valve. Turn the valve on to take the pressure reading when
  no other water outlet on the site is open."
- Hunter-US p. 4 [read]: use "the outside faucet closest to the water meter. Make sure that no other water is flowing
  at the residence."
- RB-LIDM pp. 5-6, 27 [read]: design for the worst case, "hot weekend days in the summer". "the lower pounds per square
  inch (bar) figure for the summer, daylight pressure (or 'worst case' condition) is the number to use." Ask the
  purveyor even if you have measured.
- OSU-6617 p. 3 [read]: "Measure the pressure at the same time of day the irrigation system runs." Below 25 psi or
  above 125 psi, "contact the utility department."

**Measuring working pressure and flow (a homeowner can do these).**
- **Toro flow gauge** (Toro-gauge [read]; Toro-DIY p. 5 [read]):
  1. Fit the gauge to the hose bib nearest the irrigation connection.
  2. With its valve closed, read static.
  3. Open the valve "until pressure drops to the required system pressure. Read and record PSI and GPM."
  4. Toro-DIY asks for gpm at 50, 45 and 40 psi.

  Limits: 160 psi and 13 gpm. "Not intended for use on lines larger than 1 inch." It "will only measure flow through
  the hose bib – not in the line."
- **Two-faucet bucket test** (Toro-DIY p. 5 [read]):
  1. Put a pressure gauge on faucet 2 and read static.
  2. Open faucet 1 fully. If faucet 2 then reads below 40 psi, throttle faucet 1 until it reads 40.
  3. Time a 5-gallon bucket from faucet 1 (15 s = 20 gpm, 20 s = 15, 25 s = 12, 30 s = 10, 40 s = 7.5).
  4. Repeat at 45 and 50 psi.

  This gives points on the supply's pressure-flow curve.
- **Watertips** (https://www.watertips.com/info/layout3.htm) [read via fetch]:
  - a hose bib alone is "useful for little more than obtaining a static pressure reading";
  - an open-hose bucket test "is useless" because it runs against no back pressure;
  - instead, set a manual valve "to simulate the back pressure required to operate the sprinklers";
  - gpm = gallons × 60 / seconds.

### 2d. Typical residential static pressures

| Figure | Source |
|---|---|
| "Residential water pressure is ideally about 40 to 60 psi, however, this can vary significantly based on location." | OSU-6617 p. 1 [read] |
| Distribution systems: ≥20 psi everywhere under all flow conditions. "Normal working pressure should be 60 to 80 psi, and no less than 35 psi." | *Recommended Standards for Water Works* ("Ten States Standards"), as summarised at https://www.wsbeng.com/summary-of-10-states-standards-for-drinking-water-distribution-piping-design/ [2nd] |
| Inside the house, static ≤80 psi. "Where the main pressure exceeds 80 psi (551 kPa), an approved pressure-reducing valve... shall be installed on the domestic water branch main or riser at the connection to the water service pipe." | IRC 2018 P2903.3.1, as quoted by the City of Edmond, OK (https://gis.edmondok.gov/addresselevation) [2nd, quoted code text] |
| Hunter's capacity chart spans static 30-80 psi | Hunter-US p. 5 [read] |
| Rain Bird's worked examples use 111 psi and 75 psi | RB-LIDM pp. 4, 66 [read] |

**Pressure follows elevation within a pressure zone.**
- Thornton requires designers to compute available static pressure as (low HGL elevation − POC elevation) × 0.433. Its
  example: (5351 − 5175 ft) × 0.433 = 76.2 psi. The utility publishes the low HGL. Source: Thornton [read].
- Edmond flags every address below 1150 ft elevation as requiring a pressure-reducing valve. Source: the Edmond page
  above [read via fetch].
- **Model consequence (SPECULATION):** where a utility publishes its zone HGL, lidar ground elevation at the meter
  gives static pressure without a gauge.

### 2e. Service line and water meter

**Typical sizes.**
- Hunter-US p. 4 [read]: "The most common sizes for residential meters are 5/8", 3/4", and 1"." The size is "generally
  stamped on the meter body."
- RB-LIDM p. 27 [read]: nominal meter sizes 5/8, ¾, 1, 1½, 2 in. The size is on the meter body or inside the reading
  lid.
- Toro-DIY questionnaire [read]: meter 5/8, ¾ or 1 in; supply line ¾, 1 or 1¼ in; copper, galvanized, PVC or PEX.
- Thornton [read]: "it is common to downsize at the meter and then upsize again for the rest of the service line."

**Service line size from a string around the pipe** (RB-LIDM p. 27 / p. 103 and Hunter-US p. 4) [read]:

| String length | Copper | Galvanized (and PVC, Hunter) |
|---|---|---|
| 2¾ in | ¾ in | not listed |
| 3¼ in | not listed | ¾ in |
| 3½ in | 1 in | not listed |
| 4 in | not listed | 1 in |
| 4⅜ in | 1¼ in | not listed |
| 5 in | not listed | 1¼ in |

**Meter loss: AWWA standard table, as printed in RB-LIDM p. 106** [read], in psi:

| gpm | 5/8 in | ¾ in | 1 in |
|---|---|---|---|
| 5 | 0.9 | 0.6 | 0.2 |
| 10 | 3.7 | 1.6 | 0.7 |
| 15 | 8.3 | 3.6 | 1.2 |
| 20 | 15.0 | 6.5 | 2.2 |
| 30 | not listed | 15.0 | 5.3 |
| 40 | not listed | not listed | 9.6 |
| 50 | not listed | not listed | 15.0 |

- Each column ends at 15 psi (5/8 at 20 gpm, ¾ at 30 gpm, 1 in at 50 gpm). Between, it rises close to the square of
  the flow: 15 × (10/20)² = 3.75 against 3.7 printed.
- These are the standard's maximum-loss figures, not one meter's measured losses. Stryker's worked example uses 2.2 psi
  for a meter (https://irrigationtutorials.com/?p=1161) [read via fetch]. OSU's rule of thumb is 5 psi (below).

**Rain Bird's three capacity rules** (RB-LIDM pp. 27-29) [read]:
1. Meter loss ≤10% of the minimum static pressure in the main.
2. Irrigation flow ≤75% of the meter's maximum safe flow.
3. Service line velocity ≤5-7½ ft/s.

The available flow is the most restrictive of the three. IA-BMP §3.2a repeats rules 1 and 2, and uses 7.0 ft/s for 3
[read].

**Service line friction.**
- Rain Bird tabulates Hazen-Williams losses with C = 150 for PVC, C = 140 for type K copper and C = 140 for PE (RB-LIDM
  pp. 94-102) [read].
- Examples: ¾ in type K copper loses 14.41 psi per 100 ft at 10 gpm (7.35 ft/s). 1 in type K loses 3.53 psi per 100 ft
  at 10 gpm (RB-LIDM p. 29) [read].
- The worked example totals service-side losses item by item (RB-LIDM p. 89, solutions) [read]. From 111 psi in the
  main: copper −0.24, −0.08, −0.12; elevation −1.30; −0.08, −0.12; gate valve −0.03; ¾ in meter −5.80; gate valve
  −0.11. That leaves 103.12 psi at the POC at 19 gpm.

**Hunter's shortcut table** (Hunter-US p. 5) [read]. Maximum gpm by meter, service line and static pressure. The
working pressure is "the approximate working pressure at the head":

| Meter | Service | 30 psi | 40 | 50 | 60 | 70 | 80 |
|---|---|---|---|---|---|---|---|
| 5/8" | ½" | 2 | 4 | 5 | 6 | 7 | 7 |
| 5/8" | ¾" | 4 | 6 | 8 | 8 | 10 | 12 |
| 5/8" | 1" | 4 | 7 | 8 | 10 | 13 | 15 |
| ¾" | ¾" | 4 | 6 | 8 | 9 | 10 | 12 |
| ¾" | 1" | 5 | 7 | 10 | 14 | 17 | 20 |
| ¾" | 1¼" | 5 | 12 | 17 | 20 | 22 | 22 |
| 1" | ¾" | 4 | 7 | 8 | 9 | 12 | 12 |
| 1" | 1" | 5 | 8 | 14 | 18 | 20 | 20 |
| 1" | 1¼" | 5 | 14 | 24 | 26 | 30 | 34 |
| **Working pressure** | | **25** | **30** | **35** | **45** | **50** | **55** |

- "Service lines are based on 100' of thick-walled PVC. Deduct 2 GPM for copper pipe. Deduct 5 GPM for new galvanized
  pipe."
- Without the copper deduction, velocity is about 9 ft/s, and the copper service "should not exceed 50'."
- The working-pressure row implies Hunter allows 5 psi of loss at 30 psi static, rising to 25 psi of loss at 80 psi.

### 2f. Backflow preventer height (code)

- **PVB.** Must be installed at least 12 in above all downstream piping and outlets:
  - Wisconsin DNR, *Irrigation Backflow Options* [read]: "at least twelve inches above flood rim (ground
    level/surrounding grade or basin) and downstream piping," installed vertically, outside only.
    https://dnr.wisconsin.gov/sites/default/files/topic/DrinkingWater/TN/IrrigationBackflowOptions.pdf
  - Orange County, FL standard for ASSE 1020 PVBs [read]: "at least 12 in. (305 mm) above downstream piping and the
    highest fixture flood level rim, outlet, or highest point of water use."
  - Zurn Wilkins Model 710 PVB instructions [read]: "Install valve at least 12 inches above the highest piping or water
    outlet downstream." PVBs "must not be installed where backpressure may occur."
  - The International Plumbing Code places this in §608 (numbering varies by edition). The California (UPC-based) code
    puts lawn-sprinkler protection at 603.5.6 [2nd; I could not open the code text].
- **AVB.** At least 6 in above all downstream piping and outlets, one AVB on each zone downstream of its valve, and not
  under continuous pressure (Wisconsin DNR) [read]. "NO VALVES are allowed downstream of an A.V.B." (local guidance
  summarised in search results) [2nd].
- Heights are measured from the device's **critical level**, which is the bottom of the body if it is not marked
  (Montana DEQ, per search summary) [2nd].
- **Model consequence (SPECULATION):**
  - A mapped PVB caps the elevation of every head and pipe on the system: each is ≤ (PVB critical level − 12 in).
    That gives a check on the lidar terrain.
  - The PVB riser itself is an elevation loss: water rises from the buried main to ≥12 in above the highest head.
- **Losses through a PVB** (RB-LIDM pp. 68-69) [read]: at 40 gpm, about 6.3 psi through a 1 in PVB-100 and 3.8 psi
  through a 1¼ in PVB-125. Choose a size whose flow falls mid-curve. Codes often require the device to be "the same
  nominal size as the service line or POC."

### 2g. Elevation

- RB-LIDM p. 3 [read]: "One foot of water = .433 psi." "One psi = 2.31 ft of water." A rise is a loss, a fall is a
  gain.
- Thornton [read] uses 0.433. The Fort Collins worksheet uses 0.43 psi/ft [2nd, search summary of
  https://www.fcgov.com/... pressure-calculation-worksheet, which now redirects].
- Thornton [read] requires check valves on heads "for sites with elevation change over ten feet" (low-head drainage).

### 2h. Operating ranges, and what happens outside them

**Sprays.**
- RB-LIDM p. 36 [read]: "an operating range of approximately 15 to 30 psi."
- OSU-6617 p. 3 [read]: ideal 30 psi, range 15-30.
- Rain Bird and Hunter spray charts print 15-30 psi, with 30 psi the "optimum" or bold row. Rain Bird: radius reduction
  over 25% is not recommended. Both are transcribed in ../heads/ (rainbird-sprays.json, hunter-sprays.json notes)
  [read there].
- Hunter's PRS30 **body** lists "Operational pressure range: 15 to 100 PSI." That is the inlet range of the regulated
  body, not of the nozzle (https://d7.hunterindustries.com/sites/default/files/CA-Cutsheet-PRS30-US.pdf) [read].

**Rotors.**
- RB-LIDM p. 37 [read]: "most rotating sprinklers... operate somewhere in the 25 to 100 psi range."
- OSU-6617 p. 3 [read]: "For rotors, this is about 45 psi, with an operating range of 25 to 65 psi."
- Hunter's bold "recommended" rows ([read], ../heads/hunter-rotors.json notes):
  - standard (blue) nozzles 45 psi;
  - low-angle and short-radius 50 psi;
  - high-flow 60 psi;
  - PGJ/SRM 40 psi.
- Rotary-stream nozzles: Hunter PRS40 with the MP Rotator at 40 psi; Rain Bird R-VAN at 45 psi ([read], heads notes).
- Rain Bird 5000 PRS rotors regulate to 45 psi ([read], heads notes).
- The user's "40-55 psi" sits inside all of these. No source gives exactly that band.

**Above range: misting.**
- OSU-6617 p. 1 [read]: "the water leaves the nozzle as a fine mist instead of large droplets. Carried away by the
  wind, the fine mist evaporates."
- Flow also rises. OSU's example is a spray at 30 psi giving 3.3 gpm in an even pattern, and at 50 psi giving 4.8 gpm
  in a degraded one.
- Rain Bird 1800 PRS product page (https://www.rainbird.com/products/1800-series-pressure-regulated-spray-prs-heads-dual-spray-hevan-nozzles)
  [read]: "Ends misting and fogging caused by high pressure"; the stem "maintains constant 30 psi."
- NC-BMP [read]: use "pressure regulating control devices on individual sprinklers to stop misting due to excessive
  pressure."

**Below range: poor throw.** OSU-6617 p. 1 [read]:
- heads "may not pop up";
- water "will not reach adjacent heads";
- the pattern is not uniform;
- "donut-shaped zones of brown grass around a sprinkler head."

### 2i. When designers add pressure regulation

- **IA-BMP §6.4b** [read]: when pressure is "greater than 15 percent above recommended operating pressure," use a
  pressure-reducing valve at the POC or a regulator on the zone valve. §5.4a: "If pressure exceeds equipment
  recommended operating range, use pressure regulating equipment."
- **RB-LIDM p. 71** [read]: with 111 psi and sprays needing 15-20 psi there was "pressure to burn." The designer
  specified a main-line regulator plus a regulator on each valve: fixed-outlet for drip, adjustable for sprinklers.
- **OSU-6617 pp. 4-5** [read], in order:
  1. above 80 psi to the house, a whole-house regulator;
  2. a regulator at the irrigation POC;
  3. a regulator on each zone valve ("A pressure reduction of at least 15 psi is required for these devices to function
     properly");
  4. pressure-regulated heads.

  "If you have high water pressure, then pressure-regulated heads or devices should always be used."
- **Where the irrigation tap sits.** Hunter-US p. 11 [read]: the POC "should be between the water meter and any pressure
  regulator on the structure." The IRC puts the house PRV on the domestic branch inside (§2d). So **the irrigation
  usually sees full street pressure even when the house has a PRV.**
- **NC-BMP §11** [read]: on a municipal supply, "allow for a reduction in static pressure of up to 10 psi to
  accommodate possible expansion in the supply network."
- **Regulated spray bodies are now required in places.**
  - California requires spray bodies sold from 2020-10-01 to meet the WaterSense specification and carry an integral
    regulator (CEC Title 20 §1605.3(x)). Source: CEC spray-sprinkler pages and 2020 webinar [2nd, search summary].
  - Rain Bird lists eleven jurisdictions whose guidelines its PRS bodies meet [read, product page above].
- **A regulated body is not lossless.** EPA WaterSense *Specification for Spray Sprinkler Bodies* v1.0 (2017-09-21) [read]:
  - the body is calibrated at **inlet = regulation pressure**;
  - there, its outlet must be **"not less than two-thirds (67 percent) of the regulation pressure"**;
  - flow across inlets from the regulation pressure up to 70 psi must stay within ±12% (maximum) and ±10% (average).

  https://19january2021snapshot.epa.gov/sites/static/files/2017-09/documents/ws-products-spec-ssb.pdf

---

## 3. Water quality: a short questionnaire

### The questions (each answer maps to a source below)

1. **Where does your water come from?** City water / a private well / other.
   - Wells are where iron and manganese are usually found. NDSU [read]: "Usually, iron and manganese concentrations in
     well water do not exceed 10 mg/L and 2 mg/L."
   - UF/IFAS radio: "most Florida well water is high in iron" [2nd].
2. **Do you know your water's hardness?** It may be on your utility's water report or website, or a lab test.
   - Enter it in mg/L as CaCO3, or in grains per gallon. 1 gpg = 64.799 mg / 3.7854 L = 17.1 mg/L (arithmetic).
   - USGS says hardness "should be provided by the local health agency or local water utility" [read].
3. **If you don't know, which of these do you see?**
   - white, chalky crust on faucets or shower heads;
   - spots or film on glasses after washing;
   - soap that won't lather, or scum.

   These suggest hard water (USGS) [read].
4. **Where your sprinklers hit, are there stains on concrete, rocks, siding or fences?**
   - Orange or rust coloured: iron.
   - Black or brownish-black: manganese.
   - Slimy dark film in the hose bib or valve box: possible iron bacteria.
5. **Is there a white crust on the sprinkler heads, nozzles or nearby glass after watering?** This suggests calcium
   carbonate deposits (§3c).

### 3a. Hardness classes (HARD)

USGS Water Science School, "Hardness of Water"
(https://www.usgs.gov/special-topics/water-science-school/science/hardness-water) [read via fetch], in mg/L as CaCO3:

| Class | mg/L |
|---|---|
| Soft | 0-60 |
| Moderately hard | 61-120 |
| Hard | 121-180 |
| Very hard | >180 |

USGS also says, in the same page [read]:
- signs are spots or film on dishes, soap scum, and needing more soap;
- scale "can... clog pipes";
- "water pipes can gradually close up resulting in less water movement through the pipe";
- there is "mineral buildup in plumbing, fixtures, and water heaters."

Test strips: I found no extension or USGS guidance on their accuracy. Treat a strip reading as a class, not a number.

### 3b. Iron and manganese (HARD)

- **Thresholds.** The EPA secondary standards are 0.3 mg/L for iron and 0.05 mg/L for manganese. Visible problems begin
  "when the amount of dissolved iron exceeds about 0.2 mg/L... and when dissolved manganese exceeds about 0.05 mg/L."
- **Stain colours.** Iron gives "reddish-brown staining"; manganese "a brownish-black stain."
- **Cleaning.** Chlorine bleach and alkaline builders can intensify these stains.
- **In pipes.** Deposits "build up in pipelines, pressure tanks, water heaters... This reduces the available quantity
  and pressure of the water supply."
- **Galvanized pipe.** Rusted galvanized pipes are themselves a source of particulate iron.

  All five points: NDSU Extension WQ1030 (rev. Dec. 2025),
  https://www.ndsu.edu/agriculture/sites/default/files/2025-12/wq1030.pdf [read].
- **On turf systems.** Penn State Extension, Landschoot, "Iron in Turfgrass Irrigation Water" (updated 2024-06-26),
  https://extension.psu.edu/iron-in-turfgrass-irrigation-water [read via fetch]:
  - problems "mostly center around staining of concrete surfaces";
  - "plugging of irrigation equipment";
  - rust-coloured deposits on ornamentals;
  - turf and soil harm is rare;
  - the "upper limit value of 5 ppm iron suggested in textbooks" refers to plant concerns, not staining.

  A filtered sample can read <0.1 ppm when the acidified, unfiltered sample of the same water reads 48.5 ppm, so **ask
  how a lab sample was prepared.**
- **Overhead irrigation.** UF/IFAS SS440 [2nd, search snippet]: "Overhead irrigation with water containing levels above
  0.3 ppm may cause staining to foliage."
- **Bacteria and sludge.** UF/IFAS FAWN, citrus microirrigation maintenance (https://fawn.ifas.ufl.edu/tools/irrigation/citrus/maintenance/six)
  [read via fetch]:
  - iron and manganese "as low as 0.2 ppm can cause a bacterial growth problem";
  - iron >0.6 ppm with sulfide >2.0 ppm makes iron sulfide sludge.

  These figures are for drip emitters, a finer passage than a sprinkler nozzle.

### 3c. Hardness, bicarbonate and deposits

- *Irrigation Systems Management* §14.5.2 (Workforce LibreTexts) [read via fetch]: "A bicarbonate concentration greater
  than 2 meq/L (120 ppm) coupled with a pH greater than 7.5" causes calcium precipitation. This is for microirrigation.
- White lime deposits form on leaves when high-bicarbonate water is sprinkled in hot, dry weather (WateReuse Foundation
  salinity guide) [2nd]. Ayers & Westcot, FAO Irrigation and Drainage Paper 29, has a bicarbonate row for overhead
  sprinkling; I could not open it, so its numbers are not given here.
- Rain Bird impact-sprinkler troubleshooting (https://rainbird.com/media/1296) [read]:
  - "Build up of water deposits causing friction" stops rotation;
  - "A vinegar and water solution will help remove water deposits";
  - "Do not drill or alter nozzles as this may permanently hinder the sprinkler performance";
  - replace bearing washers "if mineral deposits are a problem."

### 3d. What each does to the parts (what was and was not found)

| Part | Effect found | Quantified? |
|---|---|---|
| PVC / PE laterals and mains | No source found on scale in irrigation PVC or PE. Rain Bird's design tables use a single C (150 PVC, 140 PE) with no ageing allowance. | **No** |
| Metal service lines (copper, galvanized) | USGS: scale clogs pipes, which "gradually close up." NDSU: Fe/Mn deposits reduce quantity and pressure, and galvanized pipe is itself a source of iron. Hunter deducts 5 gpm for **new** galvanized and 2 gpm for copper. | Only Hunter's deductions. Aged-pipe C values came only from calculator websites, so none is given. |
| Valves | Rain Bird: automatic valves need a minimum pressure drop to operate (RB-LIDM p. 67). Penn State: iron plugs "irrigation equipment." | **No** valve-specific hardness figure found |
| Spray and rotor nozzles | Deposits on impact sprinklers (Rain Bird 1296); iron staining where the water lands (Penn State, UF). | **No** credible flow-loss figure. Only water-softener vendors gave percentages, and they were excluded. |
| Drip emitters | Fe/Mn bacteria at 0.2 ppm (FAWN); CaCO3 precipitation at HCO3 >2 meq/L and pH >7.5 (LibreTexts). Nakayama & Bucks (1986, *Irrigation Science*) is the usual clogging-hazard table, but I did not read it. | Thresholds only, not flow loss |

**Model consequence (SPECULATION):** water quality cannot honestly change the hydraulic numbers yet. Use it to:
- flag likely staining (Fe >~0.2-0.3 mg/L, Mn >~0.05 mg/L) where the spray pattern hits hardscape or walls;
- flag deposit and clogging risk (very hard water; high bicarbonate with pH >7.5);
- recommend inspection and cleaning;
- leave C, nozzle flow and valve loss unchanged.

---

## 4. The pressure-loss worksheet in the makers' guides

### Rain Bird (RB-LIDM ch. 4 and ch. 7)

**The equation** (p. 69) [read]: Pr = Ps − (Po + Pls).
- Ps: static pressure.
- Po: operating pressure of the worst-case sprinkler.
- Pls: losses through the main line and the worst-case lateral.
- Pr: the pressure remaining.

**Worst-case lateral** [read]: "the lateral that is most distal from the POC, or a distant lateral with the highest
flow, or a high-flow lateral at a high elevation." Its worst-case sprinkler is "the one furthest from the lateral
valve." The **critical circuit length** is "the longest path in the circuit that the water will have to travel" (p. 65).

**Supply side, main to POC** (ch. 4 exercise, p. 30; solution p. 89) [read], in order:
1. static pressure in the city main;
2. service pipe (copper) to the meter, with its fittings (equivalent lengths from the copper-fittings table, p. 103);
3. elevation rise;
4. gate valve;
5. water meter (AWWA table);
6. gate valve;
7. the POC (tee into the service line).

**System side, worst-case sprinkler back to the meter** (ch. 7 exercise, p. 71; solution p. 91) [read], with the
example's numbers:
1. Pressure needed at the sprinkler: **55 psi**.
2. Each lateral section on the critical path, at its flow, size and length (Class 200 PVC chart). ¾ in at 9.8 gpm:
   2.026; 1¼ in at 19.6: 0.709; 1½ in at 29.4: 0.780; 2 in at 39.2: 0.223 psi.
3. Zone valve at the zone flow: 1½ in PEB, **1.9 psi**.
4. Main line from the valve to the POC: 2 in Sch 40, 162.8 ft, **1.872 psi**.
5. Backflow preventer: 1¼ in PVB, **3.8 psi**.
6. Water meter: 1½ in at 39.2 gpm, **3.3 psi**.
7. **Fittings: "10% of all pipe losses"** (0.561 psi). This is the manual's default.
8. Elevation rise (+). Flat in the example.
9. Subtract elevation drop (−).

Total required 70.17 psi, against 75 psi static. "If this is a positive number, the system will work" (4.83 psi).

**Rain Bird defaults and rules used on the way:**
- valve loss ≤10% of static;
- valve the same size as the largest lateral pipe, or one size smaller;
- meter loss ≤10% of static;
- ≤75% of meter safe flow;
- velocity ≤5 ft/s in laterals and main.

PEB valve losses (p. 68) [read]:

| Flow | 1 in valve | 1½ in valve |
|---|---|---|
| 10 gpm | 1.5 psi | not listed |
| 20 gpm | 2.5 psi | 1.5 psi |
| 30 gpm | 5.0 psi | 1.5 psi |
| 40 gpm | 9.3 psi | 1.9 psi |

### Hunter (Hunter-US)

- **No itemised worksheet.** Pressure loss is folded into the capacity table (§2e). The homeowner reads off a maximum
  gpm and a "working pressure... at the head" from meter size, service line size and static pressure. Hunter says it
  "considered reasonable friction loss and acceptable water velocity" in building the charts (p. 2) [read].
- Laterals are sized from the farthest head back toward the valve with the max-gpm-per-size chart (p. 10) [read].

### Toro (Toro-DIY)

- **No itemised worksheet** in the homeowner guide.
- The homeowner measures static pressure and the dynamic flow at 40, 45 and 50 psi (gauge or two-faucet bucket test,
  §2c). These go to Toro's Water Smart design service.
- For pumps: "a minimum of 45 PSI @ 10 GPM for a sprinkler system" [read].

### Irrigation Association (IA-BMP 2014)

- **Criteria, not a form** [read]:
  - meter loss <10% of static;
  - ≤75% of the meter's safe flow;
  - service line ≤7.0 ft/s;
  - valve loss ≤10% of static;
  - calculate "Pressure loss for the 'worst-case' zone. This may be the largest zone and/or the farthest zone from the
    POC and/or the zone with the greatest elevation change";
  - ≤5 ft/s;
  - zone variation <10%;
  - sprinklers within the maker's recommended pressure.
- I did not find IA's own worksheet. IA's design textbooks were not available to me.

### Practitioner and municipal worksheets

**Stryker's Design Data Form** (https://www.irrigationtutorials.com/data.pdf) [read], in printed order:
1. Water Meter
2. Backflow Preventer
3. Filter (optional)
4. House Mainline 1 ("from water source to water meter")
5. House Mainline 2 ("from water meter to irrigation connection")
6. Irrigation Mainline ("from irrigation connection to valves")
7. Valves
8. Elevation Change
9. Sprinkler Heads
10. Laterals ("maximum 20% of sprinkler head value above")
11. TOTAL

His worked example (https://irrigationtutorials.com/?p=1161) [read via fetch]:
- meter 2.2;
- backflow 0 (anti-siphon valves used);
- mainline 2 (23 ft of 1 in Sch 40);
- valves 5;
- elevation 4 (about 9 ft);
- heads 30;
- laterals 6 (20% of 30).

He warns: "don't use the pressure losses shown here for your design" and "many brands of anti-siphon valves have much
higher losses than the 5 PSI in this example!"

**OSU's 5-4-3-2-1 rule of thumb** (OSU-6617 p. 2, Table 1) [read]:

| Item | Loss |
|---|---|
| Water meter | 5 psi |
| Backflow preventer | 4 psi |
| Control valve | 3 psi |
| Mainline | 2 psi |
| Laterals | 1 psi |
| **Total** | **about 15 psi** "from the utility supply line to one of the sprinkler heads" |

OSU's example: 60 psi in, about 45 at the head.

**Thornton** [read]:
- "a friction loss worksheet that calculates all pressure losses from the irrigation tap/meter to the last head in the
  worst-case zone";
- elevation loss shall be included, and gains are at the designer's discretion;
- static pressure comes from the low HGL (§2d).

POC components "in the general order that they are expected to be installed after the tap":
1. service line
2. water meter
3. stop/gate valve
4. RPZ backflow assembly
5. master valve
6. flow sensor
7. gate valve
8. quick connect (winterization)
9. mainline

**Fort Collins worksheet** [2nd, search summary; the page now redirects]: meter, backflow device, mainline, control
valve, lateral, elevation (0.43 psi/ft), miscellaneous fittings, for "the most pressure-demanding lateral."

### Where the sources agree, and where they do not

**Agreed, the order of losses from the street to the farthest head:**
1. service line (and its fittings and stops);
2. meter;
3. elevation to the POC;
4. irrigation main (with any isolation valve, filter or master valve);
5. backflow preventer;
6. zone valve;
7. lateral along the critical path;
8. fittings (Rain Bird: +10% of pipe loss);
9. elevation to the head;
10. the head's own required pressure.

Every source computes this for the worst-case zone and the worst-case head only.

**Not agreed:**
- **The default numbers.** OSU's meter allowance is 5 psi, Stryker's example 2.2 psi, and the AWWA maximum for a 5/8 in
  meter at 15 gpm is 8.3 psi. For valves: OSU 3 psi, Stryker 5 psi ("many brands... much higher"), Rain Bird's 1 in PEB
  1.5-9.3 psi depending on flow.
- **The zone-variation limit.** 10% (IA) against 20% (Christiansen/FAO, Stryker).
- **Fittings.** Only Rain Bird gives a lump allowance (10% of pipe losses). Stryker and OSU have no fittings line.
  Rain Bird also tabulates equivalent lengths per fitting (p. 103).

---

## Doubts and gaps

- **Routing.** No source validates any routing algorithm against real residential trenches. The RIGHT/WRONG reading of
  Hunter's figure is mine; the guide has no caption text explaining it.
- **IA-BMP.** Read from a city's reproduction (Spokane draft 2019), not from IA's own PDF (Bend's copy returned 403).
  IA-BMP's "<10 percent" zone variation does not say whether it means pressure or flow.
- **Code text.** Not read directly. ICC and UpCodes blocked fetches. The 12 in PVB and 6 in AVB figures come from state
  guidance and maker instructions, all of which agree. Section numbers are [2nd].
- **Ten States Standards.** 60-80 psi normal working pressure is from a summary, not the standard.
- **Water quality.** No quantified effect of hardness or iron on sprinkler nozzle flow, valve loss or plastic-pipe C was
  found in a credible source. Ayers & Westcot (FAO 29) and Nakayama & Bucks (1986) are the places to look next. I have
  not read either, so none of their numbers are given.
- **AWWA meter table.** These are maximum losses allowed by the standard. A real meter of the same size may lose less.
