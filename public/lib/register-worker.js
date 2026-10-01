/**
 * lib/register.js off the main thread. The editor's Auto line-up measures
 * a few hundred patches, a second or several on a phone; run here, the map
 * keeps answering while it does. One message in, one out.
 */
import { registerImages } from './register.js';

self.onmessage = (e) => {
  const { id, ref, mov, groundM, opts } = e.data || {};
  try {
    const r = registerImages(ref, mov, groundM, opts);
    self.postMessage({ id, r: { ...r, vectors: undefined } });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
