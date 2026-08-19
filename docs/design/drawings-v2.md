# Drawings v2: nicer ink, and every event may carry it

Status: contract, round 60. Author: architect session.

User's brief: *"Think about doing a nicer custom drawings of operations.
Also events themselves should be able to show custom drawings."*

## Part 1 — the renderer draws nicer ink

The vocabulary (route, frontline, thrust, marker, label) is right; the
rendering is serviceable but flat. Upgrades, each judged by screenshot:

1. **Casing.** Every stroke (frontline, thrust outline) gets a thin casing in
   the map-ground colour beneath it, the way the app's own frontiers and
   every serious atlas separate ink from a busy ground. One constant, both
   map modes.
2. **Smoothed thrusts.** A thrust spine is authored as a handful of points
   and currently renders as chords. Run it through the same smoothing the
   routes get (one owner for curves stays true: reuse `routePolyline`'s
   machinery), keep the arrowhead on the smoothed end tangent. An axis of
   advance should look drawn by a staff officer, not a plotter.
3. **Frontline ticks.** Optional `ticks: 'left' | 'right'` on a frontline:
   short perpendicular teeth on the named side, the standard "held ground
   faces this way" mark. Default none — existing data unchanged.
4. **New layer kind: `zone`.** A closed ring with a translucent fill and a
   dashed edge — a pocket, a siege perimeter, a bridgehead, an occupation
   area. The one thing operations keep needing that no current kind says.
   Schema: `{ type: 'zone', ring: GeoPath, label?, color?, at? }`. Rendered
   as a cap (same tessellation path the selection cap uses), fill ~18%
   opacity, dashed outline. Validated everywhere the other kinds are
   (build_event_chunks.py, eventsData.test.ts, isDrawing).
5. **Labels** keep their style; check halo contrast over the hatch and both
   map modes.

## Part 2 — selection shows an event's drawing

Today ink renders only through FOCUS (`focusDrawing` requires `focused`), so
a plain event's drawing is unreachable ground: the panel opens, the map shows
the generic area cap, and the drawing the author made never appears. New
rule, one sentence: **a selected event with a `drawing` shows it.**

- `focusDrawing` (rename stays; it is still "the ink on the map") falls back
  to the SELECTED item's resolved drawing when there is no focus. Same
  resolver (`resolveFocusInk`), no steps, mode-aware.
- The cap-supersession rule at GlobeView (drawing beats footprint) extends
  to selection for the same item.
- Deselect clears it; opening a saga still behaves exactly as sagas.md says
  (focus wins over selection when both exist).
- Tests: store-level (selection with drawing → ink; focus still wins;
  deselect clears) and one e2e screenshot of a plain drawn event.

## Part 3 — the corpus learns to draw (content agent, after 1+2 land)

Events that describe movement or extent in words get it in ink, using the
full v2 vocabulary. Battles with documented axes get thrusts and battle
crosses; sieges get a `zone` perimeter; treaties that moved a line can show
the line. Authoring rules unchanged (colours default to tag; `at` for
stepped events per lib/steps.ts). Quality bar: a drawing must be checkable
against the event's own text — no invented arrows.

## Non-goals

No animation of drawings (motion stays the routes' flow only). No freehand
SVG import — a drawing stays data. No per-drawing style overrides beyond
colour; the app's hand stays one hand.

## Round 64 — overview-only layers: `at: 'overview'`

The user wants saga OVERVIEWS: before the first step, a drawing that shows
the operation whole — dated battle markers, sparse arrows — the summary map
a chapter opens with. The schema could not say it. As built, a layer's `at`
had two forms and both are wrong for this ink:

- **no `at`** (timeless) is drawn on the overview AND in every step — an
  overview marker crowd would clutter all eleven of them;
- **`at: year|fraction`** (dated) is drawn on the overview and in the single
  step whose window contains it — read from `resolveFocusInk`: the overview
  branch returns the drawing WHOLE (rule 1, same object), so dated layers do
  NOT vanish from the overview; what is impossible is ink that appears
  *only* there.

The smallest honest extension is a third value of the field that already
answers "when is this layer true": **`at: 'overview'`** — drawn whenever no
step is open (the saga overview, before the first step and after stepping
back out), hidden inside every step.

**Resolution stays in ONE place.** `keepsLayer` (lib/steps.ts) gains one
clause — `'overview'` belongs to no step — and the overview side needs no
rule at all, because rule 1 already returns the drawing whole. The full
semantics, as pinned by tests/steps.test.ts:

| layer \ view      | overview (no step open) | step S open                |
| ----------------- | ----------------------- | -------------------------- |
| timeless (no at)  | drawn                   | drawn                      |
| dated (number)    | drawn                   | drawn iff S's window owns it |
| `'overview'`      | drawn                   | hidden                     |

Consequences that fall out rather than being built: selection ink outside
focus mode (Part 2 above) resolves with no step, so a selected saga shows
its summary map too; an entrance previews its child's OVERVIEW (sagas.md
rule 15), so the child's summary map is exactly what the preview shows —
unchanged, and now nameable. Label rendering is untouched: the filter runs
before the renderer ever sees a layer.

