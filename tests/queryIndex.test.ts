import { describe, it, expect } from 'vitest'
import {
  BIG_RADIUS_DEG,
  GeoGrid,
  SpanIndex,
  TopScored,
  argsortAscending,
  lowerBound,
  separationDeg,
  upperBound,
  type Located,
  type Spanned,
} from '../src/lib/queryIndex'

/* A deterministic PRNG: these tests are randomised on purpose (the structures
   are conservative approximations, and the only honest check is "agrees with
   brute force on a lot of shapes"), but a failure has to be reproducible. */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}

describe('binary search helpers', () => {
  const a = [1, 3, 3, 3, 7]
  it('lowerBound finds the first not-less element', () => {
    expect(lowerBound(a, 3)).toBe(1)
    expect(lowerBound(a, 4)).toBe(4)
    expect(lowerBound(a, 0)).toBe(0)
    expect(lowerBound(a, 99)).toBe(5)
  })
  it('upperBound finds the first greater element', () => {
    expect(upperBound(a, 3)).toBe(4)
    expect(upperBound(a, 1)).toBe(1)
    expect(upperBound(a, 99)).toBe(5)
  })
})

describe('argsortAscending', () => {
  const sorted = (keys: number[]) => [...argsortAscending(keys)].map((i) => keys[i])

  it('orders indices by key', () => {
    expect([...argsortAscending([5, 1, 9, 3])]).toEqual([1, 3, 0, 2])
  })

  it('breaks ties by index, so the order is total', () => {
    expect([...argsortAscending([7, 7, 7])]).toEqual([0, 1, 2])
  })

  it('takes the packed fast path on integer keys spanning geological time', () => {
    const keys = [2026, -4.5e9, 1969, 0, -66e6]
    expect(sorted(keys)).toEqual([-4.5e9, -66e6, 0, 1969, 2026])
  })

  it('falls back to a comparator when keys are not integers', () => {
    // the packing trick is only exact on integers; the guard has to notice
    expect(sorted([1.5, -0.25, 1.25])).toEqual([-0.25, 1.25, 1.5])
  })

  it('falls back when the key range is too wide to pack an index beside it', () => {
    expect(sorted([0, 2 ** 52, -(2 ** 52)])).toEqual([-(2 ** 52), 0, 2 ** 52])
  })

  it('handles empty and single-element input', () => {
    expect([...argsortAscending([])]).toEqual([])
    expect([...argsortAscending([42])]).toEqual([0])
  })

  it('agrees with a comparator sort on random integer keys', () => {
    const rand = rng(23)
    const keys = Array.from({ length: 5000 }, () => Math.round((rand() - 0.5) * 1e9))
    const expected = Array.from({ length: keys.length }, (_, i) => i).sort(
      (a, b) => keys[a] - keys[b] || a - b,
    )
    expect([...argsortAscending(keys)]).toEqual(expected)
  })
})

describe('SpanIndex', () => {
  const brute = (items: Spanned[], s: number, e: number) =>
    items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.start <= e && (it.end ?? it.start) >= s)
      .map(({ i }) => i)

  const collect = (idx: SpanIndex, s: number, e: number) => {
    const out: number[] = []
    idx.forEach(s, e, (i) => out.push(i))
    return out.sort((a, b) => a - b)
  }

  it('finds points and spans that touch the window, and nothing else', () => {
    const items: Spanned[] = [
      { start: 1969 }, // point inside
      { start: 1939, end: 1945 }, // wholly inside
      { start: -50e6, end: 2026 }, // swallows the window
      { start: 2100 }, // after
      { start: 1900, end: 1930 }, // before
    ]
    const idx = new SpanIndex(items)
    expect(collect(idx, 1940, 1970)).toEqual([0, 1, 2])
    expect(idx.countIntersecting(1940, 1970)).toBe(3)
  })

  it('treats both ends as closed — a window touching one year of a span hits it', () => {
    const idx = new SpanIndex([{ start: 1939, end: 1945 }])
    expect(collect(idx, 1945, 1950)).toEqual([0])
    expect(collect(idx, 1930, 1939)).toEqual([0])
    expect(collect(idx, 1946, 1950)).toEqual([])
  })

  it('survives reversed spans by normalising them', () => {
    const idx = new SpanIndex([{ start: 1945, end: 1939 }])
    expect(collect(idx, 1941, 1942)).toEqual([0])
  })

  it('an empty or backwards window finds nothing', () => {
    const idx = new SpanIndex([{ start: 0, end: 10 }])
    expect(collect(idx, 20, 5)).toEqual([])
    expect(idx.countIntersecting(20, 5)).toBe(0)
  })

  it('agrees with brute force across nine orders of magnitude of span', () => {
    const rand = rng(7)
    const items: Spanned[] = Array.from({ length: 900 }, () => {
      const start = Math.round((rand() - 0.9) * 2e6)
      // spans from a day-long battle to a geological age
      const span = rand() < 0.4 ? 0 : Math.round(10 ** (rand() * 8))
      return span ? { start, end: start + span } : { start }
    })
    const idx = new SpanIndex(items)
    for (let t = 0; t < 200; t++) {
      const s = Math.round((rand() - 0.9) * 2e6)
      const e = s + Math.round(10 ** (rand() * 6))
      expect(collect(idx, s, e)).toEqual(brute(items, s, e))
      expect(idx.countIntersecting(s, e)).toBe(brute(items, s, e).length)
    }
  })

  it('handles an empty index', () => {
    const idx = new SpanIndex([])
    expect(collect(idx, 0, 1)).toEqual([])
    expect(idx.countIntersecting(0, 1)).toBe(0)
    expect(idx.size).toBe(0)
  })
})

