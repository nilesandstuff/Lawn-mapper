"""alpha_sources.gather_sources fetches lidar and NAIP at once, and keeps both answers."""
import sys
import time
import types

import numpy as np

calls = []


def fake_lidar_for(url, bbox):
    calls.append("lidar")
    time.sleep(0.4)
    z = np.zeros((2, 2))
    return {"height": z, "n_ground": z, "n_all": z}, {"roof": z, "void": z}


def fake_naip_for(bbox, photo=None, stored=None):
    calls.append("naip")
    time.sleep(0.4)
    return np.ones((2, 2, 3)), None


sys.modules["lidar_frame"] = types.SimpleNamespace(lidar_for=fake_lidar_for, height_png=lambda h: b"png")
sys.modules["naip_bands"] = types.SimpleNamespace(naip_for=fake_naip_for)
import alpha_sources  # noqa: E402

t0 = time.time()
out = alpha_sources.gather_sources(None, {"lidarUrl": "x", "bbox": [0, 0, 1, 1]})
took = time.time() - t0
assert took < 0.7, f"downloads ran one after the other ({took:.2f}s)"
assert out["rec"]["lidar"] is True, out["rec"]
assert out["naip"] is not None and out["lidar"] is not None and out["roof"] is not None
assert set(out["seconds"]) == {"lidar", "naip"}

calls.clear()
out = alpha_sources.gather_sources(None, {"bbox": [0, 0, 1, 1]})
assert calls == ["naip"] and out["rec"]["lidar"] is False and out["naip"] is not None


def broken(*a, **k):
    raise RuntimeError("down")


sys.modules["lidar_frame"].lidar_for = broken
out = alpha_sources.gather_sources(None, {"lidarUrl": "x", "bbox": [0, 0, 1, 1]})
assert out["rec"]["lidar"] is False and "lidarError" in out["rec"] and out["naip"] is not None
print("alpha sources: ok")
