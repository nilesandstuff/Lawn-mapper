"""
Feedback loop 2's Modal half: the trained model over queued lots.

    python3 tools/score_queue_modal.py lots.jsonl scores.jsonl

COSTS MONEY -- the live server's GPU (tools/modal_serve.py), one lot at a
time through at most its container limit. Reads what `score-queue.js plan`
wrote, keeps only what the queue needs (the uncertainty and the release that
measured it), and never stops for one lot that failed.
"""

import json
import sys
import time

import modal


def main():
    src, dst = sys.argv[1], sys.argv[2]
    lots = [json.loads(line) for line in open(src) if line.strip()]
    if not lots:
        print("No lots to score.")
        open(dst, "w").close()
        return 0
    Alpha = modal.Cls.from_name("lawn-mapper-alpha", "Alpha")
    payloads = [{"imageUrl": L["imageUrl"], "frame": L["frame"], "parcel": L.get("parcel")} for L in lots]
    t0 = time.time()
    ok = failed = 0
    with open(dst, "w") as out:
        results = Alpha().detect.map(payloads, return_exceptions=True, order_outputs=True)
        for lot, r in zip(lots, results):
            if isinstance(r, Exception) or not isinstance(r, dict) or r.get("uncertainty") is None:
                failed += 1
                print(f"  {lot['id']}: failed ({str(r)[:160]})", flush=True)
                continue
            ok += 1
            out.write(json.dumps({"id": lot["id"], "uncertainty": r["uncertainty"], "version": r.get("version")}) + "\n")
            print(f"  {lot['id']}: {r['uncertainty'] * 100:.1f}% unsure, {r.get('seconds', {}).get('total', '?')}s", flush=True)
    print(f"Scored {ok} of {len(lots)} lots in {time.time() - t0:.0f}s ({failed} failed).")
    return 0 if ok or not lots else 1


if __name__ == "__main__":
    sys.exit(main())
