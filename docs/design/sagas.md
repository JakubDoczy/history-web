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
3. **A saga is entered by its own action.** "Show steps on map" on the
   article, in brass, with the step count on it, ahead of the generic Show
   on map; and on a phone, opening a step shows the step's ink with the
   panel left as a pill that names it. A saga's whole promise is a sequence
   on a map — every control that leads into one says so, literally. The
   label was "Walk the steps" through round 46 and it said the sequence
   but not the place: a reader who has not yet seen the rail cannot tell
   from it whether the walking happens in the panel or on the planet, and
   a control whose meaning is private until it is pressed has no business
   being the prominent one (round 47).

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

## The rail's contract, round 47

11. **A rule has a floor.** The tick density has two statements in it
    now, not one. `TICK_PX` (110) is the CALM figure — the room the era
    rail's labels want, which a desktop can afford and which leaves a
    six-year war at six year-marks. `MIN_TICKS` (5) is the FLOOR: a rail
    that would otherwise draw fewer than five divisions refines its
    spacing until it does. *"D-Day at fit showed a single tick; WWII
    showed 2 years"* — a 390px rail divided three ways, in labels set at
    10px condensed where 110px was measured for 11.5px type.
    - The floor may only refine **as far as the labels themselves
      allow**. `tickRoom(label)` is the collision figure and it is
      measured, not assumed: the string's own length at
      `TICK_CHAR_PX` (6.6, measured in the browser and rounded up),
      plus the 4px the label is inset from its gridline, plus 10px of
      air. Nothing is drawn closer than that, at any zoom, at any
      width — and no rule is chosen that would print the same label
      twice in a row.
    - It refines to the **coarsest** spacing that clears the floor,
      never to the finest that fits: it adds marks where there were too
      few and nowhere else. On a 390px phone that is a 10-day ladder
      rung for D-Day's seven weeks (five dated marks, 72px apart) and a
      one-year rule for the war (six, 58px apart). A 1280px desktop
      never reaches for it: the calm rule already gives six.
    - The calm rule is **coarsened** if its own choice would collide,
      which it can near an end of the span where the window reaches
      past what there is to divide. The collision proof is total.

12. **The whole rail is the rail's, header and all.** `touch-action:
    none` says "this gesture is mine", and it used to sit on the saga
    rail's `.track` alone. A phone's saga rail is 116px tall and the top
    26 of them are the breadcrumb and the Zoom / ‹ / Steps / › row — so
    a pinch that caught that row was the BROWSER'S, and it took the
    visual viewport from scale 1 to scale 5 while the rail's window
    never moved. Measured with real Touch events; a synthesised
    `PointerEvent` can never find it, because a constructed event is
    delivered where it is aimed and `touch-action` is never consulted.
    The era rail (TimelineBar.vue) has carried the line on its root
    since it was written, which is why it pinches.
    - The line is on the **root** now, and the two scrollers inside it
      are given their own axis back (`pan-x` on the crumbs, `pan-y` on
      the step index) — a blanket `none` would otherwise make a phone's
      flick through eleven steps do nothing.
    - WebKit needs a **second** mechanism: Safari's page zoom is driven
      by a gesture recogniser touch-action has no say over, and only
      `preventDefault` on the non-standard `gesturestart` /
      `gesturechange` stands it down. Two mechanisms because there are
      two browsers, not because either is a fallback for the other.
    - A **second finger captures both pointers to the track**. Touch
      pointers are implicitly captured to whatever they landed on, which
      is fine while that is a descendant of the track and fatal the
      moment a real thumb crosses the rail's edge mid-pinch. The first
      finger is deliberately NOT captured: that would retarget its
      `click` and a press on a station would stop opening it.

## The rail's contract, round 51

13. **The window has three controls, at the rail's right edge: [−] [+]
    [fit].** Rule 7 ended with one magnifier that took a step in from
    rest and became Fit once the window had moved, and it was one
    control doing two jobs badly: there was no second step in and no way
    back out one notch. The reader, in as many words — *"I don't like
    how it just zooms you a bit and you can't use it to zoom more or
    less; but zoom back to fit timeline is nice."*
    - **− and + zoom about the window's own centre** by a fixed 1.6 per
      press, repeatably, to the same clamps every other gesture obeys
      (`zoomWindow(w, k, 0.5, minWindow(span))`): the padded span out,
      about three days in. About the centre rather than about a pointer,
      because a press has no position. Nine presses walk a six-year war
      to its floor.
    - **fit is kept exactly as it was** — the whole padded span, on a
      short eased glide — because that is the half the reader asked to
      keep.
    - **Each is disabled AT its clamp**, visibly and in `aria-disabled`,
      so the end of the walk is a fact on the screen rather than a press
      that does nothing. The cluster does not exist at all on a saga
      with no extent.
    - The cluster is **pinned to the rail's right edge** and floats over
      the track's right end; the walk (prev / Steps / next) keeps the
      place in the head row it had. Each button is an `.icon-c` with a
      `.glyph` centred by translation (rule 10) — the old magnifier was
      an SVG in a grid cell beside a label that hides on a phone, and
      measured 20 px left of its own button's middle. 28 px targets on a
      desktop, 44 on a phone.
    - **Keyboard**: `-`, `+` (and `=`) and `0` while the rail has focus.
    - The old control's two-breath first-mount pulse went with it. There
      are three visible controls now and they are stated in a row; an
      affordance that waves at a reader who can already see it is a nag.

14. **A band paints its own extent, clipped to the window — never the
    window's.** A period's underline was `railX(uEnd) - railX(u)`, a
    length in WINDOW space, so it grew without limit as the reader
    zoomed: measured on World War II at June 1944 the Holocaust's band
    was 15 372 px on a 1280 px rail, and at a week in 1942 four bands
    ran the full width of a rail with no station on it at all. *"When
    you zoom in a timeline, underlines for every step stretch the more
    you zoom and eventually stretch from one side of the zoomed timeline
    to the other."*
    - `clipBand(from, to, width)` cuts the period to the window and
      returns **where it was cut**: `openL` / `openR` for an end that
      continues past an edge, `through` for a period that contains the
      whole window.
    - An open end **fades out** over 22 px instead of butting hard
      against the edge, so the band reads as "continues" rather than as
      "stops here" — a hard edge at a window boundary is a claim about
      time the data does not make.
    - A period that **contains the whole window** becomes a hairline
      continuation strip at 0.3 opacity. At that zoom the reader's cue
      is the station and its label; a rail-wide underline is not one,
      and several stacked are noise.
    - A period **entirely off the window paints nothing**. Stations off
      the window are still laid out — they are still facts, and rule 1
      keeps their positions truthful — but a bar from a mark 15 000 px
      away is not a fact about what is on screen.
    - Positions are untouched: crowding costs lanes, never positions.
