import json, urllib.request, os, statistics as st, sys
ST = ['MI_Chatham_1_SE','MI_Gaylord_9_SSW','OH_Wooster_3_SSE','PA_Avondale_2_N','MN_Sandstone_6_W','KS_Manhattan_6_SSW','NC_Durham_11_W','NC_Asheville_13_S','GA_Watkinsville_5_SSE','GA_Newton_11_SW','TX_Austin_33_NW','AZ_Tucson_11_W','WA_Spokane_17_SSW','WA_Darrington_21_NNE','KS_Oakley_19_SSW','MN_Goodridge_12_NNW']
def get(url, path):
    if not os.path.exists(path):
        req = urllib.request.Request(url, headers={'User-Agent': 'lawn-mapper research'})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f: f.write(r.read())
    return open(path, 'rb').read()
rows = []
for s in ST:
    txt = get(f'https://www.ncei.noaa.gov/pub/data/uscrn/products/daily01/2025/CRND0103-2025-{s}.txt', f'crn-{s}.txt').decode()
    crn = {}; lon = lat = None
    for ln in txt.splitlines():
        c = ln.split()
        lon, lat = float(c[3]), float(c[4])
        t5, t10 = float(c[23]), float(c[24])
        crn[c[1]] = (t5 if t5 > -99 else None, t10 if t10 > -99 else None)
    p = json.loads(get(f'https://power.larc.nasa.gov/api/temporal/daily/point?parameters=TSOIL1&community=AG&longitude={lon:.3f}&latitude={lat:.3f}&start=20250101&end=20251231&format=JSON', f'pw-{s}.json'))['properties']['parameter']['TSOIL1']
    ie = json.loads(get(f'https://mesonet.agron.iastate.edu/iemre/multiday/2025-01-01/2025-12-31/{lat:.3f}/{lon:.3f}/json', f'ie-{s}.json'))['data']
    iem = {d['date'].replace('-', ''): ((d['soil4t_high_f'] + d['soil4t_low_f']) / 2 - 32) / 1.8 for d in ie if d.get('soil4t_high_f') is not None and d.get('soil4t_low_f') is not None}
    out = {'st': s}
    for name, src in (('nasa', {k: v for k, v in p.items() if v > -90}), ('iemre', iem)):
        for depth, i in (('5', 0), ('10', 1)):
            d = [src[k] - crn[k][i] for k in crn if k in src and crn[k][i] is not None]
            if not d: continue
            out[f'{name}{depth}'] = (st.mean(d), st.mean(abs(x) for x in d), len(d))
        # summer (Jun-Aug) bias at 5 cm
        d = [src[k] - crn[k][0] for k in crn if k in src and crn[k][0] is not None and k[4:6] in ('06', '07', '08')]
        out[f'{name}5su'] = st.mean(d) if d else None
        d = [src[k] - crn[k][0] for k in crn if k in src and crn[k][0] is not None and k[4:6] in ('12', '01', '02')]
        out[f'{name}5wi'] = st.mean(d) if d else None
    rows.append(out)
    f = lambda t: f'{t[0]:+.1f}/{t[1]:.1f}' if t else '  -  '
    g = lambda v: f'{v:+.1f}' if v is not None else ' - '
    print(f"{s:24s} NASA 5cm {f(out.get('nasa5'))} 10cm {f(out.get('nasa10'))} su {g(out['nasa5su'])} wi {g(out['nasa5wi'])} | IEMRE 5cm {f(out.get('iemre5'))} 10cm {f(out.get('iemre10'))} su {g(out['iemre5su'])} wi {g(out['iemre5wi'])}  n={out.get('nasa5',(0,0,0))[2]}", flush=True)
json.dump(rows, open('crn-rows.json', 'w'))
for name in ('nasa', 'iemre'):
    for k in ('5', '10'):
        v = [r[name + k] for r in rows if name + k in r]
        print(name, k, 'cm: mean bias', round(st.mean(x[0] for x in v), 2), 'mean abs', round(st.mean(x[1] for x in v), 2), 'over', len(v), 'stations')
    for k in ('5su', '5wi'):
        v = [r[name + k] for r in rows if r.get(name + k) is not None]
        print(name, k, 'mean bias', round(st.mean(v), 2))
