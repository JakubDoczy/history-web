import { atFraction, orderedSteps, stepFraction, type Step } from '../steps'
import { timeEnd, timeStart, type Time } from '../time'
import { resolveStepChip, type StepChip } from './saga'

/**
 * THE SAGA TIMELINE — the arithmetic of a rail whose landmarks are steps.
 *
 * While a saga is on the map the bottom rail stops being a map of *time* and
 * becomes a map of *this event*: its span, drawn straight, with its steps as
 * stations along it. Everything the view needs to draw that is here, as pure
 * functions, because all three hard parts of it are arithmetic and none of them
 * is anything a component should be improvising in a `:style` binding.
 *
 * ---------------------------------------------------------------------------
 * 1. THE SPACE IS THE STEPS' OWN — FRACTIONS, NOT YEARS
 * ---------------------------------------------------------------------------
 *
 * A step's time is written as a year *or* as a fraction of the event's span
 * (lib/steps.ts, rule 3), and the two are compared in fraction space. This rail
 * is drawn in that same space, and it has to be: D-Day is dated 1944 — a point
 * — so in year space every one of its four steps lands on the same pixel and
 * the timeline is a single dot. In fraction space the same four steps are
 * spread across the rail in the order and the proportion they were authored in.
 * For a multi-year saga the two spaces are the same thing, since `atFraction`
 * is linear in the years: World War II's stations sit where 1941 and 1944 sit.
 *
 * ---------------------------------------------------------------------------
 * 2. THE CLICK TARGET IS THE STEP'S WINDOW, WIDENED UNTIL IT CAN BE HIT
 * ---------------------------------------------------------------------------
 *
 * `stepWindows` already answers "which step owns this moment": from a step's own
 * start up to (not including) the next one's, with the first window open at the
 * beginning and the last at the end. That is exactly the rule this rail needs
 * for the pointer — the pixel you pressed is a moment, and the step that owns
 * the moment is the one you meant — so the slabs here are those windows in
 * pixels rather than a second, competing rule about proximity.
 *
 * What the windows cannot do on their own is be *pressable*. World War II ends
 * with four steps inside its last 7% (Trinity, Hiroshima, VJ Day), and their
 * windows are ten pixels wide on a laptop and less on a phone. So the slab
 * EDGES are relaxed to a minimum width — a monotone push right, then a push
 * back left, which is the smallest change that gives every step a target and
 * cannot reorder them — and the station's mark is then clamped into its own
 * slab so that pressing the dot always selects the dot you pressed. The mark's
 * true position is kept (`trueX`) and the view draws a hairline there when the
 * two differ: the rail admits the compression rather than hiding it.
 *
 * ---------------------------------------------------------------------------
 * 3. A LABEL IS SHOWN WHEN THERE IS ROOM FOR ONE
 * ---------------------------------------------------------------------------
 *
 * Eleven names of up to forty characters do not fit on one line of a 1280 px
 * rail, and the answer the chips gave — scroll, and let the reader hunt — is the
 * problem this replaces. So labels take two rows when one will not do (a station
 * then has the room of its slab *and* its neighbour's, which is the whole gain),
 * are truncated to the room they have, and drop out entirely below the width at
 * which a truncation would say nothing. A dropped label is not lost: the view
 * shows it on hover, on the keyboard cursor and on the open step, which are the
 * three states in which the reader is asking about one station rather than
 * reading the row.
 */

/** Blank rail left at each end, as a fraction of the width: the span needs air. */
export const RAIL_PAD = 0.05

/** The smallest a station's target may be. A thumb, per the platform guidance. */
export const MIN_SLAB_PX = 44

/** Below this there is no room for a name worth truncating to. */
export const MIN_LABEL_PX = 56

/**
 * Rough width of a character at the rail's label size — deliberately a little
 * generous. It is only ever asked "does this name WANT more room than there
 * is", and both answers that follow (stack the labels, hang this one the other
 * way) are safe when it over-estimates and wrong when it under-estimates. It is
 * never used to cut a label short: that is the room the layout found, which is
 * measured in real pixels.
 */
export const LABEL_CHAR_PX = 6.4

/** Air between a label and the next station's mark. */
const LABEL_GAP_PX = 10

/** How many rows of labels the rail will stack before it gives up on some. */
const MAX_LABEL_ROWS = 2

/** A step, as a landmark on the rail. */
export interface Station {
  step: Step
  /** What pressing it does — a page of this saga, or a descent (see `StepChip`). */
  kind: StepChip['kind']
  /** 1-based position in time order: what the mark is numbered with. */
  ordinal: number
  /** When it happens, in 0..1 of the saga's span. */
  u: number
  /** Where it stops. Equal to `u` for a moment; greater for a period. */
  uEnd: number
}

