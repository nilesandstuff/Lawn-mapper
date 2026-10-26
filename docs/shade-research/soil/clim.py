import glob, os, statistics as st, json, datetime as dt
import numpy as np
def read(path):
    out = []
    for ln in open(path):
        c = ln.split()
        d = dt.date(int(c[1][:4]), int(c[1][4:6]), int(c[1][6:]))
        v = [float(c[i]) for i in (8, 10, 23, 24, 9)]  # air avg, sun MJ, soil 5, soil 10, rain mm
        out.append((d, [x if x > -90 else np.nan for x in v]))
    return out
names = sorted(f[len('all/crn-'):-4] for f in glob.glob('all/crn-*.txt'))
W = (7, 15, 30)
res = {w: {'5': [], '10': [], 'a': [], 'r': [], '5su': [], '10su': []} for w in W}
used = 0
for s in names:
    rows = []
    for p in sorted(glob.glob(f'yrs/{s}-*.txt')) + [f'all/crn-{s}.txt']:
        if os.path.exists(p): rows += read(p)
    if len(rows) < 2500: continue
    rows.sort(key=lambda r: r[0])
    D = np.array([r[1] for r in rows]); doy = np.array([min(364, r[0].timetuple().tm_yday - 1) for r in rows]); yr = np.array([r[0].year for r in rows])
    # climatology by day of year, smoothed +-15 days round the year
    clim = np.full((365, 5), np.nan)
    for k in range(365):
        sel = np.isin(doy, [(k + j) % 365 for j in range(-15, 16)])
        clim[k] = np.nanmean(D[sel], axis=0)
    A = D - clim[doy]
    used += 1
    for w in W:
        # non-overlapping windows within each year
        Y = []
        for y in np.unique(yr):
            idx = np.nonzero(yr == y)[0]
            for i in range(0, len(idx) - w + 1, w):
                seg = idx[i:i + w]
                a = A[seg]; raw = D[seg]
                if np.isfinite(a).sum(axis=0).min() < 0.8 * w: continue
                if np.nanmean(raw[:, 0]) < 5 or np.nanmean(raw[:, 2]) < 4: continue  # unfrozen
                Y.append([*np.nanmean(a, axis=0), doy[seg[w // 2]]])
        Y = np.array(Y)
        if len(Y) < 30: continue
        for depth, col in (('5', 2), ('10', 3)):
            for tag, m in (('', np.ones(len(Y), bool)), ('su', (Y[:, 5] >= 151) & (Y[:, 5] <= 242))):
                if m.sum() < 15: continue
                X = np.c_[np.ones(m.sum()), Y[m, 1], Y[m, 0], Y[m, 4]]
                c = np.linalg.lstsq(X, Y[m, col], rcond=None)[0]
                res[w][depth + tag].append(c[1])
                X2 = np.c_[np.ones(m.sum()), Y[m, 1], Y[m, 4]]
                c2 = np.linalg.lstsq(X2, Y[m, col], rcond=None)[0]
                res[w].setdefault('free' + depth + tag, []).append(c2[1])
                if depth == '5' and tag == '':
                    X3 = np.c_[np.ones(m.sum()), Y[m, 1], Y[m, 4]]
                    res[w].setdefault('airsun', []).append(np.linalg.lstsq(X3, Y[m, 0], rcond=None)[0][1])
                if depth == '5' and tag == '': res[w]['a'].append(c[2]); res[w]['r'].append(c[3])
print('stations used', used)
for w in W:
    r = res[w]
    q = lambda v: f"median {st.median(v):.3f} (IQR {np.percentile(v,25):.3f}..{np.percentile(v,75):.3f}, n {len(v)})"
    print(f"{w}-day windows: soil per MJ/m2/day of sun, air and rain held: 5 cm {q(r['5'])}; 10 cm {q(r['10'])}")
    print(f"   summer only: 5 cm {q(r['5su'])}; 10 cm {q(r['10su'])}; soil per C air (5 cm) {st.median(r['a']):.2f}; per mm/day rain {st.median(r['r']):.3f}")
    print(f"   AIR FREE (rain held): 5 cm {q(r['free5'])}; 10 cm {q(r['free10'])}; summer 5 cm {q(r['free5su'])}; 10 cm {q(r['free10su'])}; air per MJ {st.median(r['airsun']):.3f}")
json.dump({w: {k: list(map(float, v)) for k, v in r.items()} for w, r in res.items()}, open('clim.json', 'w'))
