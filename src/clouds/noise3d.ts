/**
 * Tileable 3D noise volume for cloud detail, following the Nubis recipe:
 * R = Perlin–Worley (billowy base shape), G = higher-frequency Worley (edge
 * erosion). Both channels wrap in all three axes so the volume can be sampled
 * repeatedly across the globe without visible seams.
 */

const hash = (n: number) => {
  const s = Math.sin(n) * 43758.5453
  return s - Math.floor(s)
}

/** Worley (cellular) noise: distance to the nearest feature point, wrapped. */
function worley(x: number, y: number, z: number, cells: number, seed: number): number {
  const fx = x * cells, fy = y * cells, fz = z * cells
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz)
  let best = 1e9
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz
        const wx = ((cx % cells) + cells) % cells
        const wy = ((cy % cells) + cells) % cells
        const wz = ((cz % cells) + cells) % cells
        const h = wx * 73856093 ^ wy * 19349663 ^ wz * 83492791
        const px = cx + hash(h + seed)
        const py = cy + hash(h + seed + 1.7)
        const pz = cz + hash(h + seed + 3.3)
        const d = (fx - px) ** 2 + (fy - py) ** 2 + (fz - pz) ** 2
        if (d < best) best = d
      }
  return Math.min(1, Math.sqrt(best) / 1.1)
}

const fade = (t: number) => t * t * (3 - 2 * t)

/** Tileable value-noise fBm, standing in for Perlin. */
function valueFbm(x: number, y: number, z: number, cells: number, octaves: number, seed: number): number {
  let sum = 0, amp = 1, total = 0, c = cells
  for (let o = 0; o < octaves; o++) {
    const fx = x * c, fy = y * c, fz = z * c
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz)
    const tx = fade(fx - ix), ty = fade(fy - iy), tz = fade(fz - iz)
    let v = 0
    for (let dz = 0; dz < 2; dz++)
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const wx = ((ix + dx) % c + c) % c
          const wy = ((iy + dy) % c + c) % c
          const wz = ((iz + dz) % c + c) % c
          const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz)
          v += w * hash((wx * 12.9898 + wy * 78.233 + wz * 37.719) * (o + 1) + seed)
        }
    sum += v * amp
    total += amp
    amp *= 0.5
    c *= 2
  }
  return sum / total
}

const remap = (v: number, a: number, b: number, c: number, d: number) =>
  c + ((v - a) * (d - c)) / (b - a)

/** Builds the RG volume as raw bytes; `size` is the edge length in texels. */
export function buildNoiseVolume(size = 64, seed = 1): Uint8Array {
  const data = new Uint8Array(size * size * size * 2)
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size, w = z / size
        // Perlin–Worley: dilate the value-noise with inverted Worley so it keeps
        // Perlin's connectedness but gains Worley's packed billows.
        const perlin = valueFbm(u, v, w, 4, 3, seed)
        const wor = 1 - worley(u, v, w, 8, seed)
        const pw = Math.max(0, Math.min(1, remap(perlin, wor - 1, 1, 0, 1)))
        // erosion channel: two Worley octaves
        const detail = 1 - (worley(u, v, w, 12, seed + 11) * 0.65 + worley(u, v, w, 24, seed + 23) * 0.35)
        const i = (z * size * size + y * size + x) * 2
        data[i] = pw * 255
        data[i + 1] = Math.max(0, Math.min(1, detail)) * 255
      }
    }
  }
  return data
}
