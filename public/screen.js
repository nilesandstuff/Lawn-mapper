/**
 * Screening the queue, one lawn at a time.
 *
 * WHAT THE FIRST SESSION TAUGHT, and it is the whole shape of this file: a
 * square of satellite imagery at a fixed zoom does not say which property is
 * being asked about, and at house scale it does not show enough ground to tell
 * grass from woodland. Five candidates in, the honest answer to every one of
 * them was "I cannot tell from this."
 *
 * So the picture is now built around the PARCEL rather than around the point:
 *
 *   the frame is fitted to the property line, with half the frame left over
 *     for context, so a wood is obviously a wood;
 *   the property line is drawn on top, so there is no question which plot the
 *     question is about;
 *   a pin marks the sampled point, for when the outline is hard to see against
 *     dark ground;
 *   and it can be zoomed in from there, because "is that grass or gravel" is a
 *     question the wide view cannot answer either.
 *
 * SAME RULE AS THE OTHER OWNER PAGES: no permission logic here and there must
 * not be. The API answers 404 to anybody who is not an administrator.
 *
 * And the same rule about text: everything goes in with textContent. A county
 * name arrives from a public records office by way of the Census, and one
 * innerHTML on this page runs a stranger's string while signed in as the owner.
 */

import { geometryBounds, zoomToFit, lngLatToFramePx } from './lib/mercator.js';

const $ = (s) => document.querySelector(s);
const n = (v) => Number(v || 0).toLocaleString();

/** The canvas is square and fixed; only the zoom inside it changes. */
const SIZE = 640;

/**
 * How much of the frame is left over for context, as a fraction.
 *
 * Nearly half, which is far more than a measuring frame would use. This is not
 * a measurement: the question is "is this a garden or the edge of a wood", and
 * that is answered by what surrounds the plot rather than by the plot. A tight
 * frame turns every wooded lot into an ambiguous green square.
 */
const CONTEXT = 0.45;

/** How far in and out the two buttons may go from the fitted zoom. */
const ZOOM_RANGE = 3;

const COLOURS = {
  parcel: '#f2c744',     // the same yellow the console draws a property line in
  pin: '#e2725b',
};

const imageryFor = (frame) => '/api/imagery?' + new URLSearchParams({
  lng: frame.lng, lat: frame.lat, zoom: frame.zoom, size: frame.size, provider: 'mapbox',
});

let queue = [];
let at = 0;
let done = 0;
let zoomShift = 0;
const counts = {};
/** Parcels already fetched, by job id. A miss is remembered as null. */
const parcels = new Map();

/**
 * The frame a job is shown in: fitted to its property line when we have one,
 * and a sensible guess around the point when we do not.
 */
function frameFor(job) {
  const parcel = parcels.get(job.id);
  const base = { lng: job.lng, lat: job.lat, size: SIZE };
  if (!parcel?.geometry) return { ...base, zoom: Math.min(20, 18 + zoomShift) };

  const [w, s, e, nn] = geometryBounds(parcel.geometry);
  const zoom = zoomToFit([w, s, e, nn], SIZE, {
    minZoom: 15, maxZoom: 20, padding: CONTEXT,
  });
  return {
    /* Centred on the PROPERTY, not on the dart that found it -- a random point
       can land in a corner of a long lot and push half of it out of shot. */
    lng: (w + e) / 2,
    lat: (s + nn) / 2,
    zoom: Math.max(14, Math.min(20, zoom + zoomShift)),
    size: SIZE,
  };
}

/** Fetch the property line for a job, once, and never throw. */
async function fetchParcel(job) {
  if (parcels.has(job.id)) return parcels.get(job.id);
  parcels.set(job.id, null);              // so two warms do not both fetch
  try {
    const res = await fetch(`/api/parcel?lng=${job.lng}&lat=${job.lat}`);
    if (!res.ok) return null;
    const body = await res.json();
    const parcel = body?.parcel || body;
    if (parcel?.geometry) parcels.set(job.id, parcel);
  } catch {
    /* A county server having a bad minute. The pin still says where. */
  }
  return parcels.get(job.id);
}

/**
 * Draw one candidate: the photograph, the property line, the pin.
 *
 * Everything is drawn only once the image has loaded, so an outline never
 * briefly sits on an empty square and reads as a shape over nothing.
 */
