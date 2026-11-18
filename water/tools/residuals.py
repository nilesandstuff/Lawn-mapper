"""
WHERE THE SURFACE MODEL COMES SHORT, FROM EVERY SCORED SQUARE (owner, 2026-11-18: "come up with a way to actually
track the trends in how the model is different from the measurements. Like, some advanced data analytics that can
actually help us pin down the things we need to change... because the model is so complex, we need an equally complex
way to extrapolate where the model is coming short").

Reads what tools/residuals.mjs writes: each thermal walk's squares, measured, both predictions (the walker's air; the
live map's own), what went into them, and how far each of the model's knobs would move each (lib/residuals.js). Six
ways in, each answering a different question, then a summary at the end (the part a phone reads):

  1. per walk                  how far off, on each walk, both ways
  2. how the error splits      a per-walk offset (the weather given: air, cloud) against the spread within a lot
  3. trends                    which factor the error follows within a lot, and whether every walk agrees
  4. the knobs                 which change to the physics, the same everywhere, best explains the error within lots,
                               alone and together, with a range, and tested on a walk the fit did not see
  5. a learned model           gradient-boosted trees on the factors, fitted on all walks but one and tested on that
                               one: how much of the error the factors can explain at all, and which ones carry it
  6. in space                  whether neighbouring squares are off alike, and to what distance: something at that
                               scale is missing from the model

Numbers only: no place. Temperatures in F. A walk is one lot at one time; with few walks every "held out" number is
a small sample and is said so.

  python3 water/tools/residuals.py residuals.json
"""
import json
import sys

import numpy as np

F = 1.8
FEATS = ['pred', 'el', 'ghi', 'cloud', 'ta', 'wind', 'rh', 'beam', 'sky', 'shelter', 'canopy', 'edge', 'pavingM', 'swNet', 'ra',
         'beta', 'fence', 'paving', 'air', 'u2', 't1', 'lambda1', 'sand', 'clay', 'rootCm', 'full', 'min']
WORDS = {
    'pred': 'the model\'s own prediction (a trend here: its range too narrow or too wide)', 'el': 'sun height', 'ghi': 'sunshine',
    'cloud': 'cloud', 'ta': 'air temperature', 'wind': 'open wind', 'rh': 'humidity', 'beam': 'direct sun reaching the grass',
    'sky': 'sky the grass sees', 'shelter': 'shelter from wind', 'canopy': 'tree canopy over it', 'edge': 'the edge-heat factor',
    'pavingM': 'distance from paving', 'swNet': 'sunshine absorbed', 'ra': 'air resistance (stillness)', 'beta': 'evaporation share',
    'fence': 'fence heat', 'paving': 'paving heat in the model', 'air': 'trees\' cooling of the air', 'u2': 'wind at the grass',
    't1': 'top soil layer temperature', 'lambda1': 'top soil conductivity', 'sand': 'sand %', 'clay': 'clay %',
    'rootCm': 'root depth', 'full': 'root-zone water', 'min': 'minutes into the walk'}


def spearman(a, b):
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 8 or np.std(a[ok]) == 0 or np.std(b[ok]) == 0:
        return np.nan
    ra = np.argsort(np.argsort(a[ok])).astype(float)
    rb = np.argsort(np.argsort(b[ok])).astype(float)
    return float(np.corrcoef(ra, rb)[0, 1])


def blocks_of(x, y, size=4.0):
    return (np.floor(x / size) * 100003 + np.floor(y / size)).astype(np.int64)


