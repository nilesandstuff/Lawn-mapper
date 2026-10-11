"""
THE MODAL LOGS, READ FROM A PHONE (owner, 2026-10-11: "if you don't have a
way to see the modal logs, could you also set that up?"). Workflow 34.

Modal keeps every app's output; the dashboard shows it, but nothing here
could read it -- so a stuck press, a cold start or a crash on the live
server left no trace anywhere a session or a phone could see. This lists
the apps, then fetches the logs of each one whose name matches, inside the
time window asked for, and ends with what is worth reading: how many
lines, how many errors, and the error lines themselves.

The live server (lawn-mapper-alpha) is a deployed app and has one id; the
GPU training runs (lawn-mapper-gpu) are ephemeral, one app per run, so
they are found by name in the list.

  APP=lawn-mapper-alpha SINCE=2h [SEARCH=text] [SOURCE=stderr] [TAIL=2000] python3 tools/modal-logs.py
"""
import json
import os
import re
import subprocess
import sys

APPS = [a.strip() for a in os.environ.get("APP", "lawn-mapper-alpha").split(",") if a.strip()]
SINCE = os.environ.get("SINCE", "2h").strip() or "2h"
SEARCH = os.environ.get("SEARCH", "").strip()
SOURCE = os.environ.get("SOURCE", "").strip()
TAIL = os.environ.get("TAIL", "2000").strip() or "2000"
OUT = os.environ.get("OUT", "modal-logs.txt")
ERRORS = re.compile(r"Traceback|Error|Exception|error:|Killed|OOM|out of memory|Timeout|timed out|failed", re.I)


def modal(*args, check=False):
    return subprocess.run([sys.executable, "-m", "modal", *args], capture_output=True, text=True, check=check)


def apps_matching(names):
    """[(app id, name, state, created)] newest first, for every app named in `names`."""
    r = modal("app", "list", "--json")
    if r.returncode != 0:
        print(f"Could not list the apps: {(r.stderr or r.stdout).strip()[:300]}")
        return []
    try:
        rows = json.loads(r.stdout)
    except json.JSONDecodeError:
        print(f"The app list was not JSON: {r.stdout[:300]}")
        return []
    found = []
    for row in rows:
        name = row.get("Description") or row.get("Name") or row.get("description") or ""
        app_id = row.get("App ID") or row.get("app_id") or row.get("App Id") or ""
        if any(name == n or n == "all" for n in names):
            found.append((app_id, name, row.get("State") or row.get("state") or "?",
                          row.get("Created at") or row.get("created_at") or ""))
    return sorted(found, key=lambda a: a[3], reverse=True)


def main():
    apps = apps_matching(APPS)
    print(f"Apps on Modal matching {', '.join(APPS)}: {len(apps)}")
    for app_id, name, state, created in apps[:20]:
        print(f"  {app_id}  {name:22} {state:10} created {created}")
    lines_all, errors = [], []
    # The deployed server by name; the ephemeral ones by id (most recent 10).
    for app_id, name, state, created in apps[:10]:
        args = ["app", "logs", app_id, "--since", SINCE, "--tail", TAIL,
                "--timestamps", "--show-container-id"]
        if SEARCH:
            args += ["--search", SEARCH]
        if SOURCE:
            args += ["--source", SOURCE]
        r = modal(*args)
        text = (r.stdout or "") + ("" if r.returncode == 0 else f"\n(could not read: {(r.stderr or '').strip()[:300]})")
        lines = [l for l in text.splitlines() if l.strip()]
        header = f"===== {name} {app_id} ({state}, created {created}): {len(lines)} lines since {SINCE}"
        lines_all += [header, *lines, ""]
        errors += [f"{name}: {l}" for l in lines if ERRORS.search(l)]
        print(f"\n{header}")
        for l in lines[-400:]:
            print(l)
    with open(OUT, "w") as f:
        f.write("\n".join(lines_all) + "\n")

    # The end of the log is the part read on a phone: say it again there.
    print("\n================ MODAL LOGS ================")
    matching = f' matching "{SEARCH}"' if SEARCH else ''
    count = sum(1 for l in lines_all if l and not l.startswith('====='))
    print(f"{len(apps)} app(s) named {', '.join(APPS)}; logs since {SINCE}{matching}: "
          f"{count} lines, {len(errors)} that look like errors.")
    for e in errors[-25:]:
        print(f"  {e[:300]}")
    if not errors:
        print("  No error lines in that window.")
    print(f"Everything is in the 'modal-logs' artifact ({OUT}).")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(f"### Modal logs since {SINCE}\n\n{len(errors)} error line(s).\n\n```\n"
                    + "\n".join(e[:300] for e in errors[-25:]) + "\n```\n")


if __name__ == "__main__":
    main()
