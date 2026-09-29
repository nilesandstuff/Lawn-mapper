#!/usr/bin/env bash
# `modal run tools/modal_gpu.py --plan PLAN`, retried when Modal says its
# app-create RATE LIMIT was hit -- and only then.
#
# Why: eight workflow 14 runs dispatched in the same minute (S18, 2026-09-29)
# all asked Modal for an app at once; two were refused ("App create rate limit
# exceeded") four minutes in and died. A real failure in a script is NOT
# retried: it would cost GPU time to fail the same way again.
set -uo pipefail
plan="$1"
log="$(mktemp)"
for attempt in 1 2 3 4 5 6; do
  modal run tools/modal_gpu.py --plan "$plan" 2>&1 | tee "$log"
  code=${PIPESTATUS[0]}
  if [ "$code" -eq 0 ]; then exit 0; fi
  if ! grep -qi "rate limit" "$log"; then exit "$code"; fi
  wait=$(( 30 * attempt + RANDOM % 60 ))
  echo "Modal rate limit (attempt $attempt of 6); trying again in ${wait}s"
  sleep "$wait"
done
echo "Modal still rate-limiting after 6 attempts"
exit 1
