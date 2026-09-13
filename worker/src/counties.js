/**
 * County parcel GIS registry -- West Michigan coverage area.
 *
 * Every county runs its own ArcGIS server with its own service path, layer
 * index, field names, and native spatial reference. Muskegon publishes in
 * EPSG:2253 (Michigan South State Plane, feet); Allegan in EPSG:3857. We
 * never deal with that: every query sends outSR=4326 so ArcGIS reprojects
 * server-side and we always get back WGS84 lng/lat, which is what area.js
 * requires.
 *
 * VERIFICATION STATUS: everything below marked `live` was found by
 * tools/discover-counties.js and confirmed by an actual point query that
 * returned a parcel-sized polygon. Re-run the "Find county servers" workflow
 * if lookups start failing -- counties republish these without notice, and
 * every endpoint in the first version of this file had already gone stale.
 */

const COUNTIES = {
  /*
   * North Carolina, all of it, from one endpoint.
   *
   * This entry used to be "Johnston County" with a bbox around Smithfield,
   * because that is the county that was being chased when it was found. But
   * the service was never Johnston's -- the county runs no reachable public
   * server, and NC OneMap is the state republishing EVERY county's parcels on
   * one layer with one schema. The bbox was the only thing holding it to one
   * county, so the bbox is now the state.
   *
   * That makes this the first entry here that is not a county at all, which is
   * why `name` reads as a state: it is what the status line quotes as the
   * source of a measurement, and calling it a county would be a lie about
   * where the number came from.
   *
   * Not every one of the hundred counties is promised. NC OneMap's coverage
   * depends on what each county has submitted to the state, and a gap returns
   * no parcel, which the app already handles by offering to trace by hand.
   * Verified at Benson; the rest is the state's claim, not a measurement.
   */
  northcarolina: {
    name: 'North Carolina (NC OneMap)',
    statewide: true,
    service: 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer',
    layer: 1, // Parcels (polys)
    // North Carolina's standard parcel schema. The discovery tool could not
    // name these -- "parno" and "siteadd" match none of its patterns -- so
    // they are set by hand and the patterns have been taught them.
    fields: { pin: 'parno', address: 'siteadd' },
    verified: 'live', // 0.259 ac at Benson
  },
  /*
   * Vermont, statewide, from VCGI's standardised parcel layer.
   *
   * Found by tools/probe-statewide.js, which tried twelve states and got one.
   * The other eleven guesses were wrong in every way a guess can be: invalid
   * URLs, services that have moved, and two that answered "Token Required" --
   * a statewide programme can exist and still not be public, which no amount
   * of reading about it would have settled.
   *
   * "Standardised" is the load-bearing word. Vermont, like North Carolina,
   * republishes what its towns send to one schema, so this is one entry for
   * 250-odd municipalities rather than 250 servers.
   *
   * What the four preflight points actually returned, since a rounder story
   * was written here before they were run:
   *
   *   Montpelier      0.244 ac   73 Main St        a real lot
   *   St Johnsbury    0.268 ac   58 Edwards St     a real lot
   *   South Burlington 49.1 ac   109 S Prospect St UVM land, badly aimed point
   *   Rutland         1843 ac    pin "ROW 1"       a right-of-way
   *
   * So two of four are houses. The other two are not the service failing --
   * every point returned SOMETHING, in four separate municipalities, with the
   * field names confirmed -- they are two coordinates I picked from memory
   * that happened to land on a university and a road corridor. Vermont towns
   * carry right-of-way parcels the way Allegan does, and a point in one gets
   * the whole corridor.
   *
   * That is enough to call this live: the layer answers statewide, and where a
   * point lands on a house it returns that house. It is not enough to claim
   * every town is in there, which is the same caveat North Carolina carries.
   */
  vermont: {
    name: 'Vermont (VCGI)',
    statewide: true,
    service: 'https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Cadastral_VTPARCELS_poly_standardized_parcels_SP_v1/FeatureServer',
    layer: 0,
    fields: { pin: 'MAPID', address: 'ADDRGL1' },
    verified: 'live', // 0.244 ac at 73 Main St, Montpelier
  },
  /*
   * Maryland, statewide, from MD iMAP's parcel boundaries.
   *
   * The cleanest result the statewide hunt produced, and the only entry added
   * in this project that answered at EVERY test point with a street address:
   *
   *   Baltimore   0.109 ac   4227 Newport Ave
   *   Annapolis   0.038 ac   64 Maryland Ave
   *   Salisbury   0.111 ac   210 W Vine St
   *   Oakland     2.249 ac   (no address on the record)
   *
   * Four counties, the Eastern Shore to the western panhandle, all
   * residential-sized, from the state's own host with proper account and
   * address fields. Nothing here needed a caveat about badly aimed points.
   */
  maryland: {
    name: 'Maryland (MD iMAP)',
    statewide: true,
    // The layer index is its OWN field, not part of the URL: parcel.js builds
    // `${service}/${layer}/query`, so folding the 0 into the service produced
    // ".../MapServer/0/undefined/query" and every Maryland address silently
    // lost its property line. The preflight caught it; nothing else would have.
    service: 'https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_ParcelBoundaries/MapServer',
    layer: 0,
    fields: { pin: 'ACCTID', address: 'ADDRESS' },
    verified: 'live', // 4 of 4 points, 0.038-2.249 ac, all with addresses
  },
  /*
   * New Hampshire, statewide, from GRANIT's parcel mosaic hosted at UNH.
   *
   * "Mosaic" is the honest word for it and the reason for the caveat: it is
   * assembled from what each town supplies, so coverage follows the towns
   * rather than the state line.
   *
   *   Concord   0.122 ac   62 N State St
   *   Nashua    2.446 ac   100 Factory St
   *   Berlin    62.3 ac    1 Community Street -- a north-country lot
   *   Keene     nothing
   *
   * Three of four, with real addresses. Keene is either a hand-aimed
   * coordinate in a road or a town that has not submitted, and from here those
   * look identical -- which is exactly the shape of gap a mosaic has and a
   * genuinely statewide layer does not. Worth knowing before promising anyone
   * blanket New Hampshire coverage.
   */
  newhampshire: {
    name: 'New Hampshire (GRANIT)',
    statewide: true,
    service: 'https://nhgeodata.unh.edu/hosting/rest/services/Hosted/CAD_ParcelMosaic/FeatureServer',
    layer: 1,
    fields: { pin: 'pid', address: 'streetaddress' },
    verified: 'live', // 3 of 4 points; Keene returns nothing
  },
  washoe: {
    name: 'Washoe County',
    fips: '32031', // Nevada -- Reno and Sparks
    // The assessor's CAMA service, not a standalone parcel one. Layer 0 is
    // called "Parcel Lines" and returns polygons regardless: a point query
    // inside a lot comes back with the lot, which a polyline layer could not
    // do. The name is the county's, not a description of the geometry.
    service: 'https://gisweb.washoecounty.gov/arcgis/rest/services/Assessor/Assessor_GSACAMA/MapServer',
    layer: 0,
    fields: { pin: 'APN', address: 'ADDRESS' },
    verified: 'live', // 0.629 ac at 1615 Belford Rd, Reno
  },
  /*
   * Wayne County, Michigan -- Detroit, Dearborn, Livonia. 1.7 million people,
   * the largest population here by a wide margin.
   *
   * FOUND FROM A CATALOGUE EXPORT, not by guessing. Every host a county of
   * this size might plausibly use was tried and none of them worked: its own
   * gis/services.waynecounty.com answer HTTP 406, SEMCOG's answers 401, and
   * the rest do not resolve. What actually serves the parcels is the county's
   * ArcGIS Online organisation, `b6rkZNtCd6Mx2gvB`, and there is nothing about
   * that string to guess. The owner exported the open data site's catalogue
   * and the host was in it. Fourth county here where the name on the server is
   * not the name of the place.
   *
   * AND THE OPEN DATA SITE ITSELF HAS NO PARCELS -- 16 feature services, all
   * boundaries and census and roads, with parcels published only as
   * per-municipality assessment CSVs and scanned tax maps. The organisation
   * behind the site publishes 332 services, and this is one of them. A site
   * catalogue lists what somebody curated onto the site; the organisation
   * lists everything.
   *
   * WHAT THE POINTS ACTUALLY RETURNED, since this county has more caveats than
   * the others and a rounder story would hide them:
   *
   *   Livonia            0.603 ac    a house
   *   Dearborn           0.161 ac    a house
   *   Detroit Islandview 0.470 ac    a house
   *   Grosse Pointe Park 0.386 ac    a house
   *   Canton Township    2.449 ac    a large township lot, plausible
   *   Detroit Rosedale Park, Palmer Woods, East English Village -- nothing
   *
   * So five of eight, and three of the four Detroit points returned nothing.
   * Detroit IS in the layer -- Islandview proves that much -- but coverage
   * inside the city is patchy at the points aimed at. Whether that is the
   * layer or three coordinates picked from memory landing on streets is not
   * settled; Detroit carries tens of thousands of vacant and demolished lots
   * and this layer has a `demolished` field, so gaps there have a real
   * explanation either way.
   *
   * A gap returns no parcel, which the app already handles by offering to
   * trace by hand. That is the same promise made for North Carolina and
   * Vermont: the layer answers, and where it answers it answers correctly.
   */
  wayne: {
    name: 'Wayne County',
    fips: '26163',
    service: 'https://services1.arcgis.com/b6rkZNtCd6Mx2gvB/arcgis/rest/services/Parcels/FeatureServer',
    layer: 4,
    // Joined to building footprints, so the attributes carry res_sqft,
    // year_built and stories as well. Only these two are read.
    fields: { pin: 'pnum', address: 'address' },
    verified: 'live', // 0.47 ac at Detroit (Islandview); 5 of 8 points
  },
  kent: {
    name: 'Kent County',
    fips: '26081',
    // Kent was written off as having no public endpoint. It has one -- the
    // server just runs under the instance name "agisprod" rather than the
    // conventional "arcgis" or "server", so every path the discovery tool
    // could invent 404'd. This is Grand Rapids, the largest population in the
    // coverage area, and it was never actually missing.
    // Was FGDBParcels/MapServer, which worked and then began timing out on
    // every point within hours -- the field metadata still answered, so it
    // looked configured correctly while returning no parcels at all. This
    // FeatureServer on the same host returns the same parcels immediately, and
    // serves queries directly rather than through MapServer's identify path,
    // which is the likelier reason it holds up.
    service: 'https://gis.kentcountymi.gov/agisprod/rest/services/ParcelsWithCondos/FeatureServer',
    layer: 0, // Parcels With Condos
    fields: { pin: 'PNUM', address: 'PROPERTYADDRESS' },
    // Kept rather than deleted: it worked this morning and timed out by
    // evening, which reads as load rather than removal. If the FeatureServer
    // has its own bad afternoon, one timeout gets the property line from here
    // instead of losing it.
    fallbacks: [{
      service: 'https://gis.kentcountymi.gov/agisprod/rest/services/FGDBParcels/MapServer',
      layer: 0,
    }],
    verified: 'live',
  },
  ottawa: {
    name: 'Ottawa County',
    fips: '26139',
    service: 'https://gis.miottawa.org/arcgis/rest/services/Hosted/AR_ParcelSearch_gdb/FeatureServer',
    layer: 6, // Ottawa_County_Parcels
    // `finalpin` is the parcel identifier; the discovery tool's first guess
    // was `propertyzip`, which merely happened to sort earlier.
    fields: { pin: 'finalpin', address: 'propertyaddress' },
    verified: 'live', // 3.3 ac at 3300 Van Buren St, Hudsonville
  },
  allegan: {
    name: 'Allegan County',
    fips: '26005',
    service: 'https://gis.allegancounty.org/server/rest/services/Parcel_Drafter_MIL1/MapServer',
    layer: 0, // Parcels
    // This layer has no single full-address column, so the address is composed
    // from its parts. MAPPING_ID is the parcel identifier.
    fields: {
      pin: 'MAPPING_ID',
      streetNum: 'propaddrnu',
      // propStreet came back blank on every parcel sampled; propstre_1 is the
      // street name in this BS&A-style export. Worst case the address renders
      // as the house number alone, which is what it already did.
      streetName: 'propstre_1',
    },
    verified: 'live',
  },
  muskegon: {
    name: 'Muskegon County',
    fips: '26121',
    service: 'https://maps.muskegoncountygis.com/arcgis/rest/services/PropertyViewer/MapServer',
    // Layer 20 ("Parcels") rejects point queries outright; 23 answers them.
    layer: 23, // Parcels - SS
    // Property_Address_Combined is the whole address; Property_Address_Num is
    // just the house number, which is what a naive field match picks first.
    fields: { pin: 'PIN', address: 'Property_Address_Combined' },
    verified: 'live', // 0.633 ac, PIN 61-27-118-300-0001-00, Norton Shores
  },
  newaygo: {
    name: 'Newaygo County',
    fips: '26123',
    /*
     * Found from a root a person opened in a browser. The instance is
     * "hosting" -- a third convention after Kent's "agisprod" and Washoe's
     * "gisweb" host -- and the service is called DrainsParcelsNewaygoCounty,
     * which no search for "parcels" alone would rank highly.
     */
    service: 'https://arcgisweb.countyofnewaygo.com/hosting/rest/services/WebApps/DrainsParcelsNewaygoCounty/MapServer',
    layer: 0,
    // P_ADDRESS is the whole address where it is filled in; the parts are kept
    // as a fallback, since the discovery run found it empty on the test parcel
    // and an address that is sometimes blank is worth composing rather than
    // dropping.
    fields: {
      pin: 'PIN',
      address: 'P_ADDRESS',
      streetNum: 'P_NUMB',
      streetName: 'P_STREET',
    },
    verified: 'live', // 0.19 ac, PIN 62-17-02-205-005
  },
};

