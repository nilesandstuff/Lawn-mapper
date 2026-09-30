/**
 * Does the page contain the things the code reaches for?
 *
 * app.js addresses the DOM by id, several hundred times, and a missing id is
 * not an error anyone sees: `$('#thing')` returns null, the optional chaining
 * that guards most of these swallows it, and the feature is simply absent.
 * Moving a control between panels -- which is exactly what splitting one long
 * column into tabs is -- is the operation that produces those, and it produces
 * them silently and in bulk.
 *
 * The browser check would catch it, but only for the paths it drives, only
 * when Mapbox is reachable, and only after four minutes of real map. This is
 * two files and a regular expression, it runs offline in milliseconds, and it
 * covers every id in the file rather than the ones a script happens to click.
 *
 * It deliberately does NOT try to parse HTML. The question is not "is this
 * document well formed", it is "does app.js refer to an element that is not
 * there", and matching the id attributes answers exactly that.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'public/index.html'), 'utf8');
const js = readFileSync(join(root, 'public/app.js'), 'utf8');
const css = readFileSync(join(root, 'public/styles.css'), 'utf8');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

/* --------------------------------------------------------- ids in the page */
const declared = new Set();
const duplicated = [];
for (const m of html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) {
  if (declared.has(m[1])) duplicated.push(m[1]);
  declared.add(m[1]);
}

check('every id in the page is unique',
  duplicated.length === 0,
  duplicated.length ? `repeated: ${[...new Set(duplicated)].join(', ')}` : `${declared.size} ids`);

/* ------------------------------------------------ ids the code asks for */
/*
 * Only the literal, unambiguous forms. A selector built from a variable --
 * `#mode-${m}`, `#tab-${t}` -- cannot be resolved by reading the file, and
 * guessing at what the variable might hold would produce false alarms about
 * ids that are fine. Those are covered below by naming the tables they come
 * from, which is the honest way to check a generated id: assert the table.
 */
const wanted = new Map(); // id -> how it was written
for (const m of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) wanted.set(m[1], `$('#${m[1]}')`);
for (const m of js.matchAll(/querySelector(?:All)?\('#([A-Za-z0-9_-]+)/g)) {
  wanted.set(m[1], `querySelector('#${m[1]}')`);
}
for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) {
  wanted.set(m[1], `getElementById('${m[1]}')`);
}

const missing = [...wanted.keys()].filter((id) => !declared.has(id));
check('every element the code reaches for is in the page',
  missing.length === 0,
  missing.length
    ? missing.map((id) => wanted.get(id)).join(', ')
    : `${wanted.size} referenced, all present`);

/* ------------------------------------------------- the generated families */
/*
 * The ids built from a table, checked against the table rather than against a
 * guess. These are the ones a rename breaks most quietly: the table moves, the
 * markup does not, and a whole row of buttons stops responding.
 */
const family = (label, prefix, names) => {
  const absent = names.filter((n) => !declared.has(`${prefix}${n}`));
  check(`every ${label} has its element`, absent.length === 0,
    absent.length ? absent.map((n) => `#${prefix}${n}`).join(', ') : names.join(', '));
};

const listFrom = (re) => {
  const m = js.match(re);
  return m ? [...m[1].matchAll(/'([a-z0-9_-]+)'/g)].map((x) => x[1]) : [];
};

const tabs = listFrom(/const TABS = \[([^\]]*)\]/);
check('the tab list is readable from the source', tabs.length >= 3, tabs.join(', '));
family('tab', 'tab-', tabs);
family('tab panel', 'pane-', tabs);

const modes = listFrom(/const MODES = \[([^\]]*)\]/);
check('the mode list is readable from the source', modes.length >= 3, modes.join(', '));
/*
 * Except a step's own tool, which has no button: the Property line step's
 * boundary editor and the Draw step's lawn tools are simply on while you are
 * on them (restMode in app.js, owner 2026-09-30). Read from restMode itself,
 * so a mode that stops being one keeps its button check.
 */
const restBody = (js.match(/function restMode\(\) \{([\s\S]*?)\n\}/) || [])[1] || '';
const stepTools = [...restBody.matchAll(/return '([a-z]+)'/g)].map((m) => m[1]);
check('the step-owned tools are readable from restMode', stepTools.length >= 2, stepTools.join(', '));
family('map mode button', 'mode-', modes.filter((m) => !stepTools.includes(m)));

/*
 * EVERY MODE BELONGS TO A TAB.
 *
 * The rail hides any button whose mode is not the open tab's, so a mode
 * missing from that table is a button that can never be shown -- a tool that
 * silently ceases to exist rather than one that visibly breaks.
 */
const modeTable = js.match(/const MODE_TAB = \{([^}]*)\}/);
const mapped = modeTable
  ? [...modeTable[1].matchAll(/([a-z]+):\s*'([a-z]+)'/g)].map((x) => [x[1], x[2]])
  : [];
const mappedModes = new Set(mapped.map(([mode]) => mode));
const orphans = modes.filter((m) => !mappedModes.has(m));
check('every map tool belongs to a tab', orphans.length === 0,
  orphans.length ? `no tab owns: ${orphans.join(', ')}` : mapped.map(([a, b]) => `${a}->${b}`).join(', '));
const badTabs = mapped.filter(([, tab]) => !tabs.includes(tab));
check('and every tool points at a tab that exists', badTabs.length === 0,
  badTabs.map(([a, b]) => `${a}->${b}`).join(', '));

/* ------------------------------------------------------------- the tips */
/*
 * A TIP MUST BE ABLE TO POINT AT SOMETHING VISIBLE.
 *
 * showTip declines to open when its target is hidden, which is right -- a box
 * in the corner talking about a button that is not on screen is worse than
 * silence. But once the tools moved onto tabs, the first tip in the app
 * pointed at a map button that only appears on a tab you do not land on, so it
 * stopped appearing at all: nothing failed, nothing threw, and the only way to
 * notice was that a box was missing.
 *
 * A map-rail button is exactly the kind of target that can be away, because
 * refreshRail hides every one whose tab is not open. So pointing at one is
 * only safe through tipTarget, which falls back to the tab that opens it.
 */
const tipBody = js.slice(js.indexOf('function tipContent'), js.indexOf('function listSentence'));

const tipTargets = [...new Set(
  [...tipBody.matchAll(/target:\s*'(#[A-Za-z0-9_-]+)'/g)].map((m) => m[1])
)];

check('the tips were found in the source', tipTargets.length >= 2, tipTargets.join(', '));

const absentTargets = tipTargets.filter((t) => !declared.has(t.slice(1)));
check('every control a tip names exists', absentTargets.length === 0, absentTargets.join(', '));

/*
 * A TIP CAN ONLY POINT AT SOMETHING ON THE MAP.
 *
 * The coaching box is positioned inside the map and clamped to it, so a tip
 * naming a control in the panel could not reach it. That is not a limitation
 * to work around -- it was tried, by letting the box out to point at a tab,
 * and the box landed across the tab strip and made every tab unclickable. The
 * box stays in the map; targets stay in the map with it.
 */
const mapMarkup = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
const offMap = tipTargets.filter((t) => !mapMarkup.includes(`id="${t.slice(1)}"`));
check('and lives on the map, where the tip box can reach it',
  offMap.length === 0,
  offMap.length ? `${offMap.join(', ')} is in the panel` : tipTargets.join(', '));

/*
 * AND A TIP WHOSE CONTROL IS ON ANOTHER TAB MUST WAIT, NOT VANISH.
 *
 * showTip declines to point at a hidden control, which is right. What it must
 * not do is treat that as "never": every map tool is hidden on three tabs out
 * of four, so a silent return is how the first tip in the app stopped
 * appearing at all, with nothing failing.
 */
check('a tip whose control is on another tab waits for that tab',
  /pendingTip = stage/.test(js) && /function flushPendingTip/.test(js),
  'showTip must record the stage and setTab must flush it');

