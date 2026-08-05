import { describe, it, expect } from 'vitest'
import {
  BASE_LEVEL,
  TILE_BYTES,
  TILE_PX,
  TileCache,
  bboxOf,
  childrenOf,
  levelPxPerDeg,
  maxLevel,
  parentOf,
  placeOnCanvas,
  targetLevel,
  tileBbox,
  tileCols,
  tileKey,
  tilePlan,
  tileRows,
  tileSpanDeg,
  tilesCovering,
  type Tile,
} from '../src/lib/tilePyramid'
import {
  BASE_SOURCE,
  BASE_TEXTURE_PX_PER_DEG,
  SHARP_SOURCE,
  Z_MAX,
  baseTexelsPerScreenPx,
  degPerScreenPx,
  viewBbox,
  type Bbox,
} from '../src/lib/detailImagery'

const box = (minLat: number, minLng: number, maxLat: number, maxLng: number): Bbox => ({
  minLat,
  minLng,
  maxLat,
  maxLng,
})

describe('the grid', () => {
  it('is 2:1, square in degrees, at every level', () => {
    for (let z = 1; z <= 14; z++) {
      expect(tileCols(z)).toBe(2 * tileRows(z))
      expect(tileCols(z) * tileSpanDeg(z)).toBeCloseTo(360, 6)
      expect(tileRows(z) * tileSpanDeg(z)).toBeCloseTo(180, 6)
    }
  })

  it('makes the bundled world texture exactly level 3', () => {
    // 4096 px across 360 degrees is 512 * 2^3; nobody chose 3, the division did
    expect(BASE_LEVEL).toBe(3)
    expect(levelPxPerDeg(BASE_LEVEL)).toBeCloseTo(BASE_TEXTURE_PX_PER_DEG, 9)
  })

  it('doubles resolution per level', () => {
    for (let z = 4; z < 12; z++) {
      expect(levelPxPerDeg(z + 1) / levelPxPerDeg(z)).toBeCloseTo(2, 9)
    }
  })
})

describe('tileBbox', () => {
  it('tiles the whole world at level 1 with no gap and no overlap', () => {
    const seen: Bbox[] = []
    for (let y = 0; y < tileRows(1); y++)
      for (let x = 0; x < tileCols(1); x++) seen.push(tileBbox(1, x, y))
    expect(seen).toHaveLength(2)
    expect(Math.min(...seen.map((b) => b.minLng))).toBe(-180)
    expect(Math.max(...seen.map((b) => b.maxLng))).toBe(180)
    expect(Math.min(...seen.map((b) => b.minLat))).toBe(-90)
    expect(Math.max(...seen.map((b) => b.maxLat))).toBe(90)
  })

  it('puts row 0 at the north pole and column 0 at the antimeridian', () => {
    const t = tileBbox(4, 0, 0)
    expect(t.maxLat).toBe(90)
    expect(t.minLng).toBe(-180)
    expect(t.maxLat - t.minLat).toBeCloseTo(tileSpanDeg(4), 9)
  })

  it('reaches the south pole in the last row', () => {
    for (const z of [2, 5, 9]) {
      expect(tileBbox(z, 0, tileRows(z) - 1).minLat).toBeCloseTo(-90, 9)
    }
  })

  it('never leaves valid geographic bounds', () => {
    for (const z of [1, 4, 7, 12]) {
      for (const [x, y] of [
        [0, 0],
        [tileCols(z) - 1, tileRows(z) - 1],
        [tileCols(z) >> 1, tileRows(z) >> 1],
      ]) {
        const b = tileBbox(z, x, y)
        expect(b.minLat).toBeGreaterThanOrEqual(-90)
        expect(b.maxLat).toBeLessThanOrEqual(90)
        expect(b.minLng).toBeGreaterThanOrEqual(-180)
        expect(b.maxLng).toBeLessThanOrEqual(180)
      }
    }
  })

  it('agrees with the parent/child relation on both axes', () => {
    for (const t of [{ z: 6, x: 13, y: 21 }, { z: 9, x: 0, y: 0 }, { z: 5, x: 31, y: 15 }]) {
      const p = bboxOf(parentOf(t))
      const own = bboxOf(t)
      expect(own.minLat).toBeGreaterThanOrEqual(p.minLat - 1e-9)
      expect(own.maxLat).toBeLessThanOrEqual(p.maxLat + 1e-9)
      expect(own.minLng).toBeGreaterThanOrEqual(p.minLng - 1e-9)
      expect(own.maxLng).toBeLessThanOrEqual(p.maxLng + 1e-9)
      // and the four children tile the parent exactly
      const kids = childrenOf(parentOf(t)).map(bboxOf)
      expect(kids.some((k) => k.minLat === own.minLat && k.minLng === own.minLng)).toBe(true)
      const area = kids.reduce((s, k) => s + (k.maxLat - k.minLat) * (k.maxLng - k.minLng), 0)
      expect(area).toBeCloseTo((p.maxLat - p.minLat) * (p.maxLng - p.minLng), 9)
    }
  })
})