**Validated in the three places all drawing fields are.** Structurally
(`isDrawingSpec`: a finite number or the one literal); contextually
(`check_drawing` in build_event_chunks.py: `'overview'` only on an event
that HAS steps — on a stepless event it could only mean "always", which is
spelt by omitting `at` — and never on a STEP's own drawing, whose ink exists
only inside its step); and over the shipped corpus (eventsData.test.ts,
which also keeps the dated-partition test honest: "dated" now means a
numeric `at`).

Content is Part 3's agent's to write; this round shipped the schema, the
resolver rule and the checks. Known limit, stated in a test: on a stepless
event the runtime degenerates `'overview'` to timeless (the resolver never
filters), and the build script is what keeps the corpus from relying on it.

## Round 68 — strengths on the strokes, and the military-map glyphs

User's brief, verbatim: *"I want to see things like for example troop counts
on some arrows"* and *"Make it so that really custom paintings are possible -
for example in wwii you can have nato markings on divisions and stuff like
that. Paint fortresses."*

### `strength` — free text on a thrust or a frontline

`ThrustSpec` and `FrontlineSpec` gain optional **`strength?: string`** — free
text on purpose ("250,000", "6 divisions", "Second Army"): a count, an
echelon and a name are all things an operational map writes on an arrow, and
the schema has no opinion about which. Rendering (lib/drawingLayer.ts):

- On a **thrust**: set at the smoothed spine's midpoint BY ARC LENGTH
  (`midOf`), laid along the mid-tangent (`textAngleDeg` — kept upright,
  flipped 180° rather than ever reading upside-down), sized with the shaft's
  own width (√ of the width ratio, clamped 0.8–1.6 em). It reads as writing
  ON the arrow.
- On a **frontline**: set at the first path's midpoint, unrotated — a front
  is one front and one count, so a multi-path front writes it once.
- Both are `.drawing-label--strength`: the map-label style (small caps,
  haloed, the paper variant inverting halo and ink), a hair smaller than a
  place name so a count never outranks the ground it crosses. Zoomed far out
  they go with every other drawing label (`LABEL_SPAN_RATIO`).

### `unit` and `fortress` — MarkerStyle grows the military vocabulary

- **`unit`** — the NATO APP-6 friendly-unit frame: a rectangle (w:h = 3:2),
  monochrome line-art in the layer's colour (a two-sided battle already
  says allegiance with per-layer colour overrides). Optional
  **`unitType?: 'infantry' | 'armor' | 'cavalry' | 'artillery' | 'mixed'`**
  draws the interior device — the saltire, the oval, the single diagonal,
  the filled dot, the saltire over the oval — and optional
  **`unitSize?: string`** sets the echelon above the frame as small text
  ('X' brigade, 'XX' division, 'XXX' corps, 'XXXX' army; free string).
- **`fortress`** — the trace italienne in plan: five pointed bastions round
  a pentagon, in outline.

Construction: line art is the SAME triangle-fan machinery every glyph uses.
An outline is `outlineBand` — the band between the ring offset outward and
inward by `GLYPH_STROKE` (mitred corners shared between neighbouring quads,
so nothing overlaps and nothing double-blends, the round-63 lesson); the
infantry saltire is ONE closed 12-point ring (the battle cross's own
construction, stretched to the frame's corners) for the same reason. Both
glyphs scale in degrees of arc, take the two-pass casing (`markInk`, strokes
growing by `CROSS_CASING_BAR` of the outset like the cross's bars), and read
on both grounds.

**Validated in the three places all drawing fields are**: `isDrawingSpec`
(structural, including "unit fields only on a unit frame" — the same layer
states both, so it is structural), `check_drawing` in
scripts/build_event_chunks.py, and over the corpus in
tests/eventsData.test.ts. Geometry pinned in tests/drawingLayer.test.ts
(band and device polygon counts, saltire closure, casing growth) and
photographed at two zooms in both map modes (tests/e2e/drawings.e2e.mjs,
the `r68*` cameras).

Known limits, stated: the `mixed` device's saltire crosses its oval in four
small patches that blend twice (~5% lightening over a few pixels — accepted
against computing the union outline of an X and an ellipse); a strength
label's rotation is the geographic bearing against a north-up screen, so
away from the frame's centre meridian convergence tilts it a few degrees
(a CSS2D label is placed per build, not per frame). Content is the corpus
pass's to write; this round shipped the schema, the renderer and the checks.
