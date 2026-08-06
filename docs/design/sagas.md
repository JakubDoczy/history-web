# Sagas — stepped events, recursively

Status: contract. Author: architect session. Implementations adapt naming to
the codebase but not the shape.

## The name

"Operation" is retired: it fit Barbarossa and insulted the Golden Age of
Piracy. The concept is a **saga** — an event told in steps. Wars, campaigns,
voyages, golden ages, plagues: anything whose story has chapters and a map.
"Saga" is short, works in UI copy ("SAGA · 5 steps"), and — unlike "arc" —
collides with nothing in a codebase full of rendered arcs.

## The model

A saga is not a new item kind. It is an `HistoricalEvent` whose presentation
carries steps (the existing `Step[]`); sagahood is the presence of that
composition, resolved where presentation is resolved, never by sprinkled
boolean checks.

**Recursion** falls out of the existing machinery rather than being built:

- `Step` gains an optional `child?: ItemId` — the step *is* another item,
  typically a child event related by the existing `parent` relation. WWII's
  "Normandy" step points at the Normandy event; Normandy has its own steps
  and is itself a saga; one of its steps could point deeper.
- Stepping into such a step **focuses the child item** — the focusStack
  already handles nested focus, back-navigation, and dismissal. No new
  navigation state. A step without `child` behaves exactly as today
  (page + drawing + camera within the current focus).
- Validation (build_event_chunks.py): every `child` id exists; the
  step-child graph is acyclic (it should follow the already-acyclic
  `parent` relation, but validate independently); a step with `child`
  may omit page/drawing (the child supplies its own).

## Priority

Sagas take precedence over ordinary events in tiering: a saga below the top
significance tier is lifted one tier. Truly major non-saga events — top tier
by ranking.txt — are not displaced; the lift never demotes anyone, it only
re-orders within the culling budget (a saga wins ties and enters the
viewport budget ahead of equally-ranked plain events). Rank-space hysteresis
rules are unchanged; the lift is applied before hysteresis so it cannot
oscillate.

As built: the lift lives in tiering only. The viewport-budget tie-break was
deliberately NOT bent — the canonical order is shared by three query plans
and the reference `visibleEvents`, and a saga-aware tie-break there would
make pin visibility depend on which plan ran. Significance is where the
lift shows.

## Pins: category glyphs + saga mark

Pins gain a small glyph inside the existing pin silhouette, chosen by the
item's **primary tag category** (which already picks the pin colour — one
source of truth, glyph and colour resolved side by side in `present/pin.ts`):

- **war** — crossed swords, drawn inside a stated budget (`GLYPH_R`): the
  head's own radius less the saga ring and a margin. The registry holds
  geometry, not path data, so "does this fit" is measured rather than
  guessed (`glyphReach`) — the first swords did not, and came back to the
  reader as fragments.
- **trade** — a balanced pair of scales (or stacked coins if scales read
  badly at 12–16 px; decide by looking, at real pin size).
- **trade path / route events** — the trade glyph over the existing route
  motif; a route's direction chevrons stay on the path itself.
- Other categories (politics, science, culture, religion, exploration…):
  extensible registry, default = today's plain dot. Add glyphs only where
  they stay legible at pin size; a bad glyph is worse than none.

**Saga mark**: still a pin, visibly special — a second concentric ring
(a thin outer orbit) around the pin head, plus the category glyph. It must
survive clustering (the stack badge shows the ring if any member is a saga),
both render modes, selection ink, and hover halos. SVG path data in the
glyph registry; no raster assets.

## UI consequences already in flight

The step strip, overview-first-on-desktop, and the "N steps" cue (UI polish
item 4) all read "operation" nowhere visible; where copy is needed it says
saga/steps. Item 5 (the step timeline that replaces the main timeline while
a saga is on the map) builds directly on this model: a station on that
timeline that carries `child` is an entrance — it advertises descent and
pushes focus, with the timeline re-anchoring to the child's span.

## The rail's contract, as corrected (round 44)

Three rules the implementation may not trade away; the whole of the
reasoning is in docs/plan-ui-polish.md item 5 and in the module comment of
lib/present/sagaTimeline.ts.

1. **The rail is a timeline.** Stations stand at their true moment in the
   saga's span, under a visible rule (years / months / days, chosen from
   the span and the width). Crowding may drop a mark into a lower lane; it
   may never move it along the axis. A saga dated to a single point has no
   rule — its axis is dashed, and its stations are spaced EVENLY and
   numbered ("3 of 5"), because proportions someone typed are not
   positions in time and were read as exactly that: *"it looks random and
   without dates"*. The answer to a saga with no dates is dates (see 4).
2. **The rail is one half of a pair.** The other half is the plain way
   through — prev, next, and a list of every step by name and date —
   mounted with the rail. The keyboard drives the same pair. A step that is
   an entrance is moved to, never entered, by prev/next: descending is a
   change of context and has to be asked for (Enter, or a press).
