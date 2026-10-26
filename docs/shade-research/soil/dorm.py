import json, os, glob, statistics as st, datetime as dt
def doy(ymd): return (dt.date(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:])) - dt.date(2025, 1, 1)).days
def series(days):   # {ymd: C} -> list of 365 (None where missing)
    a = [None] * 365
    for k, v in days.items():
        i = doy(k)
        if 0 <= i < 365: a[i] = v
    return a
def trail5(a):
    out = [None] * 365
    for i in range(4, 365):
        w = a[i - 4:i + 1]
        if all(v is not None for v in w): out[i] = sum(w) / 5
    return out
def dormancy(a, limit):
    m = trail5(a)
    vals = [(v, i) for i, v in enumerate(m) if v is not None]
    if not vals: return None
    peak = max(vals)[1]
    for i in range(peak + 1, 365):
        if m[i] is not None and m[i] < limit: return i
    return None
rows = []
for f in sorted(glob.glob('all/crn-*.txt')):
    s = f[len('all/crn-'):-4]
    if not os.path.exists(f'all/ie-{s}.json') or not os.path.exists(f'all/pw-{s}.json'): continue
    m5, m10 = {}, {}
    for ln in open(f):
        c = ln.split()
        if float(c[23]) > -99: m5[c[1]] = float(c[23])
        if float(c[24]) > -99: m10[c[1]] = float(c[24])
    try:
        ie = json.load(open(f'all/ie-{s}.json'))['data']
    except Exception: continue
    iem = {d['date'].replace('-', ''): ((d['soil4t_high_f'] + d['soil4t_low_f']) / 2 - 32) / 1.8 for d in ie if d.get('soil4t_high_f') is not None and d.get('soil4t_low_f') is not None}
    pw = json.load(open(f'all/pw-{s}.json'))['properties']['parameter']['TSOIL1']
    nasa = {k: v for k, v in pw.items() if v > -90}
    meas = {k: (m5[k] + m10[k]) / 2 for k in m5 if k in m10}
    r = {'st': s}
    for name, src in (('iemre', iem), ('nasa', nasa)):
        d = [src[k] - meas[k] for k in meas if k in src]
        if len(d) > 250: r[name] = (st.mean(d), st.mean(abs(x) for x in d))
    for lim, lab in ((7, 'cool'), (13, 'warm')):
        dm = dormancy(series(meas), lim)
        if dm is None: continue
        for name, src in (('iemre', iem), ('nasa', nasa)):
            dd = dormancy(series(src), lim)
            if dd is not None: r[f'{name}_{lab}'] = dd - dm
    rows.append(r)
json.dump(rows, open('dorm-rows.json', 'w'))
def summ(key):
    v = [r[key] for r in rows if key in r]
    if not v: return 'none'
    if isinstance(v[0], (list, tuple)): return f"bias {st.mean(x[0] for x in v):+.2f} C, mean abs {st.mean(x[1] for x in v):.2f} C, n={len(v)}"
    return f"mean {st.mean(v):+.1f} d, median abs {st.median(abs(x) for x in v):.0f} d, within 7 d {sum(abs(x) <= 7 for x in v)}/{len(v)}"
print('stations', len(rows))
for k in ('iemre', 'nasa', 'iemre_cool', 'nasa_cool', 'iemre_warm', 'nasa_warm'): print(k, summ(k))
bad = sorted(((r['st'], r['iemre'][1]) for r in rows if 'iemre' in r), key=lambda x: -x[1])[:6]
print('IEMRE worst stations (mean abs C):', bad)
