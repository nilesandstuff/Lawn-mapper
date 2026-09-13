/**
 * Points used to prove a county parcel service actually answers.
 *
 * Shared by probe-counties.js and discover-counties.js so the two cannot
 * disagree about whether a county works -- which they did: discovery
 * confirmed Muskegon against Norton Shores while the probe was still asking
 * about a downtown point that returns nothing, and reported the county dead.
 *
 * Several points per county, because a single one is fragile in ways that
 * look like a broken endpoint:
 *   - Holland straddles the Ottawa/Allegan line, so an Ottawa layer correctly
 *     returns nothing there.
 *   - The Allegan city point lands on a road right-of-way parcel: a real
 *     answer, but 85 acres of roadway rather than a lot.
 *   - Downtown points often fall on streets, rivers, or unplatted land.
 *
 * Prefer ordinary residential addresses well inside the county.
 */
export const TEST_POINTS = {
  /*
   * North Carolina, spread across the whole state on purpose.
   *
   * This entry covers all hundred counties through NC OneMap, so testing it in
   * one town would prove almost nothing about the claim being made. These are
   * five different counties, five hundred miles apart, in five different
   * assessors' offices -- because NC OneMap is the state REPUBLISHING what
   * each county sends it, and a county that has sent nothing is a hole that
   * looks exactly like a working service from Raleigh.
   *
   * BENSON is the point this entry was actually verified at -- 0.259 ac, the
   * number recorded in counties.js -- so it stays, as the one point whose
   * failure would mean something has gone backwards rather than that a
   * coordinate landed badly. A first version of this list dropped Benson and
   * kept Clayton while claiming Clayton was the verified one, which would have
   * quietly retired the only point with a known answer.
   *
   * Clayton is kept too and currently returns nothing. That is not evidence of
   * a gap in Johnston County: the coordinate is approximate and a point in a
   * road or on unplatted land returns nothing from a working service. It is
   * left in as a reminder that these points are aimed by hand.
   */
  northcarolina: [
    { lng: -78.5440, lat: 35.3830, label: 'Benson (Johnston, verified 0.259 ac)' },
    { lng: -78.4560, lat: 35.6510, label: 'Clayton (Johnston)' },
    { lng: -80.8300, lat: 35.2050, label: 'Charlotte (Mecklenburg)' },
    { lng: -82.5540, lat: 35.5850, label: 'Asheville (Buncombe)' },
    { lng: -77.8900, lat: 34.2100, label: 'Wilmington (New Hanover)' },
    { lng: -79.8200, lat: 36.0900, label: 'Greensboro (Guilford)' },
  ],
  /*
   * Vermont, in four towns across the state.
   *
   * Montpelier and St Johnsbury are the two that landed on actual houses --
   * 0.244 and 0.268 acres -- and they are the ones that mean something if they
   * stop answering.
   *
   * The other two are kept as they are, mislanded, and labelled so. South
   * Burlington hit university land at 49 acres and Rutland hit a right-of-way
   * parcel at 1,843, which the probe flagged as implausible. Neither is the
   * service failing: every one of the four returned a parcel, which is the
   * thing statewide coverage actually rests on. Aiming a point from memory at
   * a town you have never seen is how you land on a campus, and pretending
   * otherwise by quietly nudging the coordinates until the numbers look tidy
   * would make these points prove less, not more.
   */
  vermont: [
    { lng: -72.5750, lat: 44.2600, label: 'Montpelier (house, 0.244 ac)' },
    { lng: -72.0150, lat: 44.4190, label: 'St Johnsbury (house, 0.268 ac)' },
    { lng: -73.1900, lat: 44.4560, label: 'South Burlington (lands on UVM land)' },
    { lng: -72.9720, lat: 43.6100, label: 'Rutland (lands on a right-of-way)' },
  ],
  /*
   * Maryland, across the state: the Eastern Shore, the bay, the Baltimore
   * corridor and the western panhandle are four different worlds of platting.
   */
  maryland: [
    { lng: -76.6400, lat: 39.3400, label: 'Baltimore (0.109 ac when found)' },
    { lng: -79.4100, lat: 39.4100, label: 'Oakland (2.249 ac when found)' },
    { lng: -76.4900, lat: 38.9800, label: 'Annapolis' },
    { lng: -75.6000, lat: 38.3600, label: 'Salisbury (Eastern Shore)' },
  ],
  /*
   * New Hampshire. GRANIT's layer is a MOSAIC of what each town supplies, so
   * these deliberately mix a city, the seacoast belt and the north country --
   * where a town that has not submitted is exactly what would show up as a
   * hole.
   */
  newhampshire: [
    { lng: -71.5400, lat: 43.2100, label: 'Concord (0.122 ac when found)' },
    { lng: -71.4700, lat: 42.7600, label: 'Nashua' },
    { lng: -72.2800, lat: 42.9300, label: 'Keene' },
    { lng: -71.1700, lat: 44.4700, label: 'Berlin (north country)' },
  ],
  // Washoe County, Nevada. Reno and Sparks are the population; Incline Village
  // is included because it sits across the Carson Range on the Tahoe shore and
  // is the part most likely to be served by a different layer, or missed.
  washoe: [
    { lng: -119.8330, lat: 39.4980, label: 'Reno (Lakeridge)' },
    { lng: -119.7480, lat: 39.5490, label: 'Sparks' },
    { lng: -119.9460, lat: 39.2510, label: 'Incline Village' },
  ],
  kent: [
    { lng: -85.5872, lat: 42.9297, label: 'Kentwood' },
    { lng: -85.6681, lat: 42.9634, label: 'Grand Rapids' },
    { lng: -85.5406, lat: 43.1197, label: 'Rockford' },
  ],
  ottawa: [
    { lng: -85.8637, lat: 42.8703, label: 'Hudsonville' },
    { lng: -85.7975, lat: 42.9075, label: 'Jenison' },
    { lng: -86.2100, lat: 43.0631, label: 'Grand Haven' },
  ],
  allegan: [
    { lng: -85.6447, lat: 42.6742, label: 'Wayland' },
    { lng: -85.8556, lat: 42.5292, label: 'Allegan' },
    { lng: -85.6431, lat: 42.4392, label: 'Plainwell area' },
  ],
  muskegon: [
    { lng: -86.2639, lat: 43.1689, label: 'Norton Shores' },
    { lng: -86.2200, lat: 43.2342, label: 'Muskegon' },
    { lng: -86.1553, lat: 43.1319, label: 'Fruitport' },
  ],
  newaygo: [
    { lng: -85.9481, lat: 43.4661, label: 'Fremont' },
    { lng: -85.8003, lat: 43.4197, label: 'Newaygo' },
    { lng: -85.7723, lat: 43.5503, label: 'White Cloud' },
  ],

  /*
   * Wayne County, Michigan. Five points because the county is not one thing:
   * Detroit, the older inner suburbs, and the post-war townships are three
   * different assessors' worth of record-keeping inside one county, and a
   * layer that covers one may not cover the others.
   *
   * Aimed at ordinary residential streets rather than downtown, following the
   * lesson at the top of this file: a downtown point lands on a street, a
   * river or unplatted land and returns nothing from a perfectly good service.
   *
   * Detroit is deliberately a settled residential district rather than the
   * core, because the core is also where the vacant-lot record is messiest.
   */
  /*
   * FOUR OF THESE ARE DETROIT, deliberately and out of proportion to the rest.
   *
   * The county layer answered Livonia, Grosse Pointe Park and Canton with
   * believable residential lots, and returned NOTHING at the one Detroit point
   * first tried. Detroit is 640,000 of the county's 1.7 million people, so
   * whether that was a badly aimed coordinate or a hole in the layer is the
   * difference between covering Wayne County and covering the suburbs around
   * Detroit -- and the app must not claim the first while doing the second.
   *
   * One point cannot tell those apart. Four in four different districts can:
   * if all four return nothing, the layer excludes the city.
   *
   * The Dearborn point is also replaced. It returned 77 acres, which is a real
   * parcel -- Dearborn has enormous industrial lots around the Rouge plant --
   * but not a house, so it proved nothing about residential coverage. The new
   * one is aimed at a residential street well north of the industry.
   */
  wayne: [
    { lng: -83.3527, lat: 42.3684, label: 'Livonia (post-war subdivision)' },
    { lng: -83.2455, lat: 42.3380, label: 'Dearborn (residential, north of the Rouge)' },
    { lng: -83.2200, lat: 42.3900, label: 'Detroit (Rosedale Park)' },
    { lng: -83.1450, lat: 42.4260, label: 'Detroit (Palmer Woods)' },
    { lng: -82.9540, lat: 42.4110, label: 'Detroit (East English Village)' },
    { lng: -83.1020, lat: 42.3600, label: 'Detroit (Islandview)' },
    { lng: -82.9300, lat: 42.3750, label: 'Grosse Pointe Park' },
    { lng: -83.4820, lat: 42.3090, label: 'Canton Township' },
  ],

  /*
   * Champaign County, Illinois. The two cities, a village, and a town at the
   * far end of the county.
   *
   * Rantoul is there on purpose: it is twenty miles north of the university
   * and was a separate air force base town, so it is the point most likely to
   * be missing from a layer that really only covers Champaign-Urbana. If the
   * first four answer and Rantoul does not, that is a coverage fact worth
   * recording rather than a failure.
   */
  champaign: [
    { lng: -88.2700, lat: 40.1100, label: 'Champaign (residential)' },
    { lng: -88.2000, lat: 40.1150, label: 'Urbana (residential)' },
    { lng: -88.2520, lat: 40.0560, label: 'Savoy' },
    { lng: -88.4030, lat: 40.1920, label: 'Mahomet' },
    { lng: -88.1430, lat: 40.3090, label: 'Rantoul (far north of the county)' },
  ],
};
