/**
 * THE PAGE IN STEPS (owner, 2026-10-15: "the workflow should be broken up
 * into distinct steps so the user doesn't get overwhelmed with the options
 * and tools. The steps should have labels and information about the
 * tools/step. The workflow should be distinct but users should be able to
 * go back to previous steps if needed. Tools and info displayed should
 * pertain to the current step").
 *
 *   1 Property   the address and the property line (traced when the
 *                county has none)
 *   2 Trees      the lidar read and lined up; the trees as the model
 *                sees them, with the eraser
 *   3 Shade      the simulated light over the lawn
 *   4 Grass      which grass will grow in it, and when to plant
 *
 * One section (#step-N) shows at a time; the strip at the top of the panel
 * (#steps) says where you are and lets you go back to any step reached.
 * A step ahead opens only when the page unlocks it (the property line is
 * in, the trees are built...). A page without #steps (the trees page) gets
 * a no-op.
 */

const $ = (s) => document.querySelector(s);

export function startSteps({ onEnter = null, count = 4 } = {}) {
  const nav = $('#steps');
  const none = { current: 0, reached: 0, go() {}, unlock() {}, lockFrom() {}, setNext() {} };
  if (!nav) return none;
  const st = { current: 0, reached: 1 };
  const sections = Array.from({ length: count }, (_, i) => $(`#step-${i + 1}`));
  const buttons = Array.from(nav.querySelectorAll('[data-step]'));
  const paint = () => {
    for (const b of buttons) {
      const n = Number(b.dataset.step);
      b.disabled = n > st.reached;
      if (n === st.current) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.classList.toggle('done', n < st.current);
    }
    sections.forEach((s, i) => { if (s) s.hidden = i + 1 !== st.current; });
  };
  const api = {
    get current() { return st.current; },
    get reached() { return st.reached; },
    /** Show step n (1-based) if it has been reached. */
    go(n) {
      if (n < 1 || n > count || n > st.reached || n === st.current) return false;
      const from = st.current;
      st.current = n;
      paint();
      $('#panel')?.scrollTo?.({ top: 0 });
      onEnter?.(n, from);
      return true;
    },
    /** Let the visitor reach step n (and every step before it). */
    unlock(n) { st.reached = Math.max(st.reached, Math.min(count, n)); paint(); },
    /** Steps from n on are closed again (the property changed). */
    lockFrom(n) { st.reached = Math.max(1, n - 1); if (st.current >= n) { st.current = st.reached; onEnter?.(st.current, n); } paint(); },
    /** The Next button of step n: enabled or not, with a label. */
    setNext(n, enabled, label = null) {
      const b = sections[n - 1]?.querySelector('[data-next]');
      if (!b) return;
      b.disabled = !enabled;
      if (label) b.textContent = label;
    },
  };
  for (const b of buttons) b.onclick = () => api.go(Number(b.dataset.step));
  sections.forEach((s, i) => {
    if (!s) return;
    const back = s.querySelector('[data-back]'), next = s.querySelector('[data-next]');
    if (back) back.onclick = () => api.go(i);
    if (next) next.onclick = () => { api.unlock(i + 2); api.go(i + 2); };
  });
  st.current = 1;
  paint();
  return api;
}
