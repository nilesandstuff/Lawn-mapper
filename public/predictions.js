/**
 * One outline per lawn, worst first.
 *
 * SAME RULE AS THE OTHER OWNER PAGES: no permission logic here and there must
 * not be. The API answers 404 to anybody who is not an administrator, so this
 * whole page is one `if (it loaded)`.
 *
 * And the same rule about text: everything goes in with textContent. A county
 * name arrives from a public records office by way of the Census, and one
 * innerHTML on this page runs a stranger's string while signed in as the owner.
 */

import { latLngText, coordsLine } from '/lib/coords.js';

const $ = (s) => document.querySelector(s);

/*
 * WHICH SET OF PICTURES TO SHOW, from the address bar.
 *
 * `?set=crowns` is the tree crowns; anything else is the detector's own
 * renderings, which is what every existing link points at. The server keeps its
 * own allowlist -- this is a convenience, not the guard.
 */
const QS = new URLSearchParams(location.search);
const SET = QS.get('set') === 'crowns' ? 'crowns' : '';

/*
 * WHICH RUN, from the address bar, so a run is a link somebody can send.
 *
 * Empty means "the newest one there is", which is what an unadorned
 * /predictions.html should show -- the alternative is a bookmark that silently
 * stops tracking the work as soon as one more run happens.
 *
 * Checked here only to keep a malformed one out of a fetch. The server has the
 * real pattern and refuses anything outside it.
 */
const RUN = /^[a-z0-9][a-z0-9-]{0,95}$/.test(QS.get('run') || '') ? QS.get('run') : '';

/**
 * Which of the two pictures is showing, for every lawn at once.
 *
 * The shapes are what the drawing tools would receive; the raw mask is what
 * the model actually answered. The tracer between them smooths every edge,
 * fills any hole under about 60 sq ft and bins the speckle, and the flip is
 * the only way to see WHERE that happened -- the per-lawn numbers say how many
 * square feet it was worth, which is a different and much weaker fact.
 */
let showMask = false;

/* Every picture on the page, so the button can flip all of them together. */
const pictures = [];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};

const n = (v) => Number(v || 0).toLocaleString();
const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);

/**
 * ONE PICTURE, FULL SIZE, WITH PINCH AND DRAG.
 *
 * WHY IT IS NOT JUST A BIGGER <img>. The published PNG is 1280 px and the
 * column on a phone is about 360, so the list shows roughly a quarter of the
 * detail in each direction. Everything worth arguing about here is at that
 * scale: whether an edge is crisp or crumbly, whether a patch of canopy is one
 * tree or three, whether a stitched frame has a seam down it. A lightbox that
 * only made the picture fill the screen would still be showing a third of what
 * is there.
 *
 * SO IT STARTS FIT TO THE SCREEN AND ZOOMS TO 1:1 AND PAST IT. Double-tap
 * toggles between the two, which is the gesture people already expect from a
 * photo viewer, and pinch does what pinch does.
 *
 * WRITTEN WITH POINTER EVENTS RATHER THAN TOUCH, so a trackpad and a mouse
 * work the same way as a thumb -- this page is read on a phone and debugged on
 * a laptop, and two code paths for one gesture is how they drift.
 */
