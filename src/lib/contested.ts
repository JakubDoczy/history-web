import { densifyPath } from './paths'
import {
  BORDER_SEGMENT_DEG,
  coastRuns,
  decodeRing,
  decodeRuns,
  frontierRuns,
  type RingEntry,
  type CoastRuns,
  type EncodedRing,
  type Nation,
  type Piece,
  type Ring,
} from './nations'
import type { Year } from './time'

/**
 * CONTESTED TERRITORY — ground with no single honest holder.
 *
 * The contract is docs/design/contested-territory.md, and its structural idea
 * lives in the build rather than here: a zone is SUBTRACTED from every claimant
 * it overlaps in time (scripts/clip-nations.mjs), the way the sea is subtracted
 * from everyone. So by the time this module sees a zone, no polity fill covers
 * it, the overlap validator has judged it alongside the polities, and its
 * boundary and the claimant's remaining frontier are literally the same
 * vertices. What is left for the runtime is two decisions:
 *
 *  · WHAT COLOUR THE HATCH IS. The zone's fill is a diagonal hatch alternating
 *    its claimants' colours (lib/hatch.ts), and a claimant only has a colour if
 *    the reader can see it somewhere else on the map — an ink nothing else on
 *    the globe wears is a code with no legend. So a claimant that is a polity
 *    drawn at this instant contributes its own colour, and everyone else
 *    contributes nothing, which the hatch renders as neutral. Four of the five
 *    shipped zones are neutral on both sides, and that is not a shortfall: the
 *    Russian Federation, Pakistan, Morocco, the SADR, Sudan and South Sudan are
 *    not polities in this corpus and were deliberately never going to be (round
 *    57 — 241 units against a globe that caps itself at ten).
 *  · WHAT THE OUTLINE IS. A dashed line, in the frontier layer, on the same
 *    terms as any political ink: the inland edges only where the map draws its
 *    own coast, all of it on the photograph where nothing does.
 */

/** One side of a dispute, as the build resolved it. `color` iff it has a fill. */
export interface Claimant {
  id: string
  name: string
  /** The polity colour, present only when the corpus draws this claimant. */
  color?: string
}

/** A zone as `nations.clipped.json` ships it — same codec as a keyframe. */
export interface ContestedZone {
  id: string
  name: string
  from: Year
  to: Year
  claimants: Claimant[]
  polys: EncodedRing[][]
  coast?: CoastRuns[][]
}

/**
 * A zone on the globe: a `BorderRing` (so the ink layer needs no new type) with
 * the two things only a zone has — who claims it, and which two colours its
 * hatch alternates.
 */
export interface ContestedRing extends RingEntry {
  kind: 'contested'
  zone: ContestedZone
  /**
   * The stripe colours, in claimant order. An empty string is "no fill on this
   * map for this claimant", which `hatchMaterial` paints neutral.
   */
  hatch: [string, string]
}

/** True while the zone is disputed. Zones hold no keyframes: one shape, one span. */
export const isContestedAt = (z: ContestedZone, t: Year): boolean => t >= z.from && t <= z.to

/**
 * Which two colours this zone's hatch alternates at t.
 *
 * `drawn` is the set of polity ids the globe is showing at this instant, and it
 * is a parameter rather than a store read for the reason `frontierInkPlan` takes
 * one: what is on the map is the caller's business and a pure function is a
 * thing a test can pin. Only the first two claimants reach the hatch — a
 * two-tone stripe is what a reader can decode, and no zone here has three.
 */
export function hatchColors(z: ContestedZone, drawn: ReadonlySet<string>): [string, string] {
  const at = (i: number) => {
    const c = z.claimants[i] ?? z.claimants[z.claimants.length - 1]
    return c?.color && drawn.has(c.id) ? c.color : ''
  }
  return [at(0), at(1)]
}

/** "Crimea — claimed by Ukraine and the Russian Federation" */
export function contestedLabel(z: ContestedZone): string {
  const names = z.claimants.map((c) => c.name)
  const list =
    names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
  return `${z.name} — claimed by ${list}`
}

/**
 * The synthetic polity the ink layer hangs a zone's dashes on.
 *
 * `FrontierLayer` keys its rebuild on `nation.id` plus the colour and ink kind
 * it is given, so a zone needs an id that is stable while it is drawn and
 * distinct from every polity's. The prefix is the same one the build's
 * validators use, so a conviction naming `contested:crimea` and a rebuild key
 * naming it are talking about the same thing. Nothing else reads this object.
 */
const nationFor = (z: ContestedZone): Nation => ({
  id: `contested:${z.id}`,
  name: z.name,
  color: '#000000',
  from: z.from,
  to: z.to,
  visibleFrom: z.from,
  visibleTo: z.to,
  keyframes: [],
})

/**
 * The drawable rings of a zone, memoised on the zone and its resolved hatch.
 *
 * Held for the reason `borderRings` is, which lib/nations.ts writes out in
 * full: the globe's polygon layer joins by object identity and rebuilds a whole
 * three.js object — group, meshes, materials — for any datum it has not seen,
 * and this list is rebuilt on every timeline tick. The hatch is in the key
 * because a claimant entering or leaving the frame changes the material, and
 * the material is chosen from the entry.
 */
const cache = new Map<string, ContestedRing[]>()

export function contestedRings(z: ContestedZone, hatch: [string, string]): ContestedRing[] {
  const key = `${z.id}|${hatch[0]}|${hatch[1]}`
  let entries = cache.get(key)
  if (!entries) {
    const label = contestedLabel(z)
    const pieces: Piece[] = z.polys.map((rings) => rings.map(decodeRing))
    const coastal = pieces.map((rings, p) =>
      rings.map((ring, r) => decodeRuns(z.coast?.[p]?.[r] ?? [], ring.length)),
    )
    entries = pieces.map((rings, p) => ({
      kind: 'contested' as const,
      nation: nationFor(z),
      zone: z,
      hatch,
      ring: rings[0],
      coordinates: rings.map((r) => densifyPath([...r, r[0]], BORDER_SEGMENT_DEG) as Ring),
      label,
      frontier: rings
        .flatMap((r, i) => frontierRuns(r, coastal[p][i]))
        .map((run) => densifyPath(run, BORDER_SEGMENT_DEG) as Ring),
      // A zone's outline is ALREADY the dashed pen — dispute, not estimate —
      // so it has no separate sketch runs to hand the layer.
      sketch: [],
      coast: rings
        .flatMap((r, i) => coastRuns(r, coastal[p][i]))
        .map((run) => densifyPath(run, BORDER_SEGMENT_DEG) as Ring),
    }))
    cache.set(key, entries)
  }
  return entries
}
