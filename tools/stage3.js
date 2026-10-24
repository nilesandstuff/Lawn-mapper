/*
 * Stage 3 now lives in public/lib/stage3.js (2026-10-24), so the page can run
 * the same finishing steps when its confidence slider moves (public/lib/
 * finish.js). Re-exported here for the scorer and the tests.
 */
export * from '../public/lib/stage3.js';
