#!/usr/bin/env bash
# Hand a trained release (release/model.pt + release.json) to the live server:
# Modal's volume, where tools/modal_serve.py reads /models/alpha/model.pt when
# a container starts. Used by workflow 14 whichever runner trained it.
set -euo pipefail
if [ -z "${MODAL_TOKEN_ID:-}" ] || [ -z "${MODAL_TOKEN_SECRET:-}" ]; then
  echo "::error::No MODAL_TOKEN_ID / MODAL_TOKEN_SECRET secrets, so the release cannot reach the server."
  exit 1
fi
[ -f release/model.pt ] || { echo "::error::release/model.pt is missing -- the training step did not save one."; exit 1; }
command -v modal >/dev/null || pip install --quiet modal
modal volume create lawn-mapper-models 2>/dev/null || true
modal volume put --force lawn-mapper-models release/model.pt alpha/model.pt
modal volume put --force lawn-mapper-models release/release.json alpha/release.json
# A copy under its own date, so a bad release can be rolled back by copying
# the old one over alpha/model.pt.
stamp=$(python3 -c "import json;print(json.load(open('release/release.json'))['trainedAt'].replace(':','').replace('-',''))")
modal volume put --force lawn-mapper-models release/model.pt "alpha/history/$stamp.pt"
# A warm container keeps the old weights until it idles out; stopping the app
# makes the next lot load the new ones. Harmless when nothing is running.
modal app stop lawn-mapper-alpha 2>/dev/null || true
echo
echo "=== Release shipped ==="
cat release/release.json
echo
echo "Trained on $(python3 -c "import json;print(json.load(open('release/release.json'))['lawns'])") lots."
echo "If the site does not offer the trained model yet, run workflow 2 once."
echo
echo "NEXT: add this release as a row in worker/src/model-versions.js (the next version number,"
echo "today's date, the accuracy of the configuration that picked it), then deploy. That row is"
echo "the model's name in the picker and its line in Version history."