describe('tilesCovering', () => {
  it('covers every corner of the rectangle it is asked for', () => {
    for (const z of [4, 6, 9]) {
      for (const b of [box(45, 10, 47, 13), box(-33.9, 150.9, -33.8, 151.3), box(0, -0.1, 0.1, 0)]) {
        const tiles = tilesCovering(b, z).map(bboxOf)
        for (const [lat, lng] of [
          [b.minLat, b.minLng],
          [b.maxLat, b.maxLng],
          [b.minLat, b.maxLng],
          [(b.minLat + b.maxLat) / 2, (b.minLng + b.maxLng) / 2],
        ]) {
          expect(
            tiles.some(
              (t) => t.minLat <= lat && lat <= t.maxLat && t.minLng <= lng && lng <= t.maxLng,
            ),
          ).toBe(true)
        }
      }
    }
  })

  it('is the smallest such set: one tile for a box inside one tile', () => {
    const t = tileBbox(8, 100, 60)
    const inside = box(
      t.minLat + 0.1 * tileSpanDeg(8),
      t.minLng + 0.1 * tileSpanDeg(8),
      t.maxLat - 0.1 * tileSpanDeg(8),
      t.maxLng - 0.1 * tileSpanDeg(8),
    )
    expect(tilesCovering(inside, 8)).toEqual([{ z: 8, x: 100, y: 60 }])
  })

  it('grows by exactly one row or column when the box crosses a tile edge', () => {
    const t = tileBbox(6, 20, 12)
    const nudged = { ...t, maxLng: t.maxLng + tileSpanDeg(6) * 0.01 }
    expect(tilesCovering(t, 6)).toHaveLength(1)
    expect(tilesCovering(nudged, 6)).toHaveLength(2)
  })

  it('wraps longitude rather than leaving a hole at the antimeridian', () => {
    const b = box(0, 178, 2, 182) // past +180: the far side of the world
    const tiles = tilesCovering(b, 4)
    expect(tiles.every((t) => t.x >= 0 && t.x < tileCols(4))).toBe(true)
    expect(new Set(tiles.map((t) => t.x))).toEqual(new Set([15, 0]))
  })

  it('clamps latitude at the poles instead of indexing off the grid', () => {
    const tiles = tilesCovering(box(-95, 0, 95, 10), 5)
    expect(tiles.every((t) => t.y >= 0 && t.y < tileRows(5))).toBe(true)
    expect(Math.min(...tiles.map((t) => t.y))).toBe(0)
    expect(Math.max(...tiles.map((t) => t.y))).toBe(tileRows(5) - 1)
  })

  it('never returns the same tile twice, even for a box wider than the world', () => {
    const tiles = tilesCovering(box(-10, -400, 10, 400), 4)
    expect(new Set(tiles.map((t) => tileKey(t, 's'))).size).toBe(tiles.length)
    expect(tiles).toHaveLength(tileCols(4) * tilesCovering(box(-10, 0, 10, 1), 4).length)
  })

  it('returns at least one tile for a degenerate rectangle', () => {
    expect(tilesCovering(box(45, 10, 45, 10), 7)).toHaveLength(1)
  })
})

