import { atFraction, orderedSteps, stepFraction, stepTimeYears, type Step } from '../steps'
import { formatYear, timeEnd, timeExtent, timeStart, type Time, type Year } from '../time'
import { resolveStepChip, type StepChip } from './saga'

/**
 * THE SAGA TIMELINE — the arithmetic of a rail whose landmarks are steps.
 *
 * While a saga is on the map the bottom rail stops being a map of *time in
 * general* and becomes a map of *this event's own time*: its span, ruled, with
 * its steps standing where they happened. Everything the view needs to draw that
 * is here, as pure functions.
 *
 * ---------------------------------------------------------------------------
 * 1. IT IS A TIMELINE, SO THE POSITIONS ARE TRUE
 * ---------------------------------------------------------------------------
 *
 * The first cut of this rail widened every station's target to 44 px — a thumb —
 * and clamped the mark into the widened slab. It was a defensible rule and it
 * was the wrong one: it made the four steps in the last 7% of the war look like
 * four steps spread over a quarter of it, and a reader looking at it could not
 * see time in it at all ("it's spaced uniformly, not according to when it
 * happened"). Legibility had been bought with the one thing a timeline is for.
 *
 * So there is no relaxation any more. A station sits at `railX(u)` and nowhere
 * else; when two moments are eleven pixels apart their marks are eleven pixels
 * apart. What crowding costs is *lanes*, not truth: a mark with no room beside
 * its neighbour drops to the next row down and hangs off the axis by a stem, so
 * the pile-up at the end of a war reads as a pile-up (see `laneOf`). Reaching a
 * crowded station with a thumb is answered elsewhere entirely — by the rail's
 * prev/next and its list of every step (`stepBy`), which is the second half of
 * the dual system the reader asked for.
 *
 * ---------------------------------------------------------------------------
 * 2. THE SPACE IS THE STEPS' OWN — FRACTIONS, WHICH ARE THE YEARS
 * ---------------------------------------------------------------------------
 *
 * A step's time is written as a year *or* as a fraction of the event's span
 * (lib/steps.ts, rule 3), and the two are compared in fraction space. This rail
 * is drawn in that same space, and for a saga with a real span the two are the
 * same picture: `atFraction` is linear in the years, so u = 0.28 of 1939–1945
 * *is* 1940.7, and the axis below can be ruled in years over the same map.
 *
 * A saga dated to a single year (Barbarossa is a point at 1941) has no extent
 * for a rule to divide. Its fractions are proportions of the campaign rather
 * than dates, and the axis says so by having no ticks in it — see `axisTicks`.
 * Inventing months for it would be the rail claiming a precision the corpus does
 * not have.
 *
 * ---------------------------------------------------------------------------
 * 3. A LABEL IS SHOWN WHEN THERE IS ROOM FOR ONE
 * ---------------------------------------------------------------------------
 *
 * Eleven names of up to forty characters do not fit on one line of a 1280 px
 * rail. A name is drawn beside its own mark, in its own lane, for as much room
 * as there is before the next mark in that lane, and drops out entirely below
 * the width at which a truncation would say nothing. A dropped label is not
 * lost: the view shows it on hover, on the keyboard cursor and on the open step
 * — the three states in which the reader is asking about one station rather than
 * reading the row — and the step list names every one of them at once.
 */

/** Blank rail left at each end, as a fraction of the width: the span needs air. */
export const RAIL_PAD = 0.05

/**
 * The width the rail gives each station before it starts scrolling.
 *
 * Not a target width any more (see 1 above) — a *sight line*. Eleven stations on
 * a 390 px phone would be four pixels apart whatever the layout does with them,
 * so the rail grows past the element and the view scrolls, which spreads the
 * span rather than distorting it.
 */
export const MIN_STATION_PX = 44

/** Below this there is no room for a name worth truncating to. */
export const MIN_LABEL_PX = 56

/**
 * Rough width of a character at the rail's label size — deliberately a little
 * generous. It is only ever asked "does this name WANT more room than there is",
 * and the answer that follows (hang this one the other way) is safe when it
 * over-estimates and wrong when it under-estimates. It is never used to cut a
 * label short: that is the room the layout found, which is measured in real px.
 */
export const LABEL_CHAR_PX = 6.4

/** Air between a mark and its own label, and between a label and the next mark. */
const LABEL_GAP_PX = 14

/**
 * How close two marks may be in the same lane before the second drops to the
 * next one down. The mark is 16 px across, so this is "touching, plus air".
 */
export const LANE_GAP_PX = 20

/**
 * How many lanes of stations the rail will stack.
 *
 * Three is what the rail is tall enough for, and what the corpus needs: World
 * War II's end-of-war pile-up reaches two on a desktop and three on a phone.
 * Past it the crowding is real and the rail says so — the extra stations share
 * the emptiest lane and overlap, which is an honest picture of four moments in
 * eleven pixels. The list is how they are reached.
 */
export const MAX_LANES = 3

/* ------------------------------------------------------------------ the axis */

