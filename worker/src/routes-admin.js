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

import { currentUser } from './auth.js';
import {
  accountsEnabled, grantCredits, publicUser, setDailyLimit, dayKey,
} from './db.js';
import { limits, limitsForConsole, setLimit, LIMITS } from './limits.js';
import { logEntries, loggingEnabled } from './testlog.js';
import { feedbackEntries, feedbackEnabled } from './feedback.js';
import { corpusGaps, candidateScore } from './corpus.js';
import { parcelGaps } from './gaps.js';

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
      env.DB.prepare(
        `SELECT COUNT(*) presses, COALESCE(SUM(units), 0) passes FROM ledger
         WHERE reason = 'detect' AND at >= ?`
      ).bind(daysAgo(1)).first(),
      env.DB.prepare(
        `SELECT COUNT(*) presses, COALESCE(SUM(units), 0) passes FROM ledger
         WHERE reason = 'detect' AND at >= ?`
      ).bind(daysAgo(7)).first(),
      env.DB.prepare(
        `SELECT COUNT(*) presses, COALESCE(SUM(units), 0) passes FROM ledger
         WHERE reason = 'detect' AND at >= ?`
      ).bind(daysAgo(30)).first(),
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
    const { results: daily } = await env.DB.prepare(
      `SELECT substr(at, 1, 10) day, COUNT(*) presses, COALESCE(SUM(units), 0) passes
       FROM ledger WHERE reason = 'detect' AND at >= ?
       GROUP BY day ORDER BY day DESC LIMIT 30`
    ).bind(daysAgo(30)).all();

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
      ]);
      const asked = url.searchParams.get('queue');
      const wanted = QUEUES.has(asked) ? asked : 'priority';
      const status = wanted === 'rejected' ? 'rejected'
        : (wanted === 'ungraded' || wanted === 'unflagged' || wanted === 'approved')
          ? 'approved'
          : 'new';
      /* Browsing is chronological; the queues are ranked. Different jobs. */
      const browsing = wanted === 'approved' || wanted === 'rejected';
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
            WHERE c.status = '${status}'
              ${wanted === 'ungraded' ? 'AND c.tree_line IS NULL' : ''}
              ${wanted === 'unflagged' ? 'AND c.inferred_checked_at IS NULL' : ''}
            ORDER BY ${wanted === 'random' ? 'RANDOM()'
              : browsing ? 'COALESCE(c.reviewed_at, c.at) DESC' : 'c.at DESC'}
            LIMIT ${wanted === 'random' ? 1 : 40}`
        ).all(),
      ]);

      const queue = (rows.results || [])
        .map((r) => ({ row: r, ...candidateScore(r, approved) }))
        /* Stable: equal scores keep the ORDER BY above rather than jittering. */
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(({ row: r, score, why }) => ({
          id: r.id,
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
          canopy: r.tree_line === null || r.tree_line === undefined ? null : Number(r.tree_line),
          parcelSource: r.parcel_source,
          squareFeet: r.square_feet,
          detectedSqFt: r.detected_sq_ft,
          parcelSqFt: r.parcel_sq_ft,
          hasImage: Boolean(r.image_key),
          frame: r.frame ? JSON.parse(r.frame) : null,
          parcel: r.parcel ? JSON.parse(r.parcel) : null,
          shapes: JSON.parse(r.shapes || '[]'),
          detectedShapes: r.detected_shapes ? JSON.parse(r.detected_shapes) : null,
        }));

      const waiting = await env.DB.prepare(
        `SELECT COUNT(*) n FROM corpus WHERE status = 'new'`
      ).first();

      return json({ queue: wanted, waiting: waiting.n, candidates: queue }, 200, origin);
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
        provider: row.provider,
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
  if (path === 'review') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, origin);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

    const status = ['approved', 'rejected'].includes(body?.status) ? body.status : null;
    const id = typeof body?.id === 'string' ? body.id : null;
    if (!status || !id) return json({ error: 'Need an id and a verdict' }, 400, origin);
    const queue = body?.queue === 'random' ? 'random'
      : body?.queue === 'ungraded' ? 'ungraded' : 'priority';
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
        `UPDATE corpus
            SET status = ?2, reviewed_at = ?3, reviewed_by = ?4,
                review_note = ?5, review_queue = ?6, tree_line = ?7,
                /*
                 * COALESCE so a later review cannot un-check a map: the
                 * question "has anybody looked for inferred areas here" is
                 * answered once and stays answered. Sending nothing leaves
                 * whatever was there, which is what every existing caller
                 * does without changing a line.
                 */
                inferred_checked_at = COALESCE(?9, inferred_checked_at)
          WHERE id = ?1 AND (?8 = 1 OR status = 'new' OR status = ?2)`
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
        `SELECT id, county, status, square_feet, at, reviewed_at,
                inferred_checked_at, image_key, lng, lat, model, mode, shapes
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

  if (path === 'feedback') {
    if (!feedbackEnabled(env)) return json({ entries: [], enabled: false }, 200, origin);
    return json({ ...(await feedbackEntries(env, 100)), enabled: true }, 200, origin);
  }

  return hidden(json, origin);
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