describe('separationDeg', () => {
  it('measures the short way round the antimeridian', () => {
    expect(separationDeg(0, 179, 0, -179)).toBeCloseTo(2, 6)
  })
  it('is the latitude difference along a meridian', () => {
    expect(separationDeg(10, 5, 40, 5)).toBeCloseTo(30, 6)
  })
  it('foreshortens with latitude', () => {
    expect(separationDeg(60, 0, 60, 2)).toBeLessThan(2)
  })
})

describe('GeoGrid', () => {
  const brute = (items: Located[], cap: { lat: number; lng: number; radiusDeg: number }) =>
    items
      .map((it, i) => ({ it, i }))
      .filter(
        ({ it }) =>
          separationDeg(cap.lat, cap.lng, it.lat, it.lng) <= cap.radiusDeg + (it.radiusDeg ?? 0),
      )
      .map(({ i }) => i)

  const collect = (grid: GeoGrid, cap: { lat: number; lng: number; radiusDeg: number }) => {
    const out: number[] = []
    grid.forEach(cap, (i) => out.push(i))
    return out.sort((a, b) => a - b)
  }

  it('finds what is in the cap and rejects what is outside it', () => {
    const items: Located[] = [
      { lat: 48.85, lng: 2.35 }, // Paris
      { lat: 51.5, lng: -0.13 }, // London
      { lat: -33.9, lng: 151.2 }, // Sydney
    ]
    const grid = new GeoGrid(items)
    expect(collect(grid, { lat: 50, lng: 1, radiusDeg: 4 })).toEqual([0, 1])
    expect(collect(grid, { lat: 50, lng: 1, radiusDeg: 1 })).toEqual([])
  })

  it('an area item is inside when its footprint reaches the cap', () => {
    const grid = new GeoGrid([{ lat: 0, lng: 0, radiusDeg: 3 }])
    expect(collect(grid, { lat: 0, lng: 4, radiusDeg: 1.5 })).toEqual([0])
    expect(collect(grid, { lat: 0, lng: 6, radiusDeg: 1.5 })).toEqual([])
  })

  it('holds oversized footprints aside and still finds them', () => {
    const grid = new GeoGrid([{ lat: 0, lng: 0, radiusDeg: BIG_RADIUS_DEG + 20 }])
    // a cap on the other side of the world misses it; one 20° away does not
    expect(collect(grid, { lat: 0, lng: 20, radiusDeg: 1 })).toEqual([0])
    expect(collect(grid, { lat: 0, lng: 140, radiusDeg: 1 })).toEqual([])
  })

  it('agrees with brute force over random caps, poles and the seam included', () => {
    const rand = rng(11)
    const items: Located[] = Array.from({ length: 1200 }, () => ({
      // deliberately not uniform on the sphere: clumps at the seam and the poles
      lat: rand() < 0.15 ? 90 - rand() * 4 : (rand() - 0.5) * 178,
      lng: rand() < 0.2 ? 180 - rand() * 3 : (rand() - 0.5) * 360,
      radiusDeg: rand() < 0.1 ? rand() * 12 : 0,
    }))
    const grid = new GeoGrid(items)
    for (let t = 0; t < 250; t++) {
      const cap = {
        lat: (rand() - 0.5) * 178,
        lng: (rand() - 0.5) * 360,
        radiusDeg: 10 ** (rand() * 2 - 1), // 0.1° to 100°
      }
      expect(collect(grid, cap)).toEqual(brute(items, cap))
    }
  })

  it('caps over a pole take everything near it', () => {
    const items: Located[] = [
      { lat: 89, lng: 0 },
      { lat: 89, lng: 180 },
      { lat: 89, lng: -90 },
      { lat: 0, lng: 0 },
    ]
    const grid = new GeoGrid(items)
    expect(collect(grid, { lat: 88, lng: 0, radiusDeg: 5 })).toEqual([0, 1, 2])
  })

  it('candidateCount never under-counts what the query returns', () => {
    const rand = rng(3)
    const items: Located[] = Array.from({ length: 400 }, () => ({
      lat: (rand() - 0.5) * 160,
      lng: (rand() - 0.5) * 360,
    }))
    const grid = new GeoGrid(items)
    for (let t = 0; t < 50; t++) {
      const cap = { lat: (rand() - 0.5) * 160, lng: (rand() - 0.5) * 360, radiusDeg: rand() * 40 }
      expect(grid.candidateCount(cap)).toBeGreaterThanOrEqual(collect(grid, cap).length)
    }
  })

  it('contains() answers the same question as forEach', () => {
    const rand = rng(5)
    const items: Located[] = Array.from({ length: 200 }, () => ({
      lat: (rand() - 0.5) * 160,
      lng: (rand() - 0.5) * 360,
      radiusDeg: rand() < 0.2 ? rand() * 8 : 0,
    }))
    const grid = new GeoGrid(items)
    const cap = { lat: 20, lng: 30, radiusDeg: 25 }
    const inside = new Set(collect(grid, cap))
    for (let i = 0; i < items.length; i++) expect(grid.contains(cap, i)).toBe(inside.has(i))
  })

  it('handles an empty index', () => {
    const grid = new GeoGrid([])
    expect(collect(grid, { lat: 0, lng: 0, radiusDeg: 90 })).toEqual([])
    expect(grid.size).toBe(0)
  })
})

