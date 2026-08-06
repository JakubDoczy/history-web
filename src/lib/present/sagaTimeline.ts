import { atFraction, orderedSteps, stepFraction, stepTimeYears, type Step } from '../steps'
import { formatOn, timeEnd, timeExtent, timeStart, type Time, type Year } from '../time'
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
 * crowded station with a thumb is answered elsewhere entirely — by the ZOOM
 * (note 4), which spreads a pile-up without moving anything off its date, and
 * by the rail's prev/next and its list of every step (`stepBy`), which is the
 * second half of the dual system the reader asked for.
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
 * THE VISIBLE WINDOW, in *rail space* — the 0..1 the padded span is drawn over.
 *
 * A phone showing eleven moments of a six-year war used to grow the rail past
 * the element and scroll it. Two systems — a scrolling rail on a phone, a fitted
 * one on a desktop — and the scrolling one answered "I cannot read the end of
 * the war" with "drag sideways", which is a pan with none of a pan's other half.
 *
 * There is one system now, and it is the era rail's (components/TimelineBar.vue):
 * a visible window that wheel, pinch, drag and double-tap move, and which every
 * other number in this module is a function of. Positions, bands, lane
 * assignment, label room and the tick rule are all recomputed per window, so
 * zooming into June 1944 does not scale a picture of the war — it re-asks every
 * question at the new scale, and the rule answers "days" where it answered
 * "years" (see `axisTicks`). The window is the rail's own state and dies with
 * it: a descent is a different span, and it opens fitted.
 *
 * Rail space rather than span space because the pad is part of what the reader
 * sees at rest: `{ u0: 0, u1: 1 }` is the whole saga WITH its air, which is
 * exactly the picture the rail drew before it could zoom, and the clamp "never
 * out past the padded span" is then the trivial one.
 */
export interface RailWindow {
  u0: number
  u1: number
}

/** The rail at rest: the whole padded span. */
export const FULL_WINDOW: RailWindow = { u0: 0, u1: 1 }

/** A fraction of the SPAN, in rail space. */
export const railU = (u: number, pad = RAIL_PAD): number => pad + u * (1 - 2 * pad)

/**
 * How far in the rail will go: about three days across.
 *
 * Not a round number someone liked — it is where the tick ladder bottoms out.
 * The finest spacing is one day and a rail carries at least two ticks, so a
 * window under ~3 days would go on magnifying a picture whose rule had stopped
 * refining: more pixels per day and nothing new said. See `axisTicks`.
 */
export const MIN_WINDOW_DAYS = 3

const clampTo = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/**
 * The narrowest window this saga allows, as a fraction of rail space.
 *
 * A point-dated saga has no extent, so there is nothing to zoom into and the
 * floor is the whole rail: its stations are an ORDER (see `spread`), and
 * magnifying an order says nothing the numbers on the marks did not.
 */
export function minWindow(span: Time): number {
  const [from, to] = timeExtent(span)
  const len = to - from
  if (!(len > 0)) return 1
  return Math.min(1, (MIN_WINDOW_DAYS * DAY * (1 - 2 * RAIL_PAD)) / len)
}

/**
 * ZOOM, about a point the reader is holding still — the era rail's contract
 * (`zoom` in stores/time.ts): `k > 1` widens the window, `at` is where the
 * cursor or the pinch centre is, in 0..1 of the rail's width.
 *
 * Clamped at both ends and then RE-ANCHORED rather than merely clipped: a
 * window pushed against the start of the span keeps its width and slides, so
 * zooming out at the far right of a war still ends on the whole war rather than
 * on a window that has silently lost half its span.
 */
export function zoomWindow(w: RailWindow, k: number, at: number, min = 0): RailWindow {
  const len = w.u1 - w.u0
  const held = w.u0 + at * len
  const next = clampTo(len * k, Math.min(min, 1), 1)
  const u0 = clampTo(held - at * next, 0, 1 - next)
  return { u0, u1: u0 + next }
}

/** PAN, by a fraction of rail space. The width is preserved; the ends are hard. */
export function panWindow(w: RailWindow, du: number): RailWindow {
  const len = w.u1 - w.u0
  const u0 = clampTo(w.u0 + du, 0, 1 - len)
  return { u0, u1: u0 + len }
}

/**
 * The window moved just far enough that a point of rail space is comfortably
 * inside it — what prev/next and the list do when the step they take is off the
 * visible edge.
 *
 * `margin` is a fraction of the WINDOW, so a station panned into view arrives
 * with room for its own label rather than hard against the edge that was hiding
 * it. A window already showing the point is returned unchanged, which is what
 * lets the caller decide whether anything needs animating.
 */
