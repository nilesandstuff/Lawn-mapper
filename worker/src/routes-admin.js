/**
 * The console: everything the owner needs to answer a question about the site.
 *
 * WHAT THIS REPLACES. The test log and the feedback list were each reachable by
 * putting a shared token in a URL. That worked, and it has three problems worth
 * fixing rather than living with: a token in a URL ends up in browser history
 * and in whatever sits between, one secret cannot tell two people apart, and
 * there was nowhere at all to do the thing most often wanted -- look at one
 * account and give it some credits.
 *
 * An admin session answers all three. Who did it is knowable, revoking access
 * is ending a session rather than rotating a secret everybody shares, and the
 * same door leads to the ledger and the users as to the logs.
 *
 * THE TOKEN ROUTES ARE LEFT ALONE, deliberately. They are the way back in if
 * something about accounts goes wrong -- and a console that can lock its own
 * administrator out with no second path is a console you cannot safely deploy
 * changes to.
 */

import { usageSince, usageDaily } from './usage.js';
import { currentUser } from './auth.js';
import { benchmarkId, coordsOfId, mapName } from './benchmark-ids.js';
import {
  accountsEnabled, grantCredits, publicUser, setDailyLimit, dayKey,
} from './db.js';
import { limits, limitsForConsole, setLimit, LIMITS } from './limits.js';
import { logEntries, loggingEnabled } from './testlog.js';
import { feedbackEntries, feedbackEnabled } from './feedback.js';
import { corpusGaps, candidateScore, storeImage } from './corpus.js';
import { storeCountyImage } from './county-picture.js';
import { parcelGaps } from './gaps.js';
import { cleanCountyReview, cleanCountyOutlines, countyServicesAt } from './county.js';
import { scoreMap } from './score.js';
import {
  outlineKeys, idOfOutlineKey, applyReview, OUTLINE_PREFIX,
  EXAMPLE_PREFIX, isExampleId, exampleKey, exampleImageKey, keptByClass, reviewExample,
} from './outlines.js';
// The same cleaner the paid queue puts a worker id through on the way in. Two
// spellings of one id is a row the claim lookup never finds.
import {
  cleanWorker, ROUTES, PAID_RATE_CENTS, MIN_PAYOUT_CENTS, owedCents,
  SCREEN_STATES, GRADE_STATES,
} from './jobs.js';

export const isAdminPath = (pathname) => pathname.startsWith('/api/admin/');

/**
 * Everything here is refused the same way: 404.
 *
 * Not 403. A visitor who is not an administrator should not learn that there
 * is an administration API here at all -- "forbidden" is a map of what to
 * attack, and the console is not a secret worth the difference between the two
 * but it costs nothing to not advertise it.
 */
const hidden = (json, origin) => json({ error: 'Not found' }, 404, origin);

/*
 * HOW FAR EACH MAP'S SAVED OUTLINE IS FROM THE AI'S, BY SHAPE, for the
 * console's "Disagreed with the AI" filter (owner, 2026-10-02). Measured with
 * the scorer training reports use, inside the property line, on a 256-pixel
 * grid (about 1% of a lawn, plenty for a 10% line), and stored, so each map
 * costs once: corpus.js sets it back to NULL when a map is saved again.
 * Bounded per request; the Workers Paid plan's CPU is what makes it possible.
 */
export async function measureDisagreement(env, { limit = 400 } = {}) {
  const rows = (await env.DB.prepare(
    `SELECT id, shapes, detected_shapes, parcel FROM corpus
      WHERE ai_wrong_pct IS NULL AND detected_shapes IS NOT NULL AND detected_shapes != '[]'
      LIMIT ?1`
  ).bind(limit).all()).results || [];
  const writes = [];
  for (const r of rows) {
    let pct = null;
    try {
      const got = scoreMap({
        truth: JSON.parse(r.shapes || '[]'),
        detected: JSON.parse(r.detected_shapes || '[]'),
        parcel: r.parcel ? JSON.parse(r.parcel) : null,
        grid: 256,
      });
      pct = got?.errorPct;
    } catch { pct = null; }
    /* A pair that cannot be compared (nothing left of the lawn) is recorded as
       a full disagreement rather than left to be measured again forever. */
    writes.push(env.DB.prepare('UPDATE corpus SET ai_wrong_pct = ?2 WHERE id = ?1')
      .bind(r.id, Number.isFinite(pct) ? Math.round(pct * 10) / 10 : 100));
  }
  if (writes.length) await env.DB.batch(writes);
  return writes.length;
}