describe('targetLevel', () => {
  /**
   * The contract the old `imageSize` held, restated for the pyramid: the level
   * shown is never blurrier than the screen it is on, and never finer than the
   * source can honestly serve.
   */
  it('is never blurrier than the screen', () => {
    for (const screenPx of [640, 900, 1800, 3000]) {
      for (const alt of [0.4, 0.2, 0.08, 0.03, 0.01, 0.004, 0.001]) {
        const z = targetLevel(baseTexelsPerScreenPx(alt, screenPx), Z_MAX)
        const screenPxPerDeg = 1 / degPerScreenPx(alt, screenPx)
        if (z < Z_MAX) expect(levelPxPerDeg(z)).toBeGreaterThanOrEqual(screenPxPerDeg)
      }
    }
  })

  it('is the smallest level that manages it — never two levels of waste', () => {
    for (const screenPx of [640, 1800]) {
      for (const alt of [0.3, 0.05, 0.01, 0.002]) {
        const z = targetLevel(baseTexelsPerScreenPx(alt, screenPx), Z_MAX)
        const screenPxPerDeg = 1 / degPerScreenPx(alt, screenPx)
        if (z > BASE_LEVEL + 1) expect(levelPxPerDeg(z - 1)).toBeLessThan(screenPxPerDeg)
      }
    }
  })

  it('starts one level above the base map, which is already level 3', () => {
    // detailWanted only fires below one base texel per screen pixel, so the
    // floor is reached exactly where streaming becomes worth anything at all
    expect(targetLevel(1, Z_MAX)).toBe(BASE_LEVEL + 1)
    expect(targetLevel(4, Z_MAX)).toBe(BASE_LEVEL + 1)
  })

  it('rises by one for every halving of the base map on screen', () => {
    for (let i = 0; i < 6; i++) {
      expect(targetLevel(2 ** -i, Z_MAX)).toBe(Math.min(BASE_LEVEL + Math.max(i, 1), Z_MAX))
    }
  })

  it('stops where the sharp source does', () => {
    expect(targetLevel(1e-9, Z_MAX)).toBe(Z_MAX)
  })
})

describe('maxLevel', () => {
  it('is what the source declares, not a guess', () => {
    expect(maxLevel(SHARP_SOURCE)).toBe(12)
    expect(maxLevel(BASE_SOURCE)).toBe(7)
    expect(Z_MAX).toBe(maxLevel(SHARP_SOURCE))
  })

  it('never asks a source for more detail than it holds', () => {
    for (const src of [BASE_SOURCE, SHARP_SOURCE]) {
      expect(levelPxPerDeg(maxLevel(src))).toBeLessThanOrEqual(src.pxPerDeg)
      expect(levelPxPerDeg(maxLevel(src) + 1)).toBeGreaterThan(src.pxPerDeg)
    }
  })
})

