/**
 * Frame-on-demand: when the renderer should run, and when it should stop.
 *
 * A globe nobody is touching draws the same picture sixty times a second — the
 * camera has not moved, no texture has arrived, no transition is running — and
 * every one of those frames is a full-screen pass of the surface shader plus the
 * atmosphere, the stars and every polygon. globe.gl can be told to stop
 * (`pauseAnimation`), which turns rendering into something that is *asked for*
 * rather than assumed.
 *
 * This is the policy half of that, kept separate from the wiring so it can be
 * reasoned about and tested: everything that can change the picture calls
 * `wake`, and `tick` — once per animation frame — decides when to park.
 *
 * Two things make it safe to park at all:
 *
 *  - The cushion. Plenty of things keep changing on their own after the event
 *    that started them: OrbitControls' damping settles over ~0.5 s after a drag,
 *    arcs transition for 180 ms and polygons for 300 ms, a texture upload lands
 *    a frame or two after the decode. So a wake buys a stretch of *time*, not a
 *    number of frames — a frame count would give a slow device twenty seconds of
 *    rendering for one wheel notch and a fast one a quarter of a second.
 *  - The safety tick. The list of things that dirty the picture can never be
 *    proven complete, so a frame is drawn once a second whether or not anything
 *    asked. That bounds a missed wake-up at a second of staleness rather than
 *    forever, and costs ~1 frame a second against 60.
 */
export interface RenderPumpOptions {
  /** How long a plain `wake()` keeps drawing. */
  cushionMs?: number
  /** How often a frame is drawn regardless; 0 disables the backstop. */
  safetyMs?: number
  /** Clock, injectable for tests. */
  now?: () => number
}

export const RENDER_CUSHION_MS = 1500
export const RENDER_SAFETY_MS = 1000

export class RenderPump {
  private cushionMs: number
  private safetyMs: number
  private clock: () => number
  /** Wall-clock time to keep drawing until. */
  private until: number
  /**
   * Frames still owed regardless of the clock.
   *
   * This is what makes `wake(0)` — "just this frame" — mean one whole frame
   * rather than none: without it, a zero-length cushion would be over before the
   * tick that was supposed to honour it.
   */
  private owed = 1
  private lastSafety: number
  private live = true

  /** Called when the loop has to start again. */
  onResume?: () => void
  /** Called when it may stop. */
  onPause?: () => void

  constructor(o: RenderPumpOptions = {}) {
    this.cushionMs = o.cushionMs ?? RENDER_CUSHION_MS
    this.safetyMs = o.safetyMs ?? RENDER_SAFETY_MS
    this.clock = o.now ?? (() => performance.now())
    this.until = this.clock() + this.cushionMs
    this.lastSafety = this.clock()
  }

  /** Whether the renderer should be running right now. */
  get running(): boolean {
    return this.live
  }

  /**
   * Ask for frames. `wake()` buys the full cushion; `wake(0)` buys exactly one
   * frame, which is what the cloud drift and the safety tick want.
   *
   * A wake never shortens an existing cushion — several dirty sources firing in
   * the same frame is the normal case, and the longest one wins.
   */
  wake(ms = this.cushionMs): void {
    this.until = Math.max(this.until, this.clock() + ms)
    this.owed = Math.max(this.owed, 1)
    if (!this.live) {
      this.live = true
      this.onResume?.()
    }
  }

  /**
   * One animation frame. Runs the safety backstop, then parks the renderer if
   * nothing is asking for frames any more.
   */
  tick(): void {
    const now = this.clock()
    if (this.safetyMs > 0 && now - this.lastSafety >= this.safetyMs) {
      this.lastSafety = now
      this.wake(0)
    }
    if (this.owed > 0) this.owed--
    if (this.live && this.owed === 0 && now >= this.until) {
      this.live = false
      this.onPause?.()
    }
  }
}
