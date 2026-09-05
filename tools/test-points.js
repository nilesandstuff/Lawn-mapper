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