function viewer(key, alt, build = null) {
  const back = el('div', 'lightbox');
  /* A layered lawn opens as its stack, zoomed and panned as one piece, so the
     switches at the top of the page hold in the full-size view too. */
  const img = build ? build('lightshot') : el('img', 'lightshot');
  if (!build) {
    img.alt = alt;
    img.src = `/api/admin/prediction-image?key=${encodeURIComponent(key)}`;
    img.draggable = false;
  }

  const close = el('button', 'lightclose');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '✕';

  const hint = el('div', 'lighthint', 'pinch or scroll to zoom · drag to pan · double-tap to fit');
  back.append(img, close, hint);
  document.body.append(back);
  document.body.classList.add('lightbox-open');

  /*
   * ON THE SCREEN AS IT IS ZOOMED (owner, 2026-10-04: "it opens way off
   * center and I can't pull it into view"). A fixed box is placed on the
   * page's layout, so on a list that had been pinch-zoomed it opened where
   * the unzoomed screen would be -- mostly off the visible part -- and,
   * taking every gesture, could not be panned to. So it is laid over the
   * visual viewport, and drawn at 1/zoom so it looks as it does unzoomed.
   * `k` turns on-screen pixels into the box's own.
   */
  const vv = window.visualViewport;
  let k = 1, boxW = window.innerWidth, boxH = window.innerHeight;
  const place = () => {
    k = vv?.scale || 1;
    boxW = (vv ? vv.width : window.innerWidth) * k;
    boxH = (vv ? vv.height : window.innerHeight) * k;
    Object.assign(back.style, {
      left: `${vv ? vv.offsetLeft : 0}px`, top: `${vv ? vv.offsetTop : 0}px`,
      right: 'auto', bottom: 'auto', width: `${boxW}px`, height: `${boxH}px`,
      transform: k === 1 ? '' : `scale(${1 / k})`, transformOrigin: '0 0',
    });
    back.style.setProperty('--vw', `${boxW}px`);
    back.style.setProperty('--vh', `${boxH}px`);
  };
  place();
  vv?.addEventListener('resize', place);
  vv?.addEventListener('scroll', place);
  /* A point on screen as an offset from the box's centre, in its pixels. */
  const local = (x, y) => {
    const r = back.getBoundingClientRect();
    return [(x - r.left) * k - boxW / 2, (y - r.top) * k - boxH / 2];
  };

  /* The transform, applied as one string so a zoom and a pan cannot land in
     different frames and jitter. */
  let scale = 1, tx = 0, ty = 0;
  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };

  /*
   * PANNING IS CLAMPED so the picture cannot be flung off the screen and lost.
   * At fit or below there is nothing to pan to, so it re-centres instead --
   * otherwise a stray drag leaves a blank screen and no way back.
   */
  const clamp = () => {
    /* getBoundingClientRect already has the transform in it, so this is the
       picture's size ON SCREEN right now -- which is what decides how far
       there is to pan. */
    const r = img.getBoundingClientRect();
    const maxX = Math.max(0, (r.width * k - boxW) / 2);
    const maxY = Math.max(0, (r.height * k - boxH) / 2);
    tx = Math.max(-maxX, Math.min(maxX, tx));
    ty = Math.max(-maxY, Math.min(maxY, ty));
  };

  const zoomTo = (next, cx, cy) => {
    const was = scale;
    scale = Math.max(1, Math.min(8, next));
    /* Keep the point under the fingers where it was, which is what makes a
       pinch feel like it is grabbing the picture rather than a slider. */
    const k = scale / was;
    tx = cx - k * (cx - tx);
    ty = cy - k * (cy - ty);
    clamp();
    apply();
  };

  const pointers = new Map();
  let startDist = 0, startScale = 1, lastX = 0, lastY = 0, moved = 0;

  const mid = () => {
    const p = [...pointers.values()];
    return [(p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2];
  };
  const dist = () => {
    const p = [...pointers.values()];
    return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  };

  back.addEventListener('pointerdown', (ev) => {
    if (ev.target === close) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    back.setPointerCapture(ev.pointerId);
    moved = 0;
    if (pointers.size === 2) { startDist = dist(); startScale = scale; }
    lastX = ev.clientX; lastY = ev.clientY;
  });

  back.addEventListener('pointermove', (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2 && startDist) {
      const [cx, cy] = local(...mid());
      zoomTo(startScale * (dist() / startDist), cx, cy);
      return;
    }
    if (pointers.size === 1) {
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = ev.clientX; lastY = ev.clientY;
      if (scale > 1) { tx += dx * k; ty += dy * k; clamp(); apply(); }
    }
  });

  let lastTap = 0;
  const up = (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) startDist = 0;
    if (pointers.size) return;

    /* A tap that did not drag: double-tap zooms, a single tap on the backdrop
       closes. The picture itself does not close on a tap, because a stray
       thumb while panning would keep dismissing it. */
    if (moved < 10) {
      const now = Date.now();
      if (now - lastTap < 300) {
        zoomTo(scale > 1.05 ? 1 : 3, 0, 0);
        lastTap = 0;
      } else {
        lastTap = now;
        if (ev.target === back && scale <= 1.05) shut();
      }
    }
  };
  back.addEventListener('pointerup', up);
  back.addEventListener('pointercancel', up);

  back.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    zoomTo(scale * (ev.deltaY < 0 ? 1.15 : 1 / 1.15), ...local(ev.clientX, ev.clientY));
  }, { passive: false });

  function shut() {
    back.remove();
    vv?.removeEventListener('resize', place);
    vv?.removeEventListener('scroll', place);
    document.body.classList.remove('lightbox-open');
    window.removeEventListener('keydown', onKey);
  }
  function onKey(ev) { if (ev.key === 'Escape') shut(); }
  window.addEventListener('keydown', onKey);
  close.addEventListener('click', shut);

  apply();
}