describe('tilePlan', () => {
  const view = viewBbox(45, 10, 0.02, 1)
  const z = targetLevel(baseTexelsPerScreenPx(0.02, 900), Z_MAX)

  it('covers the view at the target level and at the level below it', () => {
    const plan = tilePlan(view, z)
    expect(plan.z).toBe(z)
    expect(plan.level).toEqual(expect.arrayContaining(tilesCovering(view, z)))
    expect(plan.level).toHaveLength(tilesCovering(view, z).length)
    expect(plan.fallback).toHaveLength(tilesCovering(view, z - 1).length)
    expect(plan.fallback.every((t) => t.z === z - 1)).toBe(true)
  })

  it('is roughly four times cheaper one level down, which is why it is the fallback', () => {
    const plan = tilePlan(view, z)
    expect(plan.fallback.length * 3).toBeLessThan(plan.level.length * 2)
  })

  it('orders the target level outward from the centre of the frame', () => {
    const plan = tilePlan(view, z)
    const cLat = (view.minLat + view.maxLat) / 2
    const cLng = (view.minLng + view.maxLng) / 2
    const far = (t: Tile) => {
      const b = bboxOf(t)
      return ((b.minLat + b.maxLat) / 2 - cLat) ** 2 + ((b.minLng + b.maxLng) / 2 - cLng) ** 2
    }
    const distances = plan.level.map(far)
    expect([...distances].sort((a, b) => a - b)).toEqual(distances)
  })

  it('rings the visible set without repeating any of it', () => {
    const plan = tilePlan(view, z)
    const inside = new Set(plan.level.map((t) => tileKey(t, '')))
    expect(plan.ring.some((t) => inside.has(tileKey(t, '')))).toBe(false)
    // a ring one tile deep around a rectangle: (w+2)(h+2) - wh
    const xs = new Set(plan.level.map((t) => t.x)).size
    const ys = new Set(plan.level.map((t) => t.y)).size
    expect(plan.ring.length).toBe((xs + 2) * (ys + 2) - xs * ys)
  })

  it('keeps the ring inside the grid at the poles', () => {
    const polar = tilePlan(viewBbox(89.4, 10, 0.02, 1), 8)
    for (const t of [...polar.level, ...polar.ring, ...polar.fallback]) {
      expect(t.y).toBeGreaterThanOrEqual(0)
      expect(t.y).toBeLessThan(tileRows(t.z))
      expect(t.x).toBeGreaterThanOrEqual(0)
      expect(t.x).toBeLessThan(tileCols(t.z))
    }
  })
})

describe('placeOnCanvas', () => {
  const target = box(0, 0, 10, 20) // 10 deg tall, 20 deg wide

  it('fills the canvas when the tile is the view', () => {
    expect(placeOnCanvas(target, target, 200, 100)).toEqual({ x: 0, y: 0, w: 200, h: 100 })
  })

  it('flips latitude into canvas y, which runs the other way', () => {
    // the top half of the view in latitude is the top half of the canvas
    const top = placeOnCanvas(target, box(5, 0, 10, 20), 200, 100)
    expect(top).toEqual({ x: 0, y: 0, w: 200, h: 50 })
    const bottom = placeOnCanvas(target, box(0, 0, 5, 20), 200, 100)
    expect(bottom).toEqual({ x: 0, y: 50, w: 200, h: 50 })
  })

  it('places longitude left to right', () => {
    expect(placeOnCanvas(target, box(0, 10, 10, 20), 200, 100)).toEqual({
      x: 100,
      y: 0,
      w: 100,
      h: 100,
    })
  })

  it('lets a tile hang off the edge rather than distorting it', () => {
    // a tile larger than the view keeps its own scale; clipping is the canvas's
    // job, and squeezing it would misplace every pixel inside
    const p = placeOnCanvas(target, box(-10, -20, 20, 40), 200, 100)
    expect(p.x).toBe(-200)
    expect(p.y).toBe(-100)
    expect(p.w).toBe(600)
    expect(p.h).toBe(300)
  })

  it('round-trips a tile centre to the canvas centre', () => {
    for (const t of [box(0, 0, 10, 20), box(-33, 140, -30, 155), box(60, -10, 62, -4)]) {
      const inner = box(
        t.minLat + 0.25 * (t.maxLat - t.minLat),
        t.minLng + 0.25 * (t.maxLng - t.minLng),
        t.maxLat - 0.25 * (t.maxLat - t.minLat),
        t.maxLng - 0.25 * (t.maxLng - t.minLng),
      )
      const { x, y, w, h } = placeOnCanvas(t, inner, 400, 300)
      expect(x + w / 2).toBeCloseTo(200, 6)
      expect(y + h / 2).toBeCloseTo(150, 6)
    }
  })

  it('lays neighbouring tiles down edge to edge, with no seam to feather', () => {
    const view = viewBbox(45, 10, 0.02, 1)
    const tiles = tilesCovering(view, 10)
    const placed = new Map(tiles.map((t) => [tileKey(t, ''), placeOnCanvas(view, bboxOf(t), 1024, 1024)]))
    for (const t of tiles) {
      const mine = placed.get(tileKey(t, ''))!
      const east = placed.get(tileKey({ z: t.z, x: t.x + 1, y: t.y }, ''))
      if (east) expect(mine.x + mine.w).toBeCloseTo(east.x, 6)
      const below = placed.get(tileKey({ z: t.z, x: t.x, y: t.y + 1 }, ''))
      if (below) expect(mine.y + mine.h).toBeCloseTo(below.y, 6)
    }
  })
})

