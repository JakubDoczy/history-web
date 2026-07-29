import { earthWind, valueNoise, type Wind } from './wind'

const RAD = Math.PI / 180
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Deterministic PRNG so a seed reproduces a run exactly. */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export interface CloudFieldOptions {
  width?: number
  height?: number
  seed?: number
  wind?: Wind
  /** Convective sources and subsidence sinks (off = pure advection, for tests). */
  weather?: boolean
  /** Fractional decay per second. */
  decay?: number
}

/**
 * Cloud coverage on an equirectangular grid, evolved by semi-Lagrangian
 * advection through a wind field: new(x) = old(x − v·dt). Longitude wraps,
 * latitude clamps, and zonal displacement is divided by cos(lat) so meridian
 * convergence spins the polar regions the way it does on a real planet.
 */
export class CloudField {
  readonly width: number
  readonly height: number
  data: Float32Array
  private scratch: Float32Array
  private wind: Wind
  private weather: boolean
  private decay: number
  private rand: () => number
  private noiseSeed: number
  private t = 0

  constructor(opts: CloudFieldOptions = {}) {
    this.width = opts.width ?? 256
    this.height = opts.height ?? 128
    this.wind = opts.wind ?? earthWind(opts.seed ?? 1)
    this.weather = opts.weather ?? true
    this.decay = opts.decay ?? 0.02
    this.rand = mulberry32(opts.seed ?? 1)
    this.noiseSeed = opts.seed ?? 1
    this.data = new Float32Array(this.width * this.height)
    this.scratch = new Float32Array(this.width * this.height)
    if (this.weather) this.seedInitial()
  }

  get time() {
    return this.t
  }

  lngAt = (x: number) => -180 + ((x + 0.5) * 360) / this.width
  latAt = (y: number) => 90 - ((y + 0.5) * 180) / this.height

  /** Bilinear sample in grid coordinates; wraps in x, clamps in y. */
  sample(x: number, y: number): number {
    const { width: w, height: h, data } = this
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const xa = ((x0 % w) + w) % w
    const xb = (xa + 1) % w
    const ya = clamp(y0, 0, h - 1)
    const yb = clamp(y0 + 1, 0, h - 1)
    const top = data[ya * w + xa] * (1 - fx) + data[ya * w + xb] * fx
    const bot = data[yb * w + xa] * (1 - fx) + data[yb * w + xb] * fx
    return top * (1 - fy) + bot * fy
  }

  /** Advance the simulation by `dt` seconds. */
  step(dt: number) {
    const { width: w, height: h } = this
    for (let y = 0; y < h; y++) {
      const lat = this.latAt(y)
      const stretch = 1 / Math.max(Math.cos(lat * RAD), 0.15) // meridian convergence
      for (let x = 0; x < w; x++) {
        const [u, v] = this.wind(this.lngAt(x), lat, this.t)
        const dx = ((u * stretch * dt) / 360) * w
        const dy = -((v * dt) / 180) * h
        this.scratch[y * w + x] = this.sample(x - dx, y - dy)
      }
    }
    ;[this.data, this.scratch] = [this.scratch, this.data]
    if (this.weather) this.applyWeather(dt)
    if (this.decay) for (let i = 0; i < this.data.length; i++) this.data[i] *= 1 - this.decay * dt
    this.t += dt
  }

  /**
   * Convective supply at the ITCZ and storm tracks, subsidence in the subtropics.
   * Supply is modulated by slowly-drifting coherent noise, not per-cell white
   * noise: that gives patches which advection can carry, and keeps the
   * equilibrium (supply / decay) below 1 so the field never saturates flat.
   */
  private applyWeather(dt: number) {
    const { width: w, height: h, data } = this
    for (let y = 0; y < h; y++) {
      const lat = this.latAt(y)
      const a = Math.abs(lat)
      const supply =
        0.014 * Math.exp(-((lat - 4) ** 2) / (2 * 8.5 ** 2)) + // ITCZ
        0.012 * Math.exp(-((a - 54) ** 2) / (2 * 13 ** 2)) + // storm tracks
        0.005 * Math.exp(-((a - 82) ** 2) / (2 * 11 ** 2)) // polar
      const sink = 0.007 * Math.exp(-((a - 27) ** 2) / (2 * 9 ** 2))
      for (let x = 0; x < w; x++) {
        const n = valueNoise(this.lngAt(x) * 0.06, lat * 0.06, this.t * 0.02, this.noiseSeed)
        const i = y * w + x
        data[i] = clamp(data[i] + (supply * (0.25 + 1.5 * n) - sink) * dt, 0, 1)
      }
    }
  }

  /** Spin up an initial pattern so the field doesn't start empty. */
  private seedInitial() {
    for (let i = 0; i < this.data.length; i++) this.data[i] = this.rand() * 0.5
    for (let i = 0; i < 40; i++) this.step(1)
  }

  /** Coverage as 8-bit alpha, ready to upload as a texture. */
  toAlpha(out = new Uint8Array(this.data.length)): Uint8Array {
    for (let i = 0; i < this.data.length; i++) out[i] = clamp(this.data[i], 0, 1) * 255
    return out
  }
}