/**
 * One lawn.
 *
 * THE TWO KINDS OF MISTAKE ARE SHOWN SEPARATELY, not rolled into the error
 * figure, because they mean opposite things and the summary hides which is
 * happening. A model that misses half the lawn and one that claims the whole
 * property can score the same and need completely different work.
 *
 * AND THE EDITING COST BESIDE THEM. Pieces and handles are not accuracy; they
 * are how much dragging a person would do to fix this outline, which is the
 * question the page exists for. A shape can be close and unusable.
 */
function row(e, i) {
  const box = el('div', 'entry');

  const top = el('div', 'top');
  /* B01..B32 first: the name the owner and the findings file use. */
  top.append(el('b', null, `${e.tag ? `${e.tag} · ` : ''}${e.county || 'traced by hand'}`));

  /*
   * THE TREE CANOPY IS A DIFFERENT KIND OF ENTRY and gets a different caption.
   *
   * It carries no error figure because it is not a measurement against truth
   * -- there is no canopy truth in the corpus to measure against. Reusing this
   * page rather than building a second one is right (same frames, same green
   * wash, same lazy loading), and reusing its NUMBERS would not be:
   * "undefined% out" over a picture of trees is worse than no pill at all.
   */
  if (e.clumps !== undefined || e.crowns !== undefined) {
    /*
     * PATCHES, NOT TREES, and the wording is the whole point of the change.
     *
     * This model is semantic: tree or no tree, per pixel, with no notion of
     * where one tree ends. It used to be cut into "crowns" by a watershed
     * here, and the counts that produced were facts about that watershed's gap
     * parameter -- published, for one run, as though they were counts of
     * trees. Entries from that run are still in the bucket and still readable,
     * so they are relabelled on the way out rather than left saying "crowns".
     */
    top.append(el('span', 'pill', `${n(e.clumps ?? e.crowns)} canopy patches`));
    if (e.upsampled > 1.05) {
      /* The frame was coarser than the model's 10 cm and had to be blown up to
         reach it, so this lawn was shown interpolation rather than imagery. */
      top.append(el('span', 'pill warn', `upsampled ${e.upsampled}×`));
    }
    if (e.onLawnPct !== null && e.onLawnPct !== undefined) {
      top.append(el('span', 'pill warn', `${pct(e.onLawnPct)} on the traced lawn`));
    }
    /*
     * AND HOW MUCH IS ON THE PROPERTY AT ALL, which is the pill that makes the
     * one before it readable.
     *
     * "4% on the traced lawn" has two completely different meanings and the
     * first pill cannot tell them apart: the tracer looked at these trees and
     * decided there is no grass under them -- a toggle correctly starting OFF,
     * which is the idea working -- or the crowns belong to next door and were
     * never a candidate either way. This one separates them. A lawn reading 4%
     * on the lawn and 90% inside the line is a judgement; 4% and 10% is a
     * neighbour's tree.
     */
    if (e.insidePct !== null && e.insidePct !== undefined) {
      top.append(el('span', e.insidePct >= 50 ? 'pill' : 'pill grey',
        `${pct(e.insidePct)} inside the line`));
    }
    box.append(top);
    box.append(el('div', 'meta',
      `${n(e.canopySqFt)} sq ft of canopy · ${Math.round(e.mpp * 100)} cm a pixel in the frame`
      + (e.metresAcross ? ` · ${Math.round(e.metresAcross)} m across` : '')
      + (e.readAtPx ? ` · read at ${n(e.readAtPx)} px` : '')));
    box.append(el('div', 'meta cost',
      'Canopy inside the green is a tree somebody decided has grass under it. '
      + 'Canopy outside the green but inside the property line is a no. Canopy '
      + 'outside the line is not theirs to answer. A patch is not a tree — two '
      + 'trees whose branches touch are one patch.'));
    return withPicture(box, e, i,
      `Lawn ${i + 1}: the tree canopy found, over the photograph, with the `
      + 'hand-traced lawn washed in green');
  }

  top.append(el('span', 'pill warn', `${pct(e.errorPct)} out`));
  /* The outline in the picture, scored the same way. The pill above is the
     raw mask (the run's own figure); this is the shape actually drawn, which
     is what a picture is read as. Runs before 2026-09-27 have no such field. */
  if (Number.isFinite(e.outlineErrorPct)) {
    top.append(el('span', 'pill grey', `outline ${pct(e.outlineErrorPct)}`));
  }
  if (e.samErrorPct !== null && e.samErrorPct !== undefined) {
    /* SAM beside it, because "28% wrong" only means something against the
       thing we currently pay for on the same lawn. */
    top.append(el('span', `pill ${e.errorPct < e.samErrorPct ? '' : 'grey'}`,
      `SAM ${pct(e.samErrorPct)}`));
  }
  if (e.inferredPct >= 1) top.append(el('span', 'pill', `${pct(e.inferredPct)} inferred`));
  box.append(top);

  /*
   * "the outline" is load-bearing wording. These are measured on the traced
   * polygon, not on the mask behind it, because that is what the picture shows
   * -- see traceMask() for the caption bug that made the distinction matter.
   */
  box.append(el('div', 'meta',
    `${n(e.squareFeet)} sq ft of lawn · ${Math.round(e.mpp * 100)} cm a pixel · `
    + `the outline found ${pct(e.foundPct)} of it · over-called ${pct(e.overPct)}`));
  /* Where it is, "lat, lng", for the NAIP-CHM app and anything else. */
  if (Number.isFinite(e.lat) && Number.isFinite(e.lng)) box.append(coordsLine(latLngText(e.lat, e.lng)));

  /*
   * What correcting it would cost. Written as a sentence rather than as two
   * more percentages, because it is a different kind of fact from the ones
   * above it -- those are about accuracy, this is about work.
   *
   * Older index files have no counts; they get no line rather than a row of
   * zeroes, which would read as "one piece, no handles".
   */
  if (e.pieces !== undefined && e.pieces !== null) {
    let cost = `${n(e.pieces)} ${e.pieces === 1 ? 'piece' : 'pieces'}, `
      + `${n(e.vertices)} ${e.vertices === 1 ? 'handle' : 'handles'} to drag`;
    /* What the tracer binned before anybody saw it. Invisible in the picture
       by definition, and a model whose answer is mostly speckle looks tidy
       once the speckle has been dropped. */
    if (e.droppedPieces) {
      cost += ` · ${n(e.droppedPieces)} scraps dropped (${n(e.droppedSqFt)} sq ft)`;
    }
    box.append(el('div', 'meta cost', cost));

    /*
     * WHAT TIDYING THE OUTLINE WAS WORTH, both ways.
     *
     * The tracer fills any hole under about 60 sq ft and smooths every edge,
     * which is wanted -- a shape full of pinholes is not an editing surface --
     * and it also makes the picture tidier than the model's actual answer.
     * Saying by how much is the difference between a helpful rendering and a
     * flattering one.
     */
    if (e.filledSqFt || e.trimmedSqFt) {
      box.append(el('div', 'meta cost',
        `tracing it filled ${n(e.filledSqFt)} sq ft of holes `
        + `and shaved ${n(e.trimmedSqFt)} sq ft off the edges`));
    }
  }

  /*
   * The picture loads only when it is scrolled to. Twenty-three of these is
   * about five megabytes, and on a phone that is the difference between a
   * page and a wait.
   */
  return withPicture(box, e, i,
    `Lawn ${i + 1}: the outline the detector drew, over the photograph, `
    + 'with the hand-traced lawn washed in green');
}

