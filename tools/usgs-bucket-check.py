"""
WHAT IS IN USGS'S REQUESTER-PAYS LIDAR BUCKET (owner, 2026-10-31: the
s3://usgs-lidar bucket, raw LAZ 1.4 tiles, "more complete than the EPT bucket,
but not a full mirror", per the AWS Open Data registry). Run by workflow 48
with the owner's read-only key; every request is billed to that account, so
this counts them and the bytes, and stops early rather than walk the bucket.

  1. the bucket's top two levels of folders;
  2. which of the projects we have had to fetch from rockyweb are there, and
     how many LAZ files and MB each holds;
  3. one tile downloaded whole, timed.
"""
import json
import os
import re
import sys
import time

import boto3
from botocore.config import Config

BUCKET = "usgs-lidar"
s3 = boto3.client("s3", region_name="us-west-2", config=Config(retries={"max_attempts": 4}))
REQ = {"n": 0, "bytes": 0}
norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())  # noqa: E731

# Projects whose newest flight we read as rockyweb tiles (the 18 tile lots, Ketchum, Arkansas).
TARGETS = ["AR_Western_B24", "AR_Western_1_B24", "PA_17County_D24", "PA_17Co_1_D24", "PA_17Co_5_D24", "PA_17Co_6_D24",
           "MD_4County_D24", "MD_Central_Processing_D24", "NJ_NE6County_B23", "NJ_NE6Co_2_B23",
           "ID_SouthernGaps_D23", "ID_SouthernGaps_2_D23", "GA_Central_2019_B19", "UT_2023_SaltLakeCo",
           "KY_CentralEast_A23", "IL_19County_D24", "WI_5County_B24", "PA_WesternPA_2_2019"]


def ls(prefix, delimiter="/", limit_pages=20):
    """Folders and objects under prefix (one page = 1000 keys = one billed LIST)."""
    folders, objects, token, pages = [], [], None, 0
    while True:
        kw = {"Bucket": BUCKET, "Prefix": prefix, "RequestPayer": "requester", "MaxKeys": 1000}
        if delimiter:
            kw["Delimiter"] = delimiter
        if token:
            kw["ContinuationToken"] = token
        r = s3.list_objects_v2(**kw)
        REQ["n"] += 1
        pages += 1
        folders += [c["Prefix"] for c in r.get("CommonPrefixes", [])]
        objects += [(o["Key"], o["Size"]) for o in r.get("Contents", [])]
        token = r.get("NextContinuationToken")
        if not token or pages >= limit_pages:
            return folders, objects, bool(token)


def main():
    top, objs, more = ls("")
    print(f"TOP LEVEL: {len(top)} folders{' (more not listed)' if more else ''}, {len(objs)} files")
    print("  " + " ".join(top[:40]) + (" ..." if len(top) > 40 else ""))
    # One more level where the top is a few containers (e.g. Projects/).
    second = {}
    if len(top) <= 12:
        for t in top:
            f, _, more2 = ls(t)
            second[t] = f
            print(f"  {t}: {len(f)} folders{' (more)' if more2 else ''}")
    names = []
    for t in top:
        names += second.get(t) or [t]
    print(f"PROJECT FOLDERS SEEN: {len(names)}")
    print("NAMES " + json.dumps([n.rstrip('/').rsplit('/', 1)[-1] for n in names]))
    found = {}
    for want in TARGETS:
        hits = [n for n in names if norm(want) in norm(n.rstrip('/').rsplit('/', 1)[-1])]
        found[want] = hits
    print("\nOUR TILE-ONLY PROJECTS:")
    sample = None
    for want, hits in found.items():
        if not hits:
            print(f"  {want:28s} NOT in the bucket")
            continue
        for h in hits[:2]:
            _, objects, more = ls(h, delimiter=None, limit_pages=5)
            laz = [(k, s) for k, s in objects if k.lower().endswith(".laz")]
            mb = sum(s for _, s in laz) / 1e6
            print(f"  {want:28s} {h}  {len(laz)}{'+' if more else ''} LAZ, {mb:,.0f}{'+' if more else ''} MB")
            if laz and sample is None:
                sample = sorted(laz, key=lambda x: x[1])[len(laz) // 2]
    if sample:
        key, size = sample
        t0 = time.time()
        body = s3.get_object(Bucket=BUCKET, Key=key, RequestPayer="requester")["Body"].read()
        REQ["n"] += 1
        REQ["bytes"] += len(body)
        dt = time.time() - t0
        print(f"\nDOWNLOAD: {key.rsplit('/', 1)[-1]}  {len(body) / 1e6:.1f} MB in {dt:.1f} s = {len(body) / 1e6 / max(dt, 1e-6):.1f} MB/s"
              f"  (starts {body[:4]!r})")
    cost = REQ["n"] * 0.005 / 1000 + REQ["bytes"] / 1e9 * 0.09
    print(f"\nBILLED TO THE ACCOUNT: {REQ['n']} requests, {REQ['bytes'] / 1e6:.1f} MB downloaded, about ${cost:.4f}")


if __name__ == "__main__":
    if not os.environ.get("AWS_ACCESS_KEY_ID"):
        sys.exit("No AWS_ACCESS_KEY_ID secret")
    main()
