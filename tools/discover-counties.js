/**
 * Finds the county parcel services, rather than assuming them.
 *
 * probe-counties.js answers "is the configured endpoint still right?". When
 * the answer is no -- as it was for all four counties -- it cannot tell you
 * what the right one is. This does that: it walks each county's ArcGIS
 * services directory, finds services and layers that look like parcels,
 * queries each candidate with a real point, and prints a config block for
 * whichever actually returns a parcel.
 *
 * Needs internet, so it runs on a GitHub Actions runner:
 *   Actions -> "3. Find county servers" -> Run workflow
 *
 * It only issues read-only GETs against public services, at a deliberately
 * gentle rate -- these are small public assets, not something to hammer.
 */

import { COUNTIES } from '../worker/src/counties.js';
import { esriToGeoJSON } from '../worker/src/parcel.js';
import { measure } from '../public/lib/area.js';
import { TEST_POINTS } from './test-points.js';

const TIMEOUT_MS = 12000;
/*
 * Raised from 8 because Wayne County publishes 332 services in one ArcGIS
 * Online organisation, and the first eight alphabetically were five different
 * subsets of its parcels. Only names that already look like parcels get here,
 * and they are ranked before being cut, so this is a bound on how long a
 * hopeless search runs rather than a filter doing real work.
 */
const MAX_SERVICES_PER_ROOT = 30;
const MAX_LAYERS_PER_SERVICE = 8;

/** Archive and roll layers answer queries but are not the current parcel map. */
const ARCHIVE_NAME = /historic|archive|assessment roll|\b(19|20)\d{2}\b|previous|old/i;

/**
 * A residential or small rural parcel. The old bound of 2000 acres let an
 * 85-acre polygon from a historic layer pass as a match.
 */
const PLAUSIBLE_ACRES = { min: 0.01, max: 160 };

/**
 * Where to look. The configured host comes first; the rest are the usual
 * places a county moves its GIS to (a rebrand to the county's public domain,
 * or a switch between ArcGIS Server layouts).
 */
/**
 * Which state each county is in, for the ArcGIS Online catalogue search.
 *
 * The coverage area started as West Michigan and the search string said so.
 * Searching "washoe Michigan parcels" would find nothing and report the county
 * dead, which is a confident wrong answer -- the worst kind from a tool whose
 * whole job is telling you whether an endpoint exists.
 */
const STATES = {
  washoe: 'Nevada',
  vanderburgh: 'Indiana',
  indiana: 'Indiana',
  northcarolina: 'North Carolina',
  champaign: 'Illinois',
  // Named although Michigan is the fallback, because a reader checking why
  // Wayne searched Michigan should find the answer here rather than infer it
  // from an absence.
  wayne: 'Michigan',
};