/* ------------------------------------------------------------ the layers */

/* The run's layers (index.json `layers`), and which are showing. */
let LAYER_DEFS = [];
const LAYER_STORE = 'predictions-layers';
let layerOn = {};
const imageUrl = (key) => `/api/admin/prediction-image?key=${encodeURIComponent(key)}`;

/* A <style> rule per hidden layer, so a switch is one change for every lawn
   and the full-size view at once, not a walk over hundreds of elements. */
function applyLayers() {
  let css = document.getElementById('layer-css');
  if (!css) {
    css = document.createElement('style');
    css.id = 'layer-css';
    document.head.append(css);
  }
  css.textContent = LAYER_DEFS.filter((l) => !layerOn[l.id])
    .map((l) => `.layer-${l.id} { display: none; }`).join('\n');
  for (const lab of document.querySelectorAll('.layerbar label[data-id]')) {
    lab.classList.toggle('on', Boolean(layerOn[lab.dataset.id]));
  }
  try { localStorage.setItem(LAYER_STORE, JSON.stringify(layerOn)); } catch { /* private mode */ }
}

function layerBar(defs) {
  LAYER_DEFS = defs;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LAYER_STORE) || '{}') || {}; } catch { saved = {}; }
  layerOn = Object.fromEntries(defs.map((l) => [l.id, l.id in saved ? Boolean(saved[l.id]) : Boolean(l.on)]));
  const bar = $('#layerbar');
  bar.hidden = false;
  /* Top of the drawing order first, which is how a reader looks for them. */
  for (const l of defs.slice().reverse()) {
    const lab = el('label');
    lab.dataset.id = l.id;
    const box = el('input');
    box.type = 'checkbox';
    box.checked = layerOn[l.id];
    box.addEventListener('change', () => { layerOn[l.id] = box.checked; applyLayers(); });
    const sw = el('i');
    sw.style.background = `rgb(${l.colour.join(',')})`;
    if (l.id === 'line') sw.style.outline = '1px solid #9aa39d';
    lab.append(box, sw, document.createTextNode(l.label));
    bar.append(lab);
  }
  const reset = el('button', 'ghost tiny allnone', 'defaults');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    for (const l of defs) layerOn[l.id] = Boolean(l.on);
    for (const inp of bar.querySelectorAll('input')) inp.checked = layerOn[inp.parentElement.dataset.id];
    applyLayers();
  });
  bar.append(reset);
  applyLayers();
  pin(bar);
}

