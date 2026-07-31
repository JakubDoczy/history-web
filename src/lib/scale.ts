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
