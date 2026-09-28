"""
Folds that hold out a NEIGHBOURHOOD at a time (the owner's leakage point,
2026-09-27).

Two corpus lots a few doors apart share a photograph's date, its light and
its grass. Held out one at a time, each is scored by a detector that trained
on the other, and every score is flattered. So lots within `km` of each other
(single linkage: a chain of neighbours is one neighbourhood) are always in
the same fold, and the neighbourhoods are packed into `k` folds of about equal
size -- largest first into the emptiest fold -- which trains on about
(k-1)/k of the corpus each time, close to leave-one-out, at k decoders' cost.

Deliberately not by county: a lot in one Kent County subdivision still learns
from Kent lots across town, which is how the site will be used.

Lot ids begin "lng,lat:". Pure; tests in folds_test.py.
"""

import math

import numpy as np


def lonlat(lot_id):
    """(lng, lat) from the id, or None when it carries none."""
    try:
        lng, lat = lot_id.split(":")[0].split(",")[:2]
        return float(lng), float(lat)
    except ValueError:
        return None


def km_between(a, b):
    (x1, y1), (x2, y2) = a, b
    k = math.cos(math.radians((y1 + y2) / 2))
    return math.hypot((x2 - x1) * 111.32 * k, (y2 - y1) * 111.32)


def neighbourhoods(ids, km):
    """Groups of indices: single-linkage clusters at `km`."""
    pts = [lonlat(i) for i in ids]
    parent = list(range(len(ids)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            # A lot with no position is a neighbourhood of its own.
            if pts[i] and pts[j] and km_between(pts[i], pts[j]) <= km:
                parent[find(i)] = find(j)
    out = {}
    for i in range(len(ids)):
        out.setdefault(find(i), []).append(i)
    return list(out.values())


def place_folds(ids, k, km, seed=7):
    """Lists of indices, one per fold; no neighbourhood split across two."""
    groups = neighbourhoods(ids, km)
    rng = np.random.default_rng(seed)
    order = rng.permutation(len(groups))
    groups = [groups[i] for i in order]
    groups.sort(key=len, reverse=True)        # stable: ties keep the shuffled order
    k = max(1, min(k, len(groups)))
    folds = [[] for _ in range(k)]
    for g in groups:
        min(folds, key=len).extend(g)
    return [sorted(f) for f in folds if f]