export function revealIn(w: RailWindow, v: number, margin = 0.12): RailWindow {
  const len = w.u1 - w.u0
  const m = Math.min(margin, 0.45) * len
  if (v >= w.u0 + m && v <= w.u1 - m) return w
  return panWindow(w, v < w.u0 + m ? v - m - w.u0 : v + m - w.u1)
}

/** Below this there is no room for a name worth truncating to. */
export const MIN_LABEL_PX = 56

/**
 * The room a station's label needs before it is worth drawing at rest.
 *
 * A label is a name AND ITS DATE, and only the name gives room up (the date is
 * the half the reader asked for, so it does not shrink). Measured against the
 * constant alone, a 130 px slot on a phone drew "S. 10 Jul – 10 Sep 1941" — the
 * whole date and an initial where the name was. So the date's own width is part
 * of the threshold, and what `MIN_LABEL_PX` means is what it always meant: how
 * much NAME is worth an ellipsis.
 *
 * Under it the label is dropped and shown whole when the reader asks about the
 * station — the hover, the cursor, the open step — and named in the list.
 */
export const minLabelPx = (at: string): number => MIN_LABEL_PX + labelWidth(at)

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
 * The mark's own width (`--mark` in the view; the desktop value, and a phone's
 * is 14) — half of which is on the far side of the next station's position.
 *
 * The room a label gets used to be measured to the next mark's CENTRE, which
 * left its last eight pixels underneath that mark. That was invisible while a
 * label was one ellipsised string: what went under the mark was the ellipsis.
 * With a date at the end of it — the half that does not shrink — it was the
 * year, and "Jul – Oct 1940" was drawn as "Jul – Oct 194".
 */
export const MARK_PX = 16

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

/**
 * Room one tick label wants when the rail can afford to be CALM.
 *
 * The era rail's own density (`ticks` in TimelineBar.vue), and on a desktop it
 * is the whole rule: a 1280 px rail divided eleven ways rules a six-year war in
 * years, which is the picture the reader wants of a war. It is a comfort
 * figure, not a collision figure — see `tickRoom` for the one that is.
 */
export const TICK_PX = 110

/* ------------------------------------------------ the saga rail's own density
 *
 * THE DEFECT. `TICK_PX` alone, on a phone, said almost nothing. A 390 px rail
 * divides three ways, so D-Day's seven weeks got ONE dated tick and the whole
 * of the Second World War got two — *"a single tick"*, on a rule whose entire
 * job is to put the stations in proportion. The number was not wrong; it was
 * answering a different question. 110 px is the room the ERA rail's 11.5 px
 * labels want, and this rail sets its ticks in 10 px condensed, where the
 * widest label a rule can produce ("Jan 1944", "9501 BCE") measures 53 px.
 *
 * So the saga rail gets two rules instead of one, and they are different kinds
 * of statement:
 *
 *  · CALM — `TICK_PX` of room per label. What the rail asks for when it can
 *    have it, and what keeps a desktop's full war at six year-marks rather
 *    than thirteen half-year ones. Unchanged from round 46.
 *  · THE FLOOR — `MIN_TICKS` divisions, however narrow the rail. A rule with
 *    one mark on it is not a rule. When calm leaves fewer than that, the
 *    spacing refines — but only as far as the LABELS THEMSELVES allow, which
 *    is measured (`tickRoom`) rather than assumed.
 *
 * The floor is what a phone lives on and the calm rule is what a desktop lives
 * on, and neither can push the other into a picket fence: the floor may never
 * choose a spacing whose own labels would touch, and the calm rule is coarsened
 * if its choice would (which is also how a deep-time rail stops printing
 * "12 ka" twice in a row).
 */

/**
 * Width of one character of the tick's own type, in px — 10 px IBM Plex Sans
 * Condensed with 0.06em of letter-spacing, MEASURED in the browser against the
 * labels the rule actually produces, and then rounded up.
 *
 * Measured (fallback face, which is the wider of the two the stack can resolve
 * to): "1940" 27.9, "13 Jun" 31.6, "30 Sep" 38.4, "Jan 1944" 48.8, "May 1945"
 * 54.1, "10,000 BCE" 64.2. A line through the widest of those is 6.3·n + 3; 6.6
 * and 4 sits above every one of them, which is the safe direction — the answer
 * this feeds ("is there room for another tick?") is wrong when it
 * under-estimates and merely conservative when it over-estimates. In IBM Plex
 * Condensed proper the same strings are about a fifth narrower again.
 */
