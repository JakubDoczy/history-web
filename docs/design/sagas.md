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

- **war** — crossed swords.
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