const CANDIDATE_ROOTS = {
  /*
   * North Carolina, statewide, through NC OneMap.
   *
   * This began as a hunt for Johnston County's own server and never found one
   * -- gis.johnstonnc.com and its variants all failed. What answered was the
   * state, republishing every county's parcels on one layer, and that is what
   * ships. The county roots are gone from this list because they were never
   * the thing that worked, and leaving them would send the next person looking
   * down the road that already turned out to be a dead end.
   */
  northcarolina: [
    'https://services.nconemap.gov/secure/rest/services',
    'https://services.nconemap.gov/arcgis/rest/services',
    'https://nconemap.gov/arcgis/rest/services',
  ],

  /*
   * Indiana, statewide, from IndianaMap.
   *
   * Not a guess. The catalogue search run for Vanderburgh County came back
   * with "Parcel Boundaries of Indiana Current", published by IndianaMap on
   * the state's own host, and it answered three of the five Evansville points
   * with Evansville lots. The schema is the giveaway that it is not an
   * Evansville layer at all: `county_fips`, `county_id`, `dlgf_prop_class_code`
   * -- DLGF is the state's Department of Local Government Finance, which
   * collects assessment records from all 92 counties.
   *
   * So this is listed as its own statewide key rather than filed under
   * Vanderburgh, and it gets test points in six counties across the state,
   * because "it works in Evansville" is not evidence for the other 91.
   */
  indiana: [
    'https://gisdata.in.gov/server/rest/services',
    'https://gisdata.in.gov/arcgis/rest/services',
  ],

  /*
   * Washoe County, Nevada -- Reno and Sparks. The first county outside
   * Michigan, so nothing here can be assumed from the others.
   *
   * Both instance names are tried on every host after Kent, whose server ran
   * under "agisprod" and was written off as non-existent for weeks because
   * only "arcgis" and "server" were guessed.
   */
  washoe: [
    'https://gis.washoecounty.gov/arcgis/rest/services',
    'https://gis.washoecounty.gov/server/rest/services',
    'https://gisweb.washoecounty.gov/arcgis/rest/services',
    'https://maps.washoecounty.gov/arcgis/rest/services',
    'https://arcgis.washoecounty.gov/arcgis/rest/services',
    'https://gis.washoecounty.us/arcgis/rest/services',
    // Reno and Sparks run their own GIS; a city server may publish the county
    // parcel layer even when the county's own directory is closed.
    'https://gis.reno.gov/arcgis/rest/services',
    'https://maps.cityofsparks.us/arcgis/rest/services',
  ],
  kent: [
    // Kent runs its ArcGIS Server under a non-standard instance name. No
    // amount of guessing finds "agisprod" -- the convention is "arcgis" or
    // "server" -- which is why every earlier search reported Kent dead. A
    // person spotted it in a browser; the lesson is that this list is a
    // shortcut, not a substitute for looking.
    'https://gis.kentcountymi.gov/agisprod/rest/services',
    'https://gis.kentcountymi.gov/agistest/rest/services',
    'https://gis.kentcountymi.gov/arcgis/rest/services',
    'https://gis.kentcountymi.gov/server/rest/services',
    'https://maps.kentcountymi.gov/arcgis/rest/services',
    'https://gisapps.kentcountymi.gov/arcgis/rest/services',
    'https://services.kentcountymi.gov/arcgis/rest/services',
    // Kent runs its public property lookup under accesskent.com, so its GIS
    // may have moved there along with everything else.
    'https://gis.accesskent.com/arcgis/rest/services',
    'https://maps.accesskent.com/arcgis/rest/services',
    'https://www.accesskent.com/arcgis/rest/services',
  ],
  ottawa: [
    'https://gis.miottawa.org/arcgis/rest/services',
    'https://gis.miottawa.org/server/rest/services',
    'https://maps.miottawa.org/arcgis/rest/services',
    'https://gis.co.ottawa.mi.us/arcgis/rest/services',
    'https://gis.co.ottawa.mi.us/gisweb/rest/services',
  ],
  allegan: [
    'https://gis.allegancounty.org/server/rest/services',
    'https://gis.allegancounty.org/arcgis/rest/services',
    'https://maps.allegancounty.org/arcgis/rest/services',
  ],
  muskegon: [
    'https://maps.muskegoncountygis.com/arcgis/rest/services',
    'https://gis.co.muskegon.mi.us/arcgis/rest/services',
  ],
  newaygo: [
    // "hosting" -- a third non-standard instance name, after Kent's "agisprod"
    // and Washoe's move to a "gisweb" host. Three counties, three conventions,
    // none of them the documented one. Found by a person, again.
    'https://arcgisweb.countyofnewaygo.com/hosting/rest/services',
    'https://arcgisweb.countyofnewaygo.com/arcgis/rest/services',
    'https://gis.countyofnewaygo.com/arcgis/rest/services',
    'https://maps.countyofnewaygo.com/arcgis/rest/services',
    'https://services.arcgis.com/newaygo/arcgis/rest/services',
  ],

  /*
   * Wayne County, Michigan -- Detroit, Dearborn, Livonia. By far the largest
   * population this project has tried to cover: about 1.7 million people.
   *
   * EVERY URL BELOW IS A GUESS, in the same sense as every other list here:
   * the convention, tried on the hosts a county of this size plausibly uses.
   * Three of the seven counties already here turned out to use a host or an
   * instance name nobody would have guessed, so the catalogue search at the
   * end of investigate() is the likelier finder, not this list.
   *
   * Detroit is included as its own root because it runs a substantial open
   * data GIS of its own and holds a third of the county's parcels. A city
   * layer covering only Detroit would still be worth having -- it would just
   * need saying so in the entry, rather than being filed as "Wayne County".
   *
   * SEMCOG is the regional planning agency for the seven-county Detroit area
   * and republishes member data, which is the same shape as NC OneMap: one
   * layer standing in for many assessors.
   *
   * WHAT THE SEARCH ACTUALLY FOUND, so the next person does not repeat it:
   *
   *   gis/services.waynecounty.com   HTTP 406 -- a server is there and it
   *                                  refuses the request outright
   *   maps/gisapps.waynecounty.com   does not resolve
   *   gis/gisportal.detroitmi.gov    does not resolve
   *   maps.semcog.org                answers, publishes ONE service, and it
   *                                  is not parcels
   *   gis.semcog.org                 HTTP 401 -- exists, requires a token
   *
   * The 406 and the 401 are the interesting ones: both are servers that are
   * running and have decided not to talk to us, which is different from a
   * county that has no GIS. Wayne's parcels exist; they are not published
   * anonymously at any name worth guessing.
   *
   * The ArcGIS Online catalogue returns only private extracts for Wayne -- one
   * person's flood study, somebody's "sample" of Livonia -- which is what
   * hardened the match test rather than what got added.
   */
  wayne: [
    /*
     * THE COUNTY'S OWN ArcGIS ONLINE ORGANISATION, from the catalogue export
     * of its open data site. This is the host every guess below missed,
     * because there is nothing about "b6rkZNtCd6Mx2gvB" to guess.
     *
     * The site's own catalogue lists no parcel polygons -- 16 feature
     * services, all boundaries, census, roads and districts, with parcels
     * published only as per-municipality assessment CSVs and historical tax
     * map PDFs. But a catalogue lists what somebody curated onto the site,
     * and the organisation's REST directory lists everything public in it,
     * which is a different and longer list. Worth asking directly.
     */
    'https://services1.arcgis.com/b6rkZNtCd6Mx2gvB/arcgis/rest/services',
    'https://gis.waynecounty.com/arcgis/rest/services',
    'https://gis.waynecounty.com/server/rest/services',
    'https://maps.waynecounty.com/arcgis/rest/services',
    'https://gisapps.waynecounty.com/arcgis/rest/services',
    'https://services.waynecounty.com/arcgis/rest/services',
    // Detroit's own, which is open-data-first and unusually well published.
    'https://gis.detroitmi.gov/arcgis/rest/services',
    'https://gisportal.detroitmi.gov/arcgis/rest/services',
    // The regional agency, in case the county publishes through it.
    'https://maps.semcog.org/arcgis/rest/services',
    'https://gis.semcog.org/arcgis/rest/services',
  ],

  /*
   * Champaign County, Illinois -- Champaign, Urbana, the university.
   *
   * The first Illinois county, so nothing about it can be assumed from the
   * Michigan ones. Illinois has no public statewide parcel layer to fall back
   * on the way North Carolina and Vermont do, so this has to be the county's
   * own or a member city's.
   *
   * The county's GIS is run by a consortium -- CCGISC, which the county, the
   * cities and the university fund jointly -- so its host is likelier to carry
   * the consortium's name than the county's. That is the same pattern as
   * Newaygo and Kent: the name on the server is not the name of the place.
   *
   * NINETEEN HOSTS TRIED, ALL DEAD, AND NO CATALOGUE CANDIDATES. Almost all
   * of them failed to resolve at all rather than refusing -- so unlike Wayne,
   * where a server answered 406 and another 401, there is no evidence here
   * that any of these names exists. The two ccgisc.org guesses that DID
   * resolve returned 404 for the services directory, which means a web server
   * on that name and no ArcGIS under it.
   *
   * Which puts Champaign exactly where Kent and Newaygo were: the endpoint is
   * findable, but not by guessing.
   *
   * AND IT WAS FOUND BY SEARCHING THE WEB FOR IT, in one query, after all
   * nineteen of the guesses below had failed. The host is
   * gisportal.champaignil.gov -- the CITY of Champaign's portal, serving the
   * COUNTY consortium's parcels out of a folder called CCGISC -- and the
   * instance name is "ms", with hosted services under "hs". Three separate
   * things none of the guesses had: the wrong level of government in the
   * hostname, an instance name that is neither "arcgis" nor "server", and the
   * layer a folder deep.
   *
   * That is the fourth county in a row where the name on the server is not the
   * name of the place, and the first one where a search engine, rather than a
   * person with a browser, was what closed the gap. Worth remembering the next
   * time a list like the one below starts getting long: a hostname list is a
   * guess at a fact that is written down somewhere public.
   */
  champaign: [
    // The two instance names on the portal that actually exists. Ordered
    // first because these are read off a search result, not imagined.
    'https://gisportal.champaignil.gov/ms/rest/services',
    'https://gisportal.champaignil.gov/hs/rest/services',
    // The consortium's own name, tried with the instance names that turned out
    // to be right for the city -- the portal front end lives here.
    'https://services.ccgisc.org/ms/rest/services',
    'https://services.ccgisc.org/hs/rest/services',
    'https://gis.ccgisc.org/arcgis/rest/services',
    'https://maps.ccgisc.org/arcgis/rest/services',
    'https://ccgisc.org/arcgis/rest/services',
    'https://www.ccgisc.org/arcgis/rest/services',
    'https://gisdata.ccgisc.org/arcgis/rest/services',
    'https://services.ccgisc.org/arcgis/rest/services',
    // The non-standard instance names that turned out to be the answer for
    // Kent ("agisprod") and Newaygo ("hosting"). Cheap to try, and the only
    // reason those two were ever found.
    'https://gis.ccgisc.org/server/rest/services',
    'https://gis.ccgisc.org/hosting/rest/services',
    'https://gis.co.champaign.il.us/arcgis/rest/services',
    'https://maps.co.champaign.il.us/arcgis/rest/services',
    'https://gis.co.champaign.il.us/server/rest/services',
    'https://gis.champaigncountyil.gov/arcgis/rest/services',
    'https://maps.champaigncountyil.gov/arcgis/rest/services',
    // The two cities, which co-fund the consortium and may republish it.
    'https://gis.champaignil.gov/arcgis/rest/services',
    'https://maps.champaignil.gov/arcgis/rest/services',
    'https://gis.ci.champaign.il.us/arcgis/rest/services',
    'https://gis.urbanaillinois.us/arcgis/rest/services',
    'https://maps.urbanaillinois.us/arcgis/rest/services',
  ],
};

