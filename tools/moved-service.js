/**
 * WHERE A PARCEL SERVICE THAT HAS GONE MOST LIKELY WENT, on the same server
 * (tools/verify-counties.js). Jefferson County IL's Parcel_JeffersonIL became
 * Parcel_JeffersonIL2 (2026-10-03): the same name with a version number
 * added or changed, beside it in the same folder.
 */
export const GONE = /invalid url|service not found|not found|does not exist|http 404/i;
export function renamedCandidates(service, names) {
  const m = String(service).match(/^(.*\/rest\/services)\/(.+)\/(FeatureServer|MapServer)$/i);
  if (!m) return [];
  const base = (n) => n.toLowerCase().replace(/[_\s-]*(v?\d+|copy|new|current|latest)$/i, '');
  const was = m[2];
  return names
    .filter((x) => x.name !== was && base(x.name.split('/').pop()) === base(was.split('/').pop())
      && x.name.split('/').length === was.split('/').length && x.type === m[3])
    .map((x) => `${m[1]}/${x.name}/${x.type}`);
}

