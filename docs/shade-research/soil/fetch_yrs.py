import urllib.request, os, glob, time
names = [f[len('all/crn-'):-4] for f in glob.glob('all/crn-*.txt')]
ok = 0
for s in sorted(names):
    for y in range(2015, 2025):
        p = f'yrs/{s}-{y}.txt'
        if os.path.exists(p) or os.path.exists(p + '.err'): continue
        try:
            with urllib.request.urlopen(urllib.request.Request(f'https://www.ncei.noaa.gov/pub/data/uscrn/products/daily01/{y}/CRND0103-{y}-{s}.txt', headers={'User-Agent': 'lawn-mapper research'}), timeout=60) as r: open(p, 'wb').write(r.read()); ok += 1
        except Exception as e: open(p + '.err', 'w').write(str(e))
print('fetched', ok)
