import { describe, it, expect } from 'vitest'
import { CloudField, beltWind, curlNoise, type Wind } from '../src/clouds'

/** Field with no weather and no decay: pure transport, for exact assertions. */
const advectOnly = (wind: Wind, seed = 3) =>
  new CloudField({ width: 64, height: 32, wind, weather: false, decay: 0, seed })

const blobAt = (f: CloudField, x: number, y: number) => {
  f.data.fill(0)
  f.data[y * f.width + x] = 1
}
const peak = (f: CloudField) => {
  let best = 0, at = 0
  f.data.forEach((v, i) => { if (v > best) { best = v; at = i } })
  return { x: at % f.width, y: Math.floor(at / f.width), value: best }
}
const mass = (f: CloudField) => f.data.reduce((a, b) => a + b, 0)

describe('wind belts', () => {
  it('reproduce trades, westerlies and polar easterlies in both hemispheres', () => {
    expect(beltWind(15)[0]).toBeLessThan(0) // NE trades: easterly
    expect(beltWind(45)[0]).toBeGreaterThan(0) // westerlies
    expect(beltWind(75)[0]).toBeLessThan(0) // polar easterlies
    expect(beltWind(-15)[0]).toBeLessThan(0) // SE trades
    expect(beltWind(-45)[0]).toBeGreaterThan(0)
  })
  it('are calm at the belt boundaries', () => {
    for (const lat of [0, 30, 60, 90]) expect(Math.abs(beltWind(lat)[0])).toBeLessThan(1e-9)
  })
})

describe('curl noise turbulence', () => {
  it('is divergence-free (no air created or destroyed)', () => {
    const e = 0.01
    for (const [lng, lat] of [[10, 20], [-140, -35], [77, 61]] as const) {
      const div =
        (curlNoise(lng + e, lat, 0, 1)[0] - curlNoise(lng - e, lat, 0, 1)[0]) / (2 * e) +
        (curlNoise(lng, lat + e, 0, 1)[1] - curlNoise(lng, lat - e, 0, 1)[1]) / (2 * e)
      expect(Math.abs(div)).toBeLessThan(1e-6)
    }
  })
  it('evolves over time rather than merely translating', () => {
    expect(curlNoise(30, 40, 0, 1)).not.toEqual(curlNoise(30, 40, 500, 1))
  })
})

describe('advection', () => {
  it('leaves the field untouched when there is no wind', () => {
    const f = advectOnly(() => [0, 0])
    blobAt(f, 20, 16)
    const before = [...f.data]
    f.step(10)
    expect([...f.data]).toEqual(before)
  })

  it('transports the field downwind (east and north)', () => {
    const east = advectOnly(() => [0.5, 0])
    blobAt(east, 20, 16) // row 16 sits near the equator: minimal cos stretch
    for (let i = 0; i < 5; i++) east.step(10)
    expect(peak(east).x).toBeGreaterThan(21)

    const north = advectOnly(() => [0, 0.5])
    blobAt(north, 20, 16)
    for (let i = 0; i < 5; i++) north.step(10)
    expect(peak(north).y).toBeLessThan(15) // y increases southward
  })

  it('wraps around the antimeridian', () => {
    const f = advectOnly(() => [0.2, 0])
    blobAt(f, f.width - 1, 16)
    f.step(30)
    const { x } = peak(f)
    expect(x).toBeLessThan(f.width / 2) // came out the other side
  })

  it('conserves total mass under pure transport', () => {
    const f = advectOnly((_, lat) => beltWind(lat))
    for (let i = 0; i < f.data.length; i++) f.data[i] = 0.4
    const before = mass(f)
    for (let i = 0; i < 50; i++) f.step(1)
    expect(mass(f) / before).toBeCloseTo(1, 2)
  })

  it('never leaves the physical range', () => {
    const f = new CloudField({ width: 48, height: 24, seed: 9 })
    for (let i = 0; i < 200; i++) f.step(1)
    expect(Math.min(...f.data)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...f.data)).toBeLessThanOrEqual(1)
  })
})

describe('weather', () => {
  it('produces the latitude structure of real cloud cover', () => {
    const f = new CloudField({ width: 128, height: 64, seed: 5 })
    for (let i = 0; i < 120; i++) f.step(1)
    const rowMean = (lat: number) => {
      const y = Math.round(((90 - lat) / 180) * f.height)
      let s = 0
      for (let x = 0; x < f.width; x++) s += f.data[y * f.width + x]
      return s / f.width
    }
    expect(rowMean(4)).toBeGreaterThan(rowMean(27)) // ITCZ wetter than subtropics
    expect(rowMean(54)).toBeGreaterThan(rowMean(27)) // storm track wetter too
  })

  it('is deterministic for a given seed, and different across seeds', () => {
    const run = (seed: number) => {
      const f = new CloudField({ width: 32, height: 16, seed })
      for (let i = 0; i < 20; i++) f.step(1)
      return [...f.data]
    }
    expect(run(7)).toEqual(run(7))
    expect(run(7)).not.toEqual(run(8))
  })

  it('keeps evolving instead of settling into a fixed pattern', () => {
    const f = new CloudField({ width: 64, height: 32, seed: 2 })
    for (let i = 0; i < 60; i++) f.step(1)
    const a = [...f.data]
    for (let i = 0; i < 60; i++) f.step(1)
    const changed = f.data.reduce((n, v, i) => n + (Math.abs(v - a[i]) > 0.05 ? 1 : 0), 0)
    expect(changed / f.data.length).toBeGreaterThan(0.2)
  })

  it('exports 8-bit alpha for texture upload', () => {
    const f = new CloudField({ width: 16, height: 8, seed: 1 })
    const a = f.toAlpha()
    expect(a.length).toBe(128)
    expect(Math.max(...a)).toBeLessThanOrEqual(255)
  })
})
