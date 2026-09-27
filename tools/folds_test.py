"""
Folds by place, offline.

    python3 tools/folds_test.py
"""

from folds import km_between, lonlat, neighbourhoods, place_folds

passed = 0


def check(name, cond, detail=""):
    global passed
    assert cond, f"{name} {detail}"
    passed += 1
    print(f"PASS  {name}")


check("a lot id gives its position", lonlat("-85.61014,43.0352:sam3:x") == (-85.61014, 43.0352))
check("a kilometre is a kilometre", abs(km_between((-85.6, 43.0), (-85.6, 43.009)) - 1.0) < 0.01)

ids = [
    "-85.6000,43.0000:a", "-85.6005,43.0003:b", "-85.6010,43.0006:c",   # one subdivision
    "-85.7000,43.0000:d",                                               # across town, 8 km
    "-83.7143,32.6821:e", "-83.7149,32.6829:f",                          # the two Peach County lots
    "-122.59,48.03:g",
]
hood = sorted(sorted(g) for g in neighbourhoods(ids, 2))
check("neighbours within 2 km are one neighbourhood; across town is not",
      hood == [[0, 1, 2], [3], [4, 5], [6]], str(hood))
folds = place_folds(ids, 3, 2)
where = {i: n for n, f in enumerate(folds) for i in f}
check("no neighbourhood is split across folds", where[0] == where[1] == where[2] and where[4] == where[5])
check("every lot is in exactly one fold", sorted(i for f in folds for i in f) == list(range(len(ids))))
check("the folds come out about even", max(map(len, folds)) - min(map(len, folds)) <= 2, str(folds))
check("the same seed gives the same folds", place_folds(ids, 3, 2, seed=7) == folds)
check("an id with no position is its own neighbourhood, not an error",
      lonlat("lawn0") is None and len(neighbourhoods(["lawn0", "lawn1"], 2)) == 2)
check("asking for more folds than neighbourhoods gives one per neighbourhood", len(place_folds(ids, 20, 2)) == 4)

print(f"\nAll {passed} checks passed.")
