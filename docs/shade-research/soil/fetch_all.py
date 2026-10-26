import json, urllib.request, os, time, sys
names = [l.strip() for l in open('stations.txt') if l.strip()]
def get(url, path, pause=0):
    if os.path.exists(path): return True
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'lawn-mapper research (non-commercial)'})
        with urllib.request.urlopen(req, timeout=120) as r: b = r.read()
        open(path, 'wb').write(b); time.sleep(pause); return True
    except Exception as e:
        open(path + '.err', 'w').write(str(e)); return False
for n in names:
    s = n[len('CRND0103-2025-'):-4]
    p = f'all/crn-{s}.txt'
    get(f'https://www.ncei.noaa.gov/pub/data/uscrn/products/daily01/2025/{n}', p)
    lines = open(p).read().splitlines() if os.path.exists(p) else []
    if not lines: continue
    c = lines[0].split(); lon, lat = float(c[3]), float(c[4])
    soil = sum(1 for l in lines if float(l.split()[23]) > -99)
    if soil < 300: print(s, 'soil days', soil, 'skip'); continue
    get(f'https://mesonet.agron.iastate.edu/iemre/multiday/2025-01-01/2025-12-31/{lat:.3f}/{lon:.3f}/json', f'all/ie-{s}.json', 0.5)
    get(f'https://power.larc.nasa.gov/api/temporal/daily/point?parameters=TSOIL1,T2M,ALLSKY_SFC_SW_DWN&community=AG&longitude={lon:.3f}&latitude={lat:.3f}&start=20250101&end=20251231&format=JSON', f'all/pw-{s}.json', 0.5)
    print(s, 'ok', flush=True)
