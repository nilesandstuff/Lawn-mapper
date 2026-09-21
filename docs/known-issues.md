# Known issues

Things that are wrong, or probably wrong, that nobody is working on yet. Kept
here rather than in a conversation because a bug remembered in a chat is a bug
nobody can find in three weeks.

Anything fixed comes out of this file in the same commit as the fix.

---

## Browser run: 2 checks failing, and it reaches the end

`4. Browser test` now runs to completion: **245 checks**, no early stop.

It had been stopping partway for a long time, and the count is worth reading
as a ratchet rather than a score -- 155, 162, 189, 203, 245 over one evening,
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

### A trimmed lawn leaves 87 sq ft outside the line

```
FAIL  and switching it back off trims to the line again
      148885 -> 87 sq ft outside
```

Consistent -- every run that has reached it. Turning "measure outside the
line" on, painting past the boundary, and turning it back off leaves 87 sq ft
outside a line that started under 27, against a `+60` tolerance.

Not diagnosed, and the tolerance is the first question rather than the answer:
`__lmOutsideSqFt` is rasterised, so some residue is expected, and 60 is a
number somebody picked rather than a bound derived from the pixel size. Either
the trim leaks or the check is stricter than the measure can support. Widening
it to get a green run would bury whichever it is.

### An uncaught error while painting with the add brush

```
FAIL  the page threw no uncaught errors
      PAGEERROR: .for is not iterable
        (after: painting with the add brush increases the area)
```

Nothing in `public/app.js` or `public/lib/` contains a `.for`, so by
elimination it is inside minified Mapbox -- but it throws during our brush
stroke, so it is our call into it. The stroke itself works: the check directly
before it passes and the area goes up.

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
