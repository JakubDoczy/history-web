import { clamp, toWarp, fromWarp, MIN_TIME, MAX_TIME, type Year } from './time'

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
  // An edge that saturated against the window is *exactly* that edge, not the
  // warp roundtrip of it — the same 5 µyr of slack that made a held pan
  // oscillate (see stores/time.ts pan) also kept a band pinned to the window
  // from ever comparing equal to itself, and kept the cursor that had just
  // extended it reading as still outside. Clamped, because a window may nominally
  // run past the end of time and the band may not.
  return {
    start: a === w0 ? clamp(lo) : clamp(fromWarp(a)),
    end: b === w1 ? clamp(hi) : clamp(fromWarp(b)),
  }
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

/** Air left either side of a fitted span, as a fraction of its displayed width. */
export const FIT_MARGIN = 0.05

/**
 * The window that *frames* a span: the span itself plus a margin either side,
 * and nothing else.
 *
 * Unlike `windowContaining` this always moves the view, and it is measured in
 * warp space, which is the only place the margin means anything — 5% of the
 * Proterozoic in years would be 98 million of them and would swallow the
 * Cambrian, while 5% of it on the rail is 5% of the rail. So the picked era
 * lands on screen at the same size whatever depth of time it lives at.
 *
 * Clamped to the ends of time by *saturating*, not by sliding: an era that runs
 * to the present keeps its left-hand margin and simply has none on the right,
 * because there is nothing there to show. The bound is written as the bound
 * itself rather than its warp roundtrip — `fromWarp(toWarp(MIN_TIME))` comes
 * back 5 µyr short, which is enough to make a window compare unequal to itself
 * (see stores/time.ts pan).
 */
export function windowFitting(span: Span, margin = FIT_MARGIN): Span {
  const s = orderSpan(span.start, span.end)
  const a = toWarp(s.start)
  const b = toWarp(s.end)
  const p = (b - a) * margin || 1 // a zero-width span still deserves some air
  const lo = a - p
  const hi = b + p
  return {
    start: lo <= toWarp(MIN_TIME) ? MIN_TIME : clamp(fromWarp(lo)),
    end: hi >= toWarp(MAX_TIME) ? MAX_TIME : clamp(fromWarp(hi)),
  }
}

/**
 * Air kept between a span and the edge of the window it was about to poke
 * through, as a fraction of the window's DISPLAYED width — so it is a constant
 * number of pixels on the rail at any zoom, which is what "a little room beside
 * the handle" means to a reader. See `windowLeastMoved`.
 */
export const SLIDE_MARGIN = 0.04

/**
 * The window nearest to `win` that has `span` on it: the LEAST MOVE.
 *
 * The third member of the family, and the one that moves the view as little as
 * a view can be moved. `windowFitting` always reframes (an era pick means "show
 * me this era"); `windowContaining` keeps a window that already contains the
 * span but otherwise reframes with 18% of air, which is a reframe all the same.
 * This one answers a different question — *"the visible timeline is large
 * enough; just shift the selected range"* — and it answers it in three cases:
 *
 *  1. the span is already on the rail → the window is returned UNCHANGED, to
 *     the byte, and nothing downstream so much as recomputes;
 *  2. it pokes out of one end → the window SLIDES, keeping its width exactly,
 *     until the span and a margin are inside. Never further, never recentred:
 *     the reader's frame of reference survives the click;
 *  3. it is wider than the window can hold even after sliding → and only then
 *     does the window widen, to exactly the span plus its two margins, which
 *     leaves the span centred because at that width there is nowhere else for
 *     it to be.
 *
 * All of it in warp (display) space, where the margin is a number of pixels and
 * a slide is a slide on screen. The ends of time clamp by sliding rather than
 * by shrinking — the same rule the rest of the rail keeps — so a span hard
 * against the beginning of time simply lands on the edge of the window with no
 * air on that side, rather than the window losing width to make room for air
 * there is nothing to put in.
 */
