# Known issues

Things that are wrong, or probably wrong, that nobody is working on yet. Kept
here rather than in a conversation because a bug remembered in a chat is a bug
nobody can find in three weeks.

Anything fixed comes out of this file in the same commit as the fix.

---

## Browser run: green

`4. Browser test` passes: **246 checks, 0 failures**, and the paid-queue suite
alongside it. First clean run.

It had been stopping partway for a long time, and the count is worth reading
as a ratchet rather than a score -- 155, 162, 189, 203, 246 -- each number a
further stoppage removed. Everything below each stop had been going unrun
while the summary said `0 check(s) FAILED`, which is true and useless: a check
that never executes cannot fail.

**All five stoppages were the suite's own bugs, not the app's.** Four were one
fact -- every rail button lives inside `#shape-tools`, hidden unless lawn mode
is live, so a click aimed at one from Move, Draw or the property line waits ten
seconds for something that will never appear and throws. `inLawnMode`,
`armPoints` and `armBrush` hold that precondition now. The fifth was a flaky
paint stroke upstream leaving `corners[0].x` undefined in a section that did
not guard its preconditions.

---

## Something builds a polygon out of `[[null]]`

Not fatal any more, and not fixed. `polygonRings` drops it and says so:

```
CONSOLE: polygonRings: dropped a malformed polygon, [[null]]
      (after: painting with the add brush increases the area)
```

One ring, holding one `null`. Destructuring that as `[lng, lat]` is what threw
`.for is not iterable` for the whole evening before the selector was tightened.

**Worth finding.** A polygon with no usable points contributes nothing to a
measurement, so nothing visible is wrong -- but whatever builds it is building
garbage, and the next caller to trust its contents will crash the way this one
did. It appears during add-brush painting, which points at the trace-back in
`maskToPolygons` or one of its callers.

Note for whoever picks it up: my own narrowing of this said the culprit had to
be a polygon "nested one level too shallow", reasoned from `measure()` having
survived it. That reasoning was sound and the conclusion was wrong --
`geometryAreaSqM` returns 0 for `[[null]]` too, so surviving `measure()` ruled
out less than I claimed.

---

### Latent: an area function that throws on bad data

`ringAreaSqM` throws on a ring containing `undefined`, where every other
branch of `geometryAreaSqM` answers 0 for input it cannot use. No evidence it
happens -- found while narrowing the above, by trying it. Left alone
deliberately rather than guarded on spec.

It had been stopping partway for a long time, and the count is worth reading
as a ratchet rather than a score -- 155, 162, 189, 203, 246 over one evening,
each number a further stoppage removed. Everything below each stop had been
going unrun while the summary said `0 check(s) FAILED`, which is true and
useless: a check that never executes cannot fail.

**All five stoppages were the suite's own bugs, not the app's.** Four were one
fact -- every rail button lives inside `#shape-tools`, hidden unless lawn mode
is live, so a click aimed at one from Move, Draw or the property line waits ten
seconds for something that will never appear and throws. `inLawnMode`,
`armPoints` and `armBrush` hold that precondition now. The fifth was a flaky
paint stroke upstream leaving `corners[0].x` undefined in a section that did
not guard its preconditions.

---

## Intermittent, and probably not ours

### USGS NAIP imagery sometimes does not arrive

```
FAIL  choosing USGS NAIP puts a photograph on the map
      provider=naip layer=false
```

Failed once in the eight runs that have reached it; passed the other seven,
including the most recent. This file used to list it as four checks failing
outright -- the other three are assertions *about* the layer the first one
fails to create, so they go together -- and the entry itself guessed the
service might simply have been down. The re-runs say that guess was right.

Left here rather than deleted because it still matters when it happens: NAIP
is the only imagery source that is not Mapbox, and a corpus that is entirely
one provider leaves nothing to check generalisation against (see
training-data.md, "what to watch").

### A paint stroke that sometimes does nothing

```
FAIL  painting a lawn with no detection at all measures something
      0 -> 0 shape(s), 0 sq ft
```

Twice in ten runs. The brush listens for mouse and touch alike and the tool is
confirmed armed before the stroke starts, so the obvious explanations do not
hold, and it is not diagnosed.

It used to end the whole run, because the point-eraser section below it read
`corners[0].x` off an empty list. That section guards now, and the stroke is
waited for rather than slept through, so when it does flake it costs one
section instead of a hundred and sixty checks.

---

## Not a bug, but unfinished

### `/workers.html` shows a volunteer once per name, not once per person

Volunteers are asked for a name and it is remembered in `localStorage`. Two
people who choose the same name merge into one row; one person who gives a
different name on their phone and their laptop shows as two. That is what a
name-based identity means without accounts, and it is an accepted trade where
no money moves — a merged volunteer tally is a slightly wrong number on a
screen. It would NOT be acceptable if payment hung off it.
