import json, urllib.request, os, statistics as st, time
rows = json.load(open('crn-rows.json'))
def get(url, path):
    if not os.path.exists(path):
        req = urllib.request.Request(url, headers={'User-Agent': 'lawn-mapper research'})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f: f.write(r.read())
        time.sleep(1)
    return json.load(open(path))
res = []
for r in rows:
    s = r['st']
    crn = {}
    for ln in open(f'crn-{s}.txt'):
        c = ln.split(); lon, lat = float(c[3]), float(c[4]); t5 = float(c[23])
        if t5 > -99: crn[c[1]] = t5
    try:
        d = get(f'https://archive-api.open-meteo.com/v1/archive?latitude={lat:.3f}&longitude={lon:.3f}&start_date=2025-01-01&end_date=2025-12-31&hourly=soil_temperature_0_to_7cm&timezone=GMT', f'om-{s}.json')
    except Exception as e:
        print(s, 'failed', e); continue
    h = d['hourly']; by = {}
    for t, v in zip(h['time'], h['soil_temperature_0_to_7cm']):
        if v is not None: by.setdefault(t[:10].replace('-', ''), []).append(v)
    om = {k: sum(v) / len(v) for k, v in by.items() if len(v) >= 20}
    dd = [om[k] - crn[k] for k in crn if k in om]
    wi = [om[k] - crn[k] for k in crn if k in om and k[4:6] in ('12', '01', '02')]
    res.append((st.mean(dd), st.mean(abs(x) for x in dd), st.mean(wi)))
    print(f"{s:24s} Open-Meteo archive 5cm {st.mean(dd):+.1f}/{st.mean(abs(x) for x in dd):.1f} wi {st.mean(wi):+.1f} | NASA {r['nasa5'][0]:+.1f}/{r['nasa5'][1]:.1f} | IEMRE {r['iemre5'][0]:+.1f}/{r['iemre5'][1]:.1f}", flush=True)
print('Open-Meteo archive: mean bias', round(st.mean(x[0] for x in res), 2), 'mean abs', round(st.mean(x[1] for x in res), 2), 'winter', round(st.mean(x[2] for x in res), 2), 'over', len(res))