export function windowLeastMoved(span: Span, win: Span, margin = SLIDE_MARGIN): Span {
  const s = orderSpan(span.start, span.end)
  const v = orderSpan(win.start, win.end)
  // Case 1, in years and exactly: no warp roundtrip gets to decide whether the
  // view holds still, and a span touching an edge is on the rail, not off it.
  if (s.start >= v.start && s.end <= v.end) return { ...win }

  const lo = toWarp(MIN_TIME)
  const hi = toWarp(MAX_TIME)
  const v0 = toWarp(v.start)
  const v1 = toWarp(v.end)
  const b0 = toWarp(s.start)
  const b1 = toWarp(s.end)
  const m = Math.min(0.49, Math.max(0, margin)) // two margins must leave a window
  // Keep the width if the span and its margins fit in it; otherwise take the
  // one width that holds them, and no more.
  let width = v1 - v0
  if (b1 - b0 + 2 * m * width > width) width = (b1 - b0) / (1 - 2 * m)
  const pad = m * width
  // The near edge moves, the far one follows: whichever way the span poked out,
  // it is brought just inside. (In the widened case both tests agree on the
  // same answer — the span plus a margin either side is the whole window.)
  let start = v0
  if (b0 - pad < start) start = b0 - pad
  else if (b1 + pad > start + width) start = b1 + pad - width
  if (start + width > hi) start = hi - width
  if (start < lo) start = lo
  const end = Math.min(hi, start + width)
  // The bounds are written as themselves, not as their warp roundtrip, which
  // comes back 5 µyr short and makes a window compare unequal to itself.
  return {
    start: start <= lo ? MIN_TIME : clamp(fromWarp(start)),
    end: end >= hi ? MAX_TIME : clamp(fromWarp(end)),
  }
}

/** Eased progress for the fit tween: cubic in and out, so the view leaves and
 *  arrives at rest. Clamped, so a late frame cannot overshoot. */
export const easeInOut = (t: number): number => {
  const u = Math.min(1, Math.max(0, t))
  return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2
}

/**
 * A frame of the fit animation: `from` → `to`, interpolated in warp space so
 * the zoom is geometric — the view scales at a constant rate rather than
 * crawling for most of the tween and then leaping, which is what a linear
 * interpolation of years looks like when the two windows differ by a factor of
 * a thousand.
 */
export function tweenWindow(from: Span, to: Span, t: number): Span {
  const u = easeInOut(t)
  // Both ends are exact, not the warp roundtrip of themselves: `fromWarp(toWarp(x))`
  // comes back 5 µyr off, and the first frame of an animation publishing a
  // window that differs from the current one by five microseconds of geological
  // time would re-run the whole downstream pipeline to draw the same picture.
  if (u <= 0) return { ...from }
  if (u >= 1) return { ...to }
  const mix = (x: Year, y: Year) => clamp(fromWarp(toWarp(x) + (toWarp(y) - toWarp(x)) * u))
  return { start: mix(from.start, to.start), end: mix(from.end, to.end) }
}

/* ------------------------------------------------- cursor at a band's edge */

/**
 * How close, in pixels, the cursor has to be to a selection edge before the two
 * are drawn as one marker.
 *
 * The handle's grip is 3 px wide with a 9 px cap, and the cursor is a 1 px line
 * with a 7 px knob that straddles it — so at coincidence the knob pokes 3 px
 * *outside* a band whose own glyph sits entirely inside, and the cursor reads
 * as being past a boundary it is exactly on. Merging is the fix, and the
 * threshold is the width of that discrepancy: near enough that no one can see
 * the gap being closed, far enough that a cursor a whole year away at a deep
 * zoom does not get quietly moved.
 */
export const EDGE_MERGE_PX = 4

/**
 * Which selection edge the cursor should merge with, if either. The nearer edge
 * wins, so a selection squeezed to its minimum width — both edges within the
 * threshold — still resolves to one of them rather than to both.
 */
export function mergedEdge(
  cursorX: number,
  startX: number,
  endX: number,
  tol = EDGE_MERGE_PX,
): 'start' | 'end' | null {
  const ds = Math.abs(cursorX - startX)
  const de = Math.abs(cursorX - endX)
  if (Math.min(ds, de) > tol) return null
  return ds <= de ? 'start' : 'end'
}

/** Room the year flag needs beside its marker, in pixels. */
export const FLAG_PX = 84

/**
 * Which side of the marker the year flag hangs on.
 *
 * Two rules, in order. A merged marker points *into* the band it now belongs to
 * — a flag hanging outside the selection would undo the merge by making the
 * glyph look like it straddles the edge again. Then the rail's own ends win
 * over that preference, because a flag clipped in half is worse than a flag on
 * the surprising side.
 */
export function flagSide(
  x: number,
  width: number,
  merged: 'start' | 'end' | null = null,
  room = FLAG_PX,
): 'left' | 'right' {
  const prefer = merged === 'end' ? 'left' : 'right'
  if (prefer === 'right') return x > width - room && x >= room ? 'left' : 'right'
  return x < room && x <= width - room ? 'right' : 'left'
}
