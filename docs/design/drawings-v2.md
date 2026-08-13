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
