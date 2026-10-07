/**
 * THE COUNTY TABLE ON THE LANDING PAGE, written in at deploy (owner,
 * 2026-10-07: "make it a sales pitch for users, search engines, and AI").
 *
 * The app's own coverage list is built by JavaScript from /api/coverage, which
 * a person sees and most crawlers never do. This writes the same registry into
 * public/index.html as a plain HTML table, between two marker comments, so
 * "property lines Kent County Michigan" is on the page as text.
 *
 * COMPUTED, NEVER TYPED, like everything else about coverage (see
 * worker/src/coverage.js). The copy committed between the markers is only a
 * snapshot; tools/ci-prepare.js rewrites it from the registry on every deploy,
 * so the page cannot fall behind what the Worker can actually serve.
 */

export const START = '<!-- COVERAGE:START -->';
export const END = '<!-- COVERAGE:END -->';

const esc = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** What the middle column says about one state. */
export function reach(s) {
  if (s.kind === 'whole') return 'Statewide';
  if (s.kind === 'most') return 'Statewide layer, most counties';
  return `${s.covered} of ${s.total} ${s.total === 1 ? 'county' : 'counties'}`;
}

/**
 * The counties named for a state. Statewide states are named by the layer
 * that serves them; a state served county by county lists those counties.
 */
export function named(s) {
  if (s.kind !== 'some') return '';
  return s.counties.join(', ');
}

export function coverageBlock(states) {
  const total = states.reduce((n, s) => n + (s.covered || 0), 0);
  const statewide = states.filter((s) => s.kind !== 'some').length;
  const rows = states.map((s) => `<tr><th scope="row">${esc(s.name)}</th>`
    + `<td>${esc(reach(s))}</td><td>${esc(named(s))}</td></tr>`).join('\n');
  const dc = states.some((s) => s.ab === 'DC');
  const n = states.length - (dc ? 1 : 0);
  return `${START}
<p class="lp-stat"><b>${total.toLocaleString('en-US')}</b> counties across
  <b>${n}</b> ${n === 1 ? 'state' : 'states'}${dc ? ' and Washington, D.C.' : ''}, with
  <b>${statewide}</b> served by a statewide parcel layer.</p>
<details class="lp-states">
<summary>Every state and county with property lines</summary>
<div class="lp-scroll">
<table class="lp-table lp-covtable">
<caption>Property line coverage by state</caption>
<thead><tr><th scope="col">State</th><th scope="col">Property lines</th><th scope="col">Counties</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
</details>
${END}`;
}

/** Replace what is between the markers; a page without them is left alone. */
export function fillCoverage(html, states) {
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a < 0 || b < a) return html;
  return html.slice(0, a) + coverageBlock(states) + html.slice(b + END.length);
}
