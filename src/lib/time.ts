import { assertNever } from './variant'

/** Time is a plain number: astronomical year (1 BCE = 0, deep past = large negatives). */
export type Year = number

export const MIN_TIME: Year = -4.5e9 // formation of Earth

/**
 * The present, as a year. Injectable so a test can ask what a different clock
 * would say; the app reads it once, below, at module load — a rail whose end
 * moved while you were looking at it would be worse than one that is a few
 * hours stale, and everything downstream (era tables, the home window) is
 * built from that single value.
 */
export const presentYear = (now: Date = new Date()): Year => now.getFullYear()

/** Right-hand end of the timeline: the current year. The future is not history —
 *  nothing past this is scrubbable, selectable or drawn. */
export const PRESENT: Year = presentYear()
export const MAX_TIME: Year = PRESENT

export const clamp = (t: Year, lo = MIN_TIME, hi = MAX_TIME): Year =>
  Math.min(hi, Math.max(lo, t))

/** Adaptive display: "250 Ma", "12 ka", "3000 BCE", "1969" */
export function formatYear(t: Year): string {
  if (t <= -1e6) return `${trim(-t / 1e6)} Ma`
  if (t <= -10_000) return `${trim(-t / 1e3)} ka`
  if (t < 1) return `${Math.round(1 - t)} BCE`
  return `${Math.round(t)}`
}

const trim = (n: number) => `${+n.toPrecision(3)}`

/**
 * Display warp: asinh centered on the present. Near the center asinh(x) ≈ x
 * (linear), far away ≈ sign·ln(2|x|) (logarithmic), transitioning smoothly —
 * so a decade-wide window is effectively linear, ~100 years is nearly linear,
 * and deep time compresses logarithmically. No singularity anywhere.
 *
 * The centre is the present, which is also MAX_TIME: warp 0 is the end of the
 * rail, and the whole timeline lives at u ≤ 0.
 */
const LINEAR_YEARS = 120 // half-width of the essentially-linear zone
export const toWarp = (t: Year): number =>
  Math.asinh((clamp(t, MIN_TIME, MAX_TIME) - PRESENT) / LINEAR_YEARS)
export const fromWarp = (u: number): Year => PRESENT + Math.sinh(u) * LINEAR_YEARS

/* ======================================================= WHEN, as a variant */

/**
 * WHEN something happened. A closed union with two members, because there are
 * two kinds of answer and they are not the same kind of thing:
 *
 *  · a POINT — the moon landing, a birth, a treaty signed. One year.
 *  · a PERIOD — a war, an empire, a warming trend. Two years, and the ground
 *    between them.
 *
 * It replaces the `start` + optional `end` pair that every span-aware corner of
 * the app used to carry, and the `end ?? start` that every one of them wrote to
 * make sense of it. That expression appeared in six places — the timeline
 * extent, the intersection test, the coverage penalty, the index's column fill,
 * two validators — and each of them was one author's guess at what a missing
 * `end` meant. Here the question does not arise: a point *is* a point, and the
 * folds below are the only place the two are collapsed into a pair of numbers.
 *
 * The raw JSON is unchanged — `start` and an optional `end`, as it always was —
 * and `timeFrom` at the parser boundary is what turns that into this. The rule
 * it applies is the one the data already meant: no `end`, or an `end` equal to
 * the `start`, is a point.
 *
 * A `Step` (lib/steps.ts) carries one of these too, in a space that is NOT
 * years — see `atFraction` there. Nothing here assumes the numbers are years;
 * they are ordered scalars, and every fold is arithmetic on them.
 */
export type Time =
  | { kind: 'point'; year: Year }
  | { kind: 'period'; start: Year; end: Year }

export const pointTime = (year: Year): Time => ({ kind: 'point', year })

/**
 * The constructor at every boundary: a start, and an end that may be missing.
 *
 * Three normalisations, all of them things a consumer used to do for itself:
 * a missing end is a point, an end *equal* to the start is a point (a war dated
 * 1812–1812 is a year, not a span of nothing), and a reversed pair is ordered.
 * Past here nothing has to defend against any of the three.
 */
export function timeFrom(start: Year, end?: Year): Time {
  if (end === undefined || end === start) return { kind: 'point', year: start }
  return end < start
    ? { kind: 'period', start: end, end: start }
    : { kind: 'period', start, end }
}

/** The pair of years a time occupies, ordered. `[y, y]` for a point. */
export function timeExtent(t: Time): [Year, Year] {
  switch (t.kind) {
    case 'point':
      return [t.year, t.year]
    case 'period':
      return [t.start, t.end]
    default:
      return assertNever(t)
  }
}

/** When it began — the year a thing is anchored at and sorted by. */
export function timeStart(t: Time): Year {
  switch (t.kind) {
    case 'point':
      return t.year
    case 'period':
      return t.start
    default:
      return assertNever(t)
  }
}

/** When it ended. Its own year, for a point. */
export function timeEnd(t: Time): Year {
  switch (t.kind) {
    case 'point':
      return t.year
    case 'period':
      return t.end
    default:
      return assertNever(t)
  }
}

/** How long it ran, in years. Zero for a point — see YEAR_UNIT for why the
 *  coverage arithmetic adds one to this rather than treating zero as a bug. */
export const timeLength = (t: Time): number => {
  const [a, b] = timeExtent(t)
  return b - a
}

/**
 * Does this time touch the closed interval `[start, end]`?
 *
 * Touching at a single year counts, and that is the whole reason this is one
 * function rather than a comparison written at each call site: an event dated to
 * exactly the edge of the selection band is *on* the timeline, not off it, and
 * the three places that used to ask (the index, the reference implementation,
 * the focus-mode drop) have to agree to the year or a pin appears in one and not
 * the other.
 */
export function timeIntersects(t: Time, start: Year, end: Year): boolean {
  const [a, b] = timeExtent(t)
  return a <= end && b >= start
}

/** A span the reader is shown: "1939 – 1945", or just "1969". */
export function formatTime(t: Time): string {
  switch (t.kind) {
    case 'point':
      return formatYear(t.year)
    case 'period':
      return `${formatYear(t.start)} – ${formatYear(t.end)}`
    default:
      return assertNever(t)
  }
}