/*
 * PINNED TO THE TOP OF THE SCREEN (owner, 2026-10-06). Fixed rather than
 * sticky -- sticky never stuck on the owner's phone -- so the bar leaves the
 * page's flow, and the page is padded by its height to make room for it,
 * kept right as it wraps or the phone turns.
 */
function pin(bar) {
  bar.classList.add('pinned');
  const room = () => { document.body.style.paddingTop = `${bar.offsetHeight}px`; };
  room();
  if ('ResizeObserver' in window) new ResizeObserver(room).observe(bar);
  else window.addEventListener('resize', room);
}

/*
 * One lawn as the photograph with every layer stacked over it: a div per
 * layer, each showing its own frame of the one tall layers image. Loaded when
 * scrolled to, like the pictures before it.
 */
const seen = 'IntersectionObserver' in window
  ? new IntersectionObserver((items) => {
    for (const it of items) {
      if (!it.isIntersecting) continue;
      it.target.dispatchEvent(new Event('load-layers'));
      seen.unobserve(it.target);
    }
  }, { rootMargin: '400px' })
  : null;

function layerStack(e, cls, eager = false) {
  const wrap = el('div', `${cls} stack`);
  const w = e.renderPx || 1;
  const h = e.renderPy || w;
  wrap.style.setProperty('--ar', String(w / h));
  wrap.style.aspectRatio = `${w} / ${h}`;
  const photo = el('img');
  photo.alt = '';
  photo.draggable = false;
  wrap.append(photo);
  const N = LAYER_DEFS.length;
  const layers = LAYER_DEFS.map((l, k) => {
    const d = el('div', `layer layer-${l.id}`);
    d.style.backgroundSize = `100% ${N * 100}%`;
    d.style.backgroundPosition = `0 ${N > 1 ? (k / (N - 1)) * 100 : 0}%`;
    wrap.append(d);
    return d;
  });
  const load = () => {
    photo.src = imageUrl(e.photoKey);
    for (const d of layers) d.style.backgroundImage = `url("${imageUrl(e.layersKey)}")`;
  };
  if (eager || !seen) load();
  else {
    wrap.addEventListener('load-layers', load, { once: true });
    seen.observe(wrap);
  }
  photo.addEventListener('error', () => {
    wrap.replaceWith(el('p', 'empty', 'That picture could not be loaded.'));
  });
  return wrap;
}

