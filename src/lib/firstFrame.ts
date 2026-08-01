/**
 * "The planet is on screen" as something other parts of the app can wait for.
 *
 * First paint is a bandwidth auction, and the day basemap has to win it. Before
 * this existed, three other things were requested from `onMounted` and bid
 * against it: the 900 kB starfield, the event spine, and every chunk the opening
 * window touches — 1.38 MB of contention for a picture none of them appear in.
 * None of them is needed for the first frame, and two of them (stars, pins) look
 * *better* arriving a beat after the planet than competing with it.
 *
 * So the globe releases this gate when it has actually drawn, and the deferred
 * work hangs off it. It is a one-way latch, not an event: work registered after
 * the release runs immediately, because "did I miss it?" is the bug this shape
 * exists to make impossible.
 *
 * The deadline is the other half. A gate that only opens on a rendered globe
 * opens never on a machine with no WebGL, on a lost context, or on any route
 * that does not mount one — and the event data is not optional. So the latch
 * also opens on a timer, and the deferred work is late rather than lost.
 */

export interface FirstFrameOptions {
  /** Open anyway after this long, in case no globe ever draws. 0 disables. */
  deadlineMs?: number
  /** Injectable for tests. */
  timer?: (fn: () => void, ms: number) => unknown
}

/** How long to wait for a globe before assuming there will not be one. */
export const FIRST_FRAME_DEADLINE_MS = 6000

export class FirstFrameGate {
  private opened = false
  private waiting: (() => void)[] = []
  private armed = false
  private deadlineMs: number
  private timer: (fn: () => void, ms: number) => unknown

  constructor(o: FirstFrameOptions = {}) {
    this.deadlineMs = o.deadlineMs ?? FIRST_FRAME_DEADLINE_MS
    this.timer = o.timer ?? ((fn, ms) => setTimeout(fn, ms))
  }

  /** Whether the first frame has been drawn (or the deadline gave up on it). */
  get drawn(): boolean {
    return this.opened
  }

  /**
   * Run `cb` once there is a globe on screen — synchronously if there already
   * is one.
   *
   * The deadline is armed by the first caller rather than at construction: until
   * something is waiting there is nothing for it to rescue, and arming at import
   * time would start the clock during module evaluation in tests.
   */
  whenDrawn(cb: () => void): void {
    if (this.opened) {
      cb()
      return
    }
    this.waiting.push(cb)
    if (!this.armed && this.deadlineMs > 0) {
      this.armed = true
      this.timer(() => this.release(), this.deadlineMs)
    }
  }

  /**
   * The globe drew. Idempotent: later frames are not more first, and the
   * deadline firing after a real release must not run anything twice.
   */
  release(): void {
    if (this.opened) return
    this.opened = true
    const queued = this.waiting
    this.waiting = []
    for (const cb of queued) cb()
  }
}

/** The app's gate: released by GlobeView, awaited by App.vue and the globe itself. */
export const firstFrame = new FirstFrameGate()
