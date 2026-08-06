/**
 * Significance tiers.
 *
 * The globe already ranks events — that is what the top-N budget is — but it
 * shows the result flat: thirty pins of nearly the same size, in which the
 * headline event of a century and the thirtieth-most-interesting thing in it
 * look alike. Tiers make the ranking visible without adding a second one: they
 * are cut from the same effective (coverage-penalised) score the culling used,
 * so a tier is a statement about *this* result set and nothing else.
 *
 * Relative, not absolute, and that is the whole design. An absolute threshold
 * on priority would make the tiers a second ranking list, with all the drift
 * that implies, and would leave a quiet century showing thirty tier-3 pins and
 * a busy decade showing thirty tier-1s. Relative cuts always produce a legible
 * spread: whatever is on screen, roughly a fifth of it leads.
 */

export type Tier = 1 | 2 | 3

/**
 * Where the cuts fall, as fractions of the result set: the leading fifth, the
 * middle two-fifths, the rest.
 *
 * At the default cap of thirty that is 6 / 12 / 12 — few enough leaders that
 * the glow means something, and a bottom tier big enough that the map has a
 * quiet background to read the leaders against.
 */
export const TIER_CUTS = [0.2, 0.6] as const

/**
 * How far past a cut an event must go before it changes tier, as a fraction of
 * the cut's own rank.
 *
 * Scrubbing the timeline moves every score continuously — the coverage penalty
 * is a function of the selection — so ranks shuffle constantly a few places
 * either side of a cut, and without hysteresis a pin near one would flicker
 * between two sizes for the whole drag. 0.3 means an event that has *earned*
 * tier 1 keeps it down to rank 26% (of a 30-pin set: rank 7 instead of 6), and
 * one below has to reach rank 14% (rank 4) to take it: a band of three or four
 * places, which is wider than scrubbing jitter and far narrower than a real
 * change in what the selection is about.
 *
 * The memory is one query deep and keyed by id, so an event that leaves the
 * result set and comes back is tiered afresh. That is deliberate: it re-entered
 * a different contest.
 */
export const TIER_HYSTERESIS = 0.3

/** One row of the ranked result: what the cut is made on. */
export interface TierInput {
  id: string
  /** Effective (coverage-penalised) score — the same number the culling used. */
  score: number
  /** Minor-tier events are always tier 3, whatever they score. */
  minor?: boolean
  /**
   * An event told in steps (see docs/design/sagas.md), which is lifted exactly
   * one tier — resolved by `sagaOf`, never sniffed for here.
   */
  saga?: boolean
}

/**
 * THE SAGA LIFT, in rank space.
 *
 * A saga is a thing with chapters and a map, and the reader cannot know that
 * until they open it — so it is worth a place nearer the front of the set than
 * its rank alone would buy. The lift is exactly one tier: a tier-2 saga leads,
 * a tier-3 saga joins the middle, and a saga already leading stays where it is
 * (there is no tier 0 to invent).
 *
 * Two properties make it safe, and both are why it is written as a move in RANK
 * SPACE rather than as a `tier - 1` on the way out:
 *
 *  · NOBODY IS DISPLACED. The cuts are thresholds, not quotas — each row is
 *    compared against them independently — so moving one row's position cannot
 *    push another row down. A top-tier plain event stays a top-tier plain event
 *    however many sagas are on screen, which is the promise the contract makes.
 *  · IT CANNOT OSCILLATE. The lifted position is a pure function of the rank,
 *    computed BEFORE the hysteresis bands are applied, so the hysteresis sees a
 *    saga exactly as it sees a plain event standing at that position. Lifting
 *    afterwards would instead feed the lifted tier back in as the held tier on
 *    the next query, and a saga would creep 3 → 2 → 1 with nothing having
 *    changed on screen.
 *
 * The map is the band above, proportionally: a saga at the top of tier 3 lands
 * at the top of tier 2, one at the bottom lands at the bottom. Order within the
 * band is preserved, so two sagas keep their relative standing.
 */
export function liftedRank(i: number, n: number, c1: number, c2: number): number {
  if (i >= c2) return c1 + ((i - c2) / Math.max(1e-9, n - c2)) * (c2 - c1)
  if (i >= c1) return ((i - c1) / Math.max(1e-9, c2 - c1)) * c1
  return i
}

/**
 * Assign tiers to a result set, best first.
 *
 * `ranked` must already be in display order (the order `EventIndex.query`
 * returns), because the cuts are made on rank, not on score: a set whose scores
 * are all within a point of each other still splits into three legible groups,
 * and one with a runaway leader still gives it company. `prev` is the previous
 * assignment — pass the map this function last returned — and only widens the
 * band each event has to cross; it can never invent a tier out of nothing.
 */
export function assignTiers(
  ranked: readonly TierInput[],
  prev?: ReadonlyMap<string, Tier>,
): Map<string, Tier> {
  const out = new Map<string, Tier>()
  const n = ranked.length
  if (!n) return out
  const [c1, c2] = [TIER_CUTS[0] * n, TIER_CUTS[1] * n]
  const h = TIER_HYSTERESIS
  for (let i = 0; i < n; i++) {
    const row = ranked[i]
    if (row.minor) {
      // The minor tier is the corpus's own statement that these are background;
      // a set made only of minor pins must not promote a fifth of them.
      out.set(row.id, 3)
      continue
    }
    // The lift first, so everything below it is the ordinary rule applied to a
    // position — see `liftedRank`.
    const pos = row.saga ? liftedRank(i, n, c1, c2) : i
    const held = prev?.get(row.id)
    // A boundary sits further out for an event already above it and further in
    // for one below: keeping what you have is easier than taking it.
    const cut1 = held === undefined ? c1 : held === 1 ? c1 * (1 + h) : c1 * (1 - h)
    const cut2 = held === undefined ? c2 : held === 3 ? c2 * (1 - h) : c2 * (1 + h)
    out.set(row.id, pos < cut1 ? 1 : pos < Math.max(cut1, cut2) ? 2 : 3)
  }
  return out
}