function withLayers(box, e, i, alt) {
  const frame = el('div', 'shotwrap');
  const pic = layerStack(e, 'shot pred');
  pic.setAttribute('role', 'img');
  pic.setAttribute('aria-label', alt);
  const open = el('button', 'shotopen');
  open.type = 'button';
  open.title = 'Open full size';
  open.setAttribute('aria-label', `Open lawn ${i + 1} full size`);
  open.textContent = '⤢';
  const full = () => viewer(null, alt, (cls) => layerStack(e, cls, true));
  open.addEventListener('click', (ev) => { ev.stopPropagation(); full(); });
  pic.addEventListener('click', full);
  frame.append(pic, open);
  box.append(frame);
  if (e.missedInferredPct !== null && e.missedInferredPct !== undefined) {
    box.append(el('div', 'meta',
      `Of the ground marked "inferred, not seen", the outline misses `
      + `${pct(e.missedInferredPct)}.`));
  }
  return box;
}

/**
 * The picture, loaded only when it is scrolled to.
 *
 * Twenty-three of these is about five megabytes, and on a phone that is the
 * difference between a page and a wait. Shared by both kinds of entry so the
 * lazy loading and the failure message cannot drift apart between them.
 */
function withPicture(box, e, i, alt) {
  if (e.layersKey && e.photoKey && LAYER_DEFS.length) return withLayers(box, e, i, alt);
  const img = el('img', 'shot pred');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = alt;

  /*
   * THIS LAWN'S OWN FLIP, because the one at the top is a long scroll away.
   *
   * Comparing the shapes against the mask means going back and forth on ONE
   * picture, and a control at the top of a page of thirty-three turns that
   * into a scroll each way. The top one stays -- flipping everything at once
   * is how you compare ACROSS lawns -- and this is how you compare within one.
   */
  let mine = null;

  /*
   * THE TWO PICTURES OF THE SAME LAWN, swapped in place.
   *
   * Swapping `src` rather than holding both in the DOM: these are a quarter of
   * a megabyte each and a page of thirty lawns would be fifteen megabytes to
   * load two of everything, most of it never looked at. The run folders are
   * immutable and served with a day's cache, so the second flip is instant
   * anyway and the first is the only one that costs anything.
   *
   * A run from before the mask was drawn has no second picture. Those entries
   * stay on the shapes rather than breaking, and the button says why.
   */
  /* `mine` overrides the page-wide setting for this lawn only, and is cleared
     whenever the page-wide button is pressed so the two cannot disagree. */
  const masked = () => (mine === null ? showMask : mine) && Boolean(e.maskKey);
  const shown = () => (masked() ? e.maskKey : e.key);
  const paint = () => {
    img.src = `/api/admin/prediction-image?key=${encodeURIComponent(shown())}`;
    img.alt = masked()
      ? `Lawn ${i + 1}: the model's own per-pixel answer, before any tracing `
        + 'or simplification, over the photograph with the hand-traced lawn '
        + 'washed in green'
      : alt;
    if (flipMine) {
      flipMine.textContent = masked() ? 'shapes' : 'raw mask';
      flipMine.setAttribute('aria-pressed', String(masked()));
    }
  };

  let flipMine = null;
  if (e.maskKey) {
    flipMine = el('button', 'ghost tiny');
    flipMine.type = 'button';
    flipMine.addEventListener('click', (ev) => {
      ev.stopPropagation();
      mine = !masked();
      paint();
    });
  }

  paint();
  /* The page-wide button clears every per-lawn override, so "show the raw
     mask" at the top means all of them and not all-except-the-ones-you-
     touched. */
  pictures.push(() => { mine = null; paint(); });

  img.addEventListener('error', () => {
    img.replaceWith(el('p', 'empty', 'That picture could not be loaded.'));
  });

  /*
   * TAP TO OPEN IT PROPERLY. The picture in the list is squeezed into a phone
   * column; the published PNG is 1280 px. Everything worth arguing about --
   * whether an edge is crisp or crumbly, whether a patch of canopy is one tree
   * or three -- is invisible at list size.
   */
  const frame = el('div', 'shotwrap');
  frame.append(img);
  if (flipMine) frame.append(flipMine);
  const open = el('button', 'shotopen');
  open.type = 'button';
  open.title = 'Open full size';
  open.setAttribute('aria-label', `Open lawn ${i + 1} full size`);
  open.textContent = '⤢';
  open.addEventListener('click', (ev) => { ev.stopPropagation(); viewer(shown(), img.alt); });
  frame.append(open);
  img.addEventListener('click', () => viewer(shown(), img.alt));
  box.append(frame);

  /* Only where there is marked ground to say anything about. Printing "—" on
     the maps with none would make the interesting ones harder to spot. */
  if (e.missedInferredPct !== null && e.missedInferredPct !== undefined) {
    box.append(el('div', 'meta',
      `Of the ground marked "inferred, not seen", the outline misses `
      + `${pct(e.missedInferredPct)}.`));
  }

  return box;
}

