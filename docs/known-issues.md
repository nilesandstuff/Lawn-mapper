# Known issues

Things that are wrong, or probably wrong, that nobody is working on yet. Kept
here rather than in a conversation because a bug remembered in a chat is a bug
nobody can find in three weeks.

Anything fixed comes out of this file in the same commit as the fix.

---

## Browser run: 5 checks failing

`4. Browser test` reaches the end now (178 passing, up from about 50 — it had
been stopping at `#tool-add` since 11 September, so everything below that line
went unrun for weeks). These five are what the unblocking exposed. **None of
them is a regression from that work** — they had simply never been reached.

### USGS NAIP imagery does not arrive (4 checks)

```
FAIL  the USGS photograph arrives (however slowly)
FAIL  choosing USGS NAIP puts a photograph on the map
      provider=naip layer=false
FAIL  and it is fetched as one image of the frame, not tiles
FAIL  and it covers exactly the frame the measurement is made against
```

All four are one cause: picking NAIP leaves no layer on the map. The last two
are assertions *about* that layer, so they cannot pass while the first fails.

Not diagnosed. It is somebody else's service and it may simply have been down
during the run — worth re-running before spending any time on it. If it is
really broken, it matters more than it looks: NAIP is the only imagery source
that is not Mapbox, and a corpus that is entirely one provider leaves nothing
to check generalisation against (see training-data.md, "what to watch").

### Tapping an edge of the property line grabs a corner instead

```
FAIL  but tapping a line on the property line still grabs that edge
      Corner 36 of 62 on your property line — drag it to move it.
```

The tap was meant to select the EDGE between two corners and selected a corner
instead. With 62 corners on a county outline the two targets are inches apart,
so this is probably the hit test preferring a vertex too eagerly rather than
anything structural — the same tie that `VERTEX_GRAB_PX` and the handles work
was about.

Worth fixing: dragging an edge is how somebody pulls a boundary out to the
kerb, which is the one instruction the paid and volunteer queues cannot do
without.

---

## Not a bug, but unfinished

### `/workers.html` shows a volunteer once per name, not once per person

Volunteers are asked for a name and it is remembered in `localStorage`. Two
people who choose the same name merge into one row; one person who gives a
different name on their phone and their laptop shows as two. That is what a
name-based identity means without accounts, and it is an accepted trade where
no money moves — a merged volunteer tally is a slightly wrong number on a
screen. It would NOT be acceptable if payment hung off it.
