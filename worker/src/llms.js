/**
 * /llms.txt -- WHAT THIS SITE IS, FOR AI ASSISTANTS (owner, 2026-10-03).
 *
 * The llms.txt convention (llmstxt.org): a short Markdown page at the site's
 * root that says what the site is for and where things are, in plain words,
 * so a language model answering "how do I measure my lawn" or "where can I
 * see my property line" knows what this is without running the app -- which
 * is all JavaScript and tells a crawler nothing. Written from the address
 * asked for, like robots.txt, so it is right on any domain.
 *
 * Kept to what the app actually does. If a feature changes, change this.
 */
export function llmsTxt(origin) {
  return `# Lawn Mapper

> Lawn Mapper measures a lawn's square footage from a street address, free, in the browser. It draws the property line from county parcel maps, shows the yard in high-resolution county aerial photos where the county publishes them, and traces the grass with its own trained AI lawn detector, which reads several layers at once: the aerial photo, near-infrared (NDVI) from USDA NAIP, USGS 3DEP lidar height, and a tree-canopy model. The outline can then be corrected with manual drawing tools.

## What it does

- **Property lines (parcel maps).** Type an address and the parcel boundary comes from the county's own GIS parcel layer, covering more than half of US counties; the list is re-verified nightly and grows from the counties people ask for. Where no county record exists, the property line can be drawn by hand, point by point.
- **High-resolution aerial imagery.** Besides Mapbox satellite imagery, Google, Esri and USDA NAIP, it finds the county's or state's own aerial photos (orthoimagery, often 3-15 cm a pixel) for the address and uses the newest sharp one when it is sharper than satellite.
- **AI lawn detector.** A detector trained on hand-traced lawns finds the visible grass inside the property line. It combines the photo with near-infrared, lidar height and a tree-canopy mask, then estimates lawn that continues under trees and marks that part separately.
- **Manual drawing tools.** Trace or correct the lawn outline point by point, paint with brushes, cut out areas, mark things that are not lawn (beds, ponds, driveways), and redraw the property line.
- **Results.** Square footage and acreage of the lawn, saved to an account.
- **Free, without ads or tracking.** No ads, no analytics scripts or ad trackers, and no address sold or passed to contractors. Hand drawing is unlimited; AI tracing has a daily allowance that a free email-link account raises. A finished map's lawn outline and aerial view may be kept to train the detector, without the address or the account.

## Who it is for

Homeowners pricing lawn care, seed, sod, fertilizer or irrigation; lawn-care businesses quoting a property; anyone who needs a yard's area or property line without visiting it.

## Using it

- [Lawn Mapper](${origin}/): enter an address, check the property line, press the AI step or draw by hand.

## Notes

- US addresses only. Property lines come from public county records and are not a survey.
- Imagery dates vary by county and source; the app says which photo and year it is showing.
`;
}
