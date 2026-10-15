# How much light each lawn grass needs (the shade map's step 4)

The grass step (public/shade/grass.js) sets each species' lowest daily light
against the lawn's season-average light from the shade map. The figures are
the published minimum daily light integrals (DLI, mol/m²/day) for an
acceptable turf, from two literature summaries prepared for the owner on
2026-10-15 (a cultivar-level synthesis of the primary studies, and a
follow-up on fine fescues, Poas, bentgrasses and ryegrass). This file keeps
the provenance; the numbers in grass.js are the lawn-height, summer,
no-growth-regulator, no-traffic values.

| Grass | In grass.js | Published values behind it |
|---|---|---|
| Fine fescues | 7 (derived) | No published minimum. Chewings SR5100 and creeping red Dawson could not acclimate at 4 mol but did at 8–10 (Valentino & Lang 2007, greenhouse); 40 cultivars persisted at 6.5–10.7 under a shade tent (Petrella & Watkins 2020). The follow-up's working floor: 7–8. |
| Rough bluegrass | 7.5 | Sabrena acceptable at about 7.1 under 60% cloth through a winter; wear threshold about 7.5 (Abélard & Galbrun 2022, score ≥5). Fades in summer heat. |
| Tall fescue | 9 | Rebel Exeda 8.78 (Meeks 2015, Texas); species 9.3 in a winter stadium trial (Abélard & Galbrun 2022). Short-term studies only. |
| Perennial ryegrass | 10 | Species 8.4 at a lenient winter criterion (Abélard & Galbrun 2022) plus the recommended 10–20% margin. The 23 mol quoted by grow-light vendors has no primary source. |
| Kentucky bluegrass | 23 | Conventional cultivars 22–26: Kenblue 24.05 (Meeks 2015), a four-cultivar blend 26.2 and 22.5 (Reed et al. 2024, quality 7). The transgenic ProVista line (7.5–10) is not a conventional cultivar. |
| St. Augustinegrass | 13 | Captiva 10.9, Floratam 11.8 (Unruh 2015, Florida, 8-week screen); Palmetto 15.5 at rough height in Texas. |
| Zoysiagrass | 16 | Tolerant cultivars 10–11 in an 8-week Florida screen but 19–24 after 27 months of year-round shade in Texas at fairway height (Chen et al.); 12–16 at 5 cm (USGA); Cavalier 15.0 vs Meyer 21.1 (Richardson et al. 2019). |
| Centipedegrass | 14 | TifBlair 13.4 (Unruh 2015). |
| Bahiagrass | 16 | Argentine 15.3 (Unruh 2014). |
| Seashore paspalum | 14 | SeaDwarf 13.2 (Unruh 2015). |
| Bermudagrass | 24 | Lawn and fairway cultivars 19–26: Tifway 21.0–25.95, common 25.9, Celebration 19.6–24.65, TifGrand 19.9–25.0 (Florida, Texas, Arkansas); USGA practical threshold 24–26. Ultradwarf greens 30–40. |
| Buffalograss | 16 (derived) | No published minimum. Prestige and two Nebraska lines acceptable under 60% cloth, about 15–17 mol in summer by the Clemson and Texas cloth readings (Amundsen et al. 2017). |

Not in the table: creeping bentgrass (Tyee, 30; a putting-green grass),
supina bluegrass (over 5 under traffic; rare in the US), annual bluegrass
(a survival threshold of 1.64 only), kikuyugrass and carpetgrass (nothing
quantitative found).

What the summaries said to keep in mind:

- The criterion moves the number: quality 5 (lawn-acceptable) gives a lower
  DLI than quality 7 (golf-acceptable). Short greenhouse screens rank
  cultivars but underestimate field needs; the zoysia values doubled from
  an 8-week screen to 27 months under permanent shade.
- Every value is from neutral shade cloth at 30–40° N. Tree shade cuts the
  red:far-red ratio and adds root competition, so real needs under crowns
  are likely higher; a 10–20% margin is a defensible working assumption.
- Cultivar choice buys 1–4 mol in bermudagrass; in zoysia the species
  choice matters more than the cultivar. The conventional-vs-improved
  Kentucky bluegrass gap (about 24 vs 10) comes from a transgenic line and
  an unreleased ecotype only.
- The shade map compares against the lawn's light averaged over the
  growing season with NASA's measured clouds, which runs below midsummer's
  light (the binding season in the studies): a lawn that passes on the
  season average passes in summer, which offsets some of the tree-shade
  margin above.