function paint(job) {
  const canvas = $('#shot');
  const ctx = canvas.getContext('2d');
  const frame = frameFor(job);
  const parcel = parcels.get(job.id);

  const overlay = () => {
    if (parcel?.geometry) {
      const rings = parcel.geometry.type === 'Polygon'
        ? parcel.geometry.coordinates
        : (parcel.geometry.coordinates || []).flat();
      ctx.beginPath();
      for (const ring of rings) {
        ring.forEach(([lng, lat], i) => {
          const [x, y] = lngLatToFramePx(frame, [lng, lat], SIZE, SIZE);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
      /* A dark under-stroke first, so a yellow line stays visible over pale
         concrete as well as over grass. */
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.strokeStyle = COLOURS.parcel;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    /* The pin, always: when the outline is faint against dark ground, this is
       the thing that says which plot is being asked about. */
    const [px, py] = lngLatToFramePx(frame, [job.lng, job.lat], SIZE, SIZE);
    ctx.beginPath();
    ctx.arc(px, py, 7, 0, Math.PI * 2);
    ctx.fillStyle = COLOURS.pin;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  };

  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    overlay();
  };
  img.onerror = () => {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#e7ebe7';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#7a8578';
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillText('That picture would not load.', 24, 40);
  };
  img.src = imageryFor(frame);

  $('#zoom-note').textContent = parcel?.geometry
    ? `Zoom ${frame.zoom}${zoomShift ? ` (${zoomShift > 0 ? '+' : ''}${zoomShift})` : ''}`
    : 'No property line came back — the pin is the spot.';
}

/*
 * THE NEXT FEW, FETCHED BEFORE THEY ARE ASKED FOR.
 *
 * Two requests each now: a picture from Mapbox and a property line from a
 * county server, and the county one can take a second on a bad afternoon. A
 * page that stops for that between every decision is a page that gets
 * abandoned around number forty.
 */
function warm(from) {
  for (let i = from; i < Math.min(from + 3, queue.length); i++) {
    const job = queue[i];
    fetchParcel(job).then(() => {
      const img = new Image();
      img.src = imageryFor(frameFor(job));
    });
  }
}

async function show() {
  if (at >= queue.length) { load(); return; }
  const job = queue[at];
  zoomShift = 0;

  $('#where').textContent = [
    job.county || 'somewhere with parcels',
    job.parcelSqFt ? `${n(job.parcelSqFt)} sq ft of plot` : null,
  ].filter(Boolean).join(' · ');

  const left = queue.length - at;
  $('#tally').textContent = done
    ? `${n(done)} screened this session · ${n(left)} loaded, `
      + `${n(counts.candidate || 0)} in the queue`
    : `${n(left)} loaded · ${n(counts.candidate || 0)} waiting`;

  /* Painted once without the line, then again with it, so a slow county server
     delays the outline rather than the whole card. */
  paint(job);
  await fetchParcel(job);
  if (queue[at] === job) paint(job);

  warm(at + 1);
}

function zoom(by) {
  zoomShift = Math.max(-ZOOM_RANGE, Math.min(ZOOM_RANGE, zoomShift + by));
  if (queue[at]) paint(queue[at]);
}

async function verdict(kind) {
  const job = queue[at];
  if (!job) return;

  /*
   * MOVED ON BEFORE THE SERVER ANSWERS. The decision is already made and the
   * next picture is already loaded; waiting for a round trip would put a pause
   * between every pair of taps for no gain. A failure is reported rather than
   * silently swallowed -- but it does not stop the screening, because one lost
   * verdict costs one lawn out of a county with thousands and the sampler
   * simply offers it again.
   */
  at++;
  done++;
  if (counts.candidate) counts.candidate--;
  show();

  try {
    const res = await fetch('/api/admin/screen-lawn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: job.id, verdict: kind }),
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    $('#tally').textContent = 'That last verdict did not save — it will come '
      + 'round again. Everything before it did.';
  }
}

async function load() {
  let data;
  try {
    const res = await fetch('/api/admin/lawn-jobs?limit=24');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#page').hidden = true;
    $('#locked').hidden = false;
    return;
  }

  Object.assign(counts, data.counts || {});
  queue = data.jobs || [];
  at = 0;

  if (!queue.length) {
    $('#page').hidden = true;
    $('#none').hidden = false;
    const parts = Object.entries(counts)
      .map(([state, many]) => `${n(many)} ${state}`)
      .join(' · ');
    $('#none-counts').textContent = parts ? `So far: ${parts}.` : '';
    return;
  }

  $('#none').hidden = true;
  $('#page').hidden = false;
  show();
}

$('#yes').addEventListener('click', () => verdict('approved'));
$('#no').addEventListener('click', () => verdict('rejected'));
$('#in').addEventListener('click', () => zoom(1));
$('#out').addEventListener('click', () => zoom(-1));
/*
 * A keyboard, for the one screening session that happens at a desk. Y and N
 * where they are expected, and the up and down arrows for zoom -- left and
 * right stay on the verdict, because that is the decision being repeated.
 */
document.addEventListener('keydown', (e) => {
  if ($('#page').hidden) return;
  if (e.key === 'y' || e.key === 'Y' || e.key === 'ArrowRight') verdict('approved');
  if (e.key === 'n' || e.key === 'N' || e.key === 'ArrowLeft') verdict('rejected');
  if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') zoom(1);
  if (e.key === 'ArrowDown' || e.key === '-') zoom(-1);
});

load();