/** How the axis is ruled: the unit whose round numbers its ticks are. */
export type AxisUnit = 'year' | 'month' | 'day' | 'none'

/** One mark on the rule. */
export interface Tick {
  /** Where it falls, in 0..1 of the span. */
  u: number
  label: string
  /** Does it open a larger unit — a January on a month rule, a 1st on a day one? */
  major: boolean
}

export interface Axis {
  unit: AxisUnit
  ticks: Tick[]
}

/** Room one tick label wants. The era rail's own density (TimelineBar.vue). */
export const TICK_PX = 110

const DAY = 1 / 365.2425

/**
 * The spacings the axis will rule in, finest first: days, months, years.
 *
 * A day here is a uniform 1/365.2425 of a year rather than a calendar day, which
 * is exact enough over the weeks such a rule would cover and keeps the whole
 * ladder one list of numbers. Nothing in the corpus is dated finely enough to
 * reach it; it exists so that a saga which one day is does not need a new rule.
 */
const SPACINGS: readonly { unit: AxisUnit; years: number }[] = [
  ...[1, 2, 5, 10, 15].map((d) => ({ unit: 'day' as const, years: d * DAY })),
  ...[1, 2, 3, 6].map((m) => ({ unit: 'month' as const, years: m / 12 })),
  ...Array.from({ length: 30 }, (_, i) => [1, 2, 5][i % 3] * 10 ** Math.floor(i / 3)).map((y) => ({
    unit: 'year' as const,
    years: y,
  })),
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Midnight on 1 January of a year, as a timestamp — `Date.UTC` maps 0..99 to
 *  the twentieth century, which is exactly the range a saga can be dated in. */
const jan1 = (y: number): number => {
  const d = new Date(0)
  d.setUTCFullYear(y, 0, 1)
  d.setUTCHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * A fractional year as a calendar month and day — the one place the app's time
 * unit (a real number of years, lib/time.ts) is read as a date.
 *
 * Proleptic Gregorian, through `Date`, which covers every year a saga fine
 * enough to want a month rule could be in. Outside that the answer is nothing
 * and the label falls back to the year, because a month of a year quoted in
 * millions is not a fact about anything.
 */
function calendarOf(t: Year): { m: number; d: number } | undefined {
  if (!Number.isFinite(t) || Math.abs(t) > 9999) return undefined
  const y = Math.floor(t)
  const at = new Date(jan1(y) + (t - y) * (jan1(y + 1) - jan1(y)))
  return { m: at.getUTCMonth(), d: at.getUTCDate() }
}

/**
 * A moment, named at the resolution the axis is ruled in — so nothing on the
 * rail ever claims a precision the rule underneath it does not have.
 *
 * `full` is the difference between a tick (which is read against its neighbours,
 * so "Jun" is enough) and a date in the step list (which is read on its own, so
 * it carries the year).
 */
export function formatAt(t: Year, unit: AxisUnit, full = false): string {
  const cal = unit === 'month' || unit === 'day' ? calendarOf(t) : undefined
  if (!cal) return formatYear(t)
  // The year a date is IN — `formatYear` rounds, and June 1944 is not 1945.
  const y = formatYear(Math.floor(t))
  if (unit === 'day') return `${cal.d} ${MONTHS[cal.m]}${full ? ` ${y}` : ''}`
  return full || cal.m === 0 ? `${MONTHS[cal.m]} ${y}` : MONTHS[cal.m]
}

/**
 * The rule under the stations: where the ticks fall and what they are called.
 *
 * The unit follows the span and the room — years for a war, months for a saga
 * that ran a year, days for one that ran a fortnight — by picking the finest
 * spacing that still leaves the labels their `TICK_PX`. This is the era rail's
 * own idiom (`ticks` in TimelineBar.vue) at a saga's scale; what it does not
 * inherit is the warp, because a saga's span is short enough that display space
 * and year space are the same space.
 *
 * A POINT-DATED saga is the one case with no rule at all: it has no extent, its
 * steps are proportions rather than dates (see 2 above), and the single tick
 * returned is the year itself. The view draws that axis dashed — a rule with no
 * divisions on it, which is what the data supports.
 */
export function axisTicks(span: Time, width: number): Axis {
  const [from, to] = timeExtent(span)
  const len = to - from
  if (len <= 0) return { unit: 'none', ticks: [{ u: 0, label: formatYear(from), major: true }] }
  const ideal = len / Math.max(2, Math.floor(width / TICK_PX))
  const s = SPACINGS.find((c) => c.years >= ideal) ?? SPACINGS[SPACINGS.length - 1]
  const ticks: Tick[] = []
  for (let i = Math.ceil(from / s.years - 1e-9); i * s.years <= to + 1e-9; i++) {
    const t = i * s.years
    const cal = calendarOf(t)
    ticks.push({
      u: (t - from) / len,
      label: formatAt(t, s.unit),
      major: s.unit === 'month' ? cal?.m === 0 : s.unit === 'day' ? cal?.d === 1 : true,
    })
  }
  return { unit: s.unit, ticks }
}

/* -------------------------------------------------------------- the stations */

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
  /** The mark, in px. Its true position, and no other. */
  x: number
  /** A period's band, in px. Absent for a moment. */
  band?: { x: number; w: number }
  /** Which lane it hangs in (0 = on the axis). See `laneOf`. */
  lane: number
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
  /** How many lanes the stations ended up needing. */
  lanes: number
  axis: Axis
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

/**
 * How wide the rail is drawn.
 *
 * Normally the element's own width. With more stations than the element can
 * separate, the rail grows past it and the view scrolls — which stretches the
 * span without bending it, and is the only honest way a phone can show eleven
 * moments.
 */
export const railWidth = (clientWidth: number, count: number): number =>
  Math.max(clientWidth, count * MIN_STATION_PX)

/** Where a fraction of the span sits on a rail of this width, padded at both ends. */
export const railX = (u: number, width: number, pad = RAIL_PAD): number =>
  (pad + u * (1 - 2 * pad)) * width

/**
 * Which lane each station hangs in: the first one whose last mark is far enough
 * behind, else a new one, else — past `MAX_LANES` — the emptiest.
 *
 * This is the whole of what crowding is allowed to change. A lane is a vertical
 * offset and a stem back up to the axis; it moves a mark *down*, never sideways,
 * so no station is ever drawn at a time it did not happen at.
 */
export function laneOf(xs: readonly number[]): number[] {
  const last: number[] = []
  return xs.map((x) => {
    let lane = last.findIndex((l) => x - l >= LANE_GAP_PX)
    if (lane < 0)
      lane =
        last.length < MAX_LANES
          ? last.length
          : last.reduce((best, l, i) => (l < last[best] ? i : best), 0)
    last[lane] = x
    return lane
  })
}

/** The room a name wants, in px — the same eyeballed metric the era bands use. */
export const labelWidth = (name: string): number => name.length * LABEL_CHAR_PX + 4

/** Room from a station's mark to the next mark IN ITS OWN LANE. */
const labelRoom = (xs: readonly number[], lanes: readonly number[], i: number, width: number) => {
  for (let j = i + 1; j < xs.length; j++)
    if (lanes[j] === lanes[i]) return Math.max(0, xs[j] - xs[i] - LABEL_GAP_PX)
  return Math.max(0, width - xs[i] - LABEL_GAP_PX)
}

/**
 * The whole geometry of the rail: the rule, and where each station's mark, band
 * and label go, for a given element width.
 */
export function layoutRail(
  sts: readonly Station[],
  span: Time,
  clientWidth: number,
): RailLayout {
  const width = railWidth(clientWidth, sts.length)
  const axis = axisTicks(span, width)
  if (!sts.length) return { width, lanes: 1, axis, stations: [] }
  const xs = sts.map((s) => railX(s.u, width))
  const lanes = laneOf(xs)
  return {
    width,
    lanes: Math.max(...lanes) + 1,
    axis,
    stations: sts.map((s, i) => {
      const room = labelRoom(xs, lanes, i, width)
      return {
        ...s,
        x: xs[i],
        band: s.uEnd > s.u ? { x: xs[i], w: railX(s.uEnd, width) - xs[i] } : undefined,
        lane: lanes[i],
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
 * What the list and the tooltip call a station's moment.
 *
 * At the axis's own resolution — a station on a year rule says "1942", one on a
 * month rule says "Jun 1944" — so the two halves of the dual system agree about
 * how precise this corpus is. A period whose ends round to the same name says it
 * once rather than saying "1942 – 1942".
 */
export function stationTime(s: Station, span: Time, unit: AxisUnit): string {
  const t = stepTimeYears(s.step, span)
  const [a, b] = [formatAt(timeStart(t), unit, true), formatAt(timeEnd(t), unit, true)]
  return a === b ? a : `${a} – ${b}`
}

/* ------------------------------------------------ the other half of the dual */

/**
 * PREV / NEXT — one press along the saga, over `[the overview, …the steps]`.
 *
 * The overview is a place, not the absence of one (lib/steps.ts, rule 1), so it
 * is the first stop rather than something the reader has to leave the rail to
 * get back to: prev from the first step lands on it, and next from it opens the
 * first step. Both ends are HARD — `null`, which the view draws as a disabled
 * control — because this is a walk along a span, not the search results' ring:
 * wrapping from the end of a war back to its beginning would be a claim about
 * time.
 *
 * `{ to: undefined }` is the overview, which is exactly the value `selectStep`
 * takes for it.
 */
export function stepBy(
  ids: readonly string[],
  current: string | undefined,
  dir: 1 | -1,
): { to: string | undefined } | null {
  // An id this saga does not have — a stale link, a chunk still loading — reads
  // as the overview, which is where `selectStep` would have left the reader too.
  const at = current === undefined ? 0 : Math.max(0, ids.indexOf(current) + 1)
  const next = at + dir
  if (next < 0 || next > ids.length) return null
  return { to: next === 0 ? undefined : ids[next - 1] }
}

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
