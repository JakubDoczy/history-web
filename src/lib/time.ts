/** Time is a plain number: astronomical year (1 BCE = 0, deep past = large negatives). */
export type Year = number

export const MIN_TIME: Year = -4.5e9 // formation of Earth
export const MAX_TIME: Year = 2100

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
