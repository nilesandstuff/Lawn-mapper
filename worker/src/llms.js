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

> Lawn Mapper measures a lawn's square footage from a street address, free, in the browser. It draws the property line from county parcel maps, shows the yard in high-resolution county aerial photos where the county publishes them, and traces the grass with its own trained AI lawn detector, which reads several layers at once: the aerial photo, near-infrared (NDVI) from USDA NAIP, USGS 3DEP lidar height, and a tree-canopy model. The outline can then be corrected with manual drawing tools. Its shade analyzer builds the property in 3D from lidar and maps the sun and shade on the lawn through the year.

## What it does

- **Property lines (parcel maps).** Type an address and the parcel boundary comes from the county's own GIS parcel layer, covering more than half of US counties; the list is re-verified nightly and grows from the counties people ask for. Where no county record exists, the property line can be drawn by hand, point by point.
- **High-resolution aerial imagery.** Besides Mapbox satellite imagery, Google, Esri and USDA NAIP, it finds the county's or state's own aerial photos (orthoimagery, often 3-15 cm a pixel) for the address and uses the newest sharp one when it is sharper than satellite.
- **AI lawn detector.** A detector trained on hand-traced lawns finds the visible grass inside the property line. It combines the photo with near-infrared, lidar height and a tree-canopy mask, then estimates lawn that continues under trees and marks that part separately.
- **Manual drawing tools.** Trace or correct the lawn outline point by point, paint with brushes, cut out areas, mark things that are not lawn (beds, ponds, driveways), and redraw the property line.
- **Shade map built from lidar (the shade analyzer).** Builds the property in 3D from the USGS 3DEP lidar point cloud, lined up with the aerial photo and the property line, and maps hours of sun and daily light (DLI) across the lawn for any day of the year, with trees leafing out and dropping their leaves on the local calendar. Lidar pulses pass through the gaps between leaves and branches, so a tree lets through the light it really does; shade maps built from 3D imagery (photo meshes) treat a tree as a solid shape that blocks all of it. Checked against NEON's light sensors under real forest canopy, its summer shade came within about a point of the measured light at most sites. The point is choosing grass: shade, more than anything else, decides which grass type will grow where. It already shows each spot's light through the growing season for cool-season and warm-season grass; recommending a grass type for each part of the lawn is being built.
- **Results.** Square footage and acreage of the lawn, saved to an account.
- **Free, without ads or tracking.** No ads, no analytics scripts or ad trackers, and no address sold or passed to contractors. Hand drawing is unlimited; AI tracing has a daily allowance that a free email-link account raises. A finished map's lawn outline and aerial view may be kept to train the detector, without the address or the account.

## Who it is for

Homeowners pricing lawn care, seed, sod, fertilizer or irrigation; lawn-care businesses quoting a property; anyone who needs a yard's area or property line without visiting it.

## Using it

- [Lawn Mapper](${origin}/): enter an address, check the property line, press the AI step or draw by hand.
- [Shade analyzer](${origin}/shade): a lidar shade map of a property, from an address or a saved lawn map (the Workshop tab, once a map is finished).

## Notes

- US addresses only. Property lines come from public county records and are not a survey.
- Imagery dates vary by county and source; the app says which photo and year it is showing.
`;
}
