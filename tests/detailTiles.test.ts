import { describe, it, expect } from 'vitest'
import {
  degPerTile,
  visibleSpanDeg,
  levelForAltitude,
  tileRange,
  rangeToUvRect,
} from '../src/lib/detailTiles'

describe('tile grid geometry', () => {
  it('halves tile span with each level, starting at a 180° tile', () => {
    expect(degPerTile(0)).toBe(180)
    expect(degPerTile(3)).toBe(22.5)
    expect(degPerTile(7)).toBeCloseTo(1.40625)
  })
})

describe('visibleSpanDeg', () => {
  it('shrinks as the camera descends', () => {
    const spans = [2.5, 1, 0.4, 0.1, 0.02].map(visibleSpanDeg)
    for (let i = 1; i < spans.length; i++) expect(spans[i]).toBeLessThan(spans[i - 1])
  })
  it('never exceeds a hemisphere', () => {
    expect(visibleSpanDeg(1e6)).toBeLessThanOrEqual(180.0001)
  })
})

describe('levelForAltitude', () => {
  it('selects finer levels as the camera descends', () => {
    const levels = [2.5, 1, 0.3, 0.08, 0.01].map((a) => levelForAltitude(a, 3, 7))
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1])
  })
  it('stays inside the matrix bounds at any altitude', () => {
    for (const alt of [1e9, 1e3, 2.5, 0.5, 0.01, 1e-9]) {
      const l = levelForAltitude(alt, 3, 7)
      expect(l).toBeGreaterThanOrEqual(0)
      expect(l).toBeLessThanOrEqual(7)
      expect(Number.isInteger(l)).toBe(true)
    }
    // from orbit the whole disc is visible, so only the coarsest levels apply
    expect(levelForAltitude(1e9, 3, 7)).toBeLessThanOrEqual(1)
  })

  it('picks a level whose patch actually covers the view', () => {
    for (const alt of [1.5, 0.6, 0.2, 0.05, 0.01]) {
      const l = levelForAltitude(alt, 3, 7)
      if (l === 7) continue // saturated at the finest level
      expect(degPerTile(l) * 3).toBeGreaterThanOrEqual(visibleSpanDeg(alt))
    }
  })
})

describe('tileRange', () => {
  it('centres the block on the requested point', () => {
    const r = tileRange(0, 0, 4, 3) // deg per tile = 11.25
    // lng 0 → column 16 of 32; lat 0 → row 8 of 16
    expect(r.col0).toBe(15)
    expect(r.row0).toBe(7)
    expect(r.cols).toBe(3)
    expect(r.rows).toBe(3)
  })

  it('clamps at the poles and the date line without going out of range', () => {
    for (const [lat, lng] of [[90, 180], [-90, -180], [89.9, 179.9], [-89.9, -179.9]] as const) {
      const r = tileRange(lat, lng, 5, 3)
      expect(r.col0).toBeGreaterThanOrEqual(0)
      expect(r.row0).toBeGreaterThanOrEqual(0)
      expect(r.col0 + r.cols).toBeLessThanOrEqual(2 ** 6)
      expect(r.row0 + r.rows).toBeLessThanOrEqual(2 ** 5)
    }
  })

  it('never asks for more tiles than the level contains', () => {
    const r = tileRange(0, 0, 0, 3) // level 0 is only 2×1 tiles
    expect(r.cols).toBe(2)
    expect(r.rows).toBe(1)
  })
})

describe('rangeToUvRect', () => {
  it('maps a whole-world block to the full UV square', () => {
    const [u0, v0, du, dv] = rangeToUvRect({ level: 0, col0: 0, row0: 0, cols: 2, rows: 1 })
    expect([u0, v0, du, dv]).toEqual([0, 0, 1, 1])
  })

  it('places a block at the UV coordinates of its own corner', () => {
    // level 2: 8×4 tiles of 45°. Block at col 4, row 1 → lng 0..135, lat -45..45
    const [u0, v0, du, dv] = rangeToUvRect({ level: 2, col0: 4, row0: 1, cols: 3, rows: 2 })
    expect(u0).toBeCloseTo(0.5) // lng 0
    expect(v0).toBeCloseTo(0.25) // lat -45
    expect(du).toBeCloseTo(135 / 360)
    expect(dv).toBeCloseTo(90 / 180)
  })

  it('round-trips the centre of a block back to the requested point', () => {
    const lat = 37.5, lng = -122.3, level = 6
    const r = tileRange(lat, lng, level, 3)
    const [u0, v0, du, dv] = rangeToUvRect(r)
    const u = (lng + 180) / 360
    const v = (lat + 90) / 180
    expect(u).toBeGreaterThanOrEqual(u0)
    expect(u).toBeLessThanOrEqual(u0 + du)
    expect(v).toBeGreaterThanOrEqual(v0)
    expect(v).toBeLessThanOrEqual(v0 + dv)
  })
})