/**
 * Rough bounding boxes, used to pick which county to query from a geocoded
 * point without making five network calls. Deliberately generous: a wrong
 * guess costs one failed query and we fall through to the next candidate.
 * [minLng, minLat, maxLng, maxLat]
 */
const COUNTY_BBOX = {
  /*
   * The whole state, corner to corner: the Atlantic at Cape Hatteras out to
   * the Tennessee line, and the Virginia line down to South Carolina and
   * Georgia. Generous on purpose, like every box here -- a point that falls in
   * the sea or over the border costs one query that returns nothing, and the
   * app then offers to trace by hand, which is what it would have done anyway.
   */
  northcarolina: [-84.40, 33.75, -75.35, 36.62],
  /*
   * Vermont, corner to corner: the Quebec line down to the Massachusetts
   * border, and Lake Champlain across to the Connecticut River.
   */
  vermont:  [-73.45, 42.72, -71.46, 45.02],
  maryland: [-79.50, 37.88, -75.04, 39.73],
  newhampshire: [-72.57, 42.69, -70.70, 45.31],
  // Washoe runs the full height of Nevada, from Lake Tahoe to the Oregon line.
  // Almost all of it is empty; the population is the southern tip around Reno.
  washoe:   [-120.10, 38.98, -119.00, 42.01],
  kent:     [-85.80, 42.76, -85.31, 43.29],
  // The Ottawa/Allegan line runs at roughly 42.84, through Holland. The old
  // values put Ottawa's southern edge below it and Allegan's northern edge
  // above nothing at all, so Holland addresses were attributed to the wrong
  // county. They overlap slightly on purpose: a point in the overlap simply
  // tries both, and the first county to return a parcel wins.
  ottawa:   [-86.24, 42.83, -85.78, 43.20],
  allegan:  [-86.22, 42.42, -85.54, 42.85],
  muskegon: [-86.55, 43.10, -85.77, 43.55],
  newaygo:  [-86.05, 43.29, -85.53, 43.82],
  /*
   * Wayne County, Michigan -- Detroit out to Livonia and Canton, down the
   * Detroit River to Grosse Ile. The eastern edge is the international border,
   * so the box stops at the river rather than running on into Ontario: a point
   * in Windsor is not a lookup worth making.
   */
  wayne:    [-83.60, 42.02, -82.87, 42.46],
  /*
   * Champaign County, Illinois -- Champaign-Urbana in the middle, Rantoul at
   * the north end, Savoy and Tolono south. Almost square, as Illinois counties
   * on the survey grid tend to be.
   */
  champaign: [-88.47, 39.86, -87.91, 40.33],
};

/*
 * A BOX MAY EXIST BEFORE ITS COUNTY DOES.
 *
 * `COUNTIES[key].service` threw for any point inside a box with no entry
 * beside it -- and a box lands here first, because the bounds of a county are
 * known long before anybody has found a server that answers for it. Adding
 * Wayne's box crashed every address in Detroit, before a single parcel had
 * been looked up.
 *
 * The optional chain makes an unfinished county what it should always have
 * been: not covered yet, which the app already handles by offering to trace by
 * hand. Asserted in worker.test.js, because the next county added will be
 * added the same way round.
 */
function candidateCounties(lng, lat) {
  return Object.entries(COUNTY_BBOX)
    .filter(([, [w, s, e, n]]) => lng >= w && lng <= e && lat >= s && lat <= n)
    .map(([key]) => key)
    .filter((key) => COUNTIES[key]?.service);
}

function isCovered(lng, lat) {
  return candidateCounties(lng, lat).length > 0;
}

export { COUNTIES, COUNTY_BBOX, candidateCounties, isCovered };