export async function handleAdmin(request, env, url, origin, ctx, json) {
  if (!accountsEnabled(env)) return hidden(json, origin);

  const me = await currentUser(request, env, ctx);
  if (!me || me.role !== 'admin') return hidden(json, origin);

  const path = url.pathname.slice('/api/admin/'.length);

  /* ------------------------------------------------------------ overview */
  if (path === 'overview') {
    /*
     * One round trip rather than six.
     *
     * D1 charges per statement and a phone pays for the latency of each, and
     * this is the page that loads first. The shape is ugly and the alternative
     * is a console that takes a second and a half to say hello.
     */
    const [people, maps, today, week, month, owed, live, corpus] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) n FROM users').first(),
      env.DB.prepare('SELECT COUNT(*) n FROM maps').first(),
      /* Every charged press, signed in or not -- see usage.js. */
      usageSince(env, daysAgo(1)),
      usageSince(env, daysAgo(7)),
      usageSince(env, daysAgo(30)),
      env.DB.prepare('SELECT COALESCE(SUM(credits), 0) n FROM users WHERE unlimited = 0').first(),
      env.DB.prepare('SELECT COUNT(*) n FROM sessions WHERE expires_at > ?')
        .bind(new Date().toISOString()).first(),
      /*
       * The training corpus: how many finished maps are banked, and how many
       * of them are worth anything.
       *
       * THREE NUMBERS BECAUSE THEY ARE SCARCE IN DIFFERENT WAYS -- not because
       * one kind of row is worth having and the other is not. An earlier
       * version of this comment claimed a map accepted unchanged only teaches
       * a model to imitate the detector, and that is wrong twice over: a
       * student trained on a teacher's own labels routinely beats the teacher
       * once the task is narrow enough, and a training set made only of the
       * detector's FAILURES teaches a model that every lawn is a hard case.
       * Accepted maps are most of the distribution and the calibration comes
       * from them.
       *
       * What is true is narrower. Scattered label error averages out, so more
       * accepted rows are free. DIRECTIONAL error does not -- the detector's
       * known habit of overshooting a tree line by about a quarter is wrong
       * the same way every time, and no quantity of quietly accepted rows will
       * cancel it. Only rows where somebody disagreed carry that signal, and
       * acceptance is the weaker evidence anyway: it can mean the trace was
       * right, or that nobody looked closely at it.
       *
       * So `total` is how much there is and `corrected` is how much of the
       * scarce kind -- the hard cases that fix a known fault, and the clean
       * measure of whether it was fixed. Both are wanted; they simply do not
       * arrive at the same rate.
       *
       * Ten per cent is the line between a correction and a nudge. Dragging a
       * vertex a few feet is somebody tidying an edge; a tenth of the lawn is
       * somebody saying the detector was wrong.
       *
       * `with_image` is separate because a row can save while its photograph
       * does not -- COUNT(column) skips NULLs, which is exactly that case.
       *
       * AND IT MUST NOT BE ABLE TO BREAK THIS PAGE, hence the catch. The
       * console is where you go when something is wrong, including a
       * half-applied schema; losing accounts, credits and the AI spend because
       * a nice-to-have count referenced a missing table would be the worst
       * possible trade.
       *
       * BUT THE CATCH CARRIES THE REASON OUT, which the first version did not,
       * and that cost an afternoon. It returned null, the page said "not
       * recording", and the actual message -- "no such column: image_key", a
       * complete diagnosis in four words -- was thrown away at the point it
       * was caught. Swallowing an error to protect a page is right; swallowing
       * what it said is not, and this is the one page whose whole job is to
       * tell its owner what is wrong.
       *
       * Safe to show here because there is nothing else on this route: it is
       * administrator-only, and the reader is the person who deployed the
       * database the message is about.
       */
      env.DB.prepare(
        `SELECT COUNT(*) total,
                COUNT(image_key) with_image,
                COALESCE(SUM(CASE
                  WHEN detected_sq_ft IS NULL THEN 1
                  WHEN detected_sq_ft > 0
                   AND ABS(square_feet - detected_sq_ft) * 10 >= detected_sq_ft THEN 1
                  ELSE 0 END), 0) corrected
         FROM corpus`
      ).first()
        .then((row) => ({ ok: true, row }))
        .catch((e) => ({ ok: false, why: String(e?.message || e).slice(0, 200) })),
    ]);

    /* Passes per day, which is the shape of the Replicate bill. */
    const daily = await usageDaily(env, daysAgo(30));

    return json({
      users: people.n,
      maps: maps.n,
      sessions: live.n,
      creditsOutstanding: owed.n,
      // Renamed out of SQL's snake_case here rather than in the page, so the
      // console never has to know what the column was called. `unavailable`
      // carries the database's own words when the count could not be read --
      // an answer, where the earlier null was only an absence.
      corpus: corpus.ok
        ? {
          total: corpus.row?.total ?? 0,
          withImage: corpus.row?.with_image ?? 0,
          corrected: corpus.row?.corrected ?? 0,
        }
        : { unavailable: corpus.why },
      today, week, month, daily,
      logging: loggingEnabled(env),
      feedback: feedbackEnabled(env),
    }, 200, origin);
  }

  /* ------------------------------------------------------------ the prices */
  /*
   * The daily allowances, readable and writable without a deploy.
   *
   * THE REASON THIS ROUTE EXISTS. These numbers are the price list, and every
   * question about them -- is five a day too mean, is the address ceiling
   * stopping a real customer -- is answered by changing one and watching. A
   * change that costs a trip to a repository settings page and a deploy, from
   * a phone, does not get made often enough to answer anything, so the numbers
   * stay at whatever was guessed first.
   */
  /* ------------------------------------------------ the training corpus */
  /*
   * WHAT IS IN THE PILE, AND WHAT IT IS SHORT OF.
   *
   * Its own route rather than more fields on the overview, because it is read
   * for a different reason and at a different moment: the overview answers "is
   * the site healthy", this answers "where should I spend Saturday". Loading
   * six GROUP BYs on every console open to serve a question nobody asked would
   * be the wrong trade on a phone.
   *
   * The whole thing is wrapped, not just parts. Every statement here names the
   * corpus table, so if it is missing they all fail together and the honest
   * answer is one message rather than five broken panels.
   */
  if (path === 'corpus') {
    try {
      /*
       * BLOCKS ARE APPROXIMATED WITH ROUNDED DEGREES, not real map tiles.
       *
       * Two decimal places is about 1.1 km north-south and, at US latitudes,
       * 0.8-1.0 km east-west -- near enough to the ~1 km block the split will
       * use. Proper tiles need trigonometry that D1 cannot be relied on to
       * have, and this is a progress bar rather than the split itself: being a
       * few hundred metres out changes a count nobody is making decisions to
       * the unit on. The export does the real thing.
       */
      const BLOCK = `ROUND(lng, 2) || ',' || ROUND(lat, 2)`;
      const [totals, counties, providers, modes] = await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(*) total,
                  COUNT(image_key) with_image,
                  COUNT(detected_shapes) with_detection,
                  COUNT(DISTINCT county) counties,
                  COUNT(DISTINCT ${BLOCK}) blocks,
                  COALESCE(SUM(CASE WHEN parcel_source = 'hand' THEN 1 ELSE 0 END), 0) hand_parcel,
                  /*
                   * The HARD-SLICE count: canopy that decided where the lawn
                   * ended (2), not merely canopy present (1). See the review
                   * route -- "any trees that make the cover ambiguous" is true
                   * of every lawn in a wooded county, and a number that counts
                   * every row is not a gap anybody can close.
                   */
                  COALESCE(SUM(CASE WHEN tree_line >= 2 THEN 1 ELSE 0 END), 0) heavy_canopy,
                  COALESCE(SUM(CASE WHEN tree_line >= 1 THEN 1 ELSE 0 END), 0) any_canopy,
                  COALESCE(SUM(CASE WHEN tree_line IS NULL THEN 1 ELSE 0 END), 0) canopy_unjudged,
                  COALESCE(SUM(CASE
                    WHEN detected_sq_ft IS NULL THEN 1
                    WHEN detected_sq_ft > 0
                     AND ABS(square_feet - detected_sq_ft) * 10 >= detected_sq_ft THEN 1
                    ELSE 0 END), 0) corrected
           FROM corpus WHERE status = 'approved'`
        ).first(),
        env.DB.prepare(
          `SELECT COALESCE(county, '(traced by hand)') name, COUNT(*) n,
                  COUNT(DISTINCT ${BLOCK}) blocks
           FROM corpus WHERE status = 'approved' GROUP BY county ORDER BY n DESC LIMIT 25`
        ).all(),
        env.DB.prepare(
          `SELECT COALESCE(provider, '(unknown)') name, COUNT(*) n
           FROM corpus WHERE status = 'approved' GROUP BY provider ORDER BY n DESC LIMIT 10`
        ).all(),
        env.DB.prepare(
          `SELECT COALESCE(mode, '(unknown)') name, COUNT(*) n
           FROM corpus WHERE status = 'approved' GROUP BY mode ORDER BY n DESC LIMIT 10`
        ).all(),
      ]);

      const stats = {
        total: totals.total,
        corrected: totals.corrected,
        withImage: totals.with_image,
        withDetection: totals.with_detection,
        handParcel: totals.hand_parcel,
        heavyCanopy: totals.heavy_canopy,
        anyCanopy: totals.any_canopy,
        canopyUnjudged: totals.canopy_unjudged,
        blocks: totals.blocks,
        /*
         * A hand-traced row stores county as NULL, and COUNT(DISTINCT) skips
         * nulls -- which is the behaviour wanted here. "Traced by hand" is not
         * a place and must not count towards the spread of places.
         */
        counties: totals.counties,
      };

      /*
       * WAITING IS NOT PROGRESS. The bars measure the APPROVED set, because
       * that is the training set -- counting candidates would read 1,000 while
       * 300 are verified, and the number somebody is working towards would be
       * the one number on the page that is not true.
       */
      const queued = await env.DB.prepare(
        `SELECT COUNT(*) n,
                COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) rejected
           FROM corpus WHERE status IN ('new', 'rejected')`
      ).first();
      stats.waiting = queued.n - queued.rejected;
      stats.rejected = queued.rejected;

      return json({
        stats,
        gaps: corpusGaps(stats),
        counties: counties.results,
        providers: providers.results,
        modes: modes.results,
      }, 200, origin);
    } catch (e) {
      return json({ unavailable: String(e?.message || e).slice(0, 200) }, 200, origin);
    }
  }

  /* ------------------------------------------------- the review queue */
  /*
   * The next few candidates to look at, and everything needed to draw them.
   *
   * TWO QUEUES, and the difference is not cosmetic. `priority` orders by what
   * the approved set is short of, which is the fast way to a trainable pile
   * and is EXACTLY WRONG for the representative half of the eval -- a slice
   * assembled from maps chosen for being interesting is not representative of
   * anything. `random` draws blind, so those approvals carry no selection of
   * their own and the representative slice is built from them.
   *
   * Which queue a row came from is stored with the verdict, so the export can
   * tell them apart later. Getting that wrong is unrecoverable after the fact:
   * nothing in an approved row would say why it was surfaced.
   */
  if (path === 'candidates') {
    try {
      /*
       * A THIRD QUEUE: maps already approved that carry no canopy grade.
       *
       * Needed the moment the tick box became a grade. Everything approved
       * before that is `null` -- nobody was asked the question in a form they
       * could answer -- and without a way back those rows could never count
       * toward the hard slice however wooded they are. The queue ends when
       * they are graded, which is the point.
       */
      /*
       * And two more for LOOKING BACK at settled maps.
       *
       * Approving used to be one-way: a verdict went in and the map left the
       * console for good. Fine while the only question was "is this good
       * enough", and not fine once the question became "did the app save what
       * I actually drew" -- which can only be answered by opening one again.
       */
      /*
       * A SIXTH QUEUE: approved maps nobody has looked over for inferred areas.
       *
       * Exactly the shape of `ungraded`, and for the same reason. Shapes can
       * now be marked "I know this is lawn, I cannot see it", and everything
       * approved before that existed carries no such mark -- not because there
       * was nothing to mark, but because nobody was asked. Without a way back
       * those maps could never contribute the one thing the ring is measured
       * against.
       */
      const QUEUES = new Set([
        'priority', 'random', 'ungraded', 'unflagged', 'approved', 'rejected',
        /* Maps an admin has saved, whatever their verdict, newest edit first. */
        'admin',
      ]);
      const asked = url.searchParams.get('queue');
      const wanted = QUEUES.has(asked) ? asked : 'priority';
      const status = wanted === 'rejected' ? 'rejected'
        : (wanted === 'ungraded' || wanted === 'unflagged' || wanted === 'approved')
          ? 'approved'
          : 'new';
      /*
       * FILTERS ON TOP OF ANY QUEUE (owner, 2026-10-02), and on top of each
       * other: a map shown matches every one that is on.
       *
       *   photo=county   drawn on a county or state photo (`provider`, what
       *                  the person was looking at and detected on)
       *   disagreed=1    the AI drew an outline and a tenth or more of the
       *                  saved lawn is ground the two disagree about, either
       *                  way round: by SHAPE (score.js), so an outline moved
       *                  without changing its area counts. Hand-drawn maps
       *                  had no AI answer to disagree with.
       *
       * Fixed SQL, switched by the flags; nothing from the URL reaches the
       * query text.
       */
      const onlyCounty = url.searchParams.get('photo') === 'county';
      const onlyDisagreed = url.searchParams.get('disagreed') === '1';
      const FILTERS = [
        onlyCounty ? "AND c.provider = 'county'" : '',
        onlyDisagreed ? 'AND c.ai_wrong_pct >= 10' : '',
      ].join('\n              ');
      /* Maps not yet measured by shape are measured now, once each. */
      if (onlyDisagreed) await measureDisagreement(env);
      /* Browsing is chronological; the queues are ranked. Different jobs. */
      const browsing = wanted === 'approved' || wanted === 'rejected' || wanted === 'admin';
      const BLOCK = `ROUND(lng, 2) || ',' || ROUND(lat, 2)`;

      const [approved, rows] = await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(*) total,
                  COUNT(DISTINCT county) counties,
                  COUNT(DISTINCT ${BLOCK}) blocks,
                  /*
                   * The scoring's view of how short the hard slice is. Read
                   * from the judged grade where there is one, because that is
                   * the measurement; the woods prompt is only the prefill.
                   */
                  COALESCE(SUM(CASE WHEN tree_line >= 2 THEN 1 ELSE 0 END), 0) heavyCanopy,
                  COALESCE(SUM(CASE
                    WHEN detected_sq_ft IS NULL THEN 1
                    WHEN detected_sq_ft > 0
                     AND ABS(square_feet - detected_sq_ft) * 10 >= detected_sq_ft THEN 1
                    ELSE 0 END), 0) corrected
           FROM corpus WHERE status = 'approved'`
        ).first(),
        /*
         * `new_block` and `new_county` are computed in SQL rather than by
         * pulling every approved row back: whether this candidate is somewhere
         * nothing has been approved yet is the single most useful thing the
         * score knows, and it is a NOT EXISTS, not a join in JavaScript.
         *
         * RANDOM() for the blind queue rather than shuffling a page of rows
         * here -- shuffling what the ORDER BY already chose is not a blind
         * draw, it is the same biased page in a different order.
         */
        env.DB.prepare(
          `SELECT c.*,
                  NOT EXISTS (
                    SELECT 1 FROM corpus a WHERE a.status = 'approved'
                      AND ROUND(a.lng,2) = ROUND(c.lng,2)
                      AND ROUND(a.lat,2) = ROUND(c.lat,2)
                  ) new_block,
                  (c.county IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM corpus a
                     WHERE a.status = 'approved' AND a.county = c.county
                  )) new_county
             FROM corpus c
            WHERE ${wanted === 'admin' ? 'c.admin_edited_at IS NOT NULL' : `c.status = '${status}'`}
              ${wanted === 'ungraded' ? 'AND c.tree_line IS NULL' : ''}
              ${wanted === 'unflagged' ? 'AND c.inferred_checked_at IS NULL' : ''}
              ${FILTERS}
            ORDER BY ${wanted === 'random' ? 'RANDOM()'
              : wanted === 'admin' ? 'c.admin_edited_at DESC'
              : browsing ? 'COALESCE(c.reviewed_at, c.at) DESC' : 'c.at DESC'}
            LIMIT ${wanted === 'random' ? 1 : 40}`
        ).all(),
      ]);

      const queue = (rows.results || [])
        .map((r) => ({ row: r, ...candidateScore(r, approved) }))
        /* Stable: equal scores keep the ORDER BY above rather than jittering. */
        /* ...except the admin list, which is a history and stays newest first. */
        .sort((a, b) => (wanted === 'admin' ? 0 : b.score - a.score))
        .slice(0, 10)
        .map(({ row: r, score, why }) => ({
          id: r.id,
          name: mapName(r.id, r.lot_no),
          score,
          why,
          at: r.at,
          county: r.county,
          provider: r.provider,
          imageProvider: r.image_provider,
          mode: r.mode,
          exclusions: r.exclusions,
          /*
           * A SUGGESTION for the toggle, not an answer. Ticking Trees during
           * an exclude-mode detection is decent evidence there are trees --
           * it is just not available in Find-grass or hand-drawn mode, which
           * is exactly why it cannot be the measurement itself.
           */
          canopyHint: /woods/.test(r.exclusions || ''),
          /*
           * Which draw surfaced it, for the rows coming back round to be
           * graded. Re-sending the grade must not overwrite this: it is what
           * tells the export whether a row may sit in the representative
           * slice, and a row relabelled 'ungraded' would have lost that.
           */
          reviewQueue: r.review_queue,
          /*
           * The verdict already on the row, for the browsing queues.
           *
           * The card has to say what it is looking at before it can offer to
           * change it -- "Reject" on a rejected map is a button that does
           * nothing, and "Approve" on an approved one is worse, because it
           * looks like it worked.
           *
           * `canopy` is the stored grade, so browsing back to a graded map
           * shows the grade that is on it rather than the woods-box guess.
           * Sending the guess back would quietly overwrite a real answer with
           * an inferred one every time somebody looked at a map twice.
           */
          status: r.status,
          reviewedAt: r.reviewed_at,
          reviewedBy: r.reviewed_by,
          adminEditedAt: r.admin_edited_at,
          canopy: r.tree_line === null || r.tree_line === undefined ? null : Number(r.tree_line),
          parcelSource: r.parcel_source,
          squareFeet: r.square_feet,
          detectedSqFt: r.detected_sq_ft,
          aiWrongPct: r.ai_wrong_pct,
          parcelSqFt: r.parcel_sq_ft,
          hasImage: Boolean(r.image_key),
          frame: r.frame ? JSON.parse(r.frame) : null,
          /*
           * THE FRAME THE STORED PHOTOGRAPH WAS TAKEN ON, which is not the
           * frame the phone showed. Workflow 21 re-banks a lot as the
           * rectangle round its parcel at 10 cm, and a map drawn on Google
           * has a 640-square display frame at a whole zoom, so the two
           * rectangles differ on every such row. The card draws the stored
           * photograph, so it must project the outlines with this one: with
           * `frame` the outlines sat a long way off the picture on every
           * Google-drawn map, while the same rows were right in the editor
           * (Mapbox tiles under `frame`) and right in training (the tools
           * have used image_frame since it existed).
           */
          imageFrame: r.image_frame ? JSON.parse(r.image_frame) : null,
          parcel: r.parcel ? JSON.parse(r.parcel) : null,
          shapes: JSON.parse(r.shapes || '[]'),
          detectedShapes: r.detected_shapes ? JSON.parse(r.detected_shapes) : null,
          notLawn: r.not_lawn ? JSON.parse(r.not_lawn) : null,
        }));

      const waiting = await env.DB.prepare(
        `SELECT COUNT(*) n FROM corpus WHERE status = 'new'`
      ).first();

      return json({ queue: wanted, waiting: waiting.n, candidates: queue,
        filters: { county: onlyCounty, disagreed: onlyDisagreed } }, 200, origin);
    } catch (e) {
      return json({ unavailable: String(e?.message || e).slice(0, 200) }, 200, origin);
    }
  }

  /* ------------------------------------- one candidate, shaped for the map */
  /*
   * Read by the MAP app, not the console, when Edit sends somebody over to fix
   * an outline. Shaped like one of its saves so it can be opened by the code
   * that already reopens saves -- a second loader would be a second set of
   * assumptions about what a restored map is.
   *
   * There is no address in the corpus and that is deliberate, so the county
   * stands in as the label. It is what the app puts in its heading, not
   * anything it navigates by: the frame and the parcel carry the position.
   */
  if (path === 'candidate') {
    try {
      const row = await env.DB.prepare(
        'SELECT * FROM corpus WHERE id = ?1'
      ).bind(url.searchParams.get('id') || '').first();
      if (!row) return json({ error: 'Not found' }, 404, origin);

      return json({
        id: row.id,
        address: row.county ? `Candidate in ${row.county}` : 'Candidate for review',
        lng: row.lng,
        lat: row.lat,
        parcel: row.parcel
          ? { type: 'Feature', properties: { county: row.county || 'traced by hand',
              drawn: row.parcel_source === 'hand' }, geometry: JSON.parse(row.parcel) }
          : null,
        frame: row.frame ? JSON.parse(row.frame) : null,
        /* For the every-map page, which draws the stored photograph through
           the same card as the console; see the candidates route. The editor
           ignores it and lays `frame` on live tiles. */
        imageFrame: row.image_frame ? JSON.parse(row.image_frame) : null,
        provider: row.provider,
        /* The county photo it was made on and how it sat, so the editor puts
           it back exactly under the outlines (owner, 2026-10-04). */
        countySvc: row.county_svc || null,
        countyAlign: (() => { try { return row.county_align ? JSON.parse(row.county_align) : null; } catch { return null; } })(),
        model: row.model,
        exclude: row.exclusions ? row.exclusions.split(',') : [],
        /*
         * BOTH STORED FORMS. Rows written before the inferred flag hold bare
         * geometries; rows written since hold Features. Reading only one of
         * them would either wrap a Feature inside a geometry slot -- an
         * outline that silently draws nothing -- or drop the flag on every
         * older map that gets reopened.
         */
        shapes: JSON.parse(row.shapes || '[]').map((f) => (f?.geometry
          ? { geometry: f.geometry, properties: f.properties || {} }
          : { geometry: f, properties: {} })),
        /* The owner's not-lawn traces, so reopening a map to correct it does
           not drop them (tinker mode, 2026-09-29). */
        notLawn: JSON.parse(row.not_lawn || '[]'),
      }, 200, origin);
    } catch (e) {
      return json({ error: String(e?.message || e).slice(0, 200) }, 500, origin);
    }
  }

  /* --------------------------------------------- one candidate's picture */
  /*
   * THE STORED PHOTOGRAPH, not a fresh one of the same place.
   *
   * For a lawn drawn on Google or Esri the banked image is a Mapbox tile of a
   * possibly different year, and that banked image is what a model would train
   * on. Reviewing a re-fetch would mean approving a picture the training run
   * never sees, which is the one way this whole tool could be confidently
   * wrong.
   */
  /* ------------------------------------------- what the detector got wrong */
  /*
   * THE SCREENING QUEUE: lawns sampled from county parcel services, waiting
   * for somebody to say whether they are worth paying to have traced.
   *
   * Candidates only, oldest first. Oldest rather than newest because this is a
   * queue to be emptied, not a feed to be browsed, and a queue that reorders
   * itself while you work it shows you the same lot twice.
   */
  if (path === 'lawn-jobs') {
    const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit')) || 24));
    const rows = await env.DB.prepare(
      `SELECT id, lng, lat, county, parcel_sqft, state
         FROM lawn_jobs WHERE state = 'candidate'
        ORDER BY created_at ASC LIMIT ?1`
    ).bind(limit).all();

    /* Screening's own states only -- see SCREEN_STATES. This counted every
       state in the table, so the screening page reported graded maps too. */
    const counts = await env.DB.prepare(
      `SELECT state, COUNT(*) n FROM lawn_jobs
        WHERE state IN (${SCREEN_STATES.map((_, i) => `?${i + 1}`).join(', ')})
        GROUP BY state`
    ).bind(...SCREEN_STATES).all();

    return json({
      jobs: (rows.results || []).map((r) => ({
        id: r.id,
        lng: Number(r.lng),
        lat: Number(r.lat),
        county: r.county,
        parcelSqFt: r.parcel_sqft === null ? null : Number(r.parcel_sqft),
      })),
      counts: Object.fromEntries((counts.results || []).map((r) => [r.state, Number(r.n)])),
    }, 200, origin);
  }

  /*
   * A verdict on one candidate.
   *
   * Only ever from 'candidate', so a second tap on a stale page cannot move a
   * lawn that has already been handed to somebody. The WHERE does that work
   * rather than a read-then-write, which would have a gap between the two.
   */
  if (path === 'screen-lawn' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const id = String(body?.id || '');
    const verdict = String(body?.verdict || '');
    if (!id || !['approved', 'rejected'].includes(verdict)) {
      return json({ error: 'Need an id and a verdict' }, 400, origin);
    }

    const done = await env.DB.prepare(
      `UPDATE lawn_jobs SET state = ?2, screened_at = ?3, note = ?4
        WHERE id = ?1 AND state = 'candidate'`
    ).bind(id, verdict, new Date().toISOString(), body?.note ? String(body.note).slice(0, 200) : null)
      .run();

    return json({ ok: true, changed: done?.meta?.changes ?? 0 }, 200, origin);
  }

  /*
   * THE PAID MAPS, WAITING TO BE LOOKED AT.
   *
   * A crowdsourced map does NOT go straight into the corpus. It lands as an
   * ordinary 'new' corpus row by the same road every other finished map takes,
   * and this queue is the step between that and training data -- which matters
   * more here than anywhere else, because H7 measured one bad map as worth up
   * to ten points and these are drawn by strangers being paid by the piece.
   *
   * FLAGGED ONES FIRST. A submission that went through as "I checked it and
   * the automatic outline was already right" is the one case where the machine
   * has a suspicion and cannot act on it, so it goes at the top rather than
   * waiting its turn in date order.
   */
  if (path === 'lawn-reviews') {
    const limit = Math.min(40, Math.max(1, Number(url.searchParams.get('limit')) || 12));

    const rows = await env.DB.prepare(
      `SELECT j.id, j.worker, j.county, j.parcel_sqft, j.submitted_at, j.note,
              j.map_id, j.lng, j.lat, j.seconds,
              c.square_feet, c.frame, c.image_frame, c.shapes, c.parcel, c.image_key
         FROM lawn_jobs j
         LEFT JOIN corpus c ON c.id = j.map_id
        WHERE j.state = 'submitted'
        ORDER BY CASE WHEN j.note LIKE 'flag:%' THEN 0 ELSE 1 END,
                 j.submitted_at ASC
        LIMIT ?1`
    ).bind(limit).all();

    /*
     * HOW THIS WORKER HAS BEEN DOING, on the card, because the two buttons
     * that are not "keep" are a judgement about a PERSON as much as about a
     * map. Refusing somebody's fourth map reads differently when their first
     * three were kept, and going back to look it up is not something that
     * happens on a phone.
     */
    const tallies = await env.DB.prepare(
      `SELECT j.worker,
              SUM(CASE WHEN j.state = 'kept' THEN 1 ELSE 0 END) AS kept,
              SUM(CASE WHEN j.state = 'excused' THEN 1 ELSE 0 END) AS excused,
              SUM(CASE WHEN j.state = 'refused' THEN 1 ELSE 0 END) AS refused,
              SUM(CASE WHEN j.state = 'submitted' THEN 1 ELSE 0 END) AS pending,
              MAX(COALESCE(w.trusted, 0)) AS trusted,
              MAX(w.note) AS note
         FROM lawn_jobs j
         LEFT JOIN lawn_workers w ON w.worker = j.worker
        WHERE j.worker IS NOT NULL GROUP BY j.worker`
    ).all();
    const byWorker = Object.fromEntries((tallies.results || []).map((t) => [t.worker, {
      kept: Number(t.kept || 0),
      excused: Number(t.excused || 0),
      refused: Number(t.refused || 0),
      pending: Number(t.pending || 0),
      /* So the card can show the switch in the state it is actually in,
         rather than offering to grant something already granted. */
      trusted: Number(t.trusted || 0) === 1,
      note: t.note || null,
    }]));

    /*
     * GRADING'S OWN STATES ONLY -- see GRADE_STATES.
     *
     * This counted every state in the table, so "So far:" on the grading page
     * read "104 approved · 3 claimed · 2 kept · 171 rejected". Approved and
     * rejected are SCREENING decisions about addresses; only the 2 was about
     * anybody's map. A tally under the words "how the grading is going" that
     * is mostly about something else is worse than no tally.
     */
    const counts = await env.DB.prepare(
      `SELECT state, COUNT(*) n FROM lawn_jobs
        WHERE state IN (${GRADE_STATES.map((_, i) => `?${i + 1}`).join(', ')})
        GROUP BY state`
    ).bind(...GRADE_STATES).all();

    /*
     * HOW LONG A MAP REALLY TAKES, as a median.
     *
     * The reward has to be defensible: every crowd platform left after MTurk
     * decides whether a task underpays by dividing the reward by the MEDIAN
     * OBSERVED time, not by the estimate typed into the listing. Guessing five
     * minutes on a job that really takes eight turns a compliant reward into a
     * flagged one without anybody doing anything wrong.
     *
     * The median rather than the mean, because one worker who wandered off
     * with a claim open for fifty minutes would drag a mean past the point of
     * being useful -- and that is the shape of outlier this queue produces.
     *
     * Read in SQL rather than over the page of rows above: that page is twelve
     * cards, and the number has to be over everything submitted.
     */
    const timings = await env.DB.prepare(
      `SELECT seconds FROM lawn_jobs
        WHERE seconds IS NOT NULL AND seconds > 0
        ORDER BY seconds ASC`
    ).all();
    const times = (timings.results || []).map((r) => Number(r.seconds));
    const medianSeconds = times.length
      ? (times.length % 2
        ? times[(times.length - 1) / 2]
        : Math.round((times[times.length / 2 - 1] + times[times.length / 2]) / 2))
      : null;

    return json({
      medianSeconds,
      timed: times.length,
      jobs: (rows.results || []).map((r) => ({
        id: r.id,
        worker: r.worker,
        seconds: r.seconds === null ? null : Number(r.seconds),
        county: r.county,
        parcelSqFt: r.parcel_sqft === null ? null : Number(r.parcel_sqft),
        submittedAt: r.submitted_at,
        /* Only a flag is worth surfacing; a skip note cannot reach this state. */
        flag: /^flag:/.test(r.note || '') ? String(r.note).slice(6).trim() : null,
        mapId: r.map_id,
        lng: Number(r.lng),
        lat: Number(r.lat),
        squareFeet: r.square_feet === null ? null : Number(r.square_feet),
        /*
         * The frame the worker actually drew on, so the picture and the
         * outline are the same photograph. Re-fetching imagery for the same
         * point would show a possibly different year and quietly put the
         * outline in the wrong place.
         */
        frame: r.frame ? JSON.parse(r.frame) : null,
        /* And the frame the STORED photograph was taken on, which the grading
           page draws under the outline; see the candidates route. */
        imageFrame: r.image_frame ? JSON.parse(r.image_frame) : null,
        parcel: r.parcel ? JSON.parse(r.parcel) : null,
        /* Both stored forms, same as the candidate route: older rows hold bare
           geometries, newer ones hold Features carrying the inferred flag. */
        shapes: JSON.parse(r.shapes || '[]').map((f) => (f?.geometry
          ? { geometry: f.geometry, properties: f.properties || {} }
          : { geometry: f, properties: {} })),
        hasImage: Boolean(r.image_key),
        tally: byWorker[r.worker] || null,
      })),
      counts: Object.fromEntries((counts.results || []).map((r) => [r.state, Number(r.n)])),
    }, 200, origin);
  }

  /*
   * A verdict on one paid map. Three outcomes, and the middle one is the
   * reason the worker-side bar can be as high as four in five:
   *
   *   kept     into the corpus, and it counts for the worker
   *   excused  NOT into the corpus, and it still counts for the worker. The
   *            lawn was hard and the attempt was reasonable. The queue hands
   *            lawns out in order, so who draws the awkward ones is luck.
   *   refused  genuinely bad. The only one that counts against them.
   *
   * All three are paid; payment is the crowd platform's business.
   */
  if (path === 'review-lawn' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const id = String(body?.id || '');
    const verdict = String(body?.verdict || '');
    if (!id || !['kept', 'excused', 'refused'].includes(verdict)) {
      return json({ error: 'Need an id and a verdict' }, 400, origin);
    }
    const note = body?.note ? String(body.note).slice(0, 200) : null;

    /*
     * `state = 'submitted'` in the WHERE, so a second tap on a page left open
     * cannot overturn a verdict already cast -- the same guard the corpus
     * review uses, and for the same reason.
     */
    const done = await env.DB.prepare(
      `UPDATE lawn_jobs SET state = ?2, decided_at = ?3, note = ?4
        WHERE id = ?1 AND state = 'submitted'
      RETURNING map_id`
    ).bind(id, verdict, new Date().toISOString(), note).first();

    if (!done) return json({ ok: false, reason: 'already-reviewed' }, 409, origin);

    /*
     * TWO QUESTIONS, TWO ANSWERS, AND THIS PAGE ONLY ANSWERS THE FIRST.
     *
     *   "Did this worker do adequate work?"   <- here
     *   "Is this map ready for the corpus?"   <- the ordinary review queue
     *
     * These used to be one. Keeping a map set the corpus row straight to
     * 'approved', which meant a stranger's outline entered training the moment
     * somebody said the stranger had earned their fifty cents -- skipping the
     * tidy-up the owner intends to do on every one of these, and skipping the
     * inferred check, which nothing else would ever come back and do.
     *
     * KEPT AND EXCUSED BOTH LEAVE THE MAP ALONE, at 'new', in the same queue
     * every other finished map waits in.
     *
     * Excused used to reject it, on the reasoning that an outline not worth
     * keeping has nothing for a second look to do. That was wrong about what
     * the button means: "not good enough, but a hard lawn" is a judgement
     * about how much to ASK OF A STRANGER, not a verdict on the pixels. The
     * owner may well have half an hour later and finish it themselves -- and a
     * rejected row is one nothing ever offers them again. Rejecting it threw
     * away a traced outline on a hard property, which is the most expensive
     * kind there is.
     *
     * Only an outright refusal settles the corpus row, because only that one
     * means the outline is not an attempt at this lawn.
     */
    if (done.map_id && verdict === 'refused') {
      await env.DB.prepare(
        `UPDATE corpus
            SET status = 'rejected', reviewed_at = ?2, reviewed_by = ?3,
                review_note = ?4, review_queue = 'paid'
          WHERE id = ?1`
      ).bind(done.map_id, new Date().toISOString(), me.email, note).run();
    }

    /*
     * AND A REFUSAL PUTS THE LAWN BACK IN THE QUEUE.
     *
     * The property was screened -- somebody looked at the photograph and said
     * it was worth tracing -- and one person failing to trace it does not
     * un-say that. Left as it was, an outright refusal quietly retired a good
     * lawn: the screening that earned it was spent, and nothing would ever
     * offer it again.
     *
     * A NEW ROW RATHER THAN RECYCLING THIS ONE, and that is the important
     * part. The refused row IS the worker's record -- the gates count refusals
     * per person -- so flipping it back to 'approved' would hand the lawn out
     * again AND erase the refusal that made it available, which is exactly
     * backwards. Two rows: one attempt that went badly, one lawn waiting for
     * somebody else.
     *
     * Created at `now`, so it goes to the back of the queue rather than
     * straight back to the front. Same reasoning as a skip.
     */
    let requeued = false;
    if (verdict === 'refused') {
      const lawn = await env.DB.prepare(
        'SELECT lng, lat, county, fips, parcel_sqft FROM lawn_jobs WHERE id = ?1'
      ).bind(id).first();
      if (lawn) {
        await env.DB.prepare(
          `INSERT INTO lawn_jobs (id, lng, lat, county, fips, parcel_sqft,
                                  state, note, screened_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'approved', ?7, ?8, ?8)`
        ).bind(
          crypto.randomUUID(), lawn.lng, lawn.lat, lawn.county, lawn.fips,
          lawn.parcel_sqft,
          'back in the queue after a refused attempt',
          new Date().toISOString(),
        ).run();
        requeued = true;
      }
    }

    return json({
      ok: true,
      /* Kept and excused both leave a map for the ordinary review queue. */
      stillToReview: verdict !== 'refused',
      requeued,
    }, 200, origin);
  }

  /*
   * EVERYBODY WHO HAS EVER BEEN HANDED A LAWN, and how it went.
   *
   * The grading queue answers "is this map any good" one card at a time, which
   * is the right shape for grading and the wrong shape for every question
   * about PEOPLE: who is worth trusting, who has stalled at a gate, whether
   * the volunteer link is being used at all, and which of the three routes is
   * actually producing the corpus.
   *
   * One row per worker, read straight out of lawn_jobs rather than kept in a
   * counter somewhere -- a tally that is maintained is a tally that drifts,
   * and there is no volume here that makes the scan worth avoiding.
   */
  if (path === 'workers') {
    const rows = await env.DB.prepare(
      `SELECT j.worker,
              COUNT(*)                                                    AS handed,
              SUM(CASE WHEN j.state = 'submitted' THEN 1 ELSE 0 END)      AS waiting,
              SUM(CASE WHEN j.state = 'kept'      THEN 1 ELSE 0 END)      AS kept,
              SUM(CASE WHEN j.state = 'excused'   THEN 1 ELSE 0 END)      AS excused,
              SUM(CASE WHEN j.state = 'refused'   THEN 1 ELSE 0 END)      AS refused,
              SUM(CASE WHEN j.state = 'claimed'   THEN 1 ELSE 0 END)      AS open,
              MIN(j.submitted_at)                                         AS first_at,
              MAX(j.submitted_at)                                         AS last_at,
              COUNT(j.seconds)                                            AS timed,
              SUM(COALESCE(j.seconds, 0))                                 AS total_seconds,
              MAX(COALESCE(w.trusted, 0))                                 AS trusted,
              MAX(w.note)                                                 AS note,
              /*
               * TWO DIFFERENT FACTS, KEPT APART.
               *
               *   decided  what the OWNER said this person is. Null until
               *            somebody opened the editor and saved.
               *   arrived  which link they actually came in on, recorded when
               *            the lawn was claimed. Null on rows claimed before
               *            that column existed.
               *
               * This used to be one column, COALESCEd to 'crowd', and the
               * default was indistinguishable from a decision. Seven
               * volunteers read as crowd workers on a batch where no crowd
               * link had been handed out -- and opening one of those rows to
               * add a note offered "Crowd" pre-selected, which saving would
               * have made true.
               *
               * MAX() over the routes rather than the newest one on purpose:
               * they are all the same value for anybody who has used one
               * link, and somebody who has used two is worth noticing rather
               * than smoothing over.
               */
              MAX(w.kind)                                                 AS decided,
              MAX(j.route)                                                AS arrived,
              COUNT(DISTINCT j.route)                                     AS routes_used,
              /*
               * A PAID TRACER'S WORKER ID IS THEIR ACCOUNT ID, because that
               * route reads identity from the session rather than from a link.
               * So the account is joinable, and it carries the two things the
               * owner actually needs to settle up: where to send the money and
               * a verified address to use when it bounces.
               */
              MAX(u.email)                                                AS email,
              MAX(u.payout_kind)                                          AS payout_kind,
              MAX(u.payout_handle)                                        AS payout_handle
         FROM lawn_jobs j
         LEFT JOIN lawn_workers w ON w.worker = j.worker
         LEFT JOIN users u        ON u.id     = j.worker
        WHERE j.worker IS NOT NULL
        GROUP BY j.worker
        ORDER BY MAX(COALESCE(j.submitted_at, j.claimed_at, j.created_at)) DESC`
    ).all();

    /*
     * A SEPARATE PASS FOR THE MEDIANS, because SQLite has no median and the
     * mean is the wrong number here: one worker who wandered off with a claim
     * open for an hour would read as somebody painstaking. Small enough to do
     * in memory -- this is a few hundred rows at the very most.
     */
    const times = await env.DB.prepare(
      `SELECT worker, seconds FROM lawn_jobs
        WHERE worker IS NOT NULL AND seconds IS NOT NULL AND seconds > 0
        ORDER BY worker, seconds ASC`
    ).all();
    const byWorker = new Map();
    for (const t of times.results || []) {
      if (!byWorker.has(t.worker)) byWorker.set(t.worker, []);
      byWorker.get(t.worker).push(Number(t.seconds));
    }
    /*
     * WHAT HAS ALREADY BEEN ASKED FOR OR SENT, subtracted here for the same
     * reason it is subtracted on the worker's own page: the two screens have to
     * agree about money. Without this the Owed column would still read $6.00
     * the day after the six dollars went out, and the first thing the owner
     * would do about it is pay it twice.
     */
    const settled = await env.DB.prepare(
      `SELECT worker, COALESCE(SUM(cents), 0) AS cents FROM lawn_payouts
        WHERE state IN ('requested', 'paid') GROUP BY worker`
    ).all();
    const settledBy = new Map(
      (settled.results || []).map((r) => [r.worker, Number(r.cents || 0)])
    );

    const medianOf = (list) => {
      if (!list?.length) return null;
      return list.length % 2
        ? list[(list.length - 1) / 2]
        : Math.round((list[list.length / 2 - 1] + list[list.length / 2]) / 2);
    };

    return json({
      rateCents: PAID_RATE_CENTS,
      minPayoutCents: MIN_PAYOUT_CENTS,
      workers: (rows.results || []).map((r) => {
        const kept = Number(r.kept || 0);
        const excused = Number(r.excused || 0);
        const refused = Number(r.refused || 0);
        const reviewed = kept + excused + refused;
        return {
          worker: r.worker,
          /*
           * WHAT TO CALL THEM: the owner's decision if there is one, else the
           * link they actually arrived on, else nothing at all. Null travels
           * to the page as "unknown", which is the honest answer for a row
           * claimed before the route was recorded -- and a far better one than
           * naming a route nobody used.
           */
          kind: r.decided || r.arrived || null,
          decided: r.decided || null,
          arrived: r.arrived || null,
          /* Somebody who has used more than one link. Rare and worth seeing. */
          mixed: Number(r.routes_used || 0) > 1,
          trusted: Number(r.trusted || 0) === 1,
          note: r.note || null,
          handed: Number(r.handed || 0),
          open: Number(r.open || 0),
          waiting: Number(r.waiting || 0),
          kept,
          excused,
          refused,
          reviewed,
          /*
           * The pass rate is what the gates actually read, so it is what the
           * page shows -- kept AND excused over everything reviewed. Null
           * rather than 0 when nothing has been looked at, because "no maps
           * passed" and "nobody has looked" are opposite facts that would
           * otherwise print the same.
           */
          passRate: reviewed ? (kept + excused) / reviewed : null,
          /*
           * Only APPROVED maps earn. An excused one counts as a pass at a gate
           * and is explicitly not an approval, so it owes nothing -- and the
           * owner's screen has to agree with the worker's, which computes the
           * same way in routes-auth.js.
           */
          owedCents: r.payout_handle
            ? owedCents({
              approved: kept,
              settledCents: settledBy.get(r.worker) || 0,
            })
            : 0,
          email: r.email || null,
          payout: r.payout_handle
            ? { kind: r.payout_kind || null, handle: r.payout_handle }
            : null,
          medianSeconds: medianOf(byWorker.get(r.worker)),
          totalSeconds: Number(r.total_seconds || 0),
          firstAt: r.first_at || null,
          lastAt: r.last_at || null,
        };
      }),
    }, 200, origin);
  }

  /* ------------------------------------------------ money somebody asked for */
  /*
   * NOT A PAYMENT SYSTEM. The money moves in Venmo or PayPal, by hand, outside
   * this app. This is the list of what is owed and what has been sent, so that
   * neither side has to remember.
   *
   * Open requests first and oldest first, because this is a queue to be
   * emptied: somebody is waiting on every row at the top of it.
   */
  if (path === 'payouts') {
    const rows = await env.DB.prepare(
      `SELECT p.*, u.email, u.payout_kind AS now_kind, u.payout_handle AS now_handle
         FROM lawn_payouts p
         LEFT JOIN users u ON u.id = p.worker
        ORDER BY CASE WHEN p.state = 'requested' THEN 0 ELSE 1 END,
                 p.requested_at ASC
        LIMIT 200`
    ).all();

    return json({
      payouts: (rows.results || []).map((r) => ({
        id: r.id,
        worker: r.worker,
        email: r.email || null,
        cents: Number(r.cents),
        maps: Number(r.maps),
        /*
         * WHERE IT WAS MEANT TO GO, AND WHERE IT WOULD GO NOW. Snapshotted at
         * request time so a record of money already sent says where it
         * actually went -- but the account's handle can change afterwards, and
         * paying the old one would send it to an address somebody has just
         * told us they no longer use. The console shows both when they differ;
         * that is the whole reason for keeping two.
         */
        kind: r.kind || null,
        handle: r.handle || null,
        nowKind: r.now_kind || null,
        nowHandle: r.now_handle || null,
        changed: Boolean(r.now_handle && r.handle && r.now_handle !== r.handle),
        state: r.state,
        note: r.note || null,
        reference: r.reference || null,
        requestedAt: r.requested_at,
        decidedAt: r.decided_at || null,
      })),
    }, 200, origin);
  }

  /*
   * MARKING ONE SENT, OR HANDING IT BACK.
   *
   *   paid      the money went. The claim stands and the balance stays spent.
   *   returned  it could not be sent -- a handle that bounced, usually. The
   *             row stops subtracting, so the worker's balance comes back on
   *             its own and they can fix their details and ask again. Nothing
   *             is adjusted by hand anywhere, because nothing is stored.
   */
  if (path === 'settle-payout' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const id = String(body?.id || '');
    const state = ['paid', 'returned'].includes(String(body?.state || ''))
      ? String(body.state) : null;
    if (!id || !state) return json({ error: 'Need an id and a state' }, 400, origin);

    /*
     * `state = 'requested'` in the WHERE, so a second tap on a page left open
     * cannot re-settle something already decided -- and, more to the point,
     * cannot flip a payment that has actually been sent back into a balance.
     */
    const done = await env.DB.prepare(
      `UPDATE lawn_payouts
          SET state = ?2, decided_at = ?3, decided_by = ?4,
              note = ?5, reference = ?6
        WHERE id = ?1 AND state = 'requested'`
    ).bind(
      id, state, new Date().toISOString(), me.email,
      body?.note ? String(body.note).slice(0, 200) : null,
      body?.reference ? String(body.reference).slice(0, 120) : null,
    ).run();

    if (!done.meta?.changes) {
      return json({ ok: false, reason: 'already-settled' }, 409, origin);
    }
    return json({ ok: true }, 200, origin);
  }

  /*
   * TRUSTING SOMEBODY, OR TAKING IT BACK.
   *
   * The gates and the daily cap exist to find out whether an anonymous
   * stranger can do this. For one or two people hired directly and paid by the
   * hour, that question has already been answered -- expensively, by the owner
   * looking at their maps -- and the gates become a ceiling on work that has
   * been bought. Trust lifts them, and lifts nothing else: one lawn at a time
   * still holds, because that is what stops a lawn being paid for twice.
   *
   * Granted from the grading card, which is where the opinion actually forms.
   * It deliberately does not care whether somebody was hired or came off a
   * crowd platform: a stranger who turns out to be excellent is exactly who
   * should be let off the leash.
   */
  if (path === 'trust-worker' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    /*
     * Through the SAME cleaner the queue puts a worker id through on the way
     * in, so the two spellings cannot drift. A row keyed on anything else is a
     * row the claim lookup never finds -- the switch would appear to work, the
     * card would show it on, and the gates would quietly stay shut.
     */
    const worker = cleanWorker(body?.worker);
    if (!worker) return json({ error: 'Need a worker' }, 400, origin);
    const trusted = body?.trusted === true;
    const note = body?.note ? String(body.note).slice(0, 200) : null;
    const when = new Date().toISOString();

    /*
     * WHICH ROUTE, SET SEPARATELY FROM TRUST, because they are different
     * facts and conflating them would undo the thing the gates are for.
     *
     * "Hired" says where somebody came from and what they see at the end: no
     * platform, so a running count instead of a completion code. It says
     * NOTHING about whether they are any good, and a hired person goes through
     * the same five-map and fifteen-map gates as a stranger -- which is the
     * point, because that is what replaced an audition. Trust is the separate,
     * later, deliberate decision that they have earned their way past them.
     *
     * Omitted leaves whatever is there, so the trust switch on the grading
     * card cannot silently reset somebody's route to 'crowd'.
     */
    const kind = ROUTES.includes(String(body?.kind || '')) ? String(body.kind) : null;

    /*
     * Upsert, because the owner will change their mind and the row is the
     * decision rather than the person -- there is no sign-up here to hang one
     * off. COALESCE on the note so revoking trust does not silently wipe
     * "Jane, hired on Upwork", which is the only thing that makes a worker id
     * readable three weeks later.
     */
    await env.DB.prepare(
      `INSERT INTO lawn_workers
         (worker, trusted, note, kind, decided_at, decided_by, created_at)
       VALUES (?1, ?2, ?3,
         /*
          * A ROUTE NOBODY CHOSE FALLS BACK TO THE ONE THEY ACTUALLY USED.
          *
          * The column is NOT NULL, so trusting somebody without naming a route
          * has to write something -- and writing 'crowd' is how a volunteer
          * ends up gated at five maps, because routeFor prefers this row over
          * the link. Their own recorded route is the truthful thing to put
          * here, and 'crowd' stays only for a row with nothing recorded at
          * all, which is exactly what routeFor would have concluded anyway.
          */
         COALESCE(?6,
           (SELECT route FROM lawn_jobs
             WHERE worker = ?1 AND route IS NOT NULL
             ORDER BY COALESCE(submitted_at, claimed_at, created_at) DESC
             LIMIT 1),
           'crowd'),
         ?4, ?5, ?4)
       ON CONFLICT(worker) DO UPDATE SET
         trusted = ?2, note = COALESCE(?3, lawn_workers.note),
         kind = COALESCE(?6, lawn_workers.kind),
         decided_at = ?4, decided_by = ?5`
    ).bind(worker, trusted ? 1 : 0, note, when, me.email, kind).run();

    return json({ ok: true, worker, trusted, kind }, 200, origin);
  }

  /*
   * The index written by a training run, and the pictures it points at.
   *
   * Two routes rather than one because they are different things: the index is
   * small JSON the page needs immediately, and the pictures are a quarter of a
   * megabyte each that should arrive only when something is scrolled to.
   */
  /*
   * WHICH SET OF PICTURES, and it is an allowlist rather than a sanitiser.
   *
   * The bucket also holds the training photographs -- people's gardens -- so a
   * caller naming a folder is not something to clean up and pass on.
   * "predictions/../corpus/..." is the shape of that mistake, and two literal
   * names cannot be got round. Anything else falls back to the detector's own
   * renderings rather than erroring, because a stale bookmark should show
   * something rather than break.
   */
  const renderSet = (u) => (u.searchParams.get('set') === 'crowns' ? 'crowns' : 'predictions');

  /*
   * A RUN FOLDER'S NAME, and this one is a pattern rather than a pair of
   * literals because the names are generated and there is an unbounded supply
   * of them. The same rule still applies: the bucket holds the training
   * photographs, so what comes back from here must be incapable of naming
   * anything outside `runs/`.
   *
   * No dot and no slash, so "..", "./" and a bare key elsewhere are all
   * unspellable. tools/run-folder.js builds these out of the same alphabet
   * from the other end.
   */
  const RUN_SLUG = /^[a-z0-9][a-z0-9-]{0,95}$/;
  const runOf = (u) => {
    const slug = u.searchParams.get('run') || '';
    return RUN_SLUG.test(slug) ? slug : '';
  };

  /*
   * EVERY RUN THAT HAS DRAWN PICTURES, newest first, for the picker.
   *
   * Separate from the pictures themselves because it is read on every load of
   * the page and the run behind it may be two hundred renderings. A missing
   * list is not an error: it means nothing has been drawn since runs got
   * folders, and the page falls back to the older flat set rather than showing
   * somebody an empty screen.
   */
  if (path === 'prediction-runs') {
    if (!env.CORPUS) return json({ error: 'No bucket' }, 404, origin);
    try {
      const object = await env.CORPUS.get('runs/index.json');
      if (!object) return json({ runs: [] }, 200, origin);
      return json(await object.json(), 200, origin);
    } catch {
      return json({ runs: [] }, 200, origin);
    }
  }

  if (path === 'predictions') {
    if (!env.CORPUS) return json({ error: 'No bucket' }, 404, origin);
    /*
     * A named run, or the flat set that predates them. Both are served from
     * here so the page has one route to ask and old links keep working --
     * there are renderings in `predictions/` and `crowns/` that nobody is
     * going to re-run to get a folder.
     */
    const run = runOf(url);
    const key = run ? `runs/${run}/index.json` : `${renderSet(url)}/index.json`;
    try {
      const object = await env.CORPUS.get(key);
      if (!object) return json({ error: 'Nothing drawn yet' }, 404, origin);
      const data = await object.json();
      /*
       * COORDINATES FOR RUNS DRAWN BEFORE THEY WERE WRITTEN IN (owner,
       * 2026-09-26): a benchmark lot's tag names its map id, and the id starts
       * with the address point. Admin only, like everything on this route.
       */
      for (const e of Array.isArray(data?.entries) ? data.entries : []) {
        if (e && e.lat === undefined && e.tag) Object.assign(e, coordsOfId(benchmarkId(e.tag)) || {});
      }
      /*
       * TODAY'S NAMES, B01 and C01 (owner, 2026-10-04), for every run: a run
       * keeps the name it was drawn with, and the ones drawn before C numbers
       * said "#121" or nothing. Matched by the map id when the run wrote it,
       * else by the address point every id starts with.
       */
      try {
        const rows = (await env.DB.prepare('SELECT id, lot_no FROM corpus').all()).results || [];
        const point = (lng, lat) => `${Number(lng)},${Number(lat)}`;
        const byId = new Map(rows.map((r) => [r.id, r]));
        const byPoint = new Map();
        for (const r of rows) {
          const c = coordsOfId(r.id);
          if (c) byPoint.set(point(c.lng, c.lat), r);
        }
        for (const e of Array.isArray(data?.entries) ? data.entries : []) {
          const r = (e?.id && byId.get(e.id)) || (Number.isFinite(e?.lng) && byPoint.get(point(e.lng, e.lat)));
          const name = r ? mapName(r.id, r.lot_no) : null;
          if (name) e.tag = name;
        }
      } catch { /* the names the run wrote, then */ }
      return json(data, 200, origin);
    } catch {
      return json({ error: 'Nothing drawn yet' }, 404, origin);
    }
  }

  if (path === 'prediction-image') {
    if (!env.CORPUS) return json({ error: 'No bucket' }, 404, origin);
    /*
     * THE KEY IS CHECKED, NOT TRUSTED. It arrives in a query string, and a
     * bucket holding the training photographs is not somewhere to let a
     * caller name an arbitrary object -- "predictions/../corpus/..." is the
     * shape of that mistake. A strict pattern is cheaper than a sanitiser and
     * cannot be got round.
     */
    const key = url.searchParams.get('key') || '';
    /*
     * Three shapes, all closed: the two flat sets that predate run folders,
     * and a picture inside one run folder -- either the interpreted shapes or
     * the raw mask behind them. No dot outside the extension and no slash
     * inside a name, so nothing here can address the photographs.
     */
    const ok = /^(predictions|crowns)\/\d+\.png$/.test(key)
      || /^runs\/[a-z0-9][a-z0-9-]{0,95}\/\d+(-mask|-photo|-layers)?\.png$/.test(key);
    if (!ok) return json({ error: 'Not a prediction' }, 400, origin);
    try {
      const object = await env.CORPUS.get(key);
      if (!object) return json({ error: 'No image' }, 404, origin);
      return new Response(object.body, {
        headers: {
          'Content-Type': 'image/png',
          /*
           * Private, always: these are drawn on people's gardens.
           *
           * A picture in a run folder is immutable -- the folder is named for
           * the minute it was made and nothing writes to it twice -- so it can
           * be held, which is what makes flipping between the shapes and the
           * raw mask instant on the second look. The two flat sets ARE
           * overwritten by the next run, and a long cache there would show
           * yesterday's model under today's numbers.
           */
          'Cache-Control': key.startsWith('runs/')
            ? 'private, max-age=86400, immutable'
            : 'private, max-age=60',
        },
      });
    } catch {
      return json({ error: 'No image' }, 404, origin);
    }
  }

  /* ------------------------------------ public not-lawn outlines (owner) */
  /*
   * EVERY MAP WITH PUBLIC OUTLINES FETCHED, and whether the owner has
   * approved them. See worker/src/outlines.js; workflow 25 writes the drafts.
   */
  if (path === 'outlines') {
    if (!env.CORPUS) return json({ error: 'No bucket' }, 404, origin);
    const out = [];
    let cursor;
    do {
      const page = await env.CORPUS.list({ prefix: OUTLINE_PREFIX, cursor, include: ['customMetadata'] });
      for (const o of page.objects) {
        const id = idOfOutlineKey(o.key);
        if (id) out.push({ id, status: o.customMetadata?.status || 'draft', count: Number(o.customMetadata?.count || 0) });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    /* The whole corpus is a few hundred rows; one read beats D1's hundred-
       parameter cap on an IN list that grows with the corpus. */
    const rows = out.length ? (await env.DB.prepare(
      'SELECT id, county, square_feet FROM corpus'
    ).all()).results : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return json({
      maps: out.map((o) => ({ ...o, county: byId.get(o.id)?.county || null,
        squareFeet: byId.get(o.id)?.square_feet ?? null })),
    }, 200, origin);
  }

  if (path === 'outline' && request.method === 'GET') {
    if (!env.CORPUS) return json({ error: 'No bucket' }, 404, origin);
    const id = url.searchParams.get('id') || '';
    for (const key of outlineKeys(id)) {
      const object = await env.CORPUS.get(key);
      if (object) return json(await object.json(), 200, origin);
    }
    return json({ error: 'Not fetched yet' }, 404, origin);
  }

  if (path === 'outline' && request.method === 'POST') {
    if (!env.CORPUS) return json({ error: 'No bucket' }, 404, origin);
    const body = await request.json().catch(() => ({}));
    const id = String(body?.id || '');
    /* A real map, or nothing is written: the key is built from this id. */
    const row = id ? await env.DB.prepare('SELECT id FROM corpus WHERE id = ?1').bind(id).first() : null;
    if (!row) return json({ error: 'No such map' }, 404, origin);
    let key = null, object = null;
    for (const k of outlineKeys(id)) {
      object = await env.CORPUS.get(k);
      if (object) { key = k; break; }
    }
    if (!object) return json({ error: 'Not fetched yet' }, 404, origin);
    const saved = applyReview(await object.json(), body);
    const kept = saved.features.filter((f) => !f.properties?.dropped).length;
    await env.CORPUS.put(key, JSON.stringify(saved), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { status: saved.status, count: String(kept) },
    });
    return json({ ok: true, status: saved.status, kept }, 200, origin);
  }

  /* ------------------------------------------- not-lawn examples (owner) */
  if (path === 'examples') {
    if (!env.CORPUS) return json({ error: 'No bucket' }, 404, origin);
    const out = [];
    let cursor;
    do {
      const page = await env.CORPUS.list({ prefix: EXAMPLE_PREFIX, cursor, include: ['customMetadata'] });
      for (const o of page.objects) {
        if (!o.key.endsWith('.json')) continue;
        const id = o.key.slice(EXAMPLE_PREFIX.length, -'.json'.length);
        if (!isExampleId(id)) continue;
        let kept = {};
        try { kept = JSON.parse(o.customMetadata?.kept || '{}'); } catch { kept = {}; }
        out.push({ id, status: o.customMetadata?.status || 'draft', kept });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    out.sort((a, b) => a.id.localeCompare(b.id));
    return json({ examples: out }, 200, origin);
  }

  if (path === 'example' && request.method === 'GET') {
    if (!env.CORPUS) return json({ error: 'No bucket' }, 404, origin);
    const id = url.searchParams.get('id') || '';
    if (!isExampleId(id)) return json({ error: 'No such example' }, 404, origin);
    const object = await env.CORPUS.get(exampleKey(id));
    if (!object) return json({ error: 'No such example' }, 404, origin);
    return json(await object.json(), 200, origin);
  }

  if (path === 'example' && request.method === 'POST') {
    if (!env.CORPUS) return json({ error: 'No bucket' }, 404, origin);
    const body = await request.json().catch(() => ({}));
    const id = String(body?.id || '');
    if (!isExampleId(id)) return json({ error: 'No such example' }, 404, origin);
    const object = await env.CORPUS.get(exampleKey(id));
    if (!object) return json({ error: 'No such example' }, 404, origin);
    const saved = reviewExample(await object.json(), body);
    const kept = keptByClass(saved);
    await env.CORPUS.put(exampleKey(id), JSON.stringify(saved), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { status: saved.status, kept: JSON.stringify(kept) },
    });
    /* What was stored, so the page can check it against what it sent. */
    const stored = {
      shift: saved.shift || null,
      shifts: Object.fromEntries(saved.features.map((f, k) => [k, f.properties?.shift]).filter(([, v]) => v)),
    };
    return json({ ok: true, status: saved.status, kept, stored }, 200, origin);
  }

  if (path === 'example-image') {
    if (!env.CORPUS) return json({ error: 'No bucket' }, 404, origin);
    const id = url.searchParams.get('id') || '';
    if (!isExampleId(id)) return json({ error: 'No image' }, 404, origin);
    const object = await env.CORPUS.get(exampleImageKey(id));
    if (!object) return json({ error: 'No image' }, 404, origin);
    return new Response(object.body, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=600' },
    });
  }

  /* ------------------------------------------- county orthophotos (owner, 2026-10-01) */
  /*
   * The maps tools/county-imagery.js banked a county photo for, the photo
   * itself, the map's outlines and frame -- the same image_frame training
   * rasterises them against -- and a verdict. See public/county.html.
   */
  if (path === 'county-list') {
    /* Approved maps only: only those are training data, and a candidate's
       outline may still change (owner, 2026-10-01: "you sent some maps that
       weren't yet approved"). */
    try {
      const rows = await env.DB.prepare(
        `SELECT ci.id, ci.title, ci.year, ci.native_cm, ci.review, ci.fit, ci.fit0, ci.residual_m,
                ci.east, ci.north, ci.scale, ci.review_east, ci.review_north, c.county, c.status,
                ci.reg_confident, ci.reg_why, ci.outlines_at
           FROM county_imagery ci JOIN corpus c ON c.id = ci.id
          WHERE ci.image_key IS NOT NULL AND c.status = 'approved'
          ORDER BY c.at DESC`
      ).all();
      const looked = await env.DB.prepare('SELECT COUNT(*) n FROM county_imagery').first();
      return json({ maps: rows.results || [], looked: looked?.n || 0 }, 200, origin);
    } catch (e) {
      return json({ maps: [], looked: 0, unavailable: String(e.message || e) }, 200, origin);
    }
  }

  if (path === 'county' && request.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    /* Named, not ci.*: county_imagery has shapes and not_lawn of its own now,
       and two columns of one name in a row is whichever came last. */
    const row = await env.DB.prepare(
      `SELECT ci.id, ci.service, ci.title, ci.year, ci.native_cm, ci.east, ci.north, ci.scale,
              ci.fit, ci.fit0, ci.residual_m, ci.review, ci.review_east, ci.review_north,
              ci.banked_at, ci.candidates, ci.reg_model, ci.reg_inliers, ci.reg_patches, ci.reg_rms_m,
              ci.reg_confident, ci.reg_why, ci.outlines_at, ci.outlines_by,
              ci.shapes AS county_shapes, ci.not_lawn AS county_not_lawn,
              c.county, c.status, c.frame, c.image_frame, c.shapes, c.not_lawn, c.parcel
         FROM county_imagery ci JOIN corpus c ON c.id = ci.id WHERE ci.id = ?1`
    ).bind(id).first();
    if (!row) return json({ error: 'No such map' }, 404, origin);
    const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
    return json({
      ...row,
      frame: parse(row.image_frame) || parse(row.frame),
      shapes: parse(row.shapes) || [],
      not_lawn: parse(row.not_lawn) || [],
      county_shapes: row.county_shapes ? parse(row.county_shapes) || [] : null,
      county_not_lawn: row.county_not_lawn ? parse(row.county_not_lawn) || [] : null,
      parcel: parse(row.parcel),
      candidates: parse(row.candidates) || [],
      image_frame: undefined,
    }, 200, origin);
  }

  if (path === 'county-review' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const id = String(body?.id || '');
    const clean = cleanCountyReview(body);
    if (!clean) return json({ error: 'Bad verdict' }, 400, origin);
    const res = await env.DB.prepare(
      `UPDATE county_imagery SET review = ?2, review_east = ?3, review_north = ?4,
              reviewed_at = ?5, reviewed_by = ?6 WHERE id = ?1 AND image_key IS NOT NULL`
    ).bind(id, clean.review, clean.east, clean.north, new Date().toISOString(), me.email || me.id).run();
    if (!res.meta?.changes) return json({ error: 'No such map' }, 404, origin);
    return json({ ok: true, ...clean }, 200, origin);
  }

  /*
   * Outlines traced on the county photo, from the editor. corpus is not
   * touched: its outlines were traced on Mapbox and stay Mapbox's. The first
   * time, a copy of those is set aside beside the county ones (COALESCE keeps
   * the first copy), so they survive the corpus row being finished again.
   */
  if (path === 'county-outlines' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const id = String(body?.id || '');
    const clean = cleanCountyOutlines(body);
    if (!clean) return json({ error: 'No outlines to keep' }, 400, origin);
    const res = await env.DB.prepare(
      `UPDATE county_imagery SET shapes = ?2, not_lawn = ?3, outlines_at = ?4, outlines_by = ?5,
              mapbox_shapes = COALESCE(mapbox_shapes, (SELECT shapes FROM corpus WHERE id = ?1)),
              mapbox_not_lawn = COALESCE(mapbox_not_lawn, (SELECT not_lawn FROM corpus WHERE id = ?1))
        WHERE id = ?1 AND image_key IS NOT NULL`
    ).bind(id, clean.shapes, clean.notLawn, new Date().toISOString(), me.email || me.id).run();
    if (!res.meta?.changes) return json({ error: 'No such map' }, 404, origin);
    return json({ ok: true }, 200, origin);
  }

  if (path === 'county-image') {
    if (!env.CORPUS) return json({ error: 'No bucket' }, 404, origin);
    const id = url.searchParams.get('id') || '';
    const row = await env.DB.prepare('SELECT image_key FROM county_imagery WHERE id = ?1').bind(id).first();
    if (!row?.image_key) return json({ error: 'No image' }, 404, origin);
    const object = await env.CORPUS.get(row.image_key);
    if (!object) return json({ error: 'No image' }, 404, origin);
    return new Response(object.body, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=60' },
    });
  }

  if (path === 'candidate-image') {
    if (!env.CORPUS) return json({ error: 'No bucket' }, 404, origin);
    const id = url.searchParams.get('id') || '';
    try {
      const row = await env.DB.prepare(
        'SELECT image_key FROM corpus WHERE id = ?1'
      ).bind(id).first();
      if (!row?.image_key) return json({ error: 'No image' }, 404, origin);

      const object = await env.CORPUS.get(row.image_key);
      if (!object) return json({ error: 'No image' }, 404, origin);

      return new Response(object.body, {
        headers: {
          'Content-Type': object.httpMetadata?.contentType || 'image/png',
          // Private: this is somebody's garden, behind an admin session.
          'Cache-Control': 'private, max-age=600',
        },
      });
    } catch {
      return json({ error: 'No image' }, 404, origin);
    }
  }

  /* ------------------------------------------------------- the verdict */
  /*
   * FETCH A MISSING PHOTO, from the review card (owner, 2026-10-02: a map
   * whose photo never landed said "nothing can be trained on it until the
   * picture is fetched", and nothing could fetch it). The same banking a
   * finished map gets: the county photo for a map made on one (the first
   * service that answers there; the map does not record which), Mapbox or
   * NAIP otherwise.
   */
  if (path === 'fetch-photo' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const id = String(body?.id || '');
    const row = await env.DB.prepare('SELECT id, provider, frame, lng, lat, county_svc, county_align FROM corpus WHERE id = ?1').bind(id).first();
    if (!row?.frame) return json({ ok: false, reason: row ? 'no-frame' : 'no-map' }, 404, origin);
    const map = { id: row.id, provider: row.provider, frame: JSON.parse(row.frame) };
    let got;
    if (row.provider === 'county') {
      /* The photo it was made on and how it was lined up, when the map
         says; else the first service that answers there. */
      const svcId = row.county_svc || (await countyServicesAt(env, row.lng, row.lat, 1).catch(() => []))[0]?.id;
      let align = null;
      try { align = row.county_svc && row.county_align ? JSON.parse(row.county_align) : null; } catch { /* none */ }
      got = svcId ? await storeCountyImage(env, map, { svcId, align }) : { ok: false, reason: 'no-county-photo-here' };
    } else {
      got = await storeImage(env, map);
    }
    const after = await env.DB.prepare('SELECT image_key, image_frame FROM corpus WHERE id = ?1').bind(id).first();
    return json({ ...got, hasImage: Boolean(after?.image_key),
      imageFrame: after?.image_frame ? JSON.parse(after.image_frame) : null }, got.ok ? 200 : 502, origin);
  }

  if (path === 'review') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, origin);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

    const status = ['approved', 'rejected'].includes(body?.status) ? body.status : null;
    const id = typeof body?.id === 'string' ? body.id : null;
    if (!status || !id) return json({ error: 'Need an id and a verdict' }, 400, origin);
    /*
     * WHICH DRAW SURFACED THIS MAP, which is not decoration: `random` is the
     * only value that means "chosen blind", and the representative slice of
     * the eval is built from exactly those rows. So an unknown value must not
     * quietly become one of the real ones.
     *
     * `list` is the every-map page, where a verdict is cast over the whole
     * pile rather than over a map a queue handed you. It is not `priority`
     * and pretending otherwise would credit a deliberate choice to a draw.
     */
    const queue = body?.queue === 'random' ? 'random'
      : body?.queue === 'ungraded' ? 'ungraded'
        : body?.queue === 'list' ? 'list' : 'priority';
    /*
     * HOW MUCH CANOPY, NOT WHETHER THERE ARE TREES.
     *
     *   null  nobody said -- every row reviewed before this existed, and
     *         deliberately distinct from "looked, and there is none"
     *   0     none: where the lawn ends is visible
     *   1     some: canopy overhangs, the edge was still readable
     *   2     it decided the edge: the boundary under there was a judgement
     *
     * A yes/no could not carry this. Asked what "has a tree line" meant --
     * a row of trees, or any canopy that makes the cover ambiguous -- the
     * honest answer was the second, and on a wooded region that is every lawn:
     * a flag that is true of everything selects nothing, and the hard slice it
     * exists to fill would have been the whole corpus. The grade is what puts
     * the discrimination back, and 2 is what the target counts.
     *
     * The old boolean is still accepted, because a console left open in a tab
     * will keep sending one until it is reloaded. True lands on 2 rather than
     * 1: under the old wording it meant "this lawn is a tree-line case", which
     * is the strong reading.
     */
    const canopy = (() => {
      const v = body?.canopy;
      if (v === 0 || v === 1 || v === 2) return v;
      if (body?.treeLine === true) return 2;
      if (body?.treeLine === false) return 0;
      return null;
    })();

    /*
     * CHANGING A MIND ON PURPOSE.
     *
     * The guard below exists to stop a stale tap flipping a verdict. It cannot
     * tell the difference between that and somebody deliberately going back to
     * a map they rejected last week -- both arrive as "rejected row, approved
     * in" -- so the console says which it is. `force` is only ever set by the
     * browsing queues, where the card has already shown the current verdict on
     * screen before offering to change it.
     */
    const force = body?.force === true;

    try {
      const res = await env.DB.prepare(
        /*
         * A MAP OF NOT-LAWN TRACES ONLY (status 'notlawn', corpus.js) is
         * judged too (owner, 2026-10-02: approving one answered 409), but its
         * verdict keeps it apart: 'notlawn-approved' / 'notlawn-rejected', so
         * nothing that reads status = 'approved' as a lawn map ever reads one
         * as "this lot has no lawn".
         */
        `UPDATE corpus
            SET status = CASE WHEN status LIKE 'notlawn%' THEN 'notlawn-' || ?2 ELSE ?2 END,
                reviewed_at = ?3, reviewed_by = ?4,
                review_note = ?5, review_queue = ?6, tree_line = ?7,
                /*
                 * COALESCE so a later review cannot un-check a map: the
                 * question "has anybody looked for inferred areas here" is
                 * answered once and stays answered. Sending nothing leaves
                 * whatever was there, which is what every existing caller
                 * does without changing a line.
                 */
                inferred_checked_at = COALESCE(?9, inferred_checked_at)
          WHERE id = ?1 AND (?8 = 1 OR status = 'new' OR status = ?2
                             OR status = 'notlawn' OR status = 'notlawn-' || ?2)`
      ).bind(
        id, status, new Date().toISOString(), me.email,
        typeof body?.note === 'string' ? body.note.slice(0, 300) : null,
        queue, canopy, force ? 1 : 0,
        body?.inferredChecked === true ? new Date().toISOString() : null
      ).run();

      /*
       * `status = 'new'` in the WHERE, so a double tap on a slow connection
       * cannot overwrite the first verdict with a second one -- and a row that
       * was re-finished between loading and judging is not silently approved
       * in a shape nobody looked at.
       *
       * `OR status = ?2` lets a verdict be RE-AFFIRMED, which is what grading
       * an already-approved row is: same status in, same status out, and only
       * the grade moves. It does not let one verdict become another, because
       * an approved row sent `rejected` matches neither branch. That is the
       * distinction the guard was always about -- not "write once", but "do
       * not let a stale tap change somebody's mind for them".
       *
       * `force` is the deliberate version of exactly that, and it is a
       * separate flag rather than a loosened guard so the default stays safe:
       * every existing caller keeps the old behaviour without changing a line.
       */
      if (!res.meta?.changes) {
        return json({ ok: false, reason: 'already-reviewed-or-changed' }, 409, origin);
      }
      return json({ ok: true }, 200, origin);
    } catch (e) {
      return json({ error: String(e?.message || e).slice(0, 200) }, 500, origin);
    }
  }

  if (path === 'settings') {
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

      const rejected = [];
      for (const [key, value] of Object.entries(body || {})) {
        if (!LIMITS[key]) { rejected.push(key); continue; }
        // `null` clears the row and goes back to the deployment's own number.
        // It has to be expressible, or a mistyped value can only be replaced
        // by remembering what was there before it.
        if (!(await setLimit(env, key, value, me.email))) rejected.push(key);
      }
      if (rejected.length) {
        return json({ error: `not a number, or not a setting: ${rejected.join(', ')}` }, 400, origin);
      }
    }

    return json({ settings: await limitsForConsole(env) }, 200, origin);
  }

  /* -------------------------------------------------------------- people */
  if (path === 'users') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();

    /*
     * BINDING THE VALUE IS NOT ENOUGH FOR A LIKE.
     *
     * A bound parameter cannot become SQL -- that part is safe and was never
     * in question. But `%` and `_` are wildcards INSIDE a LIKE pattern
     * wherever they come from, so a search for "%" matched every account and a
     * search for "a_b" matched "axb". Not an injection; just a search box that
     * quietly does something other than search, which is the kind of thing
     * that is noticed as "the filter is broken" long after it stops mattering.
     *
     * So the metacharacters are escaped and the escape is declared. The
     * backslash has to go first, or escaping the others would re-escape it.
     */
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

    const tier = (await limits(env)).free_daily;

    const { results } = await env.DB.prepare(
      `SELECT u.*,
              a.day dayk, a.used dayused, a.daily_limit ownlimit,
              (SELECT COUNT(*) FROM maps m WHERE m.user_id = u.id) maps,
              (SELECT COALESCE(SUM(units), 0) FROM ledger l
                WHERE l.user_id = u.id AND l.reason = 'detect') passes
       FROM users u
       LEFT JOIN allowances a ON a.user_id = u.id
       WHERE ? = ''
          OR lower(u.email) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(u.name, '')) LIKE ? ESCAPE '\\'
       ORDER BY u.last_seen_at DESC NULLS LAST LIMIT 100`
    ).bind(q, like, like).all();

    const today = dayKey();

    return json({
      users: results.map((u) => ({
        ...publicUser(u, {
          // A row from a previous day is an unspent day, not yesterday's
          // count -- the same rule the charge applies, so the console and the
          // detection cannot disagree about whether it is tomorrow yet.
          used: u.dayk === today ? Math.max(0, u.dayused || 0) : 0,
          limit: u.ownlimit === null || u.ownlimit === undefined ? tier : u.ownlimit,
        }),
        // The console needs the true balance even for an unlimited account --
        // publicUser hides it, correctly, from the account's own owner.
        rawCredits: u.credits,
        // null means "whatever the free tier is", which is not the same as a
        // hand-set limit that happens to equal it: the second one also means
        // somebody vouched for this account. See allowance.js.
        dailyLimit: u.ownlimit === null || u.ownlimit === undefined ? null : u.ownlimit,
        role: u.role,
        maps: u.maps,
        passes: u.passes,
        createdAt: u.created_at,
        lastSeenAt: u.last_seen_at,
      })),
      tier,
    }, 200, origin);
  }

  /* ----------------------------------------------------- one account's history */
  if (path === 'ledger') {
    const id = url.searchParams.get('user');
    if (!id) return json({ error: 'user required' }, 400, origin);
    const { results } = await env.DB.prepare(
      'SELECT delta, units, reason, detail, at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 200'
    ).bind(id).all();
    return json({ entries: results }, 200, origin);
  }

  /* -------------------------------------------------------------- changes */
  if (path === 'user') {
    if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

    const id = String(body.id || '');
    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!target) return json({ error: 'no such account' }, 404, origin);

    /*
     * YOU CANNOT TAKE YOUR OWN ADMIN AWAY.
     *
     * Recoverable in principle -- ADMIN_EMAILS re-grants it at the next sign-in
     * -- but only if the address is still listed there, and finding that out
     * while locked out of the console is not a thing to discover. The guard
     * costs a line.
     */
    if (id === me.id && body.role && body.role !== 'admin') {
      return json({ error: 'You cannot remove your own administrator access.' }, 400, origin);
    }

    if (Number.isFinite(Number(body.grant)) && Number(body.grant) !== 0) {
      await grantCredits(env, id, Number(body.grant), body.note || `by ${me.email}`);
    }
    if (body.role === 'admin' || body.role === 'user') {
      await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, id).run();
    }
    if (typeof body.unlimited === 'boolean') {
      await env.DB.prepare('UPDATE users SET unlimited = ? WHERE id = ?')
        .bind(body.unlimited ? 1 : 0, id).run();
    }

    /*
     * This account's own daily allowance, and the door in the address ceiling.
     *
     * Setting one is also how an account is VOUCHED FOR: an office of eight
     * people behind one IP is indistinguishable from eight accounts made by
     * one person, and no rule will ever separate them -- so a person does,
     * here, in four seconds. A vouched account stops being counted against the
     * shared address. See allowance.js.
     *
     * `null` clears it and puts the account back on the free tier, which also
     * un-vouches it. Both directions have to be reachable or the console can
     * only ever make exceptions, never end one.
     */
    if ('dailyLimit' in body) {
      const raw = body.dailyLimit;
      const clear = raw === null || raw === '';
      if (!clear && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
        return json({ error: 'A daily limit is a number of passes, or blank.' }, 400, origin);
      }
      await setDailyLimit(env, id, clear ? null : Number(raw));
    }

    const after = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    const own = await env.DB.prepare('SELECT day, used, daily_limit FROM allowances WHERE user_id = ?')
      .bind(id).first();
    const tier = (await limits(env)).free_daily;

    return json({
      user: {
        ...publicUser(after, {
          used: own && own.day === dayKey() ? Math.max(0, own.used) : 0,
          limit: own && own.daily_limit !== null && own.daily_limit !== undefined
            ? own.daily_limit : tier,
        }),
        rawCredits: after.credits,
        dailyLimit: own && own.daily_limit !== null && own.daily_limit !== undefined
          ? own.daily_limit : null,
        role: after.role,
      },
    }, 200, origin);
  }

  /* --------------------------------------------------- the logs, session-gated */
  if (path === 'log') {
    /*
     * Read because this person is an administrator, not because a shared
     * token happens to exist. `logging` still says whether anything is being
     * recorded, so an empty list is distinguishable from a switched-off one.
     */
    if (!loggingEnabled(env)) return json({ entries: [], logging: false }, 200, origin);
    return json({ ...(await logEntries(env, 200)), logging: true }, 200, origin);
  }

  /* -------------------------------------- counties people asked for in vain */
  /*
   * WHICH COUNTY TO ADD NEXT, answered with evidence instead of a hunch.
   *
   * Counties get added because somebody noticed a server existed, which
   * selects for the ones that are easy rather than the ones anybody wants.
   * This is the other half: every address typed into the bar that came back
   * with no boundary, ranked.
   *
   * Sorted in SQL rather than in the console because the list is cut to a
   * limit -- re-sorting a truncated page in the browser gives the top fifty by
   * one measure arranged by the other, which looks right and is not.
   */
  /* ------------------------------------------ every map, in one list */
  /*
   * WHAT IS ACTUALLY IN THE CORPUS, which the review queues cannot show.
   *
   * The queues are for deciding one map at a time and are right to be. They
   * cannot answer "is this lawn in here twice", and that question turned out
   * to matter: a re-save whose id no longer matched its own coordinates wrote
   * a SECOND row for the same garden, one copy carrying the reviewer's
   * inferred marks and one not. Leave-one-out then trains on one copy and
   * tests on its twin and reports a number the model has not earned.
   *
   * That bug is fixed. This exists because the next one of its kind should be
   * visible without a workflow run and a log -- the owner of this site has a
   * phone, not a database client.
   *
   * NEIGHBOURS GROUPED, NOT MERGED. Rows within about eleven metres of each
   * other are listed together and left for a person to judge. A frame centre
   * is the middle of a property, so two houses are rarely that close -- but
   * "rarely" is not "never", and deciding automatically that two rows are one
   * lawn is exactly the kind of silent correctness this file avoids.
   */
  if (path === 'maps') {
    try {
      const { results = [] } = await env.DB.prepare(
        /*
         * `review_queue` and `tree_line` are here to be SENT BACK, not shown.
         * A verdict from this page goes through the same review route as one
         * from the console, and that route writes both columns outright -- so
         * a page that does not know them rejects a map and silently erases
         * which draw surfaced it and how much canopy somebody graded it at.
         */
        `SELECT id, county, status, square_feet, at, reviewed_at,
                inferred_checked_at, image_key, lng, lat, model, mode, shapes,
                review_queue, tree_line, lot_no
           FROM corpus ORDER BY at DESC LIMIT 500`
      ).all();

      const maps = results.map((r) => {
        /* Counted here rather than shipped: shapes can be ninety kilobytes a
           row, and this page wants two numbers from them. */
        let pieces = 0;
        let marked = 0;
        try {
          for (const f of JSON.parse(r.shapes || '[]')) {
            pieces++;
            if (f?.properties?.inferred) marked++;
          }
        } catch { /* A row that will not parse still belongs in the list. */ }
        return {
          id: r.id,
          name: mapName(r.id, r.lot_no),
          county: r.county,
          status: r.status,
          squareFeet: r.square_feet,
          at: r.at,
          reviewedAt: r.reviewed_at,
          checked: Boolean(r.inferred_checked_at),
          hasImage: Boolean(r.image_key),
          lng: r.lng,
          lat: r.lat,
          method: `${r.model || 'by hand'} / ${r.mode || '-'}`,
          pieces,
          marked,
          reviewQueue: r.review_queue,
          canopy: r.tree_line,
        };
      });

      /*
       * Four decimal places is about eleven metres. Two rows in the same cell
       * are near-certainly the same lawn; the page shows them together and a
       * person decides.
       */
      const cells = new Map();
      for (const m of maps) {
        const key = `${Number(m.lng).toFixed(4)},${Number(m.lat).toFixed(4)}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(m.id);
      }
      const duplicates = [...cells.values()].filter((ids) => ids.length > 1);

      return json({ maps, duplicates }, 200, origin);
    } catch (e) {
      return json({ error: String(e?.message || e).slice(0, 200) }, 500, origin);
    }
  }

  if (path === 'parcel-gaps') {
    return json(await parcelGaps(env, {
      sort: url.searchParams.get('sort') || 'hits',
      limit: url.searchParams.get('limit') || 50,
    }), 200, origin);
  }

  /*
   * THE NIGHTLY COUNTY SEARCH, county by county (owner, 2026-10-03): what the
   * search for parcel lines and for local photos found for each county people
   * asked for, and why it failed where it did. Written by workflow 27.
   */
  if (path === 'county-search') {
    try {
      const rows = (await env.DB.prepare(
        `SELECT fips, kind, county, state, people, status, reason, detail, checked_at
           FROM county_search ORDER BY people DESC, county, kind LIMIT 400`
      ).all()).results || [];
      const byCounty = new Map();
      for (const r of rows) {
        const c = byCounty.get(r.fips) || { fips: r.fips, county: r.county, state: r.state, people: r.people };
        c[r.kind] = { status: r.status, reason: r.reason, detail: r.detail, at: r.checked_at };
        byCounty.set(r.fips, c);
      }
      return json({ counties: [...byCounty.values()] }, 200, origin);
    } catch (e) {
      return json({ counties: [], unavailable: String(e?.message || e).slice(0, 120) }, 200, origin);
    }
  }

  if (path === 'feedback') {
    if (!feedbackEnabled(env)) return json({ entries: [], enabled: false }, 200, origin);
    return json({ ...(await feedbackEntries(env, 100)), enabled: true }, 200, origin);
  }

  return hidden(json, origin);
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
