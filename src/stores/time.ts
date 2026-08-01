import { defineStore } from 'pinia'
import { clamp, toWarp, fromWarp, MIN_TIME, MAX_TIME, type Year } from '../lib/time'
import {
  clampSelection,
  orderSpan,
  sameSpan,
  tweenWindow,
  windowFitting,
  type Span,
} from '../lib/selection'
import type { Era } from '../lib/eras'

/**
 * How long the era-fit tween runs, in ms. Short enough to feel like a response
 * to the click rather than a journey — the point of animating at all is to show
 * *which way* the view moved, and past a third of a second that has been said.
 */
export const FIT_MS = 320

/**
 * The fit animation's handle, outside reactive state: a raf id is not something
 * a component should be able to watch, and wrapping it in a proxy would only
 * cost a re-render per frame.
 */
let fitRaf = 0
/**
 * Which fit is the current one. `cancelAnimationFrame` is enough in a browser,
 * but a fit's frames assign `range` *directly* (see `fitWindow`), so a stale one
 * arriving late would silently stomp whatever the user did to take the view
 * over. The token makes that unrepresentable rather than merely unlikely.
 */
let fitSeq = 0
const cancelFit = () => {
  if (fitRaf) globalThis.cancelAnimationFrame?.(fitRaf)
  fitRaf = 0
  fitSeq++
}

/**
 * Whether to animate at all. Asked per fit rather than cached, because the
 * setting can change under a running app — and answered `true` (i.e. do not
 * animate) wherever there is no `matchMedia` to ask, which is every test and
 * every non-DOM host: those get the destination, in one step, synchronously.
 */
const stillPreferred = (): boolean =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true

/** Opening view: the classical world through the present, framed on the eras
 *  most events live in. The selection is what the globe actually shows. */
const HOME_WINDOW: Span = { start: -550, end: MAX_TIME }
const HOME_SELECTION: Span = { start: 500, end: 1945 }

