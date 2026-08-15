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
