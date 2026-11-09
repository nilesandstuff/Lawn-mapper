"""
A COUNTY'S PUBLISHED PARCEL FILE, AS THE PARCEL COPY'S RECORDS (core session, 2026-11-09). tools/parcel-mirror.mjs
falls back to this when a county's parcel server cannot be copied (it refuses, or will not list its parcels) but the
county publishes the same parcels as a download on its own portal (a File Geodatabase or a shapefile, zipped).

Reads the polygon layer with the most features, the parcel number from the field the registry names (or the usual
names), puts every parcel in WGS84 with Esri's ring order (outer clockwise, holes counter-clockwise, as the county's
server sends them), keeps those whose box meets the service's box, and writes one JSON line each: {"pin":..., "rings":
[[[lng, lat], ...], ...]}. Prints counts only.

  python tools/parcel_file.py <file.zip> <out.jsonl> <pin field or -> <w,s,e,n>
"""
import json
import os
import re
import sys
import tempfile
import zipfile

import numpy as np
import pyogrio
import shapely
from pyproj import Transformer

PIN_NAMES = re.compile(r"^(pin|ppn|ppn_text|pnum|apn|parcel_?id|parcelid|parcel_?no|parcel_?num(ber)?|parno|pid|tax_?id)$", re.I)


def source(path, work):
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            z.extractall(work)
        for root, dirs, files in os.walk(work):
            for d in dirs:
                if d.lower().endswith(".gdb"):
                    return os.path.join(root, d)
        for root, _, files in os.walk(work):
            for f in sorted(files):
                if f.lower().endswith((".shp", ".gpkg")):
                    return os.path.join(root, f)
        raise SystemExit("Parcel file: no geodatabase or shapefile in the download.")
    return path


def main(path, out, pin_hint, box):
    w, s, e, n = (float(v) for v in box.split(","))
    with tempfile.TemporaryDirectory() as work:
        src = source(path, work)
        layers = [(name, kind) for name, kind in pyogrio.list_layers(src) if kind and "Polygon" in str(kind)]
        if not layers:
            raise SystemExit("Parcel file: no polygon layer.")
        best = max(layers, key=lambda l: pyogrio.read_info(src, layer=l[0])["features"])[0]
        info = pyogrio.read_info(src, layer=best)
        fields = list(info["fields"])
        pin = next((f for f in fields if pin_hint and f.lower() == pin_hint.lower()), None) \
            or next((f for f in fields if PIN_NAMES.match(f)), None)
        meta, _, geoms, data = pyogrio.raw.read(src, layer=best, columns=[pin] if pin else [], read_geometry=True)
        g = shapely.from_wkb(geoms)
        crs = meta.get("crs")
        if crs and crs.upper() not in ("EPSG:4326", "OGC:CRS84"):
            t = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
            g = shapely.transform(g, lambda xy: np.column_stack(t.transform(xy[:, 0], xy[:, 1])))
        ok = ~shapely.is_missing(g) & ~shapely.is_empty(g)
        b = shapely.bounds(g)
        ok &= (b[:, 2] >= w) & (b[:, 0] <= e) & (b[:, 3] >= s) & (b[:, 1] <= n)
        pins = data[0] if pin else None
        kept = 0
        with open(out, "w") as f:
            for i in np.nonzero(ok)[0]:
                geom = g[i]
                polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom] if geom.geom_type == "Polygon" else []
                rings = []
                for p in polys:
                    p = shapely.geometry.polygon.orient(p, sign=-1.0)
                    rings.append([[round(x, 7), round(y, 7)] for x, y in p.exterior.coords])
                    rings += [[[round(x, 7), round(y, 7)] for x, y in r.coords] for r in p.interiors]
                if not rings:
                    continue
                v = pins[i] if pins is not None else None
                v = None if v is None or (isinstance(v, float) and np.isnan(v)) else str(v).strip() or None
                f.write(json.dumps({"pin": v, "rings": rings}, separators=(",", ":")) + "\n")
                kept += 1
    print(f"Parcel file: {len(g):,} parcels in the file, {kept:,} in the service's area; "
          f"parcel numbers {'read' if pin else 'not found'}.")


if __name__ == "__main__":
    main(*sys.argv[1:5])