/* --------------------------------------------------- links off-site */
/*
 * EVERY target="_blank" CARRIES rel="noopener".
 *
 * Not ceremony and not a lint preference: without it the page that opens gets
 * a live handle on this one through `window.opener`, and can navigate the tab
 * it came from somewhere else. The tab still says lawnmap.nilesandstuff.com in
 * the history and still has the person's session in it.
 *
 * Checked rather than remembered because the first two were written carefully
 * and the third one, added in a hurry next to them, is the one that will not
 * be. "noreferrer" rides along: it is what actually stops window.opener in the
 * older browsers where noopener alone did not.
 */
{
  const blank = [...html.matchAll(/<a\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /target="_blank"/.test(tag));

  check('the off-site links were found', blank.length >= 2, `${blank.length} found`);

  const unsafe = blank.filter((tag) => !/rel="[^"]*\bnoopener\b[^"]*"/.test(tag));
  check('and every one of them denies the opened page a handle on this one',
    unsafe.length === 0,
    unsafe.length ? unsafe.map((t) => t.slice(0, 70)).join(' | ') : 'all rel=noopener');
}

/* ----------------------------------------------- the free controls */
/*
 * A LOCKED STEP MUST NOT DIM THE CONTROLS THAT COST NOTHING.
 *
 * The lock exists to stop a PAID re-detection throwing hand corrections away.
 * Two settings on that tab spend nothing -- the trees option re-reads a mask
 * already downloaded, the overlay only draws it -- so they stay usable, and
 * they are marked `stays-free`.
 *
 * The trap this pins is CSS and would pass every other check here: opacity on
 * the pane composites the whole subtree at once, so a child at opacity 1
 * inside a parent at .42 is still drawn at .42. No specificity fixes it. The
 * dimming has to be applied per child or the opt-out silently does nothing --
 * and "silently does nothing" would look exactly like it working, because
 * pointer-events WOULD come back and the control would be usable while still
 * greyed out, reading as broken.
 */
{
  const free = [...html.matchAll(/class="[^"]*\bstays-free\b[^"]*"/g)].length;
  check('the free controls are marked on the page', free >= 2, `${free} marked`);

  const rule = css.match(/\.tabpane\.is-locked[^{]*\{[^}]*\}/);
  check('and the locked pane has a dimming rule at all', Boolean(rule),
    rule ? rule[0].replace(/\s+/g, ' ') : 'no .tabpane.is-locked rule found');

  check('which dims the children, not the pane, so the opt-out can work',
    Boolean(rule) && /\.tabpane\.is-locked\s*>\s*\*:not\(\.stays-free\)/.test(css),
    'opacity on the pane cannot be undone by a child at any specificity');

  check('and the opt-out is a class the stylesheet actually knows',
    /\.stays-free\b/.test(css));
}

/* ------------------------------------------- numbers said out loud */
/*
 * A THRESHOLD QUOTED TO THE USER COMES FROM THE CONSTANT.
 *
 * The trees option names the gap size it fills, because "small" is the entire
 * question -- it decides whether the shed in the middle of the lawn is counted
 * as grass. A number typed into the sentence would be right until the constant
 * moved, and then it would be a confident, specific, wrong promise, which is
 * worse than the vague wording it replaced.
 */
check('the trees note quotes the threshold from the constant',
  /TREE_GAP_SQFT\.toLocaleString\(\)/.test(js),
  'the sentence must read the constant, not repeat its value');

/* ------------------------------------------------- shadowed globals */
/*
 * A MODULE-LEVEL `let history = []` SHADOWS THE DOM'S `history` FOR THE WHOLE
 * FILE, and the undo stack is called exactly that.
 *
 * So `history.replaceState(...)` is a method call on an Array: undefined, a
 * TypeError, at runtime, in whatever path happens to reach it. It shipped
 * once. The path was the return from a sign-in link, during boot, so the throw
 * took the map's setup down with it -- and the visible symptom was "The map
 * didn't load" for signed-in visitors only, which points nowhere near the
 * cause and does not clear on a reload because the fragment is still there.
 *
 * There WAS a comment at the other call site explaining all of this. The
 * second one was written anyway, which is the argument for a check: a note
 * explains a rule to whoever reads that line, and this enforces it for
 * whoever does not.
 */
/*
 * NAMED EXPLICITLY, because this runs in Node and `history` is not a global
 * here -- testing `name in globalThis` finds nothing and passes, which is the
 * check quietly examining an empty list. Each entry is the members that only
 * the DOM object has, so `history.push(snapshot())` on the undo stack reads as
 * what it is and `history.replaceState(...)` does not.
 */
const DOM_GLOBALS = {
  history: ['replaceState', 'pushState', 'back', 'forward', 'go', 'state'],
  location: ['href', 'pathname', 'hash', 'search', 'assign', 'reload', 'origin'],
  screen: ['width', 'height', 'availWidth', 'availHeight', 'orientation'],
  navigator: ['userAgent', 'clipboard', 'geolocation', 'share', 'platform'],
  status: ['toLowerCase'],
  origin: ['startsWith'],
};

{
  /*
   * COMMENTS ARE NOT CODE, and this check is the one place that bites.
   *
   * The call site that got it right carries a comment explaining the trap, and
   * that comment necessarily spells out `history.replaceState` to say what not
   * to write. Scanning the raw file flagged the explanation and reported a bug
   * in the one line that had already fixed it -- a linter that fails on
   * correct code gets switched off, which costs more than it ever caught.
   */
  const code = js
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

  const shadowed = [...code.matchAll(/^(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)]
    .map((m) => m[1])
    .filter((name) => name in DOM_GLOBALS);

  check('this file still shadows the global the bug was about',
    shadowed.includes('history'),
    shadowed.join(', ') || 'none -- if the undo stack was renamed, drop this check');

  /*
   * Only a shadowed name followed by one of the DOM object's own members, and
   * not where it is already spelled `window.history`.
   */
  const wrong = [];
  for (const name of shadowed) {
    for (const m of code.matchAll(new RegExp(`(\\w+\\.)?\\b${name}\\.(\\w+)`, 'g'))) {
      if (m[1]) continue;                       // window.history.replaceState
      if (DOM_GLOBALS[name].includes(m[2])) wrong.push(`${name}.${m[2]}`);
    }
  }
  check('and no call reaches the DOM one through the shadowing name',
    wrong.length === 0,
    wrong.length
      ? `${[...new Set(wrong)].join(', ')} -- spell it window.${shadowed[0]}`
      : `${shadowed.join(', ')} shadowed, every DOM use spelled out`);
}

/* --------------------------------------------------------- the console */
/*
 * THE SAME CHECK FOR THE OTHER PAGE, because it has the same failure mode and
 * far less traffic over it.
 *
 * admin.js addresses its markup by id exactly as app.js does, and a missing one
 * is just as silent -- `$('#settings')` returns null, `.innerHTML = ''` throws
 * inside a promise nobody awaits, and the card is simply absent from a page
 * one person ever looks at. The measuring app at least gets used daily; a hole
 * in the console can sit there for a month.
 *
 * The console keeps most of its rules inline AND links the shared stylesheet,
 * so a class is styled if either has it. Checking only the inline block would
 * fail on `.link`, which is real and lives in styles.css -- a linter that
 * reports working code is worse than no linter, because the next person turns
 * it off.
 */
{
  const adminHtml = readFileSync(join(root, 'public/admin.html'), 'utf8');
  const adminJs = readFileSync(join(root, 'public/admin.js'), 'utf8');

  const has = new Set([...adminHtml.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  const asks = new Map();
  for (const m of adminJs.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) asks.set(m[1], `$('#${m[1]}')`);

  const gone = [...asks.keys()].filter((id) => !has.has(id));
  check('every element the console reaches for is on its page',
    gone.length === 0,
    gone.length ? gone.map((id) => asks.get(id)).join(', ') : `${asks.size} referenced, all present`);

  /*
   * A class the console builds and nothing styles is an unstyled row rather
   * than a missing one -- quieter still, and the reason the settings card
   * needed its own rules rather than borrowing the people card's.
   */
  const built = new Set(
    [...adminJs.matchAll(/\bel\('[a-z]+',\s*'([a-z0-9- ]+)'/g)]
      .flatMap((m) => m[1].split(/\s+/))
  );
  /*
   * A WORD BOUNDARY, NOT A SUBSTRING.
   *
   * `includes('.setting')` is satisfied by a rule for `.settingx`, so renaming
   * `.setting` to anything with it as a prefix passed -- which is the single
   * most likely way this breaks and the one case the check existed to catch.
   * Proved by renaming it and watching this stay green before the boundary
   * went in.
   */
  /*
   * EVERY STYLESHEET THE PAGE LINKS, read from the page rather than listed
   * here. The console's shared furniture moved out to console.css and this
   * check went red on .entry and .empty -- correct rules, correctly loaded,
   * in a file the test did not know about. A check with a hard-coded list of
   * stylesheets fails every time one is added, which teaches the next person
   * to edit the test rather than believe it.
   */
  const adminCss = css + [...adminHtml.matchAll(/href="\/([A-Za-z0-9_.-]+\.css)"/g)]
    .map((m) => readFileSync(join(root, 'public', m[1]), 'utf8')).join('\n');
  const styled = (c) => new RegExp(`\\.${c}(?![A-Za-z0-9_-])`).test(adminHtml)
    || new RegExp(`\\.${c}(?![A-Za-z0-9_-])`).test(adminCss);
  const bare = [...built].filter((c) => c && !styled(c));
  check('and every class it builds has a rule',
    bare.length === 0,
    bare.length ? bare.map((c) => `.${c}`).join(', ') : `${built.size} classes`);
}

/* ------------------------------------------------------------- styling */
/*
 * A class the code toggles but nothing styles is a state change nobody can
 * see, which is the same bug as a missing element with a better disguise.
 */
const toggled = new Set();
for (const m of js.matchAll(/classList\.(?:toggle|add)\('([a-z0-9-]+)'/g)) toggled.add(m[1]);
const unstyled = [...toggled].filter((c) => !css.includes(`.${c}`));
check('every class the code toggles is styled',
  unstyled.length === 0,
  unstyled.length ? unstyled.map((c) => `.${c}`).join(', ') : [...toggled].join(', '));

/* --------------------------------------------- the report review page */
/*
 * REPORTED: bad reports arriving with no picture, some of the time.
 *
 * There is no picture in a report -- the review page rebuilds the map from
 * coordinates. It used to refuse unless `r.lng` was finite, and that field
 * comes from the geocoded address, which a restored save or a shared link
 * never has. The frame and the parcel in the same report both carry real
 * coordinates and were being discarded.
 *
 * Both halves are pinned. The page must not key its refusal on that one field
 * again, and the app must not send the report without a location when it has
 * one. Neither failure is visible from the review page: a missing map looks
 * the same as a map that has not loaded.
 */
{
  const review = readFileSync(join(root, 'public/review.html'), 'utf8');

  check('the review page does not refuse a report for a missing lng alone',
    !/if\s*\(!mapboxToken\s*\|\|\s*!Number\.isFinite\(r\.lng\)\)/.test(review),
    'the old guard is gone');

  check('and it falls back to the frame the detection actually ran in',
    /function centreOf[\s\S]*?r\.frame\?\.lng/.test(review),
    'centreOf reads r.frame');

  check('then to the shapes being reported on',
    /function centreOf[\s\S]*?cornersOf\(r\)/.test(review),
    'centreOf falls through to the corners');

  /*
   * An empty box is indistinguishable from a map still loading, which is how
   * this arrived: "no picture attached" rather than "no location recorded".
   */
  check('and says why when it genuinely cannot draw one',
    review.includes("el('p', 'why'"), 'the reason is rendered into the holder');

  /*
   * MEASURED IN CHROMIUM: ask for 60 WebGL contexts and 16 survive; the other
   * 44 are lost on the spot. This page lists up to 60 reports, so building a
   * map per report blanked all but the last sixteen -- imagery and traces
   * together, because losing the context takes the whole map.
   *
   * Three things hold that fix together and each fails silently on its own:
   * maps must be built lazily, destroyed when they scroll away, and released
   * before a re-render throws away the rows holding them.
   */
  check('maps are built only as reports scroll into view',
    /new IntersectionObserver/.test(review) && /function watch\(/.test(review),
    'an observer gates map creation');

  check('and destroyed when they scroll away',
    /function releaseMap[\s\S]*?map\.remove\(\)/.test(review),
    'releaseMap tears the map down');

  check('and capped well under what a browser will give',
    /MAX_LIVE_MAPS\s*=\s*([0-9]|1[0-5])\b/.test(review),
    'the cap is below the 16 Chromium allows');

  check('and a filter change frees them before the rows go',
    /releaseMap\(id\)[\s\S]{0,200}list\.innerHTML = ''/.test(review),
    'render clears the live maps first');

  const reviewCss = review.slice(0, review.indexOf('</style>'));
  check('and that message is styled',
    /\.map\s+\.why\s*\{/.test(reviewCss), '.map .why exists');

  /*
   * The app's half. `??` and not `||` on purpose: a longitude of 0 is a real
   * place, and `||` would skip past it to the next fallback.
   */
  check('the app sends a location even with no geocoded address',
    /lng: state\.chosen\?\.lng \?\? state\.frame\?\.lng/.test(js)
    && /lat: state\.chosen\?\.lat \?\? state\.frame\?\.lat/.test(js),
    'sendFeedback falls back to the frame');
}

/* ------------------------------------ the "AI detection is bad" notice */
/*
 * REMOVED (owner, 2026-09-29): the trained model replaced the detector the
 * notice was apologising for. Checked gone so it cannot come back by merge.
 */
check('the "AI detection is bad" sheet is gone', !/id="ai-notice"/.test(html) && !/showAiNotice/.test(js));
for (const tag of ['rel="canonical"', 'property="og:image"', 'name="twitter:card"', 'application/ld+json', 'rel="icon"']) {
  check(`the home page carries ${tag}`, html.includes(tag));
}
for (const page of ['admin', 'grade', 'maps', 'mywork', 'outlines', 'payouts', 'predictions', 'review', 'screen', 'workers']) {
  check(`${page}.html is kept out of search`,
    /<meta name="robots" content="noindex, nofollow">/.test(readFileSync(join(root, `public/${page}.html`), 'utf8')));
}
check('neighbours, merge and the road are on for everybody, not only tinker mode',
  /if \(!document\.body\.classList\.contains\('job-mode'\)\) aroundParcel\(\);/.test(js) && !/if \(state\.dev\) \w*[Aa]roundParcel/.test(js));
check('merge buttons show on the Property line step only, the dashed lines everywhere',
  /const onBoundaryStep = state\.tab === 'address' && !tabLock\('address'\);/.test(js)
  && /if \(!onBoundaryStep\) \{ el\.style\.display = 'none'; continue; \}/.test(js));
check('the property line locks once the AI has traced, and clearing the lawn lifts it',
  /if \(tab === 'address' && state\.detected\)/.test(js));
check('the land cover method and overlays are offered only where the map is (Virginia)',
  /const LAND_COVER_STATES = \['VA'\];/.test(js)
  && /!isLandCoverModel\(m\) \|\| landCoverHere\(\)/.test(js)
  && /const here = overlaysHere\(\);/.test(js));
check('the detection timer says what to expect', /usually takes less than 60 seconds/.test(js)
  && /id="busy-timer"/.test(html) && /id="busy-cancel"/.test(html) && /id="busy-retry"/.test(html));

/* ------------------------------- nothing redraws over somebody's work */
/*
 * THE REPORT: "the count grass under trees thing should not override manually
 * drawn shapes... when I toggled it off, I lost all of my work."
 *
 * Both of those controls re-trace the model's mask, which rebuilds every shape
 * from scratch -- so a switch that reads as a display option throws away every
 * corner moved and every shed rubbed out. It said so afterwards, in a status
 * line, which is a receipt rather than a question.
 *
 * Checked in the source because the browser run cannot reach it: retracing
 * needs a mask in hand, and a real detection is opt-in there and costs money.
 * That is the exact gap this bug walked through, so the guard goes where it
 * can actually stand.
 */
{
  const retrace = js.match(/function retrace\([\s\S]*?\n}/)?.[0] || '';
  check('re-tracing asks before it redraws over hand corrections',
    /mayRedrawFromMask\(/.test(retrace),
    'it used to rebuild first and mention it afterwards');

  const guard = js.match(/function mayRedrawFromMask\([\s\S]*?\n}/)?.[0] || '';
  check('and only asks when there is something to lose',
    /state\.handEdited/.test(guard) && /return true/.test(guard),
    'a confirm on an untouched AI trace is a dialog about nothing');

  /*
   * A CONTROL THAT WAS REFUSED HAS TO PUT ITSELF BACK. A checkbox still ticked
   * after "no, keep my work" is claiming a measurement the map is not showing
   * -- and the next thing that re-traces would then apply it without asking
   * again.
   */
  const trees = js.match(/#toggle-trees'\)\.addEventListener\([\s\S]*?\n\}\);/)?.[0] || '';
  check('the trees box puts itself back when the redraw is declined',
    /if \(!retrace\(/.test(trees) && /e\.target\.checked = was/.test(trees),
    trees ? 'the handler runs retrace and ignores the answer' : 'handler not found');

  const edge = js.match(/function setEdgeFt\([\s\S]*?\n}/)?.[0] || '';
  check('and so does the edge distance, for the same reason',
    /!retrace\(/.test(edge) && /state\.edgeFt = was/.test(edge),
    edge ? 'the setting moves whether or not the shapes did' : 'setEdgeFt not found');

  /*
   * And once the shapes really are the model's own work again, the flag that
   * says "corrected by hand" has to stop saying it -- that flag is what marks
   * a map in the training corpus, and a pure AI trace labelled as a correction
   * is a worse lie than the silence this replaced, because it travels.
   */
  check('a completed redraw stops calling the result a hand correction',
    /state\.handEdited = false;/.test(retrace),
    'the flag decides what the training set believes about this map');
}

/* ------------------------------- edges are a property-line tool only */
/*
 * Sliding an edge keeps a surveyed bearing, which is worth having on a
 * boundary a county recorded and worth nothing on a lawn. Meanwhile it took
 * the corners' pixels: distance to a segment goes to zero at its endpoints, so
 * a corner tap that missed by a few pixels grabbed the edge every time.
 */
{
  const near = js.match(/function selectNear\([\s\S]*?\n}/)?.[0] || '';
  check('a tap that misses a lawn corner does not fall through to an edge',
    /state\.mode !== 'parcel'/.test(near) && near.indexOf('selectEdgeNear') > near.indexOf("state.mode !== 'parcel'"),
    'the mode test has to come before the edge search, not after it');

  /*
   * And the corner hit test covers every outline that is DRAWN, not the one
   * that happens to be selected. That gap is the point eraser bug: deleting a
   * corner clears the selection, so every tap after the first was tested
   * against an empty list while the dots were still on screen.
   */
  const rings = js.match(/function handleRings\(\)[\s\S]*?\n}/)?.[0] || '';
  check('and corner tapping covers every outline whose corners are drawn',
    /return editableRings\(\);/.test(rings),
    'a dot you can see and cannot tap is indistinguishable from a dead tool');
}

/* ------------------------------- what the editor selects is a ring */
/*
 * THE REPORT: "some of those interior shapes, like sheds, don't have points
 * that can be touched."
 *
 * They had none to touch. Every part of the editor was keyed by a shape's id
 * and read coordinates[0], so a hole was not hard to reach -- it did not exist
 * as far as selection, hit testing or drawing were concerned, and a shed
 * traced into a lawn could never be adjusted afterwards.
 */
{
  const editable = js.match(/function editableRings\(\)[\s\S]*?\n}/)?.[0] || '';
  check('the editor enumerates every ring of a shape, not just its outline',
    /coordinates/.test(editable) && !/outerRing\(f\)/.test(editable),
    'reading coordinates[0] is what made a cut-out unselectable');

  /*
   * ONE WRITER. A second place that assigns `[ring, ...slice(1)]` is a place
   * that writes ring 0 whatever ring was selected -- which on a hole means
   * dragging its corner silently reshapes the lawn's outline instead.
   */
  const writers = (js.match(/geometry\.coordinates = \[ring,/g) || []).length;
  check('and exactly one place writes a ring back into a shape',
    writers === 0,
    `${writers} open-coded ring-0 write(s) outside writeRing`);

  check('ring ids carry which ring they mean',
    /function ringOwner\(/.test(js) && /const ringKey = /.test(js),
    'a bare feature id cannot name the second ring of a shape');

  /*
   * And the cut is a HOLE rather than a new kind of feature. Everything
   * downstream -- the geodesic area, the even-odd raster, the corner editor --
   * already understands holes; a "negative shape" would be a second kind of
   * thing for each of those to learn, and wrong wherever one was missed.
   */
  const cut = js.match(/function cutHoleFromDrawn\([\s\S]*?\n}/)?.[0] || '';
  check('a cut-out is appended as an interior ring',
    /coordinates = \[\.\.\.f\.geometry\.coordinates, ring/.test(cut),
    'the measurement and the raster both already subtract holes');
  check('and it refuses to land anywhere it was not drawn',
    /ringInsideRing\(/.test(cut),
    'punching it into a shape that does not contain it moves the shed');

  /*
   * AND THE REVIEW CANVAS HAS TO AGREE WITH THE MEASUREMENT.
   *
   * It filled each ring in its own path, which paints a hole GREEN on top of
   * the lawn -- the shed shown as grass, in the one tool whose whole job is
   * deciding whether a map is good enough to train on. Even-odd is the rule
   * area.js and the raster already use.
   */
  /*
   * The drawing moved to lib/review-draw.js when the every-map page needed it
   * too -- two pages showing the same lawn slightly differently would reopen
   * exactly the hole this check exists to hold shut.
   */
  const drawJs = readFileSync(join(root, 'public/lib/review-draw.js'), 'utf8');
  check('the review canvas fills a shape and its holes as one path',
    /fill\('evenodd'\)/.test(drawJs),
    'a hole filled separately reads as lawn, and gets approved as one');
  /*
   * And it projects the outlines with the frame the STORED photograph was
   * taken on, not the display frame. Those differ on every re-banked row and
   * every Google-drawn one, and with the display frame the outlines sat well
   * off the picture while the editor and the training tools were both right.
   */
  check('the review canvas projects against the stored photograph\'s own frame',
    /c\.hasImage && c\.imageFrame \? c\.imageFrame : c\.frame/.test(drawJs)
    && !/lngLatToFramePx\(c\.frame, \[lng, lat\]/.test(drawJs),
    'outlines projected with the display frame land off the stored photograph');
}

/* ------------------------ the property line holds a corner in */
/*
 * "Measure outside the property line" gated the Add brush and nothing else, so
 * a corner dragged past the boundary went past it and the square footage
 * counted the ground beyond -- the option off, the line on the map, and the
 * total wrong anyway. An option that governs one of the two ways to reach the
 * same mistake reads as a promise it does not keep.
 */
{
  const move = js.match(/function moveSelectedVertex\([\s\S]*?\n}/)?.[0] || '';
  check('dragging a corner is held inside the line',
    /heldInsideParcel\(/.test(move),
    'moveVertex used the raw pointer position, whatever the option said');

  const held = js.match(/function heldInsideParcel\([\s\S]*?\n}/)?.[0] || '';
  check('and the option is what decides it',
    /state\.measureOutside/.test(held));
  check('held at the nearest point on the line, not refused',
    /nearestPointOnRing\(/.test(held),
    'a corner that stops dead under a moving finger reads as a bug');
  check('the boundary\'s own corners are never held',
    /state\.mode !== 'shape'/.test(held),
    'the property line is the thing that defines where outside is');

  /*
   * And the sentence under the checkbox has to describe the rule rather than
   * one tool that follows it. It used to say "lets the Add brush paint past
   * your boundary", which was exactly true and exactly the wrong promise.
   */
  check('and the option says what it now governs',
    /corner tools/.test(html) && /held at the line/.test(html),
    'the old wording named only the brush');
}

/* ------------------------------- the way out of a review edit */
/*
 * ASKED DIRECTLY: "is there a save-and-return-to-console button escape path
 * that I didn't see?" There was not one to see. The console's Edit button
 * sends the reviewer into the editor, and getting back was the Finish button
 * -- several steps away, on another tab, labelled "Finish, save, and see more
 * options", which says nothing about the console. The only thing that
 * mentioned it was a status line, which the next status line replaced.
 */
{
  check('a review edit shows the way back on screen',
    /id="review-bar"/.test(html)
    && /id="btn-review-save"/.test(html)
    && /id="btn-review-back"/.test(html),
    'a status line is not a control');

  const leave = js.match(/function leaveReview\([\s\S]*?\n}/)?.[0] || '';
  check('saving on the way out is the same finish the panel button runs',
    /keepFinished\(\)/.test(leave),
    'a second way to save is a second thing to keep in step');
  check('and going back without saving writes nothing',
    /if \(save\) keepFinished/.test(leave),
    'a candidate that needed no correction should not go round the queue again');
  check('both land on the console',
    /admin\.html/.test(leave));

  /*
   * The bar is shown when a candidate opens and hidden everywhere the visit
   * ends -- including Start over, which is leaving the candidate. A bar
   * offering to return to a review that is no longer open is a button that
   * throws away the map you are on.
   */
  const shows = (js.match(/#review-bar'\)\.hidden = /g) || []).length;
  check('and it appears and disappears with the review itself',
    shows >= 4, `${shows} place(s) set its visibility`);
}

/* ------------------------------- the rail must not clip its own menu */
/*
 * THE REGRESSION: "I can't change the layers, there's no options."
 *
 * The Layers menu is an absolutely-positioned flyout INSIDE #maprail-left,
 * which carries the .maprail class. An ancestor with any overflow other than
 * visible clips absolutely-positioned descendants -- so a max-height plus
 * overflow-y added to .maprail as a backstop against a tall rail took the
 * whole menu out of view. The button still worked and opened something nobody
 * could see, which is the worst shape a UI bug can have.
 */
{
  const rail = css.match(/\.maprail\s*\{[^}]*\}/g) || [];
  check('the map rail never clips, because its menu hangs outside it',
    rail.every((rule) => !/overflow/.test(rule)),
    rail.filter((r) => /overflow/.test(r)).join(' ') || `${rail.length} .maprail rule(s), none with overflow`);

  check('and the flyout is still positioned out of the rail',
    /\.layerlist\s*\{[^}]*position:\s*absolute/.test(css),
    'if it ever stops being absolute this check stops meaning anything');
}

/* ------------------------------- the canopy question, asked not stated */
/*
 * THE REPORT: "make sure the has-treeline check box shows up for all
 * candidates, not just the ones that use exclude treeline as the model."
 *
 * It always did show. What it did not do was LOOK like a control. Unset it
 * read "No tree line" in a plain button identical to "Skip for now" beside it,
 * so on every candidate but an exclude-woods run -- the only case where it went
 * green with a tick -- it read as a caption reporting a fact. It went
 * unpressed, and every approved map came back unmarked, which is the other
 * half of the same report.
 *
 * So: a heading that asks, and a row of graded answers where "not answered"
 * looks not-answered.
 */
{
  const adminJs = readFileSync(join(root, 'public/admin.js'), 'utf8');
  const adminHtml = readFileSync(join(root, 'public/admin.html'), 'utf8');

  check('the canopy question is asked out loud, above its answers',
    /Canopy over this lawn/.test(adminJs),
    'an unlabelled toggle reads as a statement, not a question');
  check('and an ungraded candidate says so rather than showing a default',
    /Not answered yet/.test(adminJs),
    'starting on "No tree line" is how every approval came back unmarked');
  check('the answers are styled as a chooser rather than as buttons in a row',
    /#review \.choices/.test(adminHtml) && /#review \.ask h3/.test(adminHtml));

  /*
   * A GRADE, NOT A FLAG, and only the top one counts. "Any trees that make the
   * cover ambiguous" is true of every lawn on a wooded street: as a yes/no it
   * would have been yes everywhere, the hard slice would have been the whole
   * corpus, and the target would be met by approving anything.
   */
  const routes = readFileSync(join(root, 'worker/src/routes-admin.js'), 'utf8');
  check('the target counts only canopy that decided the edge',
    /tree_line >= 2/.test(routes),
    'a flag true of every lawn selects nothing');
  check('and the middle grade is still recorded',
    /tree_line >= 1/.test(routes),
    '"some canopy" is worth knowing even though it is not a hard case');
  check('an ungraded row stays apart from a graded "none"',
    /tree_line IS NULL/.test(routes),
    '"nobody looked" and "looked, there is none" are different evidence');

  /*
   * And the console that a reviewer already has open keeps working until they
   * reload it, rather than silently filing its verdicts as ungraded.
   */
  check('a console still sending the old boolean is still understood',
    /body\?\.treeLine === true/.test(routes),
    'a stale tab should not quietly record nothing');

  /*
   * A SETTLED MAP CAN BE LOOKED AT AGAIN.
   *
   * Approving was one-way, and the question that broke that was not "is this
   * good enough" but "did the app save what the person actually drew" -- which
   * has no answer from outside the row. The two browsing queues are the way
   * back in, and the force flag is what separates a deliberate change of mind
   * from the stale tap the guard exists to stop.
   */
  check('settled maps can be browsed again',
    /'approved', 'rejected'/.test(routes) && /queue-approved/.test(adminHtml)
      && /queue-rejected/.test(adminHtml),
    'a verdict with no way back is a verdict nobody can check');
  check('and changing one has to be said, not merely sent',
    /body\?\.force === true/.test(routes) && /\?8 = 1 OR status = 'new'/.test(routes),
    'loosening the guard instead would let a double tap flip a verdict');
  check('the buttons say what they would do to the row in front of you',
    /Keep it approved/.test(adminJs) && /Reject it after all/.test(adminJs),
    '"Reject" over an already-rejected map is a button that does nothing');

  /*
   * And the thing the browsing was built to find: shapes stacked on top of
   * each other, which look like one lawn with extra lines on it.
   */
  check('overlapping pieces are counted rather than left to the eye',
    /distinctFraction/.test(readFileSync(join(root, 'public/lib/review-draw.js'), 'utf8'))
    && /overlap by/.test(adminJs),
    'the difference between a corrected outline and a new one drawn over it');

  const doc = readFileSync(join(root, 'docs/training-data.md'), 'utf8');
  check('and the rule the grade encodes is written down',
    /decided the edge/.test(doc) && /a row of trees/.test(doc),
    'the question that could not be answered was never written down anywhere');
}

/* ------------------------------------------- one piece of ground, one outline */
/*
 * EVERY EDIT EMPTIES THE MAP AND PUTS BACK WHAT IT WORKED OUT -- the brush,
 * the clip, undo, a re-trace. Drawing a patch was the single exception: it
 * added a shape and left everything under it alone, which is the only way this
 * app could ever produce two outlines over the same ground. They were then
 * saved that way, and on the review card they read as a mess with no way to
 * tell what a person drew from what the detector did.
 *
 * So the drawn patch merges with whatever it lands on. This checks the wiring,
 * not the arithmetic -- mask.test.js owns the round trip itself.
 */
{
  const create = js.slice(js.indexOf("map.on('draw.create'"));
  const handler = create.slice(0, create.indexOf('\n  });'));
  check('a drawn patch is merged into the lawn it lands on',
    /mergeDrawnPatch\(/.test(handler),
    'the one tool that adds without removing is the one that makes overlaps');

  /* From the doc comment, not the `function` line: half of what is checked
     below is the reasoning written above it. */
  const body = js.slice(
    js.indexOf('A patch drawn over lawn that is already there'),
    js.indexOf('function adoptDrawnParcel')
  );
  check('and a patch that overlaps nothing is left exactly as drawn',
    /if \(!near\.length\) return 0;/.test(body) && /if \(!touching\.length\) return 0;/.test(body),
    'a round trip through a pixel grid moves every corner, so it is only paid '
    + 'by shapes that actually touch');
  check('a trace that comes back empty changes nothing',
    /if \(!polygons\.length\) return 0;/.test(body),
    'two stacked shapes are untidy; deleting the lawn is not the better outcome');

  /*
   * And it must say what it did not do. Merging a patch onto an outline the
   * detector got wrong makes one shape that still covers the wrong ground --
   * the union is identical. Only erasing takes a mistake off the map.
   */
  check('and the comment says merging is tidying, not correcting',
    /WHAT IT DOES NOT FIX/.test(body) && /driveway/i.test(body)
      && /tidying, not correcting/.test(body),
    'someone will otherwise read this as the fix for a bad detection');
}

/* --------------------------------------------- the locate button, end to end */
{
  const html = readFileSync(join(root, 'public/index.html'), 'utf8');
  const js = readFileSync(join(root, 'public/app.js'), 'utf8');

  /*
   * TYPE="BUTTON" IS LOAD-BEARING AND EASY TO LOSE.
   *
   * A bare <button> inside a form submits it. Without this attribute, asking
   * for your location would ALSO fire the address search -- with an empty
   * field, so the form's own `required` fights the click and nothing happens
   * at all. It would look like a dead button rather than a wiring mistake.
   */
  const locate = html.match(/<button[^>]*id="btn-locate"[^>]*>/)?.[0] || '';
  check('the locate button is in the address form',
    /id="address-form"[\s\S]*?id="btn-locate"[\s\S]*?<\/form>/.test(html),
    'next to the field it is an alternative to');
  check('and does not submit the form it sits in',
    /type="button"/.test(locate), locate || 'not found');

  /* Both ways in have to reach the same handler, or one of them is a button
     that does nothing. */
  check('and something listens to it',
    /\$\('#btn-locate'\)\.addEventListener/.test(js),
    'a button with no listener is a button that looks broken');

  /*
   * THE REFUSALS ARE TOLD APART. A denied permission, a radio that is off and
   * a timeout need three different things done about them, and only one of
   * them is something the app can even hint at. Collapsing them into
   * "location unavailable" sends somebody to the wrong setting.
   */
  for (const code of ['code === 1', 'code === 3', 'code === 2']) {
    check(`a geolocation failure with ${code} says something of its own`,
      js.includes(code),
      'PERMISSION_DENIED, POSITION_UNAVAILABLE and TIMEOUT are different problems');
  }

  /* The accuracy warning has to land on the screen that acts on it. It was
     written to the note beside the address field one line before moving away
     from that field, which displayed it where it could not be read. */
  const locateBody = js.slice(js.indexOf('async function useMyLocation'),
    js.indexOf('function renderCandidates'));
  check('a vague fix warns on the confirm step, not on the screen it leaves',
    /VAGUE_FIX_M[\s\S]*?setHint\(/.test(locateBody),
    'the confirm step is the one that asks whether this is your property');
}

/* --------------------------------------------- moving the pin by hand */
{
  const html = readFileSync(join(root, 'public/index.html'), 'utf8');
  const js = readFileSync(join(root, 'public/app.js'), 'utf8');

  check('the pin can be dragged',
    /new mapboxgl\.Marker\(\{[^}]*draggable: true/.test(js),
    'a pin that cannot be moved leaves a wrong guess with no correction');
  check('and a tap on the map moves it while the confirm step is up',
    /state\.placingPin\) return movePin/.test(js),
    'dragging a pin on a phone is fiddly; tapping the right roof is not');

  /*
   * THE FLAG IS CLEARED CENTRALLY. There are several ways out of the confirm
   * step -- confirming, going back, starting over -- and a flag cleared by
   * hand in each is one the next exit added will forget. A stray tap on the
   * measuring screen relocating the property would be a bad way to find out.
   */
  check('and only while it is up',
    /function showStep[\s\S]{0,700}?state\.placingPin = name === 'confirm'/.test(js),
    'set by showStep, so every exit clears it without being told to');

  check('the step says the pin can be moved',
    /id="step-confirm"[\s\S]*?drag it or tap[\s\S]*?<\/section>/.test(html),
    '"No, go back" does not help when the address itself is what is wrong');

  const move = js.slice(js.indexOf('async function movePin'),
    js.indexOf('async function confirmLocation'));

  /*
   * THE OLD SPOT'S COUNTY MUST NOT SURVIVE THE MOVE.
   *
   * Spreading the previous `chosen` kept `county` and `state` from wherever
   * the pin used to be, so a pin dragged three streets over filed its parcel
   * request under the old county's name. That is the Gwinnett bug with the
   * sides swapped: the lookup answers "that county has no record of this
   * parcel" when the truth is that the wrong county was asked. Caught by
   * driving it in a browser, not by reading it.
   */
  check('a moved pin does not inherit the last spot\'s county',
    !/state\.chosen = \{ \.\.\.\(state\.chosen/.test(move),
    'no name at all is honest; the last one is invented');

  /*
   * Two moves in flight, the first slower than the second: without a guard
   * the stale answer lands last and labels the new pin with the old spot.
   */
  check('and a slow lookup cannot label a pin that has already moved on',
    /state\.pinMove !== token/.test(move),
    'only the latest move gets to write');

  /* The point is the thing the measurement needs; the address is a caption.
     A pin that jumped after being placed would be the app arguing with the
     person who placed it. */
  check('and the pin stays where it was put',
    /lng,\n\s+lat,\n\s+label: found\?\.label/.test(move),
    'the coordinates are theirs; only the name comes from the geocoder');

  /*
   * THE TAP LISTENER IS NOT TIED TO A DRAWING TOOL, which is what made the
   * branch above unreachable.
   *
   * `map.on('click', onMapClick)` was added by armLawnPicker and removed by
   * disarmLawnPicker, so taps only arrived while a DRAWING tool was armed.
   * That was invisible for as long as every tap-driven feature was a drawing
   * tool; the confirm step is not one, arms nothing, and so the pin moved
   * only by dragging however correct the handler was.
   */
  const arm = js.slice(js.indexOf('function armLawnPicker'),
    js.indexOf('/* ------------------------------------------------- panning with a tool on */'));
  check('the map tap listener is not armed and disarmed with the tools',
    !/map\.on\('click', onMapClick\)/.test(arm)
    && !/map\.off\('click', onMapClick\)/.test(arm),
    'a screen with no tool is still a screen that can be tapped');
  check('and is registered for the life of the map instead',
    /map\.on\('click', onMapClick\);/.test(js.slice(0, js.indexOf('function armLawnPicker'))),
    'handleMapPoint already decides what a tap means, so it can always listen');

  /*
   * AND SO IS THE TOUCH HALF, which the first attempt left behind and which
   * is the half that matters here.
   *
   * Moving `map.on('click')` fixed a tap on a MOUSE. The touch listeners
   * stayed inside armLawnPicker, so on a phone -- the only device this app is
   * really used on -- a tap on the confirm step still reached nothing, and the
   * pin still moved only by dragging. It cannot fall back to the click path
   * either: Mapbox GL Draw calls preventDefault on touchend and the browser
   * then synthesises no click, which is the whole reason there are two paths
   * into handleMapPoint.
   *
   * The browser run found it, saying "reached handler 0x (touch 0, click 0)",
   * and only because the counters were printed. This is the offline half of
   * that check, so the next person moving these around fails in one second
   * rather than in a CI run with a Mapbox token.
   */
  const boot = js.slice(0, js.indexOf('function armLawnPicker'));
  check('and a bare tap listener rides along for the life of the map too',
    /addEventListener\('touchstart', onBareTouchStart/.test(boot)
    && /addEventListener\('touchend', onBareTouchEnd/.test(boot),
    'Draw preventDefaults touchend, so a phone never gets the click fallback');

  check('and it stands down while a tool is armed, so a tap is not handled twice',
    /function onBareTouchEnd[\s\S]{0,400}?if \(diag\.armed/.test(js)
    && /function onBareTouchStart[\s\S]{0,300}?if \(diag\.armed/.test(js),
    'the armed listeners capture the same gesture; two handlers move the pin twice');
}

/* ------------------------------------- the three zoom-by-tapping handlers */
{
  const js = readFileSync(join(root, 'public/app.js'), 'utf8');

  /*
   * MAPBOX HAS THREE, AND `doubleClickZoom` WRAPS TWO OF THEM.
   *
   *   clickZoom     mouse double-click   } wrapped by map.doubleClickZoom
   *   tapZoom       touch double-tap     }
   *   tapDragZoom   tap, then drag       -- registered separately, owned by
   *                                         touchZoomRotate, wrapped by nothing
   *
   * The gesture in the report is the third one. It survived the constructor
   * flag, `.disable()` and `disableRotation()` -- three switches that are all
   * real and none of which reach it -- and the app's own diagnostics said
   * "off" the whole time because they only read the wrapper.
   *
   * There is no public switch for it, so the fix reaches into the handler
   * registry. That is exactly the kind of thing a Mapbox upgrade removes
   * silently, which is why it is asserted here AND in the browser test: this
   * one catches the line going away, that one catches it stopping working.
   */
  check('tap-then-drag zoom is disabled by name',
    /_handlersById\?\.tapDragZoom/.test(js),
    'doubleClickZoom.disable() does not reach it, and never did');
  /* Looked for as a CALL, not as a string. The comment beside the fix names
     this switch in order to explain why it is not the one used, and a check
     that cannot tell code from the prose about it fails on its own
     explanation. */
  const calls = js.split('\n')
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .filter((l) => /touchZoomRotate\.disable\(\)/.test(l));
  check('and the blunt switch that would take pinch with it is not used',
    calls.length === 0,
    calls.join(' | ') || 'touchZoomRotate.disable() would kill pinch-to-zoom as well');
  check('and the diagnostics report it separately from its wrapper',
    /tapDragZoom: Boolean\(map\?\.handlers/.test(js),
    'reading one as though it covered both is what kept this alive');
}

/* ------------------------------------ the coverage dialog is wired end to end */
{
  /*
   * FOUR IDS AND AN ATTRIBUTE, every one of which fails silently.
   *
   * getElementById returns null, mountCoverage's guard returns early, and the
   * address step keeps the placeholder sentence -- which is a real sentence,
   * so the page looks finished while saying nothing about forty-five states.
   * That is the same shape of fault as the every-map page's missing
   * stylesheet: correct code, correct names, and no symptom.
   */
  const indexHtml = readFileSync(join(root, 'public/index.html'), 'utf8');
  const covJs = readFileSync(join(root, 'public/lib/coverage-ui.js'), 'utf8');
  const ids = new Set([...indexHtml.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));

  const wants = [...covJs.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
  const gone = wants.filter((id) => !ids.has(id));
  check('every element the coverage dialog reaches for is in the page',
    gone.length === 0,
    gone.length ? gone.join(', ') : `${wants.length} referenced, all present`);

  /* The openers are found by attribute so a third one costs nothing -- which
     only works while at least one carries it. */
  const openers = (indexHtml.match(/data-coverage-open/g) || []).length;
  check('and at least one button opens it',
    openers >= 1, `${openers} found`);
  check('with the tab that prompted this among them',
    /id="pane-address"[\s\S]*?data-coverage-open/.test(indexHtml),
    'the Property line tab is where somebody asks whether their county is in');

  /*
   * A <dialog>, not a div dressed as one. showModal is what dims the page,
   * traps focus and answers Escape; a div would need all three by hand and
   * the two older sheets in this file are the evidence of what that costs.
   */
  check('the dialog is a real <dialog>',
    /<dialog[^>]*id="coverage-dialog"/.test(indexHtml)
    && /showModal/.test(covJs),
    'and it is opened with showModal');

  /* Its classes are styled, or the list is a wall of county names with no
     rows, no indentation and nothing to tap. */
  for (const cls of ['sheet-dialog', 'cov-state', 'cov-flat', 'cov-head',
    'cov-name', 'cov-count', 'cov-names', 'cov-source']) {
    check(`.${cls} is styled`,
      new RegExp(`\\.${cls}(?![A-Za-z0-9_-])`).test(css),
      'a class nothing styles is an unstyled row rather than a missing one');
  }

  /*
   * AND NOTHING IS WRITTEN DOWN. A state or county name typed into the markup
   * is the bug this whole feature exists to fix: it was true the week it was
   * typed and wrong by the next deploy.
   */
  const note = indexHtml.match(/id="coverage-note"[\s\S]*?<\/p>/)?.[0] || '';
  const named = ['North Carolina', 'Maryland', 'Vermont', 'New Hampshire',
    'Indiana', 'Connecticut', 'Michigan', 'Nevada', 'Kent', 'Ottawa']
    .filter((n) => note.includes(n));
  check('and the coverage note names no state or county of its own',
    named.length === 0,
    named.length ? `hard-coded: ${named.join(', ')}` : 'every name comes from the API');
}

/* ------------------------------ the predictions page addresses its own markup */
{
  const html = readFileSync(join(root, 'public/predictions.html'), 'utf8');
  const js = readFileSync(join(root, 'public/predictions.js'), 'utf8');

  const has = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  const asks = [...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
  const gone = asks.filter((id) => !has.has(id));
  check('every element the predictions page reaches for is on it',
    gone.length === 0, gone.join(', ') || `${new Set(asks).size} referenced, all present`);

  const css = readFileSync(join(root, 'public/console.css'), 'utf8');
  check('and it loads the stylesheet its classes are in',
    /href="\/console\.css"/.test(html),
    'the every-map page shipped once without this and rendered as plain text');

  /*
   * THE LEGEND IS LOAD-BEARING, so its colours must be the ones actually
   * painted. Two colours carry the entire meaning of every picture on the
   * page; a legend that disagrees with the renderer does not mislabel a
   * detail, it inverts the conclusion -- and it would do so to somebody who
   * had just LOOKED at the evidence.
   */
  const render = readFileSync(join(root, 'tools/render-prediction.js'), 'utf8');
  const bytesOf = (name) => {
    const m = render.match(new RegExp(`${name} = \\[(\\d+), ?(\\d+), ?(\\d+)\\]`));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  for (const [constant, cls] of [['TRACE', 'sw-trace'], ['TRUTH_FILL', 'sw-truth'],
    ['INFERRED_EDGE', 'sw-inf']]) {
    const bytes = bytesOf(constant);
    const want = bytes ? `rgb(${bytes.join(', ')})` : null;
    check(`the legend's ${cls} swatch is the colour ${constant} paints`,
      Boolean(want) && css.includes(want),
      want ? `${want} not found in console.css` : `could not read ${constant}`);
  }

  /*
   * AND THE RENDERER AGREES WITH THE CONSOLE'S OWN PALETTE.
   *
   * The rendering is the same three things the review card draws -- the lawn
   * somebody traced, the detector's attempt at it, and ground marked "inferred,
   * not seen". Somebody arrives here straight from that card, and green
   * meaning the detector on one page and the person on the other is a way to
   * reach the exact opposite conclusion about a shape while feeling certain.
   *
   * The renderer keeps its own bytes rather than importing them, because it
   * runs in Node and review-draw.js is a browser module; this is the check
   * that makes the copy safe.
   */
  const drawJsSrc = readFileSync(join(root, 'public/lib/review-draw.js'), 'utf8');
  const hexOf = (key) => {
    const m = drawJsSrc.match(new RegExp(`${key}: '#([0-9a-f]{6})'`, 'i'));
    return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
  };
  for (const [constant, key] of [['TRACE', 'ai'], ['TRUTH_FILL', 'lawn'],
    ['INFERRED_EDGE', 'inferred']]) {
    const mine = bytesOf(constant);
    const theirs = hexOf(key);
    check(`${constant} is the same colour the console draws "${key}" in`,
      Boolean(mine && theirs) && String(mine) === String(theirs),
      `${JSON.stringify(mine)} vs REVIEW_COLOURS.${key} ${JSON.stringify(theirs)}`);
  }

  /*
   * THE LEAVE-ONE-OUT CAVEAT HAS TO BE ON THE PAGE. Every answer shown was
   * drawn by a model that had never seen that lawn, which is what makes it an
   * honest measurement and is NOT what a published model would draw for a new
   * address. Somebody will screenshot this page.
   */
  check('and the page carries the leave-one-out caveat',
    /id="caveat"/.test(html) && /data\.note/.test(js),
    'a picture without it reads as "this is what the app would draw"');
}

/* ------------------------------- the screening page addresses its own markup */
{
  const html = readFileSync(join(root, 'public/screen.html'), 'utf8');
  const js = readFileSync(join(root, 'public/screen.js'), 'utf8');

  const has = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  const asks = [...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
  const gone = asks.filter((id) => !has.has(id));
  check('every element the screening page reaches for is on it',
    gone.length === 0, gone.join(', ') || `${new Set(asks).size} referenced, all present`);

  check('and it loads the stylesheet its classes are in',
    /href="\/console\.css"/.test(html),
    'the every-map page shipped once without this and rendered as plain text');

  /*
   * THE STANDARD IS ON THE PAGE, not in somebody's head. Screening drifts over
   * a session -- the fortieth answer is looser than the first unless the rule
   * is written where it is being applied -- and a queue screened to a sliding
   * standard is a corpus with a sliding standard, which H7 says is worth up to
   * ten points of error per map.
   */
  check('and the screening rule is written on the page itself',
    /class="rule"/.test(html) && /<b>Yes<\/b>/.test(html) && /<b>No<\/b>/.test(html),
    'both halves of the standard have to be visible while deciding');

  /*
   * NO ADDRESS ANYWHERE. The queue is shown to the owner here and handed to
   * strangers later, and the whole design avoids holding a house number: a
   * point plus the county's own parcel record is all it takes to trace a lawn.
   */
  check('and it shows a place rather than an address',
    !/address/i.test(js.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the sampler stores no address and this page must not invent one');
}

/* -------------------------------- the every-map page addresses its own markup */
{
  /*
   * A THIRD PAGE, CHECKED LIKE THE OTHER TWO.
   *
   * maps.js reaches for its elements by id exactly as the console does, and a
   * missing one is the same silent nothing: $('#thing') returns null, the
   * optional chaining swallows it, and a filter button simply never works.
   * This page is the one somebody opens to find out whether the corpus is
   * sound, so it failing quietly would be the worst of the three.
   */
  const mapsHtml = readFileSync(join(root, 'public/maps.html'), 'utf8');
  const mapsJs = readFileSync(join(root, 'public/maps.js'), 'utf8');

  const has = new Set([...mapsHtml.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  const asks = new Set(
    [...mapsJs.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1])
  );
  /* The filter buttons are built from a key, so their ids never appear as a
     literal. Derived the same way the page derives them. */
  for (const m of mapsJs.matchAll(/FILTERS = \{([\s\S]*?)\}/g)) {
    for (const k of m[1].matchAll(/^\s*([a-z]+):/gm)) asks.add(`filter-${k[1]}`);
  }

  const gone = [...asks].filter((id) => !has.has(id));
  check('every element the every-map page reaches for is on it',
    gone.length === 0,
    gone.length ? gone.join(', ') : `${asks.size} referenced, all present`);

  /*
   * AND THE STYLESHEETS IT ACTUALLY LOADS.
   *
   * This is the second half of the same fault, and the half that shipped: the
   * class names were all correct and every rule for them lived inside the
   * console's own <style> block, which this page does not load. Nothing
   * failed. The list simply rendered as a wall of unstyled text, and the ids
   * check above passed the whole time, because a page can address its markup
   * perfectly and still look like a 1994 error message.
   *
   * So the question is not "is this styled somewhere" -- it was -- but "is it
   * styled in a file THIS page links".
   */
  const linkedCss = (html) => [...html.matchAll(/href="\/([A-Za-z0-9_.-]+\.css)"/g)]
    .map((m) => readFileSync(join(root, 'public', m[1]), 'utf8')).join('\n');

  const mapsCss = linkedCss(mapsHtml);
  /* The console's own <style> block counts for the console, because it loads
     it. It does nothing for the page next door, which is the whole point. */
  const consoleHtml = readFileSync(join(root, 'public/admin.html'), 'utf8');
  const consoleCss = linkedCss(consoleHtml) + consoleHtml;

  /* The shell the two owner pages share. Each one is furniture -- a column, a
     card, a row -- and a page missing any of them is not subtly off, it is
     visibly broken. */
  for (const cls of ['console', 'conhead', 'locked-out', 'card', 'entry',
    'actions', 'pill', 'grey', 'warn', 'empty', 'dupe-group', 'mono', 'shot',
    'verdict-row', 'armed']) {
    check(`the every-map page loads a stylesheet defining .${cls}`,
      new RegExp(`\\.${cls}[\\s,{:.]`).test(mapsCss),
      'styled somewhere else is styled nowhere, from this page');
  }
  /* The same rules moved out from under the console. Its own block still
     overrides where it needs to, but it must not have LOST any of them. */
  for (const cls of ['console', 'conhead', 'locked-out', 'card', 'entry',
    'actions', 'pill', 'empty']) {
    check(`the console still gets .${cls} after the move`,
      new RegExp(`\\.${cls}[\\s,{:.]`).test(consoleCss),
      'extracting shared rules must not take them away from the page they came from');
  }
}

/* --------------------------- the property line is tidied when it arrives */
/*
 * A COUNTY BOUNDARY ARRIVES STUDDED, and the app tidies it without being asked.
 *
 * "Tidy up this boundary" has always been able to drop the redundant points; it
 * was a button somebody had to know to press, and nobody pressing it is the
 * ordinary case. Leaving them is not cosmetic -- corners and edges compete for
 * the same pixels, the corner always wins, and at that density there is no
 * pixel left that belongs to an edge. Dragging an edge out to the kerb is the
 * main thing property-line mode is for.
 *
 * The geometry of it is tested in edges.test.js. What this holds is the wiring:
 * that the parcel is tidied on the way in, and before the record of which
 * corners came from the county is taken -- otherwise that record describes
 * corners that no longer exist.
 */
{
  const app = readFileSync(join(root, 'public/app.js'), 'utf8');
  const arrival = app.slice(app.indexOf('const data = await api(`/api/parcel'));
  const upToSurveyed = arrival.slice(0, arrival.indexOf('state.surveyed ='));

  check('the parcel is tidied when it arrives, not only when asked',
    /tidyRing\(/.test(upToSurveyed),
    'a boundary nobody tidied is a boundary whose edges cannot be tapped');

  check('and before the note of which corners came from the county',
    upToSurveyed.length > 0 && arrival.includes('state.surveyed ='),
    'surveyed corners that were just removed would describe a line nobody has');

  /* Said out loud, per the rule the tidy button set for itself: changing
     somebody's boundary quietly is worse than saying nothing changed. */
  check('and it says so rather than changing the boundary quietly',
    /duplicate corner/.test(upToSurveyed) || /duplicate corner/.test(arrival.slice(0, 4000)),
    'doing it unasked is the reason to keep saying it, not to stop');
}

/* ------------------------- not knowing is not the same as knowing it is off */
/*
 * THE SIGN-IN PANEL MUST NOT CLOSE THE DOOR ON A GUESS.
 *
 * Whether this deployment can send mail is learned once, at boot, from
 * /api/auth/me. The flag holding that answer started as `false`, so one
 * dropped request -- an ordinary event on a phone -- left the default standing
 * and the panel then told people the site cannot send email at all. The field
 * was gone for the rest of the visit.
 *
 * The browser suite covers this properly by dropping the request, but it runs
 * in its own workflow. This runs on every deploy, costs nothing, and holds the
 * two things that made the bug possible.
 */
{
  const app = readFileSync(join(root, 'public/app.js'), 'utf8');

  check('not knowing whether mail works has its own value, apart from "no"',
    /emailSignin: null/.test(app),
    'a flag that starts false cannot tell a failed lookup from a real answer');

  check('and the sign-in field is withheld only on a definite no',
    /hidden = state\.emailSignin === false/.test(app),
    'anything looser hides the only way in whenever the answer is unknown');

  /*
   * And the boot-time failure must leave it unknown rather than writing the
   * guess down -- otherwise the panel has nothing to re-ask about.
   */
  const caught = app.slice(app.indexOf('async function refreshAccount'));
  const body = caught.slice(0, caught.indexOf('\n}'));
  const failure = body.slice(body.indexOf('} catch {'));
  check('and a failed lookup does not record an answer it never got',
    !/emailSignin/.test(failure),
    'the catch concludes "signed out", which is true, and nothing about mail');
}

/* ------------------------- the pages about people and money address theirs */
{
  /*
   * THE SAME CHECK AGAIN FOR THE FOUR PAGES THE PAID ROUTE ADDED, because the
   * silent-nothing failure is the same one and the stakes on two of them are
   * higher than a filter that does not filter.
   *
   * /mywork.html is the only page in this project written for somebody other
   * than the owner, and the button it would lose is the one that asks to be
   * paid. /payouts.html is where the owner answers that. A null element on
   * either is a person who cannot get their money and no error anywhere.
   */
  for (const page of ['grade', 'workers', 'mywork', 'payouts']) {
    const pageHtml = readFileSync(join(root, `public/${page}.html`), 'utf8');
    const pageJs = readFileSync(join(root, `public/${page}.js`), 'utf8');

    const has = new Set([...pageHtml.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
    const asks = new Set([
      ...[...pageJs.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]),
      ...[...pageJs.matchAll(/querySelector(?:All)?\('#([A-Za-z0-9_-]+)/g)].map((m) => m[1]),
    ]);

    const gone = [...asks].filter((id) => !has.has(id));
    check(`every element /${page}.html reaches for is on it`,
      gone.length === 0,
      gone.length ? gone.join(', ') : `${asks.size} referenced, all present`);

    check(`and /${page}.html loads the stylesheet its classes are in`,
      /href="\/console\.css"/.test(pageHtml),
      'the every-map page shipped once without this and rendered as plain text');
  }

  /*
   * AND THE TWO ENDS OF THE PAYOUT AGREE ABOUT ITS STATES. The worker's page
   * translates them into something readable and the owner's page into
   * something actionable, and a state neither recognises prints as the raw
   * database word to whichever one missed it.
   */
  const jobs = readFileSync(join(root, 'worker/src/jobs.js'), 'utf8');
  const states = [...jobs.matchAll(/PAYOUT_STATES = \[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([a-z]+)'/g)].map((s) => s[1]));
  check('there are payout states to check at all', states.length === 3, states.join(', '));
  for (const file of ['mywork', 'payouts']) {
    const js = readFileSync(join(root, `public/${file}.js`), 'utf8');
    const missing = states.filter((s) => !new RegExp(`^\\s{2}${s}:`, 'm').test(js));
    check(`/${file}.html has words of its own for every payout state`,
      missing.length === 0,
      missing.length ? missing.join(', ') : states.join(', '));
  }
}

/* --------------------------------------------- what job mode takes away */
/*
 * A REMOVAL IS A DECISION, AND IT IS INVISIBLE IN THE MARKUP.
 *
 * Job mode is the same app with a list of things hidden by CSS, which is the
 * right shape -- a stripped copy would be a second copy, and the one people are
 * paid to use is the last one that should drift. The cost is that the list is a
 * selector in a stylesheet, and taking a control away from the people who use
 * the app most is a one-line edit with nothing on screen to notice.
 *
 * Both of these have already gone wrong. The AI step was hidden on the
 * reasoning that the outline is run for them once on arrival, which left a
 * tracer who thought the outline was wrong with no way to try another method,
 * another photograph, or trim the edge -- only corner-by-corner repair of
 * somebody else's guess, which several said was slower than drawing it
 * themselves. And the tips switch was reported as missing from the paid
 * workflow when it was never hidden at all, which is its own argument for
 * pinning the list: "is this control there" should be answerable by a test
 * rather than by reading a stylesheet.
 */
{
  const rules = [...css.matchAll(/body\.job-mode\s+([#.[][A-Za-z0-9_="\]-]+)/g)]
    .map((m) => m[1]);
  check('job mode is still a list of removals rather than a second page',
    rules.length >= 4, rules.join(', '));

  /* The tips switch and the drawing tools. */
  for (const id of ['#toggle-tutorials', '#btn-clear', '#btn-draw', '#btn-undo', '#btn-redo']) {
    check(`a paid tracer still has ${id}`,
      !rules.includes(id),
      'taken away, and a tracer on an empty map needs every one of these');
  }

  /*
   * THE AI IS OFF EVERY JOB ROUTE (2026-09-26): the owner's call, until there
   * is a better interim answer than an outline that has to be dismantled
   * before the lawn can be traced. So the tab and the button into it go, and
   * nothing runs a detection when a lawn opens.
   */
  for (const id of ['#tab-detect', '#pane-detect', '#btn-to-detect']) {
    check(`and does not have ${id}`, rules.includes(id), 'the AI is off the job routes');
  }
  const opener = js.slice(js.indexOf('async function openJob'), js.indexOf('async function openJob') + 6000);
  check('and opening a lawn runs no detection', !/await detect\(/.test(opener));
  check('and every way into the AI tab lands on Draw in job mode',
    /name === 'detect' && document\.body\.classList\.contains\('job-mode'\)/.test(js));

  /* And the ones that genuinely do not exist for somebody with no account. */
  for (const id of ['#account-btn', '#quota-badge', '#tab-saved', '#btn-finish']) {
    check(`and is not shown ${id}`,
      rules.includes(id),
      'they have no account, and sending the map is what ends the task');
  }

}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