/**
 * The run list, for the picker.
 *
 * NEVER FATAL. A missing or empty list means nothing has been drawn since runs
 * got folders of their own, and there are renderings in the old flat place
 * that should still open. Losing the picker is a smaller loss than losing the
 * page.
 */
async function loadRuns() {
  try {
    const res = await fetch('/api/admin/prediction-runs');
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.runs) ? body.runs : [];
  } catch {
    return [];
  }
}

/** A run's own line in the picker: when it ran, what it was, how it scored. */
function runLabel(r) {
  const when = r.at ? new Date(r.at).toLocaleString() : r.slug;
  const score = Number.isFinite(r.headline) ? ` · ${r.headline.toFixed(1)}%` : '';
  /* WHICH ROW WAS DRAWN. Two runs that drew the same row draw the same
     pictures (H36), and the picker used to hide that. */
  const row = r.settings?.config ? ` · ${r.settings.config}` : '';
  return `${when} · ${r.title || r.slug}${row}${score}`;
}

function fillPicker(runs, current) {
  const sel = $('#run');
  if (!runs.length) {
    /* One option saying so, rather than an empty box that reads as broken. */
    sel.append(el('option', null, 'the latest drawing'));
    sel.disabled = true;
    return;
  }
  for (const r of runs) {
    const o = el('option', null, runLabel(r));
    o.value = r.slug;
    if (r.slug === current) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => {
    /* A whole page load rather than a re-render. Every picture, every number
       and the caveat all belong to the run, and swapping them piecemeal is how
       a page ends up showing one run's outlines under another's error figure. */
    const next = new URLSearchParams(location.search);
    next.set('run', sel.value);
    next.delete('set');
    location.search = next.toString();
  });
}

