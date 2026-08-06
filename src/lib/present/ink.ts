import { featureOf, pointFeatures, type HistoricalEvent } from '../events'
import {
  areaOutlineFor,
  routeDrawingFor,
  type Drawing,
  type DrawingSpec,
} from '../drawing'
import { keepsLayer, stepOwner, type Step } from '../steps'
import { PAPER } from '../drawnTile'
import type { RenderCtx } from './mode'

/**
 * WHAT GOES ON THE GROUND — the two drawings the globe puts under an item, both
 * resolved from the model rather than assembled at the call site.
 *
 * There are exactly two, and keeping them apart is a lifecycle decision that
 * predates this module (see the two `DrawingLayer` instances in GlobeView):
 *
 *  · SELECTION ink follows the *selection* — up when the panel opens on an
 *    event, gone when it closes. Routes, the outline of a footprint, the
 *    secondary sites the event names. Cheap, and true of the event as a whole.
 *  · FOCUS ink follows *focus mode* — the authored battle plan, filtered to
 *    whichever step the reader has stepped into. Expensive, and a request to
 *    study the thing rather than glance at it.
 *
 * Both are pure functions of an event (and, for focus, a step id), which is what
 * makes them testable without a scene and what stops them going stale: they are
 * rebuilt from the data, never cached against it.
 */

/** How heavy an area's outline is drawn, in screen pixels, per mode. */
export const OUTLINE_WIDTH = { realistic: 2, schematic: 1.4 } as const

/**
 * INK ON PAPER — a colour chosen against a dark photograph, re-aimed at pale
 * parchment.
 *
 * Every accent on this globe was picked against Blue Marble: a night-blue sea,
 * a dark continent, a black sky. Nine of the fourteen tag colours and every one
 * of the nation colours sit in the top half of the value range because that is
 * what reads on black — `#ffe27a` for the selected pin's ring, `#b09a72` for
 * Sumer's border. Put the same colours on the drawn map's paper (`#ece2c8`
 * land, `#d3c8a8` sea) and the pale ones are gone: measured as luminance
 * contrast against the land tone, Sumer's border is 1.05:1 and the selection
 * ring is 1.11:1 — invisible, not merely quiet.
 *
 * Taking a colour toward the map's own pen fixes it without inventing a second
 * palette: the hue is what carries the meaning (war is red, trade is amber) and
 * the hue survives a mix toward a near-neutral dark. At 0.45 the same two go to
 * 3.4:1 and 3.0:1, which is a drawn line on a drawn map.
 */
export function inkOnPaper(hex: string, mix = 0.45): string {
  const to = PAPER.ink
  const at = (i: number, from: string) => parseInt(from.slice(i, i + 2), 16)
  const ch = (i: number) => Math.round(at(i, hex) * (1 - mix) + at(i, to) * mix)
  if (hex.length !== 7 || hex[0] !== '#') return hex
  return `#${[1, 3, 5].map((i) => ch(i).toString(16).padStart(2, '0')).join('')}`
}

/** …and the same, only where the ground is paper. One call site's worth of `if`. */
export const onGround = (hex: string, ctx: RenderCtx, mix?: number): string =>
  ctx.mode === 'schematic' ? inkOnPaper(hex, mix) : hex

/**
 * Radius of the dot marking a secondary site, in degrees of arc.
 *
 * Small: a named site is a footnote on the map, not a second pin, and the pin it
 * belongs to is already somewhere else on screen saying where the event *is*.
 */
export const SITE_MARKER_DEG = 0.3

/**
 * The marks the selected event puts on the map.
 *
 * Expressed as a `Drawing` and rendered by the same layer the battle plans use.
 * That is the point of the arrangement: there is one piece of code on this globe
 * that knows how to put a line on a sphere, so a voyage and a frontline are at
 * the same altitude, in the same units, with the same depth handling, and a
 * route cannot drift out of step with the dots that mark its ports because they
 * are built from it in one pass.
 *
 * The footprint's OUTLINE rides here rather than with the polygon cap: three
 * globe strokes a polygon with GL_LINES, which no depth offset in WebGL can
 * reach, so the one place on this globe that can put a biased line on a sphere
 * draws it (see `areaOutlineFor`).
 *
 * The one conditional is the plan: while a battle plan is up, the footprint's
 * cap steps aside (see `eventAreas` in GlobeView) and an outline around nothing
 * is a line round a theatre the reader is no longer being shown.
 */
export function resolveSelectionInk(
  event: HistoricalEvent,
  ctx: RenderCtx,
): Drawing | undefined {
  const line = featureOf(event.location, 'line')
  const area = featureOf(event.location, 'area')
  const layers: DrawingSpec[] = [
    ...(routeDrawingFor(line ?? {})?.layers ?? []),
    ...(event.drawing || !area ? [] : [areaOutlineFor(area.ring, OUTLINE_WIDTH[ctx.mode])!]),
    // Every secondary site the event names, as a dot and (when it is named) a
    // word. This is the whole of what a `point` feature draws, and it draws on
    // the selection for the same reason a route does: it is a property of the
    // event that is worth a glance, not a study.
    ...pointFeatures(event.location).flatMap((p): DrawingSpec[] => [
      { type: 'marker', style: 'dot', size: SITE_MARKER_DEG, pos: [p.at.lng, p.at.lat] },
      ...(p.name
        ? [{ type: 'label' as const, size: 'sm' as const, pos: [p.at.lng, p.at.lat] as [number, number], text: p.name }]
        : []),
    ]),
  ]
  return layers.length ? { layers } : undefined
}

/**
 * The plan on the globe: the focused event's drawing as one step shows it.
 *
 * Three cases, and the first is the one the design turns on.
 *
 *  1. NO STEP (the overview, and every event that has no steps) returns the
 *     drawing UNCHANGED — the same object, not a copy — so the renderer's key
 *     comparison (see `DrawingLayer.set`) sees nothing to rebuild when the
 *     reader steps back out. Rule 1 in lib/steps.ts.
 *  2. A STEP filters the parent's layers to the timeless ones plus the ones its
 *     window owns (`keepsLayer`), which is how the June front and the December
 *     front stop being on the map at the same time.
 *  3. …and then MERGES the step's own drawing over the top, if it has one. Order
 *     is the merge: the step's ink is appended, so it is drawn last and reads as
 *     an overlay on the filtered plan rather than as more of it. This is the
 *     half a step could not do before — a step used to be able only to subtract.
 *
 * An unknown step id falls back to the overview rather than to nothing: it can
 * only come from a stale link or a chunk that has not loaded, and answering "I
 * do not know that step" with an empty map is worse than answering with the
 * whole thing.
 */
export function resolveFocusInk(
  event: HistoricalEvent,
  stepId: string | undefined,
  _ctx: RenderCtx,
): Drawing | undefined {
  const steps: readonly Step[] = event.steps ?? []
  const base = event.drawing
  if (!stepId || !steps.length) return base
  const step = steps.find((s) => s.id === stepId)
  if (!step) return base
  // The windows are built ONCE here and reused for every layer: this is the one
  // caller with a list to walk, and `layerInStep` is the same predicate for a
  // caller with a single layer.
  const kept = base?.layers.filter(keepsLayer(stepId, stepOwner(steps, event.time))) ?? []
  const layers = [...kept, ...(step.drawing?.layers ?? [])]
  return layers.length ? { layers } : undefined
}
