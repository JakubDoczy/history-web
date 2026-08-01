export const EARTH_RADIUS_KM = 6371

/**
 * Ground kilometres per screen pixel at the point under the camera.
 *
 * The globe's own radius cancels: the camera sits `altitude` radii above the
 * surface, the vertical field of view subtends 2·alt·tan(fov/2) radii there, and
 * converting radii to kilometres reintroduces the Earth's real radius.
 */
export const kmPerPixel = (altitude: number, fovDeg: number, viewportPx: number): number =>
  (2 * altitude * Math.tan((fovDeg * Math.PI) / 360) * EARTH_RADIUS_KM) / viewportPx

/** Largest 1/2/5×10ⁿ distance whose bar fits within `maxPx`. */
export function niceScale(kmPerPx: number, maxPx = 130): { km: number; px: number } {
  const limit = kmPerPx * maxPx
  const pow = 10 ** Math.floor(Math.log10(limit))
  const km = [5, 2, 1].map((m) => m * pow).find((v) => v <= limit) ?? pow / 10
  return { km, px: km / kmPerPx }
}

/** Renders as metres below 1 km, and with thousands separators above. */
export const formatDistance = (km: number): string =>
  km < 1 ? `${Math.round(km * 1000)} m` : `${km.toLocaleString('en-US')} km`


/**
 * How present the cloud layer should be at a given altitude: full when the
 * whole disc is in view, gone well before the surface fills the screen. Clouds
 * sell the planet seen from orbit and spoil it seen from close up, where they
 * simply hide the ground you zoomed in to look at.
 */
export const cloudFadeFor = (visibleSpanDeg: number): number =>
  Math.max(0, Math.min(1, (visibleSpanDeg - 55) / 45))

/** Strongest unsharp the cloud mask is ever given. Subtle by design: past this
 * the mask's own JPEG blocking starts to come back up with the detail. */
export const CLOUD_SHARPEN_MAX = 0.55

/**
 * How hard to sharpen the cloud mask at a given altitude.
 *
 * The band that matters is the one where clouds are still drawn but the mask is
 * being magnified — roughly 100° of visible arc down to the 55° where
 * `cloudFadeFor` has retired them. Off entirely from 120° up, where a texel is
 * smaller than a pixel and sharpening would only alias; full by 60°, just
 * before the clouds themselves go. The globe's `closeness` signal is no use
 * here: it is still zero at 40°, long after the last cloud has faded out.
 */
export const cloudSharpenFor = (visibleSpanDeg: number): number =>
  CLOUD_SHARPEN_MAX * Math.max(0, Math.min(1, (120 - visibleSpanDeg) / 60))

/** How fast the cloud deck slides, in UV per second. Read by `cloudDriftPhase`
 * and by the shader's `setCloudDrift`, so the two cannot disagree. */
export const CLOUD_DRIFT_UV_PER_S = 0.0016

/**
 * Where the deck is, as a pure function of wall-clock time.
 *
 * This is the whole of the drift animation, and it being a *function of the
 * clock* rather than an accumulator is the point. The previous scheme advanced
 * the phase on a timer of its own — one step every `driftIntervalMs`, sized so
 * that a step moved the deck 0.4 screen pixels — and left it alone in between.
 * That was fine as long as the only frames drawn were the frames the timer
 * asked for, and the app draws frames for a dozen other reasons: a pointer
 * moving over the canvas, OrbitControls' damping, the render pump's one-second
 * safety tick, a texture or an era frame landing. Measured on an idle globe
 * with a pointer resting on it, 61% of rendered frames drew a phase identical
 * to the frame before, and the frames that did advance jumped up to 3.6x an
 * even step. That is exactly what "staggered" describes: the deck freezes for
 * as many frames as the renderer happens to draw, then catches up in one go.
 *
 * Evaluated per frame from the clock, the phase cannot do that. Whatever the
 * reason a frame is being drawn, and however irregularly frames arrive, each
 * one shows the deck where the wall clock says it is — so the *only* remaining
 * question is how often to draw, and that is a smoothness question rather than
 * a correctness one (see `cloudIdleIntervalMs`).
 *
 * Wrapped into [0, 1) so the value stays exact over a long session; the shader
 * fract()s it again, so the wrap is invisible.
 */
export const cloudDriftPhase = (elapsedMs: number): number => {
  const p = ((elapsedMs / 1000) * CLOUD_DRIFT_UV_PER_S) % 1
  return p < 0 ? p + 1 : p
}

/**
 * Frames per second to draw an idle globe at while the clouds are moving.
 *
 * With the phase continuous, the cadence buys nothing but smoothness, so it is
 * chosen for smoothness alone. The deck is slow — 0.0016 UV/s is 0.58° of
 * longitude a second, which at the default framing works out at about 3.5 px/s
 * — so at 30 Hz a frame advances it by roughly a *tenth* of a pixel, and the
 * motion is continuous well below the threshold where stepping is visible.
 *
 * 30 rather than a full 60: measured over 5 s of idle at 400x400 under
 * SwiftShader, the renderer's own cost is 12.4 ms of main-thread task time per
 * drawn frame, so the cadence is very nearly the whole of the idle bill —
 * 60 Hz costs twice the energy of 30 Hz for a per-frame displacement of 0.06 px
 * against 0.12 px, i.e. for a difference nothing can see. Both are far below
 * the ~1 px per frame where an eye starts to read motion as a sequence of
 * positions; the old 8-9 Hz at 0.4 px was not.
 */
export const CLOUD_IDLE_HZ = 30

/**
 * The one zoom where 30 Hz is not enough, in screen pixels per frame.
 *
 * The deck's speed *on screen* rises steeply as the camera closes in: at the
 * default framing it is 3.5 px/s, and at the closest view the film survives to
 * (altitude 0.15, where `cloudFadeFor` has it down to 9% alpha) it is 64 px/s,
 * which 30 Hz would present in 2.1 px steps. So the rate is a ceiling on the
 * interval rather than a fixed interval: 30 Hz, unless the deck is crossing
 * pixels fast enough to need more, and then as many frames as the display will
 * give. Half a pixel is comfortably inside where an eye stops resolving the
 * steps and is where the old rule sat at its *fastest*, not its slowest.
 */
export const CLOUD_IDLE_STEP_PX = 0.5

/**
 * How long to wait between idle frames — or `null` for "draw nothing at all".
 *
 * The deep sleep is the reason this returns a nullable rather than a number.
 * With no cloud film on screen (deep time, the setting off, or a close
 * approach) and with `prefers-reduced-motion`, there is nothing animating on an
 * untouched globe, and the render pump should park indefinitely rather than
 * wake 30 times a second to redraw an identical picture.
 *
 * `viewSpanDeg` is the ground actually inside the frame (lib/detailImagery),
 * not the horizon: close in the two differ by more than an order of magnitude,
 * and it is the framed span that says how many pixels a degree is worth. An
 * interval under the display's own frame time simply means every frame.
 */
export const cloudIdleIntervalMs = (o: {
  cloudsShown: boolean
  reducedMotion: boolean
  viewSpanDeg: number
  viewportPx: number
}): number | null => {
  if (!o.cloudsShown || o.reducedMotion) return null
  const pxPerSec = CLOUD_DRIFT_UV_PER_S * 360 * (o.viewportPx / Math.max(o.viewSpanDeg, 1e-6))
  return Math.min(1000 / CLOUD_IDLE_HZ, (1000 * CLOUD_IDLE_STEP_PX) / Math.max(pxPerSec, 1e-9))
}
