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
   * The probe that found this service tested one point in central Burlington
   * and got a 16-acre parcel -- a campus or a park, not a house. That is not
   * a failure of the service, it is a badly aimed point, and it is exactly why
   * these are ordinary residential streets in four separate towns: what needs
   * proving is that a HOUSE comes back, in more than one municipality, since
   * VCGI republishes what each town submits.
   */
  vermont: [
    { lng: -73.1900, lat: 44.4560, label: 'South Burlington' },
    { lng: -72.9720, lat: 43.6100, label: 'Rutland' },
    { lng: -72.5750, lat: 44.2600, label: 'Montpelier' },
    { lng: -72.0150, lat: 44.4190, label: 'St Johnsbury' },
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
};
