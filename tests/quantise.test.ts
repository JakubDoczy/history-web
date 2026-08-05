import { describe, it, expect } from 'vitest'
import { halfOctave } from '../src/lib/quantise'
import { clusterSpanBucket } from '../src/lib/eventClusters'
import { scopeRadiusBucket } from '../src/lib/viewport'

/* The one zoom ladder (lib/quantise.ts). It has no test file of its own until
   now because both callers had their own — but the property the ladder exists
   for is that the two callers AGREE, and that is a statement about neither of
   them individually. */

const RUNGS = [0.25, 0.3535533905932738, 0.5, 0.7071067811865476, 1, 1.4142135623730951, 2, 2.8284271247461903, 4]

describe('halfOctave', () => {
  it('lands on 2 ** (n / 2), and nowhere else', () => {
    for (const v of [0.3, 0.61, 1.1, 1.7, 3, 5.5, 40, 137, 4000]) {
      const rungs = Math.log2(halfOctave(v)) * 2
      expect(Math.abs(rungs - Math.round(rungs)), `${v}`).toBeLessThan(1e-9)
    }
  })

  it('is idempotent on a rung: quantising one leaves it where it is', () => {
    // 'nearest' only. `2 ** (n / 2)` does not round-trip exactly through
    // `log2` for odd n — 2**-0.5 comes back as -0.9999999999999998 rungs — so
    // 'up' may lift an exact rung to the next one. That is the rounding doing
    // what it promises rather than a defect: a radius is never shrunk.
    for (const r of RUNGS) {
      expect(halfOctave(r), `${r}`).toBeCloseTo(r, 9)
      expect(halfOctave(r, 'up'), `${r}`).toBeGreaterThanOrEqual(r * (1 - 1e-12))
    }
  })

  it('keeps the rungs a factor of ~1.41 apart — a step, never a jump', () => {
    for (let i = 1; i < RUNGS.length; i++)
      expect(RUNGS[i] / RUNGS[i - 1]).toBeCloseTo(Math.SQRT2, 9)
  })

  it('is monotone: a bigger value never buckets smaller', () => {
    let prevN = -Infinity
    let prevU = -Infinity
    for (let v = 0.01; v < 200; v *= 1.03) {
      const n = halfOctave(v)
      const u = halfOctave(v, 'up')
      expect(n).toBeGreaterThanOrEqual(prevN)
      expect(u).toBeGreaterThanOrEqual(prevU)
      prevN = n
      prevU = u
    }
  })

  it("rounds 'up' to a rung that is never below the value — the promise a radius makes", () => {
    // 'nearest' may shave up to 1 - 2**-0.25 (~16%) off; 'up' may not shave any,
    // because a scope radius says "everything inside this was considered".
    for (let v = 0.01; v < 200; v *= 1.017) {
      expect(halfOctave(v, 'up'), `${v}`).toBeGreaterThanOrEqual(v * (1 - 1e-12))
      expect(halfOctave(v), `${v}`).toBeGreaterThanOrEqual(v * 2 ** -0.25 - 1e-12)
    }
  })

  it("never returns 'up' more than one rung above the value", () => {
    for (let v = 0.01; v < 200; v *= 1.017)
      expect(halfOctave(v, 'up') / v, `${v}`).toBeLessThanOrEqual(Math.SQRT2 + 1e-9)
  })

  it('survives zero and negatives rather than returning NaN', () => {
    // Math.log2(0) is -Infinity; the floor inside is what keeps a degenerate
    // altitude (or a scope at a pole with no extent) from poisoning the ladder.
    expect(Number.isFinite(halfOctave(0))).toBe(true)
    expect(Number.isFinite(halfOctave(-5, 'up'))).toBe(true)
  })
})

describe('the two callers share one ladder', () => {
  it('puts clusterSpanBucket and scopeRadiusBucket on the same rungs', () => {
    // Load-bearing, and the reason the ladder was pulled out of both of them:
    // SCOPE_MARGIN is sized on the assumption that a zoom step means the same
    // thing to the clustering as it does to the query's circle. They differ
    // only in which way they round, so the test is that every value either
    // produces is a rung of the one lattice — never that the two agree value
    // for value, which they must not.
    for (let v = 0.05; v < 400; v *= 1.02)
      for (const out of [clusterSpanBucket(v), scopeRadiusBucket(v)]) {
        const rungs = Math.log2(out) * 2
        expect(Math.abs(rungs - Math.round(rungs)), `${v} -> ${out}`).toBeLessThan(1e-9)
      }
  })

  it('rounds each one the way its own meaning requires', () => {
    // a threshold may go either way; a promise may only grow
    expect(clusterSpanBucket(1.05)).toBeLessThan(1.05)
    expect(scopeRadiusBucket(1.05)).toBeGreaterThan(1.05)
  })
})
