/** Wind velocity at a point, in degrees of great-circle motion per second. */
export type Wind = (lngDeg: number, latDeg: number, timeSec: number) => [u: number, v: number]

const RAD = Math.PI / 180

/**
 * Earth's prevailing zonal belts in one term: sin(6·lat) has zeros exactly at
 * 0°/30°/60°/90°, so a single sine reproduces easterly trades (0–30°),
 * mid-latitude westerlies (30–60°) and polar easterlies (60–90°) — symmetric
 * across both hemispheres.
 */
export const beltWind = (lat: number, strength = 0.0016): [number, number] => [
  -strength * Math.sin(6 * Math.abs(lat) * RAD),
  // weak Hadley-cell drift toward the ITCZ
  -strength * 0.18 * Math.sin(2 * lat * RAD),
]

const hash = (x: number, y: number, z: number, seed: number) => {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 43.3) * 43758.5453
  return n - Math.floor(n)
}
const fade = (t: number) => t * t * (3 - 2 * t)

/** Smooth 3D value noise (2 space dimensions + time). */
export function valueNoise(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
  const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi)
  let v = 0
  for (let dz = 0; dz < 2; dz++)
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const w =
          (dx ? xf : 1 - xf) * (dy ? yf : 1 - yf) * (dz ? zf : 1 - zf)
        v += w * hash(xi + dx, yi + dy, zi + dz, seed)
      }
  return v
}

/**
 * Divergence-free turbulence: the curl of a scalar potential, so eddies swirl
 * without creating or destroying air. This is what makes cyclones emerge instead
 * of blobs pulsing in place.
 */
export function curlNoise(lng: number, lat: number, t: number, seed: number, scale = 0.055, amp = 0.0022): [number, number] {
  const e = 0.75
  const psi = (a: number, b: number) => valueNoise(a * scale, b * scale, t * 0.012, seed)
  const dPsiDy = (psi(lng, lat + e) - psi(lng, lat - e)) / (2 * e)
  const dPsiDx = (psi(lng + e, lat) - psi(lng - e, lat)) / (2 * e)
  return [amp * dPsiDy, -amp * dPsiDx]
}

/** Prevailing belts plus turbulent eddies. */
export const earthWind =
  (seed = 1): Wind =>
  (lng, lat, t) => {
    const [bu, bv] = beltWind(lat)
    const [cu, cv] = curlNoise(lng, lat, t, seed)
    return [bu + cu, bv + cv]
  }