/** A station with its geometry on a rail of a known width. */
export interface PlacedStation extends Station {
  /** The mark, in px — inside its own slab, so pressing it selects it. */
  x: number
  /** Where its time really is, before the slab minimum moved it. */
  trueX: number
  /** A period's band, in px. Absent for a moment. */
  band?: { x: number; w: number }
  /** Its half-open slab `[from, to)` — the pointer target, and its label's room. */
  from: number
  to: number
  /** Which label row it is on (0-based). */
  row: number
  /** Room the label has at rest, in px; 0 means "only when asked about". */
  labelPx: number
  /**
   * Does the whole name hang to the LEFT of the mark?
   *
   * Only the last stations on a rail need it, and only in the state where the
   * label is shown whole (the cursor, the open step, a hover): a name reaching
   * past the right-hand end would either be clipped or make the rail scroll for
   * no reason. The era rail's cursor flag flips for the same reason and at the
   * same edge (`flagSide` in lib/selection.ts).
   */
  flip: boolean
}

export interface RailLayout {
  /** The width the stations are laid out over — the element's, or wider (scroll). */
  width: number
  /** How many rows the labels are stacked in. */
  rows: number
  stations: PlacedStation[]
}

/**
 * The steps of a saga as stations, in time order.
 *
 * Ordered by `orderedSteps` rather than trusted, for the reason the chips were:
 * the sequence is the whole of what a timeline says, and it must not depend on
 * the order someone typed the objects in.
 */
export function stations(steps: readonly Step[], span: Time): Station[] {
  return orderedSteps(steps, span).map((step, i) => ({
    step,
    kind: resolveStepChip(step).kind,
    ordinal: i + 1,
    // Clamped, because a fraction-form time is authored in 0..1 and a year-form
    // one is already clamped by `atFraction`: anything outside is a data error
    // the validator catches, and a station off the end of its own rail would be
    // unreachable rather than merely wrong.
    u: clamp01(stepFraction(step, span)),
    uEnd: clamp01(atFraction(timeEnd(step.time), span)),
  }))
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : v < lo ? lo : v > hi ? hi : v)

/**
 * How wide the rail is drawn.
 *
 * Normally the element's own width. When there are more stations than will fit
 * at a pressable size the rail grows past it and the view scrolls — a phone
 * showing eleven stations cannot honour a 44 px target any other way, and
 * shrinking the targets instead would break the one rule that has a number in
 * it.
 */
export const railWidth = (clientWidth: number, count: number): number =>
  Math.max(clientWidth, count * MIN_SLAB_PX)

/** Where a fraction of the span sits on a rail of this width, padded at both ends. */
export const railX = (u: number, width: number, pad = RAIL_PAD): number =>
  (pad + u * (1 - 2 * pad)) * width

/**
 * The slab edges: `[0, x1, x2, …, width]`, widened so no slab is thinner than
 * `min` and never reordered.
 *
 * Forward, then backward. The forward pass pushes each edge right until its
 * slab is wide enough, which fixes every slab but can run the last one past the
 * end; the backward pass pulls edges left off the right-hand wall, and because
 * it walks downwards, an edge it moves is followed by the one behind it. With
 * `min` capped at `width / n` the two passes together always land on a monotone
 * solution — the smallest displacement that makes every slab hittable.
 */
export function slabEdges(xs: readonly number[], width: number, min: number): number[] {
  const n = xs.length
  if (!n) return [0, width]
  const m = Math.min(min, width / n)
  const edges = [0, ...xs.slice(1), width]
  for (let i = 1; i < n; i++) edges[i] = Math.max(edges[i], edges[i - 1] + m)
  for (let i = n - 1; i >= 1; i--) edges[i] = Math.min(edges[i], edges[i + 1] - m)
  return edges
}

/** The room a name wants, in px — the same eyeballed metric the era bands use. */
export const labelWidth = (name: string): number => name.length * LABEL_CHAR_PX + 4

/**
 * How many rows the labels need: one if every name fits beside its own station,
 * two if stacking buys any of them the room. Never more — a third row is taller
 * than the rail and a reader cannot follow a name back to its mark across it.
 */
export function labelRows(edges: readonly number[], xs: readonly number[], names: readonly string[]): number {
  for (let rows = 1; rows < MAX_LABEL_ROWS; rows++)
    if (names.every((name, i) => labelRoom(edges, xs, i, rows) >= labelWidth(name))) return rows
  return MAX_LABEL_ROWS
}