/**
 * A named dataset, rather than a host to go looking through.
 *
 * WHY THIS EXISTS. Guessing hostnames has now failed for four counties in a
 * row -- Kent, Newaygo, Wayne, Champaign -- and three of those were solved by
 * a person handing over a link they had found in a browser. That is the
 * reliable path, and until now the tool could not take one: it accepted a
 * services DIRECTORY to walk, and a person with a link has an ArcGIS Hub page
 * or an item id, which is neither.
 *
 * So this takes what people actually have. Anything identifying an ArcGIS
 * item works -- a Hub dataset page, an item.html link, or the bare 32-character
 * id -- and the item's own metadata says where the service lives. No guessing
 * at all: the id IS the answer, one lookup away.
 */
const CANDIDATE_ITEMS = {
  /*
   * Vanderburgh County, Indiana -- Evansville. Supplied as a Hub dataset page
   * by the owner, which is the whole point of this list.
   *
   * `evvc-evvc` is the Hub subdomain for the city/county GIS; the "_0" on the
   * dataset id is the layer within the service, and the 32 characters before
   * it are the item.
   */
  vanderburgh: [
    'https://evvc-evvc.opendata.arcgis.com/datasets/02762faf4df24829bced0cd54ccdb19c_0/api',
  ],
};

/** The 32-character item id inside whatever form of link somebody has. */
function itemIdFrom(ref) {
  const s = String(ref);
  // A Hub dataset path: /datasets/<32 hex>_<layer>, layer optional.
  const hub = s.match(/\/datasets\/([0-9a-f]{32})(?:_(\d+))?/i);
  if (hub) return { id: hub[1], layer: hub[2] === undefined ? null : Number(hub[2]) };
  // An item.html link, or any URL carrying ?id=
  const byParam = s.match(/[?&]id=([0-9a-f]{32})/i);
  if (byParam) return { id: byParam[1], layer: null };
  // A bare id.
  const bare = s.match(/^([0-9a-f]{32})$/i);
  if (bare) return { id: bare[1], layer: null };
  return null;
}