export const useTimeStore = defineStore('time', {
  state: () => ({
    currentTime: 1500 as Year,
    range: { ...HOME_WINDOW },
    /** Sub-range of `range` that filters what the globe shows (see stores/events). */
    selection: { ...HOME_SELECTION },
  }),
  getters: {
    span: (s) => s.range.end - s.range.start,
    selectionSpan: (s) => s.selection.end - s.selection.start,
  },
  actions: {
    /**
     * The cursor a user asked for. The selection is what the globe draws, so a
     * year picked from outside the band would put the cursor on a world with
     * none of its events on it: the band comes along (see extendSelectionTo).
     */
    setTime(t: Year) {
      cancelFit() // a scrub outranks a fit still in flight
      const target = clamp(t, this.range.start, this.range.end)
      this.extendSelectionTo(target)
      this.currentTime = target
    },
    /** Jump to a time; if it lies outside the window, recenter the window on it. */
    focusTime(t: Year) {
      cancelFit()
      const target = clamp(t)
      if (target < this.range.start || target > this.range.end) {
        const half = (toWarp(this.range.end) - toWarp(this.range.start)) / 2
        const c = toWarp(target)
        this.setRange({ start: clamp(fromWarp(c - half)), end: clamp(fromWarp(c + half)) })
      }
      // The window first, the band second: clampSelection works against the
      // window, so extending before the recentre would only be clipped back out.
      this.extendSelectionTo(target)
      this.currentTime = target
    },
    /**
     * Grow the selection just far enough to hold `t`, by moving the edge `t` is
     * past — exactly onto it. The far edge does not move and the band is never
     * recentred: the user asked for a year, not for a different span.
     *
     * Only the user-intent entry points call this (setTime, focusTime). The
     * cursor also moves on its own — setRange drags it in when the window
     * shrinks under it — and *that* must not touch the selection: the window
     * pulls the selection, the selection pulls the cursor, and a cursor that
     * pushed back on the selection would close that ring into a loop.
     *
     * A `t` already inside publishes nothing at all, which matters because the
     * ends of time are absorbing: setTime(MAX_TIME) extends the band to exactly
     * MAX_TIME once, and every later call finds it already there. (Exactly, not
     * the warp roundtrip of it — the same slack that made pan() oscillate.)
     */
    extendSelectionTo(t: Year) {
      const { start, end } = this.selection
      if (t >= start && t <= end) return
      if (t > end) this.setSelection(start, t)
      else this.setSelection(t, end)
    },
    /** Zoom in warp (display) space around a focus fraction [0..1] of the window. */
    zoom(factor: number, focus = 0.5) {
      cancelFit()
      const ws = toWarp(this.range.start)
      const we = toWarp(this.range.end)
      const pivot = ws + (we - ws) * focus
      const start = clamp(fromWarp(pivot - (pivot - ws) * factor))
      const end = clamp(fromWarp(pivot + (we - pivot) * factor))
      if (end - start >= 1) this.setRange({ start, end })
    },
    /** Pan by a fraction of the visible window (display space). */
    pan(fraction: number) {
      // Before the early-out below, not after: a pan that moves nothing because
      // it is hard against the end of time is still the user taking the view
      // over, and a fit must not carry on underneath it.
      cancelFit()
      const ws = toWarp(this.range.start)
      const we = toWarp(this.range.end)
      const lo = toWarp(MIN_TIME) - ws // how far left there is still room to go
      const hi = toWarp(MAX_TIME) - we
      const d = Math.max(lo, Math.min(hi, (we - ws) * fraction))
      // Already hard against the end being pushed at: not a pan.
      if (d === 0) return
      // A saturated end is *exactly* the end of time, not the warp roundtrip of
      // it. `fromWarp(toWarp(MIN_TIME))` comes back 5 µyr short, which is enough
      // room for the next pan to move and the one after to move back — so a
      // held drag at the bound oscillated between two windows five microseconds
      // of geological time apart, republishing the range on every pointer move
      // and re-running the whole downstream pipeline for each.
      const start = d === lo ? MIN_TIME : clamp(fromWarp(ws + d))
      const end = d === hi ? MAX_TIME : clamp(fromWarp(we + d))
      this.setRange({ start, end })
    },
    /**
     * Move the window. The selection follows it in, keeping what overlap it can,
     * and the cursor comes along too — a cursor outside the window has no mark on
     * the rail, yet it is what the globe's surface is drawn for.
     *
     * A move that changes none of the three publishes nothing. This is not a
     * micro-optimisation: pushing the window against the beginning or the end of
     * time is a *held gesture*, one call per pointer move, and every one of them
     * used to assign three fresh objects for the same three intervals. Vue
     * compares by identity, so each one re-ran the entire downstream pipeline —
     * the nation borders re-digested, the event index re-queried, the era plan
     * rebuilt — to arrive at the picture already on screen.
     */
    setRange(range: Span) {
      cancelFit() // a pan, a zoom or a wheel step takes the view over
      const selection = clampSelection(this.selection, range)
      const currentTime = clamp(this.currentTime, range.start, range.end)
      if (
        sameSpan(range, this.range) &&
        sameSpan(selection, this.selection) &&
        currentTime === this.currentTime
      )
        return
      this.range = range
      this.selection = selection
      this.currentTime = currentTime
    },
    /**
     * Set the selection from two instants in any order (a dragged handle may pass
     * the other) — and, as with setRange, only when the result actually differs:
     * a handle held against the edge of the window clamps to where it already is.
     */
    setSelection(a: Year, b: Year) {
      cancelFit()
      const selection = clampSelection({ start: a, end: b }, this.range)
      if (sameSpan(selection, this.selection)) return
      this.selection = selection
    },
    /**
     * Frame an era or sub-age: it becomes the selection, and the window is fitted
     * to it — the span plus 5% of air either side, and nothing else.
     *
     * Fitting rather than merely containing is the whole gesture. "Bring it into
     * view if it is not already there" left a century-long sub-age as a
     * fingernail of colour on a rail showing two millennia, which is a strange
     * answer to a click that said "show me this".
     *
     * The order matters. The selection is set *first* and directly, so that the
     * windows the tween passes through on its way cannot clip it (see
     * `clampSelection`) — for the length of the flight the band is simply wider
     * than the rail, which is exactly what flying into an era looks like. The
     * final window contains it by construction, so the invariant is intact the
     * moment the tween lands.
     */
    selectEra(era: Era) {
      cancelFit()
      const target = windowFitting(era)
      const selection = orderSpan(clamp(era.start), clamp(era.end))
      if (!sameSpan(selection, this.selection)) this.selection = selection
      // The cursor comes along, but only as far as it has to: one already inside
      // the era stays put (an era is a framing, not a jump), and one outside is
      // put on the near edge of the era rather than left adrift in the margin,
      // where it would drive the globe from a year the selection excludes.
      const currentTime = clamp(this.currentTime, selection.start, selection.end)
      if (currentTime !== this.currentTime) this.currentTime = currentTime
      this.fitWindow(target)
    },
    /**
     * Move the window to `target`, tweened in warp space unless the user has
     * asked for less motion (or there is no clock to tween against).
     *
     * Frames assign `range` directly instead of going through `setRange`: the
     * destination is known to be valid, the selection is already the thing being
     * flown to, and routing 20 intermediate windows through `clampSelection`
     * would chew the band up and re-run the whole event query on every one.
     */
    fitWindow(target: Span) {
      cancelFit()
      const from = { ...this.range }
      const land = (win: Span) => {
        if (!sameSpan(win, this.range)) this.range = win
        const t = clamp(this.currentTime, win.start, win.end)
        if (t !== this.currentTime) this.currentTime = t
      }
      const raf = globalThis.requestAnimationFrame
      if (!raf || stillPreferred() || sameSpan(from, target)) return land(target)
      const seq = fitSeq
      const t0 = performance.now()
      const step = () => {
        if (seq !== fitSeq) return // superseded, or the user took the view over
        const u = (performance.now() - t0) / FIT_MS
        land(tweenWindow(from, target, u))
        fitRaf = u >= 1 ? 0 : raf(step)
      }
      fitRaf = raf(step)
    },
    /** Abandon a running fit — anything the user does to the view outranks it. */
    stopFit: cancelFit,
  },
})
