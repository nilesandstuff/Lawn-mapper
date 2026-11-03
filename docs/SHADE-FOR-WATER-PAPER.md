The shade map works out how much light reaches each square meter of a lawn on every day of the year. It is the water model's source for sunlight under trees, for which trees drop their leaves and when, for fences, and for the growing season and soil temperature. This part, written by the shade map's developers, explains how it does that, what it assumes, and how far it has been checked.

### Trees and buildings from airborne lidar

The U.S. Geological Survey has flown most of the country with airborne lidar, a laser fired from a plane that records where each pulse bounced back [S1]. The shade map reads the survey over the lot, from its public cloud store or, for the newest surveys, from USGS's download tiles cut down to the lot. A survey with fewer than half a point per square meter over the lot (below USGS's lowest grade) is treated as having a hole there, and the next one is tried.

The points become a stack of one-meter cubes. For each cube, the share of laser pulses that went in and came back out tells how strongly it stops light, by the same Beer's law that governs light through a leaf canopy [S2, S3]. A crown that let half the pulses through lets about half the sun through. A roof stops every pulse, and since nothing reached the ground under it, the walls are filled in solid. Buildings are found by their flat or solid tops. Against a 1 m land-use map of 23 residential squares in Virginia, Maryland and Pennsylvania, this found 83% of building squares, and 85% of what it called building was building (91% and 94% within one meter) [S4].

A person can erase a tree that has since been cut down, or that they plan to remove. The erased space is open air in every season.

### The sun, the sky and the clouds

For each square, the map traces rays toward the sun through the cube model for each day of the year, and toward the whole sky for the scattered light. The light for a day is the direct sunlight times the share of the beam that gets through, plus the diffuse sky light times the share of sky the spot can see. The amounts of each come from ten years of NASA POWER satellite-based daily records for the place [S5]. Light is reported as the daily light integral (DLI), in moles of photosynthetic light per square meter per day, the measure turf science uses for shade tolerance.

The ground under the rays is the lidar's own, smoothed the same way the water map smooths it, so both maps stand on one surface. Hills shade themselves.

### Leaves: the hard part

Most lidar is flown in winter, with the leaves off. The laser then measures a maple's branches, not its summer crown. The map adds the summer leaves itself:

- **Which trees are evergreen.** A crown that stopped most of the laser in winter (passing under a fifth of the overhead sun) is taken as evergreen and kept as measured all year. Everything else is deciduous and gets leaves. A broad, flat-topped dome is kept deciduous even when dense, because big oaks can hold dead leaves into a late flight.
- **How much leaf.** About one square meter of leaf per cubic meter of crown, capped at a leaf area index of 5.5, from measurements of open-grown urban trees [S6]. A full crown passes about 6% of the sun straight down. Deeper crowns are darker, which is what Canham and colleagues found separates shady species from light ones [S7].
- **Where the leaves go.** Leaf-off lidar under-reads crown cover by about a fifth [S8], so small gaps inside a crown are filled. Leaves start at the crown's lowest branches, not at the ground, so a low sun can still slip under a tall tree.
- **When.** Leaf-out and leaf-fall follow the year's own weather: the days already observed, the National Weather Service forecast for the week ahead, then the typical year. Spring green-up was fitted on PhenoCam's canopy cameras at 119 deciduous sites [S9]. The delay from green-up to shade, and the fall timing, were fitted on the National Ecological Observatory Network's (NEON) light sensors on the forest floor at eleven sites [S10].

Technical note: each cube's extinction is μ = −ln(1 − returned/entered)/Δz, with every return counted as 1/n of its pulse. In leaf, a deciduous crown's cubes take μ = G × LAD with G = 0.5 (spherical leaf angles) and an effective LAD of 1.0 m²/m³, clumping folded in, until the crown's effective LAI reaches 5.5. A beam's share through is exp(−Σ μ ds) along its path.

When a survey was flown in leaf, the map can tell from each point's own laser clock. Those trees get no added leaves, because the laser already saw them in leaf. A deciduous tree on an in-leaf survey therefore keeps its summer leaves all year. That is a known weak point: it is too shady before leaf-out and after leaf-fall.

### Fences

Fences are too thin for the lidar, so the user draws them, with a height and a build. A solid privacy fence stops all light. A fence with board-wide gaps passes half the sun straight on and less at a slant. A shadowbox fence passes almost none, except at a slant. These shares are worked out from the board geometry for every sun angle. A sunlit pale face throws some light back onto the lawn in front of it: white vinyl about 70% of what strikes it, dark stain about 15%. The reflected share is spread in proportion to how much of the fence each spot sees. The reflectances are typical values for the materials, not measured on fences. The water model also takes each fence's wind porosity and surface heat values from the same record. The shadowbox wind figure (20%) is an estimate, unmeasured. Fences have not yet been checked against light readings.

