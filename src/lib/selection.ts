import { clamp, toWarp, fromWarp, type Year } from './time'

/** A closed interval of time. Used for both the visible window and the selection. */
export interface Span {
  start: Year
  end: Year
}

/**
 * Smallest selection, as a fraction of the visible window. Widths are measured
 * in warp (display) space so the floor is a constant number of pixels on the
 * rail rather than a number of years — the handles stay grabbable at any zoom.
 */
export const MIN_SEL_FRACTION = 0.02

/**
 * Same interval, whatever objects it arrives in.
 *
 * Every step of the timeline produces a *fresh* `{start, end}`, and the stores
 * hand those straight to Vue — which compares by identity, so a new object is a
 * change even when the two numbers in it are the ones already there. That is
 * exactly what a pan against the ends of time produces: the clamp returns the
 * present window, in a new object, and the whole downstream pipeline (nation
 * borders re-digested, the event index re-queried, the surface re-planned) runs
 * to redraw an identical picture. See stores/time.ts.
 */
export const sameSpan = (a: Span, b: Span): boolean => a.start === b.start && a.end === b.end

/** Ordered span: a handle dragged past its partner swaps rather than inverting. */
export const orderSpan = (a: Year, b: Year): Span =>
  a <= b ? { start: a, end: b } : { start: b, end: a }

/**
 * Fit a selection inside the visible window, keeping as much of it as possible:
 * the overlap survives, and only when nothing overlaps (the window panned clear
 * past it) does the selection collapse to the minimum width at the near edge.
 */
export function clampSelection(sel: Span, win: Span): Span {
  const w0 = toWarp(Math.min(win.start, win.end))
  const w1 = toWarp(Math.max(win.start, win.end))
  if (!(w1 > w0)) return { start: win.start, end: win.start } // degenerate window

  const ordered = orderSpan(sel.start, sel.end)
  const pin = (u: number) => Math.min(w1, Math.max(w0, u))
  let a = pin(toWarp(ordered.start))
  let b = pin(toWarp(ordered.end))
  // A selection already inside the window, and wide enough, is returned in the
  // years it came in as: the warp roundtrip is lossy at the 1e-10 level, and an
  // era boundary that drifts to 499.9999999 reads as reaching into Classical.
  // The test is in years, not warp — warp saturates outside MIN/MAX_TIME, so a
  // year past the end of time has the same warp as the end of time.
  const lo = Math.min(win.start, win.end)
  const hi = Math.max(win.start, win.end)
  const min = Math.min((w1 - w0) * MIN_SEL_FRACTION, w1 - w0)
  if (ordered.start >= lo && ordered.end <= hi && b - a >= min) return ordered

  if (b - a < min) {
    const c = (a + b) / 2
    a = c - min / 2
    b = c + min / 2
    if (a < w0) [a, b] = [w0, w0 + min]
    if (b > w1) [a, b] = [w1 - min, w1]
  }
  return { start: clamp(fromWarp(a)), end: clamp(fromWarp(b)) }
}

/**
 * A window that comfortably contains `span`. The current window is kept when it
 * already does — picking an era you can already see should not move the view.
 */
export function windowContaining(span: Span, win: Span, pad = 0.18): Span {
  const s = orderSpan(span.start, span.end)
  if (s.start >= win.start && s.end <= win.end) return { ...win }
  const a = toWarp(s.start)
  const b = toWarp(s.end)
  const p = (b - a) * pad || 1 // a zero-width span still deserves some air
  return { start: clamp(fromWarp(a - p)), end: clamp(fromWarp(b + p)) }
}
