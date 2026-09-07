/**
 * What an upstream source said when it refused us.
 *
 * Lives here rather than in index.js for the rule that governs this whole
 * project: a Workers entrypoint may only export handlers, so a function that
 * needs testing cannot live there. And this one needs testing -- it is the
 * only thing standing between an upstream error page and a leaked API key.
 */

/** Longest upstream message worth carrying. An error page is not a status line. */
const MAX_REASON = 400;

/**
 * Strip anything shaped like a credential out of text bound for the browser.
 *
 * Our imagery URLs carry keys in the query string, and an upstream that echoes
 * the request back inside its error message -- which several do -- would hand
 * that key to whoever asked. Redacting the value while keeping the parameter
 * name leaves the message readable: "key=REDACTED" still tells you the request
 * had a key on it, which is often exactly the point being made.
 */
export const redactSecrets = (text) =>
  String(text).replace(/([?&](?:key|access_token|token|api_key)=)[^&\s"'<]+/gi, '$1REDACTED');

/**
 * The upstream's own explanation, or null if it did not give one.
 *
 * This exists because the explanation was being thrown away, and it is the
 * whole answer. A newly created Google key returns 403 with a plain sentence
 * naming exactly what is missing -- "This API project is not authorized to use
 * this API", or a complaint about billing -- and the Worker replaced all of it
 * with "Imagery unavailable", which the browser reported as "no photograph of
 * this spot". That sentence asserts something about aerial coverage when the
 * truth was a console setting, and it sends people hunting through Google
 * Cloud for a problem the response had already named.
 */
export async function upstreamReason(res) {
  const type = res.headers.get('Content-Type') || '';
  // An error delivered as an image has nothing to read out of it.
  if (!/text\/|json/.test(type)) return null;

  let body;
  try {
    body = (await res.text()).slice(0, MAX_REASON);
  } catch {
    return null;
  }

  return redactSecrets(body).replace(/\s+/g, ' ').trim() || null;
}