export const TICK_CHAR_PX = 6.6

/** The label starts here, past its own gridline (`.tick i { left: 4px }`). */
export const TICK_INSET_PX = 4

/** Air between the end of one tick's label and the next tick's gridline. */
export const TICK_AIR_PX = 10

/**
 * The room a tick label needs before the NEXT gridline — the collision figure.
 *
 * A label hangs to the right of its own mark, so the room is owed by the tick
 * on the left, and this is measured against the string that tick will actually
 * be drawn with rather than against a constant standing in for all of them.
 */
export const tickRoom = (label: string): number =>
  TICK_INSET_PX + label.length * TICK_CHAR_PX + TICK_AIR_PX

/**
 * The fewest divisions worth calling a rule.
 *
 * Five, because a reader reads a POSITION off a rule by interpolating between
 * marks: with two there is no interpolation to do, with three (the ends and the
 * middle) everything between them is guessed, and five is where a 390 px phone
 * stops having to guess. It is a floor, not a target — where the calm rule
 * already clears it, nothing here does anything at all.
 *
 * Chosen against the corpus at the width that hurt, a 390 px phone at fit:
 *
 *   span             calm (TICK_PX)        with the floor
 *   D-Day, 7 weeks   1 tick   (1 month)    5 ticks  (10 days), 72 px apart
 *   WWII, 6 years    2 ticks  (5 years)    6 ticks  (1 year),  58 px apart
 *
 * and the widest label either rule draws wants 54 px, so both clear `tickRoom`
 * with room to spare. A desktop's full war is untouched: six year-marks, 192 px
 * apart, because the calm rule already gives more than five.
 */
export const MIN_TICKS = 5

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

/** The first instant of a calendar month, back in the app's unit of years. */
function monthStart(y: number, m: number): Year {
  const d = new Date(0)
  d.setUTCFullYear(y, m, 1)
  d.setUTCHours(0, 0, 0, 0)
  return y + (d.getTime() - jan1(y)) / (jan1(y + 1) - jan1(y))
}

/**
 * The moments a spacing puts inside [a, b].
 *
 * Multiples of the spacing, EXCEPT for months, which are not a length. A
 * twelfth of a year is 30.44 days and a calendar month is 28 to 31, so a rule
 * stepped in twelfths drifts a third of a day per month — invisible on a rail
 * showing one year, and on a rail zoomed to ten months it printed "Jan 1944"
 * twice and no February at all. A month tick stands on the first of its month
 * or it is not a month tick, and the sequence is aligned to the CALENDAR (so a
 * three-month rule is Jan/Apr/Jul/Oct) rather than to wherever the window
 * happens to begin.
 *
 * Days stay uniform: they are a real length, and 1/365.2425 of a year is within
 * a fraction of a day of one over the fortnight such a rule ever covers.
 */