def main(path):
    D = json.load(open(path))
    walks = D['walks']
    knobs = list(D['knobs'].keys())
    print('=====')
    print(f"RESIDUAL ANALYSIS  {D['model']}  {len(walks)} walks with squares kept"
          + (f", {D['unscored']} not yet re-scored with them" if D.get('unscored') else ''))
    if not walks:
        print('No squares kept yet: the walks are re-scored with them within the hour after a deploy.')
        return
    # one table
    rows, wid = [], []
    for k, w in enumerate(walks):
        cols = w['cols']
        a = np.array([[np.nan if v is None else v for v in r] for r in w['rows']], dtype=float)
        rows.append({c: a[:, j] for j, c in enumerate(cols)})
        wid.append(np.full(len(a), k))
    T = {c: np.concatenate([r.get(c, np.full(len(r['meas']), np.nan)) for r in rows]) for c in set().union(*[r.keys() for r in rows])}
    g = np.concatenate(wid)
    names = [w['name'] for w in walks]
    rA = T['meas'] - T['pred']          # on the walker's air
    rB = T['meas'] - T['predSt']        # the live map's own
    ok = np.isfinite(rA)
    W = len(walks)

    # 1. PER WALK
    print('=====')
    print('1. PER WALK (measured minus modelled, F)')
    for k, n in enumerate(names):
        m = (g == k) & ok
        b = m & np.isfinite(rB)
        sun = np.nanmean(T['beam'][m] >= 0.5) if m.any() else np.nan
        print(f"  {n} (property {walks[k]['property']}): {m.sum()} squares, sun {sun:.0%}  |  walker's air: mean {F*np.mean(rA[m]):+.1f}, RMS {F*np.sqrt(np.mean(rA[m]**2)):.1f}"
              f"  |  live map: mean {F*np.mean(rB[b]):+.1f}, RMS {F*np.sqrt(np.mean(rB[b]**2)):.1f}")

    # 2. HOW THE ERROR SPLITS
    print('=====')
    print('2. HOW THE ERROR SPLITS: a per-walk offset (the weather given) against the spread within a lot')
    wm = np.array([np.mean(rA[(g == k) & ok]) for k in range(W)])
    e = rA - wm[g]                      # within-lot residual: what the physics and the maps must explain
    for lab, r in (('walker\'s air', rA), ('live map', rB)):
        okr = np.isfinite(r)
        mk = np.array([np.mean(r[(g == k) & okr]) for k in range(W)])
        tot = np.mean(r[okr] ** 2)
        between = np.mean(mk[g[okr]] ** 2)
        print(f"  {lab}: mean square {F*F*tot:.1f} F2 = per-walk offsets {between/tot:.0%} + within lots {1-between/tot:.0%}")
    within_rms = np.sqrt(np.mean(e[ok] ** 2))
    print(f"  within lots, on the walker's air: RMS {F*within_rms:.1f} F; this is what sections 3-6 try to explain")

    # 3. TRENDS
    print('=====')
    print('3. TRENDS WITHIN LOTS: Spearman rank of the residual with each factor, per walk; and the residual by fifths of it')
    trend = []
    for c in FEATS:
        x = T.get(c)
        if x is None:
            continue
        rhos, ns = [], []
        for k in range(W):
            m = (g == k) & ok & np.isfinite(x)
            rho = spearman(x[m], e[m])
            if np.isfinite(rho):
                rhos.append(rho); ns.append(m.sum())
        if not rhos:
            continue
        wr = float(np.average(rhos, weights=ns))
        agree = sum(1 for r in rhos if np.sign(r) == np.sign(wr) and abs(r) >= 0.1)
        m = ok & np.isfinite(x)
        q = np.nanquantile(x[m], [0, .2, .4, .6, .8, 1])
        fifths = []
        for j in range(5):
            mm = m & (x >= q[j]) & ((x <= q[j + 1]) if j == 4 else (x < q[j + 1]))
            fifths.append(F * np.mean(e[mm]) if mm.sum() >= 10 else np.nan)
        trend.append((abs(wr), c, wr, agree, len(rhos), fifths, q))
    trend.sort(reverse=True)
    for _, c, wr, agree, nw, fifths, q in trend[:12]:
        fs = ' '.join('  -  ' if not np.isfinite(v) else f'{v:+.1f}' for v in fifths)
        print(f"  {c:8s} rho {wr:+.2f}, {agree}/{nw} walks agree  | low to high fifths: {fs}  ({q[0]:.3g} to {q[-1]:.3g})  {WORDS.get(c, '')}")

    # 4. THE KNOBS
    print('=====')
    print('4. THE KNOBS: what change to the physics, the same everywhere, explains the error within lots')
    J = {q: T.get(f'J_{q}') for q in knobs if T.get(f'J_{q}') is not None}
    Jc = {q: v - np.array([np.nanmean(v[g == k]) for k in range(W)])[g] for q, v in J.items()}
    blocks = blocks_of(np.nan_to_num(T['x']), np.nan_to_num(T['y'])) * 16 + g
    rng = np.random.default_rng(1)

    def fit1(x, y):
        d = np.sum(x * x)
        return float(np.sum(x * y) / d) if d > 1e-9 else np.nan

    def boot(fn, reps=300):
        ub = np.unique(blocks[ok])
        out = []
        for _ in range(reps):
            pick = rng.choice(ub, len(ub))
            idx = np.concatenate([np.where((blocks == b) & ok)[0] for b in pick])
            out.append(fn(idx))
        return np.nanpercentile(np.array(out, dtype=float), [5, 95], axis=0)

    def lowo(fn_fit, fn_pred):
        """held out, walk by walk: RMS of the within-lot residual before and after the fitted change"""
        if W < 2:
            return np.nan
        before, after = [], []
        for k in range(W):
            tr, te = ok & (g != k), ok & (g == k)
            p = fn_fit(np.where(tr)[0])
            before.append(np.mean(e[te] ** 2)); after.append(np.mean((e[te] - fn_pred(p, np.where(te)[0])) ** 2))
        return 1 - np.sqrt(np.mean(after)) / np.sqrt(np.mean(before))

    single = []
    print('  ALONE (each knob by itself: the implied change in nudges, its 90% range resampling 4 m blocks, how much of the')
    print('  within-lot error it explains, and by how much it cuts the error on each walk when fitted on the others):')
    for q, x in Jc.items():
        if np.nanstd(x[ok]) < 1e-4:
            continue
        a = fit1(x[ok], e[ok])
        lo, hi = boot(lambda idx: fit1(x[idx], e[idx]))
        gain = lowo(lambda idx: fit1(x[idx], e[idx]), lambda p, idx: p * x[idx])
        explained = 1 - np.mean((e[ok] - a * x[ok]) ** 2) / np.mean(e[ok] ** 2)
        single.append((gain if np.isfinite(gain) else -1, q, a, lo, hi, explained, gain))
    single.sort(reverse=True)
    for _, q, a, lo, hi, ex, gain in single:
        print(f"    {q:8s} x{a:+6.2f} nudges [{lo:+.2f}, {hi:+.2f}]  explains {ex:5.1%} within lots, cuts a walk it did not see by {gain:+.1%}  -- {D['knobs'][q]}")
    # together (ridge, its strength chosen held out)
    use = [q for q in Jc if np.nanstd(Jc[q][ok]) >= 1e-4]
    X = np.column_stack([Jc[q] for q in use]) if use else np.zeros((len(e), 0))
    scale = X[ok].std(axis=0) + 1e-9 if use else None

    def ridge(idx, lam):
        A = X[idx] / scale
        return np.linalg.solve(A.T @ A + lam * len(idx) * np.eye(A.shape[1]), A.T @ e[idx]) / scale

    best = None
    if use:
        for lam in [1e-4, 1e-3, 1e-2, 0.03, 0.1, 0.3, 1.0]:
            gain = lowo(lambda idx: ridge(idx, lam), lambda p, idx: X[idx] @ p)
            if best is None or (np.isfinite(gain) and gain > best[0]):
                best = (gain, lam)
        lam = best[1]
        coef = ridge(np.where(ok)[0], lam)
        lohi = boot(lambda idx: ridge(idx, lam), reps=200)
        ex = 1 - np.mean((e[ok] - X[ok] @ coef) ** 2) / np.mean(e[ok] ** 2)
        print(f"  TOGETHER (ridge, strength {lam:g} chosen held out): explains {ex:.1%} within lots; cuts a walk it did not see by {best[0]:+.1%} (RMS within lots)")
        order = np.argsort(-np.abs(coef * scale))
        for j in order:
            print(f"    {use[j]:8s} x{coef[j]:+6.2f} nudges [{lohi[0][j]:+.2f}, {lohi[1][j]:+.2f}]  -- {D['knobs'][use[j]]}")
        cc = np.corrcoef((X[ok] / scale).T) if len(use) > 1 else np.eye(1)
        pairs = [(abs(cc[i, j]), use[i], use[j]) for i in range(len(use)) for j in range(i + 1, len(use)) if abs(cc[i, j]) > 0.9]
        if pairs:
            print('    knobs that move squares almost alike (cannot be told apart by these walks): ' + ', '.join(f'{a}~{b} ({r:.2f})' for r, a, b in sorted(pairs, reverse=True)[:6]))
    print('  (a "nudge" is the step named on each line: x-1.5 on "sunshine absorbed +10%" means the data want 15% less)')

    # 5. A LEARNED MODEL
    print('=====')
    print('5. A LEARNED MODEL OF THE ERROR (gradient-boosted trees on the factors; fitted on all walks but one, tested on it)')
    feats = [c for c in FEATS if c in T and np.isfinite(T[c][ok]).sum() > 0 and np.nanstd(T[c][ok]) > 0]
    Xf = np.column_stack([T[c] for c in feats])
    gbm_summary = []
    try:
        from sklearn.ensemble import HistGradientBoostingRegressor
        from sklearn.inspection import permutation_importance
        mk = lambda: HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=250, l2_regularization=1.0, min_samples_leaf=30, random_state=0)
        if W >= 2:
            pred_oof = np.full(len(e), np.nan)
            imps = np.zeros(len(feats))
            for k in range(W):
                tr, te = ok & (g != k), ok & (g == k)
                mdl = mk().fit(Xf[tr], e[tr])
                pred_oof[te] = mdl.predict(Xf[te])
                pi = permutation_importance(mdl, Xf[te], e[te], n_repeats=5, random_state=0, scoring='neg_mean_squared_error')
                imps += pi.importances_mean * te.sum()
            imps /= ok.sum()
            r2 = 1 - np.mean((e[ok] - pred_oof[ok]) ** 2) / np.mean(e[ok] ** 2)
            print(f"  held out walk by walk: explains {r2:+.1%} of the within-lot error (below 0: what it learned on one lot does not carry to another)")
            for k in range(W):
                m = ok & (g == k)
                print(f"    {names[k]} held out: {1 - np.mean((e[m] - pred_oof[m]) ** 2) / np.mean(e[m] ** 2):+.1%}")
            full = mk().fit(Xf[ok], e[ok])
            order = np.argsort(-imps)
            print('  the factors it leaned on, on walks it had not seen (rise in mean square error when shuffled, F2), and which way:')
            for j in order[:8]:
                if imps[j] <= 0:
                    continue
                x = Xf[ok, j]
                qs = np.nanquantile(x, [0.1, 0.5, 0.9])
                eff = []
                for qv in qs:
                    Z = Xf[ok].copy(); Z[:, j] = qv
                    eff.append(F * np.mean(full.predict(Z)))
                gbm_summary.append((feats[j], imps[j], eff, qs))
                print(f"    {feats[j]:8s} {F*F*imps[j]:.2f}  | at its 10th/50th/90th percentile ({qs[0]:.3g}/{qs[1]:.3g}/{qs[2]:.3g}) the error is {eff[0]:+.1f}/{eff[1]:+.1f}/{eff[2]:+.1f} F  {WORDS.get(feats[j], '')}")
        else:
            print('  one walk: nothing to hold out yet')
    except ImportError:
        print('  scikit-learn is not installed here')

    # 6. IN SPACE
    print('=====')
    print('6. IN SPACE: how alike the errors of two squares are by the distance between them (correlation, within lots)')
    bins = [(0.5, 1), (1, 2), (2, 4), (4, 8), (8, 16)]
    res_after = e - (X @ coef if use else 0)
    reach = {}
    for lab, r in (('as scored', e), ('after the knobs', res_after)):
        cors = []
        for lo, hi in bins:
            num, den, n = 0.0, 0.0, 0
            for k in range(W):
                m = np.where(ok & (g == k))[0]
                if len(m) < 20:
                    continue
                i = rng.choice(m, min(len(m) * 40, 60000)); j = rng.choice(m, len(i))
                d = np.hypot(T['x'][i] - T['x'][j], T['y'][i] - T['y'][j])
                s = (d >= lo) & (d < hi) & (i != j)
                rr = r[m]; mu = rr.mean(); sd = rr.std() or 1
                num += np.sum((r[i[s]] - mu) * (r[j[s]] - mu)) / sd / sd; n += s.sum()
            cors.append(num / n if n else np.nan)
        reach[lab] = cors
        print(f"  {lab:16s} " + '  '.join(f"{lo:g}-{hi:g} m {c:+.2f}" for (lo, hi), c in zip(bins, cors)))

    # 7. SLID
    print('=====')
    print('7. THE WALK SLID OVER THE MODEL: each walk\'s measured squares against the model\'s a few metres east and north of them')
    print('   (a clear best away from 0,0 = the walk or the map laid off by that much; flat = placement is not the trouble)')
    slid = []
    for k in range(W):
        m = np.where(ok & (g == k))[0]
        xs = np.unique(np.round(T['x'][m], 2))
        step = np.min(np.diff(xs)) if len(xs) > 1 else 1.0
        cx, cy = np.round(T['x'][m] / step).astype(int), np.round(T['y'][m] / step).astype(int)
        cells = {}
        for a, b, me, pr in zip(cx, cy, T['meas'][m], T['pred'][m]):
            c = cells.setdefault((a, b), [0.0, 0.0, 0]); c[0] += me; c[1] += pr; c[2] += 1
        meas = {c: v[0] / v[2] for c, v in cells.items()}
        pred = {c: v[1] / v[2] for c, v in cells.items()}
        lagN = int(round(4 / step))
        out = []
        for de in range(-lagN, lagN + 1):
            for dn in range(-lagN, lagN + 1):
                # the model's square de east and dn north of where the reading was laid (rows run south)
                d = np.array([meas[c] - pred[(c[0] + de, c[1] - dn)] for c in meas if (c[0] + de, c[1] - dn) in pred])
                if len(d) >= 0.5 * len(meas):
                    out.append((float(np.std(d)), de * step, dn * step, len(d)))
        if not out:
            print(f"  {names[k]}: too few squares side by side"); continue
        zero = next(o for o in out if o[1] == 0 and o[2] == 0)
        best = min(out)
        rank = sorted(out)[:3]
        gain = 1 - best[0] / zero[0]
        slid.append((names[k], best, gain))
        print(f"  {names[k]} ({len(meas)} model squares of {step:.2g} m): as laid, spread {F*zero[0]:.1f} F; best {F*best[0]:.1f} F at {best[1]:+.0f} m east, {best[2]:+.0f} m north ({gain:.0%} less)"
              f"; next best: " + ', '.join(f"{F*o[0]:.1f} at ({o[1]:+.0f}, {o[2]:+.0f})" for o in rank[1:]))

    # SUMMARY
    print('=====')
    print('WHERE THE MODEL COMES SHORT (summary)')
    sq = np.mean(rA[ok] ** 2)
    print(f"  {W} walks on {len(set(w['property'] for w in walks))} lots, {int(ok.sum())} squares. Of the error on the walker's air, {np.mean(wm[g[ok]]**2)/sq:.0%} is a per-walk offset and {1-np.mean(wm[g[ok]]**2)/sq:.0%} is spread within lots (RMS {F*within_rms:.1f} F).")
    good = [s for s in single if np.isfinite(s[6]) and s[6] > 0.01 and (s[3] > 0 or s[4] < 0)]
    if good:
        for _, q, a, lo, hi, ex, gain in good[:4]:
            print(f"  THE DATA WANT: {D['knobs'][q]} x{a:+.2f} (range {lo:+.2f} to {hi:+.2f}); on a walk it was not fitted on it cuts the within-lot error by {gain:.0%}.")
    else:
        print('  No single knob both has a range clear of zero and helps on a walk it was not fitted on.')
    if gbm_summary:
        top = ', '.join(f"{WORDS.get(c, c)} ({e3[0]:+.1f} to {e3[2]:+.1f} F from its low to high end)" for c, _, e3, _ in gbm_summary[:3])
        print(f"  THE FACTORS THE ERROR FOLLOWS (held out): {top}.")
    near = reach.get('after the knobs', [np.nan])
    far = [b for (b, c) in zip(bins, near) if np.isfinite(c) and c > 0.2]
    if far:
        print(f"  Errors stay alike out to about {far[-1][1]:g} m after the knobs: something at that scale is not in the model (a surface, a shade, a wet patch).")
    for n_, b_, g_ in slid:
        if g_ >= 0.1 and (b_[1] or b_[2]):
            print(f"  PLACEMENT: {n_} fits {g_:.0%} better slid {b_[1]:+.0f} m east, {b_[2]:+.0f} m north: the walk or the map may be laid off by about that.")
    if slid and not any(g_ >= 0.1 and (b_[1] or b_[2]) for _, b_, g_ in slid):
        print('  PLACEMENT: no walk fits much better slid over the model (under 10% each): the patches are not a simple offset.')
    print(f"  {W} walk{'s' if W != 1 else ''}: every 'held out' number above rests on {'that one' if W == 1 else 'these'}; a sunny walk and a dull one on the same lot would test it best.")


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'residuals.json')