describe('TileCache', () => {
  const key = (n: number) => `9/${n}/0/s`

  it('holds what fits and reports its own size honestly', () => {
    const c = new TileCache<string>(TILE_BYTES * 4)
    for (let i = 0; i < 3; i++) c.set(key(i), `t${i}`)
    expect(c.size).toBe(3)
    expect(c.bytes).toBe(3 * TILE_BYTES)
    expect(c.get(key(1))).toBe('t1')
    expect(c.has(key(9))).toBe(false)
  })

  it('evicts the least recently wanted once the budget bites', () => {
    const c = new TileCache<string>(TILE_BYTES * 3)
    for (let i = 0; i < 5; i++) c.set(key(i), `t${i}`)
    expect(c.size).toBe(3)
    expect(c.has(key(0))).toBe(false)
    expect(c.has(key(1))).toBe(false)
    expect(c.has(key(4))).toBe(true)
  })

  it('releases what it drops, because a bitmap is memory the collector cannot see', () => {
    const closed: string[] = []
    const c = new TileCache<string>(TILE_BYTES * 2, (v) => closed.push(v))
    for (let i = 0; i < 4; i++) c.set(key(i), `t${i}`)
    expect(closed).toEqual(['t0', 't1'])
    c.clear()
    expect(closed).toEqual(['t0', 't1', 't2', 't3'])
  })

  it('never evicts a pinned tile, even past the budget', () => {
    const c = new TileCache<string>(TILE_BYTES * 2)
    for (let i = 0; i < 4; i++) c.set(key(i), `t${i}`)
    c.pin([key(2), key(3)])
    for (let i = 4; i < 10; i++) c.set(key(i), `t${i}`)
    expect(c.has(key(2))).toBe(true)
    expect(c.has(key(3))).toBe(true)
    // memory yields to correctness: a view whose own tiles exceed the budget
    // keeps them, because a hole on screen costs a refetch as well as a hole
    expect(c.size).toBe(2)
  })

  it('makes pinning the touch, so the wanted set is always the newest', () => {
    const c = new TileCache<string>(TILE_BYTES * 3)
    for (let i = 0; i < 3; i++) c.set(key(i), `t${i}`)
    c.pin([key(0)]) // the oldest is wanted again
    c.pin([]) // …and then it is not, but it is no longer the oldest either
    c.set(key(3), 't3')
    expect(c.has(key(0))).toBe(true)
    expect(c.has(key(1))).toBe(false)
  })

  it('replaces a tile in place, releasing the copy it displaced', () => {
    const closed: string[] = []
    const c = new TileCache<string>(TILE_BYTES * 4, (v) => closed.push(v))
    c.set(key(0), 'old')
    c.set(key(0), 'new')
    expect(c.size).toBe(1)
    expect(c.get(key(0))).toBe('new')
    expect(closed).toEqual(['old'])
  })

  it('counts a tile as its decoded RGBA bytes, which is what memory costs', () => {
    expect(TILE_BYTES).toBe(TILE_PX * TILE_PX * 4)
  })
})