### What the water model takes from the shade map

- each square meter's daily light as a share of open ground's, sampled through the year;
- each square's kind (open, building, evergreen or deciduous tree), the drawn fences and the erased trees;
- the growing season and the typical-year climate.

The growing season starts when turf growth potential [S11] reaches 20%. It ends when the five-day mean soil temperature falls below the dormancy point (7 °C for cool-season grass, 13 °C for warm-season). Soil temperature comes from Iowa State's IEMRE analysis [S12], or from NASA POWER where IEMRE does not reach.

### What has been checked against measurements

- **Under full summer canopy.** At eight NEON forests, the model's share of daylight on the forest floor came within about a point of the ground sensors at most hardwood sites (for example 2.4% against 2.4%, 3.3% against 3.4%). The worst miss was a Virginia mountain site, 7.3% measured against 2.2% [S10].
- **Summer shadows on lawns.** On 53 summer aerial photos (USDA NAIP [S13]) of 29 lots in 13 states, the photos showed 16.4% of the grass near trees in shade and the model 18.4%. Square by square they agreed 85.5% of the time, with nothing tuned on the trees.
- **The added leaves.** Against summer lidar of the same trees at four NEON sites, open ground near trees agreed 93% of the time and the model was slightly dark: 0.83 of the beam against 0.85. Single crowns were darker in the model than in summer lidar on slanted beams. Overhead they were slightly lighter than the U.S. Forest Service's shade factors for 149 street-tree species: 0.83 of the sky blocked against 0.85 to 0.93 [S14].
- **A phone on a mower.** On one clear October day, about 3,900 phone light readings over 23 west Michigan lawns agreed with the model's sun or shade 80% of the time. In the open it was 95%, behind buildings 91%, at shadow edges 66% and in deep tree shade 49%. GPS error alone would hold a perfect model to about 80% at edges. In deep shade the misses were the model being too dark: trees cut or thinned since the 2018 flight, including a lot built on after it.
- **On foot.** On the developer's lawn on 17 October, the phone agreed 65%. Most misses were the model too dark, from leaves the calendar had added to trees that had already dropped theirs.
- **Soil.** Against 16 U.S. Climate Reference Network stations for a year [S15], IEMRE's soil temperature was off by 0.1 °C on average and 2.1 °C on a typical day. NASA's ran 1.6 °C cold, 3.2 °C in winter. IEMRE's dormancy date fell within a median 4 days of the stations' own (111 stations; NASA's 8). In Germany it was closer than NASA at 12 of 13 weather service stations. Shade's cooling of the soil was measured from ten years at 114 of those stations: a sunnier fortnight than usual warms the soil 0.11-0.15 °C for each extra MJ/m² of daily sunlight when the air is free to warm with it, and only 0.01-0.03 °C when the air is held. Shade cools the air under a tree too, so the map takes 0.13 °C per MJ/m² lost. That is about 2.6 °C under full summer shade, near the 3.1 °C Edmondson and colleagues measured under trees [S16].

### Known weak points

- **Pines.** In the Southeast, open pine crowns pass so much winter sun that they are called deciduous and given leaves they never grow. On pine savanna forest floors that makes the model 10 to 20 points too dark in summer. No rule tried four ways did better on lawns.
- **Bare winter forests.** These are off by about 12 points on average in the model, mostly too bright. A correction for bark seen from the side fixed most forests but made lawns worse, and was not used.
- **Leaf timing is one calendar for a town.** Trees of different species drop on different weeks, and the fall rule rests on one autumn in one region. The Pacific Northwest's spring comes out weeks late.
- **Light scattered off leaves and the ground is left out.** That keeps shade on the dark side, by an amount Canham measured at 14-41% of understory light [S7].
- **The lidar is as old as its flight.** Trees grow and are cut. The eraser handles removals; growth is not modelled.

### References

S1. U.S. Geological Survey (2024). Lidar Point Cloud - USGS National Map 3DEP Downloadable Data Collection. Read through USGS's public cloud store and download tiles. [usgs.gov/3d-elevation-program](https://www.usgs.gov/3d-elevation-program) · [ScienceBase record](https://www.sciencebase.gov/catalog/item/4f70ab64e4b058caae3f8def)
S2. Campbell, G.S. & Norman, J.M. (1998). An Introduction to Environmental Biophysics, 2nd ed. Springer, New York. [doi:10.1007/978-1-4612-1626-1](https://doi.org/10.1007/978-1-4612-1626-1)
S3. Hopkinson, C. & Chasmer, L. (2009). Testing LiDAR models of fractional cover across multiple forest ecozones. Remote Sensing of Environment 113(1): 275-288. [doi:10.1016/j.rse.2008.09.012](https://doi.org/10.1016/j.rse.2008.09.012)
S4. Chesapeake Conservancy and Chesapeake Bay Program. 1-meter land use for the Chesapeake Bay watershed, read through the Chesapeake Conservancy's bay_lu_tif image service (the edition that service served on 2026-10-17). [Image service](https://cicgis.org/arcgis/rest/services/LULC/bay_lu_tif/ImageServer) · current edition: Claggett, P.R., et al. (2025), USGS data release, [doi:10.5066/P14BEBRC](https://doi.org/10.5066/P14BEBRC)
S5. NASA Langley Research Center (LaRC) POWER Project, funded through the NASA Earth Science Applied Science Program. Daily point data (community AG; T2M, TSOIL1, ALLSKY_SFC_SW_DWN, ALLSKY_SFC_SW_DIFF), API version current at each request, read live by the map since October 2026. [power.larc.nasa.gov](https://power.larc.nasa.gov/)
S6. Nowak, D.J. (1996). Estimating leaf area and leaf biomass of open-grown deciduous urban trees. Forest Science 42(4): 504-507. [doi:10.1093/forestscience/42.4.504](https://doi.org/10.1093/forestscience/42.4.504) · [free copy](https://research.fs.usda.gov/treesearch/18809)
S7. Canham, C.D., Finzi, A.C., Pacala, S.W. & Burbank, D.H. (1994). Causes and consequences of resource heterogeneity in forests: interspecific variation in light transmission by canopy trees. Canadian Journal of Forest Research 24(2): 337-349. [doi:10.1139/x94-046](https://doi.org/10.1139/x94-046)
S8. Wasser, L., Day, R., Chasmer, L. & Taylor, A. (2013). Influence of vegetation structure on lidar-derived canopy height and fractional cover in forested riparian buffers during leaf-off and leaf-on conditions. PLoS ONE 8(1): e54776. [doi:10.1371/journal.pone.0054776](https://doi.org/10.1371/journal.pone.0054776)
S9. Richardson, A.D., et al. (2018). Tracking vegetation phenology across diverse North American biomes using PhenoCam imagery. Scientific Data 5: 180028. [doi:10.1038/sdata.2018.28](https://doi.org/10.1038/sdata.2018.28)
S10. National Ecological Observatory Network (NEON). Photosynthetically active radiation (quantum line), DP1.00066.001; Photosynthetically active radiation (PAR), DP1.00024.001 (the top of the tower's profile); Discrete return LiDAR point cloud, DP1.30003.001; Ecosystem structure (canopy height model), DP3.30015.001. 2022-2023 data as served by NEON's data portal in October 2026 (each release carries its own DOI). [DP1.00066.001](https://data.neonscience.org/data-products/DP1.00066.001) · [DP1.00024.001](https://data.neonscience.org/data-products/DP1.00024.001) · [DP1.30003.001](https://data.neonscience.org/data-products/DP1.30003.001)
S11. Gelernter, W. & Stowell, L.J. (2005). Improved overseeding programs. 1. The role of weather. Golf Course Management 73(3): 108-113. [PDF](https://files.asianturfgrass.com/gelernter_stowell_2005_improved_overseeding_gp.pdf)
S12. Iowa Environmental Mesonet, Iowa State University. IEM Reanalysis (IEMRE) daily and hourly grids. [mesonet.agron.iastate.edu/iemre](https://mesonet.agron.iastate.edu/iemre/)
S13. U.S. Department of Agriculture, Farm Service Agency. National Agriculture Imagery Program (NAIP), every leaf-on year over 29 lots in 13 states, read through Microsoft's Planetary Computer. [doi:10.5066/F7QN651G](https://doi.org/10.5066/F7QN651G) · [USDA NAIP](https://naip-usdaonline.hub.arcgis.com/)
S14. McPherson, E.G., et al. (2018). Shade factors for 149 taxa of in-leaf urban trees in the USA. Urban Forestry & Urban Greening 31: 204-211. [doi:10.1016/j.ufug.2018.03.001](https://doi.org/10.1016/j.ufug.2018.03.001) · [free copy](https://research.fs.usda.gov/treesearch/55873)
S15. Diamond, H.J., et al. (2013). U.S. Climate Reference Network after one decade of operations: status and assessment. Bulletin of the American Meteorological Society 94(4): 485-498. [doi:10.1175/BAMS-D-12-00170.1](https://doi.org/10.1175/BAMS-D-12-00170.1)
S16. Edmondson, J.L., et al. (2016). Soil surface temperatures reveal moderation of the urban heat island effect by trees and shrubs. Scientific Reports 6: 33708. [doi:10.1038/srep33708](https://doi.org/10.1038/srep33708)
