/**
 * A lawn's address point as "lat, lng", ready to paste into another map tool
 * (the NAIP-CHM Earth Engine app, Google Maps). Corpus ids carry the point
 * as "lng,lat:model:mode" -- longitude first, which no search box accepts
 * (owner, 2026-09-26). Five decimals is about a metre.
 */
export function latLngText(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/** The same, read out of a corpus map id; '' if the id carries no point. */
export function latLngOfId(id) {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?::|$)/.exec(String(id || ''));
  return m ? latLngText(Number(m[2]), Number(m[1])) : '';
}

/**
 * A line with the coordinates and a Copy button. The button falls back to
 * selecting the text where the clipboard is not allowed, so a long-press copy
 * still works on a phone.
 */
export function coordsLine(text, cls = 'meta') {
  const line = document.createElement('div');
  line.className = `${cls} coords`;
  const span = document.createElement('span');
  span.className = 'mono';
  span.textContent = text;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost tiny';
  btn.textContent = 'copy';
  btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'copied';
    } catch {
      const r = document.createRange();
      r.selectNodeContents(span);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      btn.textContent = 'selected';
    }
    setTimeout(() => { btn.textContent = 'copy'; }, 1500);
  });
  line.append(span, document.createTextNode(' '), btn);
  return line;
}
