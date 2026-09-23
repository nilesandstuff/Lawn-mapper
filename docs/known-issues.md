# Known issues

Things that are wrong, or probably wrong, that nobody is working on yet. Kept
here rather than in a conversation because a bug remembered in a chat is a bug
nobody can find in three weeks.

Anything fixed comes out of this file in the same commit as the fix.

---

## Property lines are offset from the imagery in some counties, and it is the county's data

*Measured 2026-09-21 at 1186 Brook View Ct, Pittsburgh PA (Allegheny County).*
Reported as "definitely off, substantially", and it is: **about 5 metres east**.

Measured rather than eyeballed. The county's road right-of-way parcel and the
pavement in the aerial photograph were rasterised onto the same 1280 px frame
and cross-correlated for the shift that best lines them up:

    pavement mask       best shift
    saturation < 12     4.9 m east, 0.8 m south
    saturation < 16     4.9 m east, 1.0 m south
    saturation < 8      7.1 m east, 2.4 m north   (only 1.8% of the frame
                                                   masked -- too sparse to trust)

An independent eyeball of the same three images put it at 5.1 m east, which is
the agreement worth having: two methods, one number.

**WHAT IT IS NOT.** Not our projection: `/api/parcel` already asks for
`outSR=4326`, so the county server reprojects before we see anything. Not the
NAD83-vs-WGS84 datum either -- that is about a metre in the lower 48 and this
is five. Asking both county servers for an explicit datum transformation
changed the returned coordinates by exactly 0.00 m, so that path is untested
rather than ruled in.

**WHAT IT PROBABLY IS.** A county parcel layer is a cadastral fabric assembled
from deed dimensions and old plats, fitted together to be internally
consistent. It is not surveyed against the photograph, and a subdivision drawn
into the fabric can sit several metres off the ground it describes. That is
the county's data being what it is, not a fault in anything here.

Two independent aerials -- Mapbox and USGS NAIP, flown years apart, one of
them during construction -- put the pavement in the same place as each other
and disagree with the parcel. They may share lineage (Mapbox uses NAIP in
places), so that is support rather than proof.

**NOT MEASURED:** 271 Saint James Parkway, Sugar Grove IL (Kane County),
reported at about a metre south. A metre is the scale a datum shift would
explain and five metres is not, so these may be two different faults wearing
the same symptom. The same measurement would settle it; Kane's layer has no
road right-of-way parcel to correlate against, so it needs a different anchor.

**NOBODY IS WORKING ON IT.** Worth knowing before somebody spends a day on
our own projection maths: it is not there. If it is ever worth fixing, the
shape of the fix is a per-county offset, measured once this way and stored
beside the endpoint -- which is a real piece of work and should not be started
on one county's evidence.

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