/**
 * The settings the run was given, as one line.
 *
 * Free-form on purpose -- the training runs and the tree crowns have almost
 * nothing in common -- so this prints whatever it is handed rather than
 * knowing the names. A key it has never seen is the case that matters: this
 * page should not need editing before a new knob can be recorded.
 */
function settingsLine(settings) {
  const pretty = (k) => k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return Object.entries(settings || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false)
    .map(([k, v]) => `${pretty(k)}: ${v === true ? 'yes' : v}`)
    .join(' · ');
}

(async () => {
  const runs = await loadRuns();
  /* No run named in the address bar means the newest one, so a bare link keeps
     tracking the work instead of freezing on whatever was current the day it
     was bookmarked. */
  const want = RUN || (!SET && runs.length ? runs[0].slug : '');

  let data;
  try {
    const q = want ? `?run=${encodeURIComponent(want)}` : (SET ? `?set=${SET}` : '');
    const res = await fetch(`/api/admin/predictions${q}`);
    if (res.status === 404) { $('#none').hidden = false; return; }
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#locked').hidden = false;
    return;
  }

  const entries = data.entries || [];
  if (!entries.length) { $('#none').hidden = false; return; }

  $('#page').hidden = false;
  fillPicker(runs, want);

  if (data.about) {
    $('#about').hidden = false;
    $('#about').textContent = `What this run was testing: ${data.about}`;
  }
  const line = settingsLine(data.settings);
  if (line) {
    $('#settings').hidden = false;
    $('#settings').textContent = line;
  }

  /*
   * THE FLIP. Off unless this run drew both pictures -- and it says which,
   * because a button that simply does nothing reads as a broken button rather
   * than as a run that predates the second rendering.
   */
  const flip = $('#flip');
  const hasMasks = entries.some((e) => e.maskKey);
  if (!hasMasks) {
    flip.disabled = true;
    flip.textContent = 'No raw mask in this run';
  } else {
    flip.addEventListener('click', () => {
      showMask = !showMask;
      flip.setAttribute('aria-pressed', String(showMask));
      flip.textContent = showMask ? 'All: shapes' : 'All: raw mask';
      for (const paint of pictures) paint();
    });
  }
  /*
   * THE HEADING IS ABOUT WHATEVER SET IS OPEN. The detector's renderings carry
   * an error figure and the tree crowns do not -- they are not a measurement,
   * they are a question about whether something would work as a tap target --
   * so printing "undefined% on the middle lawn" over them would be inventing a
   * number the run never produced.
   */
  $('#head').textContent = Number.isFinite(data.medianErrorPct)
    ? `"${data.config}" — ${pct(data.medianErrorPct)} on the middle lawn`
    : `"${data.config}" — ${entries.length} lawns`;
  $('#sub').textContent = `${entries.length} lawns · ${data.features} · drawn `
    + `${new Date(data.drawnAt).toLocaleString()}`;
  $('#caveat').textContent = data.note || '';

  /* A run drawn with layers gets the switches; the raw mask is one of them,
     so the old all-or-nothing flip steps aside. */
  if (Array.isArray(data.layers) && data.layers.length && entries.some((e) => e.layersKey)) {
    layerBar(data.layers);
    flip.hidden = true;
  }

  /*
   * IN NUMBER ORDER (owner, 2026-09-26; C numbers 2026-10-04): B01 to B32,
   * then C01 on, then any lawn with no name in the order the run wrote them. The index is kept as written;
   * `i` stays the position there, which is what the picture keys are named by.
   */
  const order = entries.map((e, i) => [e, i]).sort(([a, ia], [b, ib]) => {
    if (a.tag && b.tag) return a.tag.localeCompare(b.tag, undefined, { numeric: true });
    if (a.tag || b.tag) return a.tag ? -1 : 1;
    return ia - ib;
  });
  const list = $('#list');
  for (const [e, i] of order) list.append(row(e, i));
})();
