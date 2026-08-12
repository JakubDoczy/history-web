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
import type { BorderRing, FrontierInk } from '../nations'

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
 * HOW A POLITY IS FILLED, and whether its coast is inked — the two decisions
 * the clipped nations data makes possible, and they differ by ground.
 *
 * The fill exists in both modes because it has to: once a polity is cut against
 * the coastline, most of its boundary IS the coastline, and an outline-only
 * island would be an island with nothing drawn on it. It is a wash rather than a
 * colour — a border is still meant to read as a drawn line.
 *
 * The alpha differs because the grounds do. On the drawn map the ground is
 * `#ece2c8` parchment and the ink is already taken toward the map's own pen
 * (`inkOnPaper`), so a low wash separates cleanly and a heavier one would turn
 * the paper into a poster. On the satellite photograph the ground is a dark,
 * busy, high-variance image — coastline, cloud shadow, desert, ice — and the
 * same alpha over it is not a tint, it is noise; it needs half again as much to
 * read as a deliberate colour at all.
 *
 * COASTAL INK is the decision the design asked to be made by looking, and the
 * answer came out different in the two modes:
 *
 *  · SCHEMATIC — off. The drawn map inks every coastline itself, in its own pen,
 *    with an eleven-pixel shoreline wash over the top of it. A polity's outline
 *    drawn there as well is a second coastline in a second colour a hair off the
 *    first: at world view it reads as a thickened, muddied shore, and at any
 *    zoom where the two lines separate it reads as an error, because it IS one.
 *    Only the frontier is inked, and the wash meeting the map's own coast is
 *    what says where the polity ends.
 *  · REALISTIC — on. There is no coastline drawn on the photograph; the shore is
 *    a change of colour in an image, which is not a line, and on the night side
 *    it is not even that. The two were photographed side by side at Japan in
 *    1900 (/tmp/shots52/nations/{after,nocoastink}-h-japan1900-realistic.png):
 *    with the coastal edges inked the islands are a country, a crisp pale
 *    outline against the sea; without them they are a brown wash whose edge
 *    dissolves into a dark ocean, and Hokkaido stops being a shape at all. The
 *    doubling that motivates dropping them in map mode cannot happen here,
 *    because there is no first line to double — so the flag is per mode, and
 *    this is the mode that keeps the whole outline.
 */
export const NATION_FILL_ALPHA = { realistic: 0.24, schematic: 0.16 } as const
export const COASTAL_INK = { realistic: true, schematic: false } as const

/**
 * THE MODERN STATES' PEN — quieter than a polity's, and neutral.
 *
 * A modern frontier is context: it is the only political line on this globe
 * that is not an answer to the year the reader chose, so it is the only one
 * drawn in no colour at all. The pale grey reads on the photograph as it
 * stands; on paper `inkOnPaper` takes it a fifth of the way to the map's pen
 * rather than the 0.45 a polity border gets, which lands it at about 2.7:1
 * against the land tone — under a polity's 3.0-3.4, which is the whole point.
 * A whisper, and legible.
 */
export const MODERN_BORDER = { color: '#9aa0a8', mix: 0.2 } as const

/**
 * WHO INKS WHICH BORDER, when both layers are on the globe at once.
 *
 * From `MODERN_FROM` the globe draws Natural Earth's surveyed frontiers, and
 * the historical corpus still draws the United States, China and India in those
 * years with hand-authored extents whose frontiers are hundreds of kilometres
 * off the same lines. Drawing both is two pens on one border — the defect this
 * whole rework exists to remove — so while the modern set is on, a polity keeps
 * its wash, its label and (on the photograph, where nothing else draws a shore)
 * its coastline, and gives up its frontier.
 *
 * It is a function of the ENTRY LIST rather than of the year because that is
 * what the caller has and what the test can build: `modern` is the store's
 * modern entries, nought or one, and the plan is the two accessors the ink
 * layer takes.
 */
