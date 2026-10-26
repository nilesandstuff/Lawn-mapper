import glob, json, urllib.request, os, statistics as st, time
meta = {}
for ln in open('stations.txt', encoding='latin1').read().splitlines()[2:]:
    c = ln.split()
    if len(c) > 6: meta[int(c[0])] = (float(c[4]), float(c[5]), ' '.join(c[6:-2]))
def get(url, path):
    if not os.path.exists(path):
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'lawn-mapper research'}), timeout=120) as r: open(path, 'wb').write(r.read())
        time.sleep(0.5)
    return json.load(open(path))
rows = []
for f in sorted(glob.glob('x/produkt_*.txt')):
    sid = int(f.split('_')[-1][:-4]); lat, lon, name = meta[sid]
    meas = {}
    for ln in open(f).read().splitlines()[1:]:
        c = [x.strip() for x in ln.split(';')]
        if not c[1].startswith('2025'): continue
        t5, t10 = float(c[4]), float(c[5])
        if t5 > -99 and t10 > -99: meas[c[1]] = (t5 + t10) / 2
    if len(meas) < 300: continue
    ie = get(f'https://mesonet.agron.iastate.edu/iemre/multiday/2025-01-01/2025-12-31/{lat:.3f}/{lon:.3f}/json', f'ie-{sid}.json')
    pw = get(f'https://power.larc.nasa.gov/api/temporal/daily/point?parameters=TSOIL1&community=AG&longitude={lon:.3f}&latitude={lat:.3f}&start=20250101&end=20251231&format=JSON', f'pw-{sid}.json')['properties']['parameter']['TSOIL1']
    iem = {d['date'].replace('-', ''): ((d['soil4t_high_f'] + d['soil4t_low_f']) / 2 - 32) / 1.8 for d in ie['data'] if d.get('soil4t_high_f') is not None and d.get('soil4t_low_f') is not None}
    out = {'st': name, 'domain': ie.get('iemre_domain')}
    for nm, src in (('iemre', iem), ('nasa', {k: v for k, v in pw.items() if v > -90})):
        d = [src[k] - meas[k] for k in meas if k in src]
        w = [src[k] - meas[k] for k in meas if k in src and k[4:6] in ('12', '01', '02')]
        if d: out[nm] = (st.mean(d), st.mean(abs(x) for x in d), st.mean(w) if w else None)
    rows.append(out)
    f2 = lambda t: f"{t[0]:+.1f}/{t[1]:.1f} wi {t[2]:+.1f}" if t else '-'
    print(f"{name[:26]:26s} {out['domain']} IEMRE {f2(out.get('iemre'))} | NASA {f2(out.get('nasa'))}", flush=True)
for nm in ('iemre', 'nasa'):
    v = [r[nm] for r in rows if r.get(nm)]
    print(nm, f'bias {st.mean(x[0] for x in v):+.2f} C, mean abs {st.mean(x[1] for x in v):.2f} C, winter {st.mean(x[2] for x in v if x[2] is not None):+.2f} C, n={len(v)}')
json.dump(rows, open('dwd-rows.json', 'w'))