3. **A saga is entered by its own action.** "Walk the steps" on the
   article, in brass, ahead of the generic Show on map; and on a phone,
   opening a step shows the step's ink with the panel left as a pill that
   names it. A saga's whole promise is a sequence on a map — every control
   that leads into one says so.

## The rail's contract, round 45

4. **Every station carries its own date.** Beside its name, always,
   at the resolution the saga's span supports and one notch finer than the
   rule — the rule is a picture of the span, not an answer to "when was
   this one", and on a phone two of its labels are on screen at a time. A
   step written as a whole year still says the year: nothing on the rail
   says more than it knows. Where there is no date at all the station says
   its place in the order instead.
5. **A saga's steps are dated.** A step is a named historical moment and
   is written as one — a year, to the day where the day is known — not as
   a fraction of the span. The fractions the first corpus carried put
   D-Day in 1943 and gave two of the three exemplars no axis at all. A
   saga's own span is the true period its steps run over, and widening it
   from a point is part of dating them.
6. **Show on map keeps the step.** It is a statement about the camera:
   put this in front of me. Only the innermost crumb and the list's
   overview row leave a step, and both say so.

## The rail's contract, round 46

7. **The rail has a window, and everything is derived from it.** A phone
   used to answer "eleven moments will not fit" by growing the rail past
   the element and scrolling it — a second system the desktop did not
   have, and a pan with none of a pan's other half. There is ONE system
   now and it is the era rail's (components/TimelineBar.vue): a visible
   window over the padded span that wheel and pinch zoom about the point
   under the cursor, a drag pans, and a double-tap takes one step in.
   The rail is exactly as wide as its element on every screen.
   - Positions, period bands, lane assignment, label room and the tick
     rule are all **re-derived per window** (`layoutRail(sts, span,
     width, win)`), not transformed. Marks that were eleven pixels apart
     become a hundred, so they climb out of their lanes and their dropped
     names come back. That is what zooming is for.
   - **Clamps.** Never out past the padded span (`{u0:0, u1:1}`); never
     in past about three days across, which is where the tick ladder
     stops refining (`minWindow`). A saga with no extent cannot zoom at
     all: magnifying an order says nothing the numbers on the marks do
     not already say.
   - The window is **rail-local state**. It dies with the rail, so a
     descent re-anchors to the child's span fitted — a child is a
     different question.
   - The **index pans the picture**: prev, next and the list bring their
     target inside the window with a short eased glide when it is
     outside it (`revealIn`), and leave a window that already holds it
     alone.
   - One visible control carries the affordance: it takes a step in from
     rest and becomes **Fit** once the window is anything but the whole
     span. A phone has no grab cursor and no `title`, so the rail says
     "this moves" with a control rather than with a hint that has to be
     dismissed.

8. **The rule refines with the window; the saga's own dates do not.**
   The tick ladder (round 44) is fed the VISIBLE span and the rail's
   pixel width, so a war rules in years, its 1944 in months and D-Day's
   June in days — one ladder walked by the zoom, no modes, no
   thresholds. The `TICK_PX` density rule is the collision proof: a
   spacing is only chosen if every label has that much rail, at any zoom
   and any width. Month ticks stand on the **first of a calendar month**
   and are aligned to the year (a twelfth of a year is 30.44 days, and a
   rule stepped in twelfths printed "Jan 1944" twice and skipped
   February). What must NOT follow the window is the span readout in the
   head and each station's own date (rule 4): those are facts about the
   saga, asked of the span at a fixed density (`spanUnit`), because a
   date that changes when you turn the wheel is not one.

9. **A phone's rail is the taller one, and the step you are on is drawn
   on top.** The saga rail carries a rule, three lanes of marks and a
   dated name beside each; the era rail carries two strips and a ruler.
   At 84px it drew all of that in 14px rows — *"it should be taller
   (take a bit more screen on mobile)"*. Under a saga `--rail` is 116px
   on a phone (`:root:has(.rail.saga)`, tokens.css) so that every
   clearance derived from it — the pill's position, the mobile sheet's
   height, the scale bar — moves with it; desktop is unchanged.
   In a pile-up the open step is **topmost**: above every other lane's
   marks and labels, its own label never dropped, and lifted with a ring
   of the rail's own ground and a shadow under it. The priority is a
   pure function (`markZ`) rather than four CSS rules of equal
   specificity all claiming `z-index: 3`.

10. **An icon is geometry, never type.** Every glyph in a control is an
    inline SVG path whose geometric centre is its viewBox's centre, and
    it is placed by translation off its container's centre — never by
    flex or grid alignment, never on a baseline, never a text character
    (`←`, `▸`) resolved through whatever font a device happens to have.
    The rule and the reasoning are in styles/tokens.css (`.glyph`,
    `.icon-c`); the phone reported the minimised window's chevron
    off-centre twice, and both earlier fixes argued with a layout instead
    of removing the dependence on one.