/**
 * Where an ArcGIS item's data actually lives.
 *
 * The item record carries the service URL in `url`. A Hub page is a view of
 * exactly this, so resolving the id is the same thing a browser does when
 * somebody clicks through to the API endpoint -- without the browser.
 */
async function resolveItem(ref) {
  const found = itemIdFrom(ref);
  if (!found) return { error: `not an ArcGIS item reference: ${ref}` };

  const meta = await getJson(
    `https://www.arcgis.com/sharing/rest/content/items/${found.id}?f=json`
  );
  if (meta.error) return { error: describe(meta.error) };
  if (!meta.url) return { error: `item "${meta.title || found.id}" publishes no service URL` };

  /*
   * AN ITEM'S URL IS SOMETIMES A LAYER, NOT A SERVICE.
   *
   * Evansville's item -- the one link this whole list was built to accept --
   * publishes ".../PROPERTY_BOUNDARIES/MapServer/0". Everything downstream
   * appends its own layer index, so that became ".../MapServer/0/0/query" and
   * the server answered "Invalid or missing input parameters": a link a person
   * handed over, resolved correctly, failing on a slash.
   *
   * The trailing number is the layer the item points at, which is better
   * information than the layer scan that would otherwise run -- so it is kept
   * as a hint rather than discarded.
   */
  let url = String(meta.url).replace(/\/+$/, '');
  let layer = found.layer;
  const asLayer = url.match(/^(.*\/(?:Map|Feature)Server)\/(\d+)$/i);
  if (asLayer) {
    url = asLayer[1];
    if (layer === null) layer = Number(asLayer[2]);
  }

  return { url, title: meta.title, owner: meta.owner, type: meta.type, layer };
}

const PARCEL_NAME = /parcel|propert|cadastr|landbase|tax.?map|assessor/i;

/**
 * Words that make a parcel layer a SUBSET of the parcel layer.
 *
 * Every one of these was found on a real service that answered real queries
 * with real parcel-shaped polygons, and none of them is the county's parcel
 * map: flood parcels, county-OWNED parcels, a DRAFT of the missing ones, a
 * sample, one person's study of parcels AFFECTED by something.
 *
 * They are the reason ranking by name is worth doing at all. A subset answers
 * a point query exactly as convincingly as the real thing -- it just answers
 * for a fraction of the county, and nothing about the response says so.
 */
const QUALIFIED_NAME =
  /flood|owned|draft|missing|cleanup|clean_?up|sample|affected|research|study|test|temp|backup|non_?park|proposed|pending|split|merge|delinq|forfeit|foreclos|vacant|demo|survey_?only/i;

/**
 * How likely a service name is to BE the county parcel layer, rather than a
 * slice of it. Higher is better.
 *
 * The plainest name wins, because that is how these are actually named: the
 * real one is "Parcels", and everything built from it gets a qualifier. A
 * short name is preferred for the same reason -- "Parcels" over
 * "Parcels_Public_View_2024_Final".
 */
function nameScore(fullName) {
  const name = String(fullName).split('/').pop();
  let score = 0;

  if (PARCEL_NAME.test(name)) score += 10;
  if (/^parcels?$/i.test(name)) score += 40;              // the ideal
  if (/^[a-z_ ]*parcels?[a-z_ ]*$/i.test(name)) score += 10; // nothing but words
  if (QUALIFIED_NAME.test(name)) score -= 50;             // a subset, not the map
  if (ARCHIVE_NAME.test(name)) score -= 30;

  // Shorter is likelier to be the canonical one; a mild tiebreak, not a rule.
  score -= Math.min(10, Math.floor(name.length / 8));
  return score;
}

