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
