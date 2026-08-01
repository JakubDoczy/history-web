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

/** How fast the cloud deck slides, in UV per second. Read by the shader's own
 * `setCloudDrift` and by the interval below, so the two cannot disagree. */
export const CLOUD_DRIFT_UV_PER_S = 0.0016

/**
 * How far the deck is allowed to move between two drift frames, in screen
 * pixels.
 *
 * A still globe with clouds on it is the one thing that keeps this app
 * rendering when nobody is touching it, and it did so at a flat 20 Hz — a rate
 * picked for the closest view the clouds survive to and then applied to every
 * view, including the one the globe actually sits at. That is backwards: the
 * deck's speed *on screen* falls with the zoom, so the wide view was being
 * redrawn for motion far below what an eye can resolve.
 *
 * 0.4 px is set from measurement rather than from taste. Screenshotting one
 * drift step at several intervals and differencing (900x900, SwiftShader):
 *
 *   altitude 1.10, 50 ms (what ships today):  mean 1.00/255, 8.9% of pixels >= 2
 *   altitude 2.50, 100 ms:                    mean 0.39/255, 3.3% of pixels >= 2
 *   altitude 2.50, 200 ms:                    mean 0.74/255, 4.5% of pixels >= 2
 *   altitude 2.50, 300 ms:                    mean 1.07/255, 5.4% of pixels >= 2
 *
 * At 0.4 px the default view lands near 115 ms, which changes less than half as
 * much of the picture per step as the app already presents at a closer zoom —
 * so no view is made worse than the worst one shipping now, and the default
 * view draws 8-9 frames a second instead of 20.
 *
 * Longitude only, and no cosine of latitude: the deck slides in u, so its
 * on-screen speed is fastest at the equator and this uses that worst case
 * rather than tracking where the camera happens to be looking.
 */
export const DRIFT_STEP_PX = 0.4
/** Never faster than the old fixed rate, and never slower than 4 Hz. */
export const DRIFT_MS_MIN = 50
export const DRIFT_MS_MAX = 250

/**
 * Milliseconds between cloud-drift frames for a given framed span.
 *
 * `viewSpanDeg` is the ground actually inside the frame (lib/detailImagery),
 * not the horizon: close in the two differ by more than an order of magnitude,
 * and it is the framed span that decides how many pixels a degree is worth.
 */
export const driftIntervalMs = (viewSpanDeg: number, viewportPx: number): number => {
  const pxPerSec = CLOUD_DRIFT_UV_PER_S * 360 * (viewportPx / Math.max(viewSpanDeg, 1e-6))
  const ms = (1000 * DRIFT_STEP_PX) / Math.max(pxPerSec, 1e-9)
  return Math.max(DRIFT_MS_MIN, Math.min(DRIFT_MS_MAX, ms))
}