/*
 * Field picking, in preference order.
 *
 * Loose matching gets this wrong in ways that look right: "propertyzip"
 * starts with "prop" and was offered as a parcel id, and
 * "Property_Address_Num" matched an address pattern while holding just the
 * house number ("787"). Exact names are tried first, then patterns, and a
 * candidate whose value does not look like the thing is rejected outright.
 */
const PIN_EXACT = /^(pin|parcelid|parcel_id|parcelno|parcel_no|parcelnum|parcelnumber|pnum|apn|pid|finalpin|mapping_?id|parno|altparno)$/i;
const PIN_LOOSE = /(parcel.*(id|no|num)|^pin$|packedpin)/i;
/*
 * `prop_add` and `dlgf_prop_address` are Indiana's, and they are here for the
 * same reason `siteadd` and `parno` are: the tool found a layer carrying a
 * perfectly good street address and reported "address field: (none found)",
 * which reads as a layer with no addresses on it. Every state's parcel schema
 * abbreviates differently, so this list grows one state at a time rather than
 * by imagining what a name might be.
 *
 * The Indiana layer carries BOTH, plus `dlgf_prop_address_city`, `_state` and
 * `_zip`. Two separate things keep those three out: the loose pattern is
 * anchored at the end, so a name with a piece tacked on never matches it, and
 * ADDR_FRAGMENT below rejects them again by that suffix. Checked against the
 * layer's real field list, not assumed.
 */
const ADDR_EXACT = /^(propertyaddress|property_address_combined|siteaddress|site_address|siteadd|fulladdress|full_address|address|situs_address|prop_add|prop_address|propadd|dlgf_prop_address)$/i;
const ADDR_LOOSE = /(addr.*combined|full.?addr|site.?addr|situs|prop.?addr?e?s?s?$)/i;

/** Reject fields that are clearly a fragment rather than the whole value. */
const ADDR_FRAGMENT = /(num|number|dir|direction|city|state|zip|country|unit|apt)$/i;

const looksLikePin = (v) =>
  typeof v === 'string' && v.trim().length >= 6 && /\d/.test(v);
const looksLikeAddress = (v) =>
  typeof v === 'string' && v.trim().length >= 5 && /\d/.test(v) && /[a-z]/i.test(v);

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const text = await res.text();
    // ArcGIS answers a bad path with an HTML error page and a 200.
    if (/^\s*</.test(text)) return { error: 'returned HTML, not JSON' };
    try {
      return JSON.parse(text);
    } catch {
      return { error: 'unparseable response' };
    }
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** ArcGIS reports failures as an object; render it as something readable. */
const describe = (err) =>
  typeof err === 'string' ? err : err?.message || JSON.stringify(err).slice(0, 160);

/**
 * Every service under a root, following one level of folders.
 *
 * REPORTS WHAT IT WALKED, not just what it found. Twice now a root has been
 * reachable, published dozens of services, and produced no candidate worth
 * testing -- Indiana's gisdata.in.gov and Champaign's gisportal -- and both
 * times the output said "48 services published" and nothing else, which cannot
 * be told apart from "the parcel layer is not here". The folder list and the
 * names are the two facts that separate those, so they come back with the
 * services and get printed.
 */
