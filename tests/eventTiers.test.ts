import { describe, it, expect } from 'vitest'
import {
  TIER_CUTS,
  TIER_HYSTERESIS,
  assignTiers,
  type Tier,
  type TierInput,
} from '../src/lib/eventTiers'

/** A ranked set of `n` rows, best first, with plausibly decaying scores. */
const ranked = (n: number, minorFrom = Infinity): TierInput[] =>
  Array.from({ length: n }, (_, i) => ({ id: `e${i}`, score: 100 - i, minor: i >= minorFrom }))

const tiersOf = (rows: TierInput[], prev?: ReadonlyMap<string, Tier>) => {
  const map = assignTiers(rows, prev)
  return rows.map((r) => map.get(r.id))
}

describe('assignTiers', () => {
  it('cuts the set into a leading fifth, a middle, and the rest', () => {
    const out = tiersOf(ranked(30))
    expect(out.filter((t) => t === 1)).toHaveLength(6)
    expect(out.filter((t) => t === 2)).toHaveLength(12)
    expect(out.filter((t) => t === 3)).toHaveLength(12)
  })

  it('cuts on rank, so a set of near-identical scores still splits', () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, score: 50 }))
    const out = tiersOf(flat)
    expect(out[0]).toBe(1)
    expect(out[19]).toBe(3)
  })

  it('is monotone: a better rank never gets a worse tier', () => {
    const out = tiersOf(ranked(47))
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!)
  })

  it('always gives a lone event the top tier', () => {
    expect(tiersOf(ranked(1))).toEqual([1])
  })

  it('is empty for an empty set', () => {
    expect(assignTiers([]).size).toBe(0)
  })

  it('puts minor events in tier 3 wherever they rank', () => {
    // a set made only of minor pins must not promote a fifth of them
    expect(tiersOf(ranked(10, 0))).toEqual(Array(10).fill(3))
    // and a minor pin that outranks ranked ones is still background
    const mixed: TierInput[] = [
      { id: 'minor', score: 99, minor: true },
      ...ranked(9).map((r) => ({ ...r, id: `r${r.id}` })),
    ]
    expect(assignTiers(mixed).get('minor')).toBe(3)
    expect(assignTiers(mixed).get('re0')).toBe(1)
  })
})

describe('tier hysteresis', () => {
  const n = 30
  const c1 = TIER_CUTS[0] * n // 6
  const c2 = TIER_CUTS[1] * n // 18

  /** A set where `id` sits at rank `at`. */
  const setWith = (id: string, at: number): TierInput[] =>
    Array.from({ length: n }, (_, i) => ({ id: i === at ? id : `x${i}`, score: 100 - i }))

  it('keeps a tier-1 event at tier 1 when it slips just past the cut', () => {
    const prev = new Map<string, Tier>([['a', 1]])
    const slipped = Math.floor(c1 * (1 + TIER_HYSTERESIS)) - 1 // rank 6: just past
    expect(assignTiers(setWith('a', slipped), prev).get('a')).toBe(1)
    // without the memory the same rank is tier 2
    expect(assignTiers(setWith('a', slipped)).get('a')).toBe(2)
  })

  it('drops it once it slips past the whole band', () => {
    const prev = new Map<string, Tier>([['a', 1]])
    expect(assignTiers(setWith('a', Math.ceil(c1 * (1 + TIER_HYSTERESIS)) + 1), prev).get('a')).toBe(
      2,
    )
  })

  it('makes promotion harder than staying put', () => {
    const prev = new Map<string, Tier>([['a', 2]])
    const justInside = Math.floor(c1) - 1 // rank 5: tier 1 for a newcomer
    expect(assignTiers(setWith('a', justInside)).get('a')).toBe(1)
    expect(assignTiers(setWith('a', justInside), prev).get('a')).toBe(2)
    // deep enough in and it is promoted anyway
    expect(assignTiers(setWith('a', 0), prev).get('a')).toBe(1)
  })

  it('applies the same band at the second cut', () => {
    const prev = new Map<string, Tier>([['a', 2]])
    const slipped = Math.floor(c2 * (1 + TIER_HYSTERESIS)) - 1
    expect(assignTiers(setWith('a', slipped), prev).get('a')).toBe(2)
    expect(assignTiers(setWith('a', slipped)).get('a')).toBe(3)
  })

  it('settles a scrub: jitter around a cut stops changing tiers', () => {
    // an event oscillating one place either side of the cut, ten times over
    let prev: ReadonlyMap<string, Tier> = new Map()
    const seen = new Set<Tier>()
    for (let t = 0; t < 10; t++) {
      const rank = t % 2 ? Math.floor(c1) : Math.floor(c1) - 1
      prev = assignTiers(setWith('a', rank), prev)
      if (t > 0) seen.add(prev.get('a')!)
    }
    expect(seen.size).toBe(1) // one tier held throughout, not two alternating
  })

  it('forgets an event that leaves the set', () => {
    const prev = new Map<string, Tier>([['a', 1]])
    const without = ranked(30)
    expect(assignTiers(without, prev).has('a')).toBe(false)
  })

  it('never lets the memory invert the order of two neighbours by more than the band', () => {
    // a set where every event remembers the *worst* tier: nothing is promoted
    // out of turn, and the leading event still leads
    const rows = ranked(25)
    const prev = new Map<string, Tier>(rows.map((r) => [r.id, 3 as Tier]))
    const out = assignTiers(rows, prev)
    expect(out.get('e0')).toBe(1)
    for (let i = 1; i < rows.length; i++)
      expect(out.get(rows[i].id)!).toBeGreaterThanOrEqual(out.get(rows[i - 1].id)!)
  })
})