/** Room from a station's mark to the next mark ON ITS OWN ROW. */
const labelRoom = (edges: readonly number[], xs: readonly number[], i: number, rows: number): number =>
  Math.max(0, (xs[i + rows] ?? edges[edges.length - 1]) - xs[i] - LABEL_GAP_PX)

/**
 * The whole geometry of the rail: where each station's mark, band, target and
 * label go, for a given element width.
 */
export function layoutRail(sts: readonly Station[], clientWidth: number): RailLayout {
  const width = railWidth(clientWidth, sts.length)
  if (!sts.length) return { width, rows: 1, stations: [] }
  const trueXs = sts.map((s) => railX(s.u, width))
  const edges = slabEdges(trueXs, width, MIN_SLAB_PX)
  // The marks, each clamped into its own slab: after the widening a step's true
  // moment can lie under its neighbour's target, and a mark you cannot press is
  // worse than a mark a few pixels from its date. A mark normally sits ON the
  // left edge of its own slab — that is what a half-open window means — so half
  // of the drawn dot overhangs the slab before it; the view draws the marks
  // inside their own buttons, which are painted in order, so the overhanging
  // half still belongs to the station it is drawn for.
  const xs = trueXs.map((x, i) => clamp(x, edges[i], edges[i + 1]))
  const rows = labelRows(edges, xs, sts.map((s) => s.step.name))
  return {
    width,
    rows,
    stations: sts.map((s, i) => {
      const room = labelRoom(edges, xs, i, rows)
      const bandEnd = s.uEnd > s.u ? clamp(railX(s.uEnd, width), xs[i], width) : undefined
      return {
        ...s,
        x: xs[i],
        trueX: trueXs[i],
        band: bandEnd === undefined ? undefined : { x: xs[i], w: bandEnd - xs[i] },
        from: edges[i],
        to: edges[i + 1],
        row: i % rows,
        // The ROOM, not the guess at the name's width: the cap exists to keep a
        // label off its neighbour, and capping it at an estimate of its own
        // width instead put an ellipsis on names that had a clear rail in front
        // of them the moment the estimate was a pixel short.
        labelPx: room >= MIN_LABEL_PX ? room : 0,
        flip: xs[i] + labelWidth(s.step.name) > width,
      }
    }),
  }
}

/**
 * Which station a pixel belongs to — the pointer's answer, and the same tiling
 * `stepOwner` uses over time (half-open, both ends left open).
 *
 * The view gives each slab its own button, so this exists for the tests and for
 * anything that has a coordinate rather than an event target.
 */
export const stationAt = (rail: RailLayout, x: number): PlacedStation | undefined =>
  rail.stations.find((s, i) => (i === 0 || x >= s.from) && (i === rail.stations.length - 1 || x < s.to))

/* ------------------------------------------------------------- the breadcrumb */

/** One rung of the focus stack, as the rail names it. */
export interface Crumb {
  id: string
  name: string
  /** The innermost one: where the reader is. Pressing it means "the whole of it". */
  current: boolean
}

/**
 * The stack, named — "World War II ▸ D-Day landings".
 *
 * The trail is the focus stack itself (stores/events.ts), so the crumbs are a
 * *reading* of navigation state rather than a second copy of it: descend and a
 * crumb appears because the stack grew, pop and it goes because the stack
 * shrank. Nothing here can disagree with where the app actually is.
 */
export const crumbs = (trail: readonly { id: string; name: string }[]): Crumb[] =>
  trail.map((i, n) => ({ id: i.id, name: i.name, current: n === trail.length - 1 }))

/**
 * How many presses of the panel's own "back" it takes to get from here to an
 * ancestor crumb — 0 if it is not on the stack.
 *
 * Composed of the existing rung-at-a-time ladder rather than a new "go to level
 * N" transition, because the ladder is what every other way out of the mode
 * uses (`focusBack`, Escape, the pill's close) and a second path with its own
 * rules is exactly how the two would come to disagree. The first press is spent
 * on the SELECTION when the panel is open on a part of the context rather than
 * on the context itself: that is the rung `focusBack` takes first, and the
 * crumb has to pay for it or it stops one level short.
 */
export function backPressesTo(
  stack: readonly string[],
  selectedId: string | undefined,
  target: string,
): number {
  const top = stack[stack.length - 1]
  const at = stack.lastIndexOf(target)
  if (top === undefined || at < 0) return 0
  const onAPart = selectedId !== undefined && selectedId !== top ? 1 : 0
  return onAPart + (stack.length - 1 - at)
}