async function listServices(root) {
  const top = await getJson(`${root}?f=json`);
  if (top.error) return { error: top.error };

  const services = [...(top.services || [])];
  const all = top.folders || [];
  /*
   * Raised from 12, which was never a considered number. Kept as a bound on
   * how long a hopeless walk runs; anything cut is now named below rather than
   * silently dropped, because a folder that was never opened looks exactly
   * like a folder with nothing in it.
   */
  const walked = all.slice(0, 40);
  const failed = [];
  for (const folder of walked) {
    const sub = await getJson(`${root}/${folder}?f=json`);
    if (sub.error) {
      failed.push(`${folder} (${describe(sub.error)})`);
      continue;
    }
    services.push(...(sub.services || []));
  }
  // Names already carry their folder ("Hosted/Parcels"); de-duplicate, since
  // a service listed at the root can reappear in its folder listing.
  const seen = new Set();
  return {
    folders: all,
    uncounted: all.slice(40),
    failed,
    services: services.filter((s) => {
      const key = `${s.name}/${s.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

/**
 * Ask ArcGIS Online for a county's parcel layer.
 *
 * Counties increasingly publish to ArcGIS Online rather than running their own
 * server, in which case there is no county-hosted directory left to walk --
 * which is exactly what Kent's 404 looks like. This searches the public
 * catalogue instead.
 */
/*
 * `key`, NOT the display name, and this was wrong from the day STATES was
 * added to fix it.
 *
 * STATES is keyed by the county key -- `washoe` -- and this was called with
 * the name minus " County" -- `Washoe`. So the lookup missed every time and
 * fell through to Michigan, and the search Washoe actually ran was "Washoe
 * Michigan parcels": precisely the confidently-wrong query the comment on
 * STATES says it exists to prevent. It never fired, because Washoe was found
 * by a host guess before the catalogue search was reached.
 *
 * It matters now because Champaign is in Illinois and has no obvious host, so
 * the catalogue search is the likeliest thing to find it.
 */
async function searchArcGISOnline(key) {
  const countyName = (COUNTIES[key]?.name || key).replace(/ County$/, '');
  const q = `${countyName} ${STATES[key] || 'Michigan'} parcels`;
  const url =
    'https://www.arcgis.com/sharing/rest/search?' +
    new URLSearchParams({
      q,
      f: 'json',
      num: '20',
      sortField: 'numviews',
      sortOrder: 'desc',
    });
  const data = await getJson(url);
  if (data.error || !data.results) return [];

  return data.results
    .filter((r) => /Feature Service|Map Service/i.test(r.type) && r.url)
    .filter((r) => PARCEL_NAME.test(r.title) || PARCEL_NAME.test(r.snippet || ''))
    .slice(0, 6)
    .map((r) => ({ url: r.url.replace(/\/$/, ''), title: r.title, owner: r.owner }));
}

/**
 * Point-in-polygon query, mirroring the fallback in worker/src/parcel.js.
 *
 * resultRecordCount is gone entirely: several of these servers answer
 * "Pagination is not supported" and return nothing at all, which is what made
 * Allegan's and Muskegon's current parcel layers look dead.
 */
async function queryLayer(serviceUrl, layerId, point) {
  const base = {
    f: 'json',
    geometry: JSON.stringify({ x: point.lng, y: point.lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
  };

  let last = null;
  for (const params of [{ ...base, geometryPrecision: '8' }, base]) {
    last = await getJson(`${serviceUrl}/${layerId}/query?${new URLSearchParams(params)}`);
    if (!last.error) return last;
  }
  return last;
}

function summarise(attrs) {
  const names = Object.keys(attrs);

  const pick = (tests, valueOk, reject) => {
    for (const test of tests) {
      // A field that matches AND holds a sensible value beats one that only
      // matches by name.
      const withValue = names.find(
        (n) => test.test(n) && !(reject && reject.test(n)) && valueOk(attrs[n])
      );
      if (withValue) return withValue;
    }
    for (const test of tests) {
      const byName = names.find((n) => test.test(n) && !(reject && reject.test(n)));
      if (byName) return byName;
    }
    return null;
  };

  return {
    pin: pick([PIN_EXACT, PIN_LOOSE], looksLikePin),
    address: pick([ADDR_EXACT, ADDR_LOOSE], looksLikeAddress, ADDR_FRAGMENT),
    names,
  };
}

/**
 * Test every plausible layer of one service. Returns true on a match.
 *
 * `hint` is a layer index somebody's link already named. When it is given, that
 * layer is tried first and on its own: a person pointing at a dataset has said
 * which layer holds the parcels, and guessing past them would only find a
 * different answer than the one they asked about.
 */
async function tryService(key, serviceUrl, label, points, hint = null) {
  const meta = await getJson(`${serviceUrl}?f=json`);
  if (meta.error) {
    console.log(`      x ${label} -- ${describe(meta.error)}`);
    return false;
  }

  // A FeatureServer with a single layer often omits the list; /0 is the layer.
  const layers = meta.layers || (meta.type === 'Feature Layer' ? [{ id: 0, name: meta.name }] : []);
  if (!layers.length) {
    console.log(`      x ${label} -- no layers`);
    return false;
  }

  const pointedAt = hint === null ? null : layers.find((l) => l.id === hint);
  if (pointedAt) {
    console.log(`      -> ${label}: layer ${hint} ("${pointedAt.name}"), named by the link`);
    return probeLayer(key, serviceUrl, pointedAt, points);
  }

  const usable = layers.filter((l) => !ARCHIVE_NAME.test(l.name));
  const named = usable.filter((l) => PARCEL_NAME.test(l.name));
  const tryThese = (named.length ? named : usable).slice(0, MAX_LAYERS_PER_SERVICE);

  const skipped = layers.length - usable.length;
  console.log(
    `      -> ${label}: ${layers.length} layers, testing ${tryThese.length}` +
    (skipped ? ` (${skipped} archive//historic skipped)` : '')
  );

  for (const layer of tryThese) {
    if (await probeLayer(key, serviceUrl, layer, points)) return true;
  }
  return false;
}

/**
 * Query one layer at every test point and decide what it is.
 *
 * Split out of tryService so a layer somebody's link named can be tested
 * directly, without the layer scan that exists for services nobody has
 * pointed at.
 */
async function probeLayer(key, serviceUrl, layer, points) {
  /*
   * EVERY POINT, NOT THE FIRST ONE THAT ANSWERS.
   *
   * This used to return on the first hit and print a ready-to-paste block
   * claiming `verified: 'live'`. Searching Wayne County it hit a layer named
   * "Wayne_County_Parcels_Affected1" -- one private individual's flood study
   * of the River Rouge, published to their personal ArcGIS Online account --
   * matched a single point at 37 acres, found no pin or address field, and
   * printed a config block with the literal string 'null' in it.
   *
   * Four of the five points had returned nothing. The evidence for that
   * recommendation was one oversized polygon from a stranger's coursework,
   * and the tool presented it in the same words it uses for Kent.
   *
   * So: all the points are tried, the hits are counted, and the verdict says
   * how much of the county actually answered. A layer that names fields and
   * answers in several towns is a county parcel layer. One that answers in a
   * single spot with no identifiers is a subset of something, and the paste
   * block says so instead of lying.
   */
  const hits = [];
  let rejected = null;

  for (const point of points) {
    const result = await queryLayer(serviceUrl, layer.id, point);

    if (result.error) {
      console.log(`         [${layer.id}] ${layer.name} @${point.label}: ${describe(result.error)}`);
      rejected = 'the layer refuses queries';
      break; // a rejected query will be rejected for every point
    }
    if (!result.features?.length) {
      console.log(`         [${layer.id}] ${layer.name} @${point.label}: 0 features`);
      continue;
    }

    const feature = result.features[0];
    const geometry = esriToGeoJSON(feature.geometry);
    if (!geometry) {
      console.log(`         [${layer.id}] ${layer.name} @${point.label}: no usable geometry`);
      continue;
    }

    const area = measure(geometry);
    if (area.acres < PLAUSIBLE_ACRES.min || area.acres > PLAUSIBLE_ACRES.max) {
      console.log(`         [${layer.id}] ${layer.name} @${point.label}: ${area.acres} ac -- not parcel-sized`);
      continue;
    }

    console.log(`         [${layer.id}] ${layer.name} @${point.label}: ${area.acres} ac`);
    hits.push({ point, feature, area });
  }

  if (rejected || !hits.length) return false;

  const f = summarise(hits[0].feature.attributes || {});

  /*
   * What would make this trustworthy, stated as the two things a county
   * parcel layer has and a one-off extract does not.
   */
  const doubts = [];
  if (!f.pin && !f.address) {
    doubts.push('no parcel id or address field -- nothing to label a lot with');
  }
  if (points.length > 1 && hits.length < 2) {
    doubts.push(`only ${hits.length} of ${points.length} test points returned a parcel`);
  }
  /*
   * A residential point that comes back as tens of acres is not this lot. It
   * passes PLAUSIBLE_ACRES because that bound has to allow real rural
   * parcels, so the median is checked separately against a suburban size.
   */
  const median = [...hits].sort((a, b) => a.area.acres - b.area.acres)[Math.floor(hits.length / 2)];
  if (median.area.acres > 25) {
    doubts.push(`typical result is ${median.area.acres} ac, far too big for the residential points aimed at`);
  }

  console.log(`\n         ${doubts.length ? '--- CANDIDATE (not trusted) ---' : '*** MATCH ***'}`);
  console.log(`         [${layer.id}] ${layer.name}`);
  console.log(`         ${hits.length} of ${points.length} points answered; typical ${median.area.acres} ac`);
  console.log(`         pin field:     ${f.pin || '(none found)'}`);
  console.log(`         address field: ${f.address || '(none found)'}`);

  if (doubts.length) {
    console.log(`\n         NOT recommended, because:`);
    for (const d of doubts) console.log(`           - ${d}`);
    console.log(`         Service: ${serviceUrl} layer ${layer.id}`);
    console.log(`         all fields: ${f.names.slice(0, 30).join(', ')}\n`);
    return false;   // keep looking; something better may be further down the list
  }

  console.log(`\n         Paste into worker/src/counties.js:`);
  console.log(`           ${key}: {`);
  console.log(`             name: '${COUNTIES[key]?.name || key}',`);
  console.log(`             fips: '${COUNTIES[key]?.fips || ''}',`);
  console.log(`             service: '${serviceUrl}',`);
  console.log(`             layer: ${layer.id},`);
  const fieldBits = [f.pin ? `pin: '${f.pin}'` : null, f.address ? `address: '${f.address}'` : null]
    .filter(Boolean).join(', ');
  console.log(`             fields: { ${fieldBits} },`);
  console.log(`             verified: 'live', // ${median.area.acres} ac at ${median.point.label}`);
  console.log(`           },`);
  console.log(`         all fields: ${f.names.slice(0, 30).join(', ')}\n`);
  return true;
}

async function investigate(key) {
  const points = TEST_POINTS[key];
  const labels = points.map((p) => p.label).join(', ');
  console.log(`\n${'='.repeat(66)}\n${COUNTIES[key]?.name || key}  (test points: ${labels})\n${'='.repeat(66)}`);

  /*
   * NAMED DATASETS FIRST, because they are not guesses.
   *
   * Everything below this is a search: a list of hostnames somebody thought
   * plausible, walked for anything parcel-shaped. An item id is the opposite
   * -- a person found the dataset and this resolves where it is served from.
   * Trying it first means the answer somebody already has beats twenty
   * hostnames that will not resolve.
   */
  for (const ref of CANDIDATE_ITEMS[key] || []) {
    const item = await resolveItem(ref);
    if (item.error) {
      console.log(`  ✗ ${ref}\n      ${item.error}`);
      continue;
    }
    console.log(`  ✓ item "${item.title}" [${item.owner}] -- ${item.type}`);
    console.log(`      ${item.url}`);
    if (await tryService(key, item.url, item.title, points, item.layer)) return true;
  }

  for (const root of CANDIDATE_ROOTS[key] || []) {
    const { services, error, folders, uncounted, failed } = await listServices(root);
    if (error) {
      console.log(`  ✗ ${root}\n      ${describe(error)}`);
      continue;
    }

    console.log(`  ✓ ${root}\n      ${services.length} services published`);
    if (folders.length) console.log(`      folders: ${folders.join(', ')}`);
    if (failed.length) console.log(`      folders that would not list: ${failed.join(', ')}`);
    if (uncounted.length) console.log(`      NOT WALKED (past the cap): ${uncounted.join(', ')}`);

    /*
     * RANKED, NOT THE FIRST EIGHT ALPHABETICALLY.
     *
     * Wayne County's ArcGIS Online organisation publishes 332 services. The
     * old `.slice(0, 8)` took whichever eight sorted first, which for Wayne
     * meant A_E_PropertiesFinal_NonParkYet, CleanUpMissingParcels,
     * CountyOwnedParcels, CountyParcelPoint and Flood_Parcels -- five working
     * subsets of the county's parcels, none of them the parcel layer, and the
     * search stopped at the first that answered. The actual layer was
     * somewhere in the other 327 and was never asked.
     *
     * A county's real parcel layer is almost always the one with the PLAINEST
     * name. Every qualifier -- flood, county-owned, draft, missing, non-park
     * -- is a subset of it. So the qualified ones sink and the plain one
     * floats, and far more get tried.
     */
    const candidates = services
      .filter((s) => PARCEL_NAME.test(s.name) && /MapServer|FeatureServer/.test(s.type))
      .map((s) => ({ svc: s, score: nameScore(s.name) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SERVICES_PER_ROOT)
      .map((c) => c.svc);

    /*
     * PRINT THE NAMES EVEN WHEN THERE IS A CANDIDATE.
     *
     * This used to list services only when NOTHING matched. Champaign's portal
     * matched exactly one -- NSD/Vacant_Parcels, a subset of the city's -- so
     * the listing was suppressed and the run reported "48 services published"
     * with no way to see what the other 47 were called. A weak match hides the
     * evidence more effectively than no match does, which is backwards.
     */
    const sample = services.slice(0, 60).map((s) => s.name).join(', ');
    console.log(`      names: ${sample}${services.length > 60 ? ', …' : ''}`);

    if (!candidates.length) {
      console.log('      none of them look like parcels.');
      continue;
    }

    for (const svc of candidates) {
      // svc.name already carries any folder ("Hosted/Parcels"). Stripping it
      // produced a URL missing the folder, which is why every hosted service
      // failed on the previous run.
      const serviceUrl = `${root}/${svc.name}/${svc.type}`;
      if (await tryService(key, serviceUrl, `${svc.name} (${svc.type})`, points)) return true;
    }
  }

  // Nothing county-hosted answered; try the public ArcGIS Online catalogue.
  console.log(`\n  Searching ArcGIS Online for "${COUNTIES[key]?.name || key}"…`);
  const hosted = await searchArcGISOnline(key);
  if (!hosted.length) console.log('      no candidates found');

  for (const item of hosted) {
    if (await tryService(key, item.url, `${item.title} [${item.owner}]`, points)) return true;
  }

  console.log(`  → nothing worked for ${key}.`);
  return false;
}

const only = process.argv[2];

/*
 * Say what is wrong, rather than throwing.
 *
 * A name this file does not know used to reach investigate() and die on
 * `TEST_POINTS[key].map` with a stack trace -- from a diagnostic tool whose
 * whole audience is someone on a phone with no way to read one. It is also the
 * only tool here that takes a free-text name, so a typo is the expected input,
 * not the exceptional one. `none` is accepted as a way to run the workflow for
 * its statewide half alone.
 */
const known = [...new Set([...Object.keys(CANDIDATE_ROOTS), ...Object.keys(CANDIDATE_ITEMS)])];
if (only && only !== 'none' && !known.includes(only)) {
  console.error(`No county called "${only}" is configured here.`);
  console.error(`Known: ${known.join(', ')}`);
  console.error('Or "none" to skip the county search entirely.');
  process.exit(1);
}
if (only === 'none') {
  console.log('Skipping the county search (county: none).');
  process.exit(0);
}

const keys = only ? [only] : known;
const found = [];

for (const key of keys) {
  if (await investigate(key)) found.push(key);
}

console.log(`\n${'='.repeat(66)}`);
console.log(`Working parcel sources found for: ${found.length ? found.join(', ') : '(none)'}`);
console.log(`No source for: ${keys.filter((k) => !found.includes(k)).join(', ') || '(none)'}`);
console.log(`${'='.repeat(66)}\n`);
