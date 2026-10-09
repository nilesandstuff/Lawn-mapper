/**
 * WHEN A PHOTO WAS FLOWN, as one number to sort by (owner, 2026-10-09:
 * "newest should mean date of flight"). Years with a fraction for the part
 * of the year: 2025.25 for "spring 2025", 2024.21 for "March 2024", 2025.5
 * for a bare "2025" (the middle of the year, so a year-only service ties
 * with a summer one rather than losing to it). Null when nothing dates it:
 * a service calling itself "most current" with no date is not newest, it is
 * undated, and sorts after every dated one.
 *
 * `flown` is the catalogue's own words (tools/county-imagery.js seasonOf):
 * "Summer of 2025", "Spring 2022; Spring of 2019", "2018-01-01..2026-08-29",
 * "March 2024". The latest date in it counts, since a range or a list ends
 * at the newest flight it holds.
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SEASON = { winter: 0.05, spring: 0.25, summer: 0.5, fall: 0.75, autumn: 0.75 };
const YEAR_OK = (y) => y >= 1900 && y <= 2100;

export function flightDate(flown, year = null) {
  const t = String(flown || '').toLowerCase();
  const found = [];
  for (const m of t.matchAll(/\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/g)) {
    found.push(Number(m[1]) + (Number(m[2]) - 0.5) / 12);
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})\b/g)) {
    found.push(Number(m[3]) + (Number(m[1]) - 0.5) / 12);
  }
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?((?:19|20)\d{2})\b/g)) {
    found.push(Number(m[2]) + (MONTHS.indexOf(m[1]) + 0.5) / 12);
  }
  for (const m of t.matchAll(/\b(winter|spring|summer|fall|autumn)\s+(?:of\s+)?((?:19|20)\d{2})\b/g)) {
    found.push(Number(m[2]) + SEASON[m[1]]);
  }
  for (const m of t.matchAll(/\b((?:19|20)\d{2})\b/g)) {
    /* A bare year only when nothing finer names that year. */
    const y = Number(m[1]);
    if (!found.some((d) => Math.floor(d) === y)) found.push(y + 0.5);
  }
  const dated = found.filter(YEAR_OK);
  if (dated.length) return Math.round(Math.max(...dated) * 1000) / 1000;
  const y = Number(year);
  return Number.isFinite(y) && YEAR_OK(y) ? y + 0.5 : null;
}

/** Newest flight first; undated last; a tie says so with 0. */
export function byFlightDate(a, b) {
  const da = flightDate(a?.flown, a?.year), db = flightDate(b?.flown, b?.year);
  if (da === null && db === null) return 0;
  if (da === null) return 1;
  if (db === null) return -1;
  return db - da;
}

/** The same flight date, as far as either says. */
export const sameFlight = (a, b) => byFlightDate(a, b) === 0 && flightDate(a?.flown, a?.year) !== null;