describe('TopScored', () => {
  const drainIds = (top: TopScored<string>) => top.drain()

  it('keeps the best `cap` by score', () => {
    const top = new TopScored<string>(3)
    ;[5, 1, 9, 7, 3].forEach((s, i) => top.push(`e${i}`, s, i))
    expect(drainIds(top)).toEqual(['e2', 'e3', 'e0']) // 9, 7, 5
  })

  it('breaks ties on the canonical order, whatever order candidates arrive in', () => {
    const a = new TopScored<string>(2)
    a.push('x', 5, 3)
    a.push('y', 5, 1)
    const b = new TopScored<string>(2)
    b.push('y', 5, 1)
    b.push('x', 5, 3)
    expect(drainIds(a)).toEqual(['y', 'x'])
    expect(drainIds(b)).toEqual(['y', 'x'])
  })

  it('evicts by the same total order it sorts by', () => {
    // the loser of a tie is the one with the later canonical position
    const top = new TopScored<string>(1)
    top.push('late', 5, 9)
    top.push('early', 5, 2)
    expect(drainIds(top)).toEqual(['early'])
  })

  it('reports the weakest kept score once full, and −∞ before', () => {
    const top = new TopScored<string>(2)
    expect(top.worstScore).toBe(-Infinity)
    top.push('a', 4, 0)
    expect(top.full).toBe(false)
    top.push('b', 8, 1)
    expect(top.full).toBe(true)
    expect(top.worstScore).toBe(4)
    top.push('c', 6, 2)
    expect(top.worstScore).toBe(6)
  })

  it('agrees with a full sort on random input', () => {
    const rand = rng(13)
    for (let t = 0; t < 40; t++) {
      const n = 1 + Math.floor(rand() * 200)
      const cap = 1 + Math.floor(rand() * 20)
      const rows = Array.from({ length: n }, (_, i) => ({
        id: `e${i}`,
        // coarse scores, so ties are common and the tie-break is exercised
        s: Math.round(rand() * 8),
        o: i,
      }))
      const top = new TopScored<string>(cap)
      for (const r of rows) top.push(r.id, r.s, r.o)
      const expected = [...rows]
        .sort((a, b) => b.s - a.s || a.o - b.o)
        .slice(0, cap)
        .map((r) => r.id)
      expect(top.drain()).toEqual(expected)
    }
  })

  it('a cap of zero keeps nothing', () => {
    const top = new TopScored<string>(0)
    top.push('a', 5, 0)
    expect(top.drain()).toEqual([])
  })
})