function tickTimes(a: Year, b: Year, s: { unit: AxisUnit; years: number }): Year[] {
  const out: Year[] = []
  if (s.unit === 'month' && Math.abs(a) <= 9999) {
    const k = Math.max(1, Math.round(s.years * 12))
    const y0 = Math.floor(a)
    for (let i = Math.ceil((y0 * 12 + (a - y0) * 12) / k) * k; ; i += k) {
      const t = monthStart(Math.floor(i / 12), ((i % 12) + 12) % 12)
      if (t > b + 1e-9) break
      if (t >= a - 1e-9) out.push(t)
    }
    return out
  }
  for (let i = Math.ceil(a / s.years - 1e-9); i * s.years <= b + 1e-9; i++) out.push(i * s.years)
  return out
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
  if (!cal) return formatOn(t)
  const y = formatOn(t)
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
 * A POINT-DATED saga is the one case with no rule at all: it has no extent, so
 * there is nothing to divide, and the single tick returned is the year itself.
 * The view draws that axis dashed — a rule with no divisions on it, which is
 * what the data supports. Where its stations then stand is `spread`.
 *
 * THE RULE REFINES WITH THE WINDOW. What is divided is the span the reader can
 * actually SEE, so the same war rules in years whole, in months at 1944 and in
 * days inside June — one ladder, walked by the zoom rather than by a mode. The
 * density rule (`TICK_PX` of room per label) is what makes that safe at every
 * step of the way: the finest spacing is chosen from the room there is, so two
 * labels can never be drawn closer than one label is wide.
 *
 * The visible range is clipped to the SPAN, not taken raw from the window: at
 * rest the window includes the pad, and dividing the pad would make a war
 * eleven per cent longer than it was — the rule would answer a question about
 * time with a fact about margins.
 */
export function axisTicks(span: Time, width: number, win: RailWindow = FULL_WINDOW): Axis {
  const [from, to] = timeExtent(span)
  const len = to - from
  if (len <= 0) return { unit: 'none', ticks: [{ u: 0, label: formatOn(from), major: true }] }
  const at = (v: number) => from + ((v - RAIL_PAD) / (1 - 2 * RAIL_PAD)) * len
  const [a, b] = [clampTo(at(win.u0), from, to), clampTo(at(win.u1), from, to)]

  /** Pixels per year on this rail, through this window — the real scale. */
  const px = (width * (1 - 2 * RAIL_PAD)) / (len * (win.u1 - win.u0))

  const rule = (k: number): Tick[] => {
    const s = SPACINGS[k]
    return tickTimes(a, b, s).map((t) => {
      const cal = calendarOf(t)
      return {
        u: (t - from) / len,
        label: formatAt(t, s.unit),
        major: s.unit === 'month' ? cal?.m === 0 : s.unit === 'day' ? cal?.d === 1 : true,
      }
    })
  }

  /**
   * Would this rule draw two labels on top of each other — or two labels that
   * say the same thing?
   *
   * The room is owed by the LEFT tick, because that is the one whose label
   * reaches into the gap. The gap is taken from the ticks' own positions rather
   * than from the nominal spacing, so a calendar month (28 to 31 days, against
   * a nominal 30.44) is judged on where it actually falls.
   */
  const fits = (ts: readonly Tick[]): boolean => {
    for (let i = 1; i < ts.length; i++) {
      if (ts[i].label === ts[i - 1].label) return false
      if ((ts[i].u - ts[i - 1].u) * len * px < tickRoom(ts[i - 1].label)) return false
    }
    return true
  }

  // 1. THE CALM RULE: `TICK_PX` of room per label, the era rail's own density.
  const ideal = (b - a) / Math.max(2, Math.floor(width / TICK_PX))
  let i = SPACINGS.findIndex((c) => c.years >= ideal)
  if (i < 0) i = SPACINGS.length - 1
  // …coarsened if it would collide anyway. It can, near an end of the span,
  // where the window reaches past what there is to divide and the pixel budget
  // and the visible span stop agreeing.
  while (i < SPACINGS.length - 1 && !fits(rule(i))) i++

  // 2. THE FLOOR: a rule needs divisions. Refine — as far as the labels allow,
  // and no further than the coarsest spacing that clears the floor.
  if (rule(i).length < MIN_TICKS) {
    let finest = -1
    for (let k = i - 1; k >= 0; k--) {
      // Below one glyph plus its inset and its air nothing can be legible, and
      // the spacings ascend — so nothing finer can be either. This is the
      // loop's bound as well as its rule: without it, a rail showing three
      // millennia would go on to lay out a rule of days over them (a million
      // ticks) only to throw it away.
      if (SPACINGS[k].years * px < tickRoom('0')) break
      const ts = rule(k)
      if (!fits(ts)) continue
      finest = k
      if (ts.length >= MIN_TICKS) {
        finest = -1
        i = k
        break
      }
    }
    // Nothing cleared the floor: take the most divisions that will fit at all.
    if (finest >= 0) i = finest
  }
  return { unit: SPACINGS[i].unit, ticks: rule(i) }
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
   * Is there room for the DATE beside the name at rest?
   *
   * Below `minLabelPx` there is not, and then the name goes on alone rather
   * than being cut to an initial by a date that will not shrink — a rail of
   * five bands and no names is a worse answer to "there are no dates" than a
   * rail of five names. The date is never lost: the label is shown WHOLE, date
   * and all, in the three states where the reader is asking about one station,
   * and the list spells out every one of them at once.
   */
  dated: boolean
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
  /** The width the stations are laid out over: the element's, always. */
  width: number
  /** The window everything here was derived from. */
  win: RailWindow
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
 * WHERE THE STATIONS STAND, in 0..1 of the rail.
 *
 * At their own moments — that is the whole contract (see 1 above) — with one
 * exception, and it is not a relaxation of that rule but the absence of any
 * data to apply it to. A saga dated to a single point has no extent, so its
 * steps' fractions are proportions of a campaign that someone typed rather than
 * dates anything can be read off. Drawing them as positions was the rail
 * claiming a precision the corpus does not have, and it was read as exactly
 * that: *"it looks random and without dates"*.
 *
 * So an unruled rail spaces its stations EVENLY. It says one true thing — this
 * came after that — instead of a false one, and the labels (`stationAt`, which
 * numbers them when there is no date) carry the rest. The moment such a saga is
 * given real dates it gets the true axis back, with no code path to switch.
 */
export const spread = (sts: readonly Station[], unit: AxisUnit): number[] =>
  unit !== 'none'
    ? sts.map((s) => s.u)
    : // One equal slot each, and the mark stands in the middle of its own slot.
      // Not `i / (n - 1)`, which is even in the same sense and puts the last
      // station hard against the end of the rail, where there is no room for
      // its name — on a rail whose names are the whole of what it has to say.
      sts.map((_, i) => (i + 0.5) / sts.length)

/**
 * Where a fraction of the span sits on a rail of this width — through the
 * window, which at rest is the whole padded span and so the identity this was
 * before it could zoom.
 */
export const railX = (u: number, width: number, win: RailWindow = FULL_WINDOW): number =>
  ((railU(u) - win.u0) / (win.u1 - win.u0)) * width

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

/**
 * WHICH STATION IS DRAWN ON TOP.
 *
 * Lanes are how the rail survives a pile-up, and a pile-up is where "which step
 * am I on?" is hardest to answer — four marks in eleven pixels, in three rows,
 * with labels crossing each other. The one the reader is standing on must
 * therefore be the one nothing is drawn over, and the one they are pointing at
 * next: the open step outranks the cursor, the cursor outranks a hover, and all
 * three outrank the row.
 *
 * Here rather than in the stylesheet because CSS said it in source order — four
 * rules at equal specificity, all claiming `z-index: 3` — which is a priority
 * written in a place where it cannot be read, and could not be tested at all.
 */
export function markZ(s: {
  on?: boolean
  cursor?: boolean
  hover?: boolean
  lane?: number
}): number {
  if (s.on) return 40
  if (s.cursor) return 30
  if (s.hover) return 20
  // Within the row, an upper lane is nearer the axis and nearer the eye; the
  // stems of the lanes below it pass behind rather than through its label.
  return 10 - Math.min(9, s.lane ?? 0)
}

/** The room a name wants, in px — the same eyeballed metric the era bands use. */
export const labelWidth = (name: string): number => name.length * LABEL_CHAR_PX + 4

/** Room from a station's mark to the next mark IN ITS OWN LANE — its near edge. */
const labelRoom = (xs: readonly number[], lanes: readonly number[], i: number, width: number) => {
  for (let j = i + 1; j < xs.length; j++)
    if (lanes[j] === lanes[i])
      return Math.max(0, xs[j] - xs[i] - LABEL_GAP_PX - MARK_PX / 2)
  return Math.max(0, width - xs[i] - LABEL_GAP_PX)
}

/**
 * The whole geometry of the rail: the rule, and where each station's mark, band
 * and label go, for a given element width AND VISIBLE WINDOW.
 *
 * Everything is re-derived, not transformed. A zoomed-in rail is not a scaled
 * picture of the fitted one: the marks that were eleven pixels apart are now a
 * hundred, so they no longer collide, so they climb back out of their lanes and
 * their names — which had no room and were dropped — are drawn. That is the
 * whole point of being able to zoom, and it is why the window is an argument
 * here rather than a CSS transform in the view.
 */
export function layoutRail(
  sts: readonly Station[],
  span: Time,
  width: number,
  win: RailWindow = FULL_WINDOW,
): RailLayout {
  const axis = axisTicks(span, width, win)
  if (!sts.length) return { width, win, lanes: 1, axis, stations: [] }
  const us = spread(sts, axis.unit)
  const xs = us.map((u) => railX(u, width, win))
  const lanes = laneOf(xs)
  return {
    width,
    win,
    lanes: Math.max(...lanes) + 1,
    axis,
    stations: sts.map((s, i) => {
      const room = labelRoom(xs, lanes, i, width)
      const at = stationAt(s, span, sts.length)
      return {
        ...s,
        x: xs[i],
        // A band is a length of the axis, so it exists only where the axis is
        // one: on an evenly spaced rail (`spread`) the distance between two
        // marks means nothing and a bar drawn across it would mean less.
        band:
          axis.unit !== 'none' && s.uEnd > s.u
            ? { x: xs[i], w: railX(s.uEnd, width, win) - xs[i] }
            : undefined,
        lane: lanes[i],
        // The ROOM, not the guess at the name's width: the cap exists to keep a
        // label off its neighbour, and capping it at an estimate of its own
        // width instead put an ellipsis on names that had a clear rail in front
        // of them the moment the estimate was a pixel short.
        labelPx: room >= MIN_LABEL_PX ? room : 0,
        dated: room >= minLabelPx(at),
        // The name AND the date it now carries: the date is pinned (it is the
        // half a truncation must not eat), so it is the pair that decides which
        // way the whole label hangs.
        flip: xs[i] + labelWidth(`${s.step.name} ${at}`) > width,
      }
    }),
  }
}

/**
 * The unit a STATION's date is written in — one notch finer than its rule.
 *
 * Two things this is not. It is not the rule's own unit: a rule says how the
 * span divides, and "1941" beside both Barbarossa and Pearl Harbor answers the
 * reader's question ("when is this one?") with the tick they are already
 * standing on. And it is not read off the live rail width: D-Day's axis rules
 * in months on a 390 px phone and in days on a desktop, and a label that says
 * "Jun" on one and "6 Jun" on the other is a fact that changes when you turn
 * the phone. So it is asked of the SPAN, at the density a desktop rail has, and
 * then sharpened by one — which is the difference between a picture of the war
 * and a date for each of its moments.
 *
 * Nothing is invented by the sharpening: a step dated to a whole year still
 * says the year (see `stationTime`), and outside the calendar's reach the month
 * form falls back to the year on its own (`calendarOf`).
 */
const FINER: Record<AxisUnit, AxisUnit> = {
  year: 'month',
  month: 'day',
  day: 'day',
  none: 'none',
}

/**
 * The resolution a SAGA is written at — what its own span deserves, asked at a
 * desktop rail's density and at no particular zoom.
 *
 * The rail's live axis is not this: it refines as the reader zooms in, which is
 * the whole point of it. But the saga's own dates — the span in the head, and
 * every station's date beside its name — are facts about the saga, and a fact
 * that changes as you turn the wheel is not one. Zoomed into June 1944 the
 * live rule says "day", and the head read "1 Sep – 2 Sep 1945" for a war that
 * ran from 1939.
 */
export const spanUnit = (span: Time): AxisUnit => axisTicks(span, TICK_PX * 11).unit
export const stationUnit = (span: Time): AxisUnit => FINER[spanUnit(span)]

/**
 * What the rail, the list and the tooltip call a station's moment.
 *
 * Read on its own, so it carries its year — but only once: a period inside a
 * single year is "22 Jun – 9 Jul 1941", the way anyone would write it, and one
 * whose ends have the same name at this resolution says that name once.
 *
 * NOTHING SAYS MORE THAN IT KNOWS. A step dated to a whole year is written as
 * that year whatever the rest of the saga is dated to, because "Jan 1750" is a
 * claim about a month that the value 1750 does not make.
 */
export function stationTime(s: Station, span: Time, unit: AxisUnit): string {
  const t = stepTimeYears(s.step, span)
  const at = (v: Year, full = true) => formatAt(v, Number.isInteger(v) ? 'year' : unit, full)
  const [a, b] = [at(timeStart(t)), at(timeEnd(t))]
  if (a === b) return a
  // the year is the END's to carry when both ends are inside it
  const year = (s: string) => s.slice(s.lastIndexOf(' ') + 1)
  return `${year(a) === year(b) ? at(timeStart(t), false) : a} – ${b}`
}

/**
 * THE DATE EVERY STATION CARRIES — beside its name on the rail, in its row in
 * the list, and in its tooltip.
 *
 * A rule along the top is a picture of time; it is not an answer to "when was
 * this one", and a reader on a phone sees two of its labels at a time. So the
 * station says its own date, always, and the rule is what puts the dates in
 * proportion rather than what carries them.
 *
 * Where there is no date to say — a saga dated to a single point, whose steps
 * are an order and nothing more — it says the order instead: "3 of 5", which is
 * the true statement the evenly spaced rail is making (see `spread`).
 */
export const stationAt = (s: Station, span: Time, count: number): string => {
  const unit = stationUnit(span)
  return unit === 'none' ? `${s.ordinal} of ${count}` : stationTime(s, span, unit)
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