export function frontierInkPlan(
  modern: readonly BorderRing[],
  ctx: RenderCtx,
): { colorOf: (e: BorderRing) => string; inkOf: (e: BorderRing) => FrontierInk } {
  const isModern = (e: BorderRing) => modern.includes(e)
  const yielded = modern.length > 0
  return {
    colorOf: (e) =>
      isModern(e)
        ? onGround(MODERN_BORDER.color, ctx, MODERN_BORDER.mix)
        : onGround(e.nation.color, ctx),
    inkOf: (e) =>
      isModern(e)
        ? 'all'
        : COASTAL_INK[ctx.mode]
          ? yielded
            ? 'coast'
            : 'all'
          : yielded
            ? 'none'
            : 'frontier',
  }
}

/**
 * INK ON PAPER — a colour chosen against a dark photograph, re-aimed at pale
 * parchment.
 *
 * Every accent on this globe was picked against Blue Marble: a night-blue sea,
 * a dark continent, a black sky. Nine of the fourteen tag colours and every one
 * of the nation colours sit in the top half of the value range because that is
 * what reads on black — `#ffe27a` for the selected pin's ring, `#b09a72` for
 * Sumer's border. Put the same colours on the drawn map's paper (`#ece2c8`
 * land, `#b1bfbb` sea) and the pale ones are gone: measured as luminance
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
 * THE MARK AND ITS CASING — round 52, and the reported defect is the whole of it.
 *
 * *"In steps, 'x' mark is a bit too hard to see on the map."* Measured on the
 * Kiev step of Barbarossa over the drawn map: the battle cross is authored
 * `#ffd7a8`, a pale peach picked — like every accent on this globe — against a
 * night-blue photograph. On `#ece2c8` parchment that is 1.16:1, which is not a
 * quiet mark, it is no mark; the reader was navigating by the LABEL, and the
 * three crosses on the D-Day plan were photographed with nothing under their
 * captions at all. On the satellite ground the same cross does read, but it is
 * drawn in the same family as the thrust ribbons it sits on and has no casing,
 * so it dissolves exactly where a pocket closes — on top of the arrow.
 *
 * Two tones per ground, and they are opposite tones on purpose:
 *
 *  · ON PAPER the mark is INK — the accent taken toward the map's own pen, at a
 *    heavier mix than a border gets. `#ffd7a8` at 0.55 is `#8c7559`, 3.2:1
 *    against the land: a drawn symbol on a drawn map. The casing is then the
 *    paper's own highlight, a reserved halo of the kind a cartographer leaves
 *    round a symbol so it is not read as part of what it stands on. That is what
 *    lifts the cross off the orange ribbon underneath it.
 *  · ON A PHOTOGRAPH the mark keeps the colour it was chosen for, and the casing
 *    is the route casing — the same near-black at a little more weight, because
 *    a glyph's rim is a thinner thing than a line's. One treatment, two grounds,
 *    and the rule that decides between them is the ground, not the call site.
 *
 * `mix` is 0.55 rather than the 0.45 a nation border gets because a mark is
 * SMALL: a border is hundreds of pixels of line and can afford to be quiet, and
 * a cross is twelve pixels across and cannot.
 */
export const MARK_MIX = 0.55

/** The paper's own highlight: the reserved halo a symbol is set in. */
export const MARK_CASING_PAPER = { color: '#fdf8ea', opacity: 0.92 } as const
/** …and on a photograph, the route casing, a shade heavier for a smaller mark. */
export const MARK_CASING_DARK = { color: '#03070d', opacity: 0.55 } as const

export interface MarkInk {
  /** The glyph itself. */
  fill: string
  /** The tone it is set in, drawn one step wider and underneath. */
  casing: string
  casingOpacity: number
}

/** How a small glyph is inked on the ground it landed on. */
export function markInk(hex: string, ground: 'dark' | 'paper'): MarkInk {
  const c = ground === 'paper' ? MARK_CASING_PAPER : MARK_CASING_DARK
  return {
    fill: ground === 'paper' ? inkOnPaper(hex, MARK_MIX) : hex,
    casing: c.color,
    casingOpacity: c.opacity,
  }
}

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
