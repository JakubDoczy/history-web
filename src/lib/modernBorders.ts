import { densifyPath } from './paths'
import { BORDER_SEGMENT_DEG, decodeRing, type BorderRing, type Nation, type Ring } from './nations'
import type { Year } from './time'
import { MODERN_BORDER } from './present/ink'
import raw from '../data/borders.modern.json'

/**
 * THE MODERN STATES — the world's present-day frontiers, as context.
 *
 * The polity corpus is historical and it thins out on the way to now: at 2000
 * the globe draws three polities (the United States, China, India) and Europe,
 * Africa and the Middle East have no political line on them at all. This is the
 * layer that fills that in, and everything about it is decided by what it is
 * NOT allowed to become.
 *
 * NOT POLITIES. A `Nation` is a protagonist: it has a fill, a hover label, a
 * click target, a place in `visibleNations`' ranking and a share of
 * `MAX_VISIBLE`. A hundred and ninety-five of them would be a different app —
 * the globe would show ten arbitrary countries by area and call it the world.
 * So the modern states are not in the corpus, are not in the store's `all`, and
 * never reach the polygon layer. What ships is the LINES BETWEEN them, which is
 * a set of open polylines, and they are handed to the same `FrontierLayer` the
 * polities' ink goes to — one entry, one colour, one draw call.
 *
 * NOT A SECOND COASTLINE. A country's shore is not in the payload: only arcs
 * that separate two countries are (scripts/modern-borders-lib.mjs). The drawn
 * map inks every coastline itself, and round 52's whole lesson is that a second
 * pen over that line is worse than no line at all.
 *
 * NOT ALL THE WAY BACK. Natural Earth ships today's borders, so there is a year
 * before which drawing them is a lie; `MODERN_FROM` is where that argument
 * landed and `dated` is the patch set that pushes it back to 1992. See the
 * library for both, written out in full.
 */

interface DatedGroup {
  from: Year
  pair: string
  why: string
  lines: number[][]
}

interface ModernBorderData {
  source: string
  from: Year
  to: Year
  stats: { vertices: number; pairs: number; droppedEdges: number }
  dated: DatedGroup[]
  lines: number[][]
}

const data = raw as unknown as ModernBorderData

/** The first year the set is drawn, and the last. See the build library. */
export const MODERN_FROM: Year = data.from
export const MODERN_TO: Year = data.to

/** Where the geometry came from, for the credits and for a test to assert. */
export const MODERN_SOURCE = data.source

/** The frontiers that were not frontiers yet, in the order they became ones. */
export const modernDatedGroups = (): readonly { from: Year; pair: string; why: string }[] =>
  data.dated.map((d) => ({ from: d.from, pair: d.pair, why: d.why }))

/** True while the modern set has anything honest to say about the year. */
export const isModernYear = (t: Year): boolean => t >= data.from && t <= data.to

/**
 * How many of the dated groups are in force at t — and the identity of the line
 * set, which is why it is a number rather than a boolean.
 *
 * The groups are cumulative in time (a frontier that appears never disappears),
 * so the count identifies the set exactly, and there are eight possible sets
 * over the whole window. It is the cache key, and it is what a timeline tick
 * compares to decide it has nothing to rebuild.
 */
export const modernGeneration = (t: Year): number =>
  isModernYear(t) ? data.dated.reduce((n, d) => n + (t >= d.from ? 1 : 0), 0) : -1


/**
 * The synthetic polity the ink layer hangs the lines on.
 *
 * `FrontierLayer` keys its rebuild on each entry's `nation.id` and colour, so
 * the generation goes in the id: crossing 2011 has to look like new data, and
 * a year that changes nothing has to look like the same data. Nothing else
 * reads this object — there is no fill, no label and no hover — but the type is
 * the polities' and it costs nothing to fill it in honestly.
 */
const nationFor = (gen: number): Nation => ({
  id: `modern@${gen}`,
  name: 'Modern states',
  color: MODERN_BORDER.color,
  from: data.from,
  to: data.to,
  visibleFrom: data.from,
  visibleTo: data.to,
  keyframes: [],
})


const cache = new Map<number, BorderRing[]>()

/**
 * The modern frontier ink at t: one `BorderRing`, or none outside the window.
 *
 * ONE entry for the whole world, not one per country pair. The layer walks
 * entries to build a single buffer either way, but the entry list is also the
 * key it compares to decide whether to rebuild — 362 entries would be a 362-part
 * string built on every timeline tick to answer a question the generation number
 * already answers.
 *
 * All three path fields hold the same polylines. A polity's boundary is one loop
 * that has to be split into the part the map already draws and the part it does
 * not; this payload arrived pre-split (it is *only* frontier), so every ink kind
 * resolves to the same lines and no caller has to know which one to ask for.
 */
export function modernBorderEntries(t: Year): BorderRing[] {
  const gen = modernGeneration(t)
  if (gen < 0) return []
  let entries = cache.get(gen)
  if (!entries) {
    const paths: Ring[] = []
    for (const enc of data.lines) paths.push(densifyPath(decodeRing(enc), BORDER_SEGMENT_DEG) as Ring)
    for (const group of data.dated)
      if (t >= group.from)
        for (const enc of group.lines) paths.push(densifyPath(decodeRing(enc), BORDER_SEGMENT_DEG) as Ring)
    const nation = nationFor(gen)
    entries = [
      {
        nation,
        kind: 'full',
        ring: paths[0] ?? [],
        coordinates: paths,
        label: nation.name,
        frontier: paths,
        coast: paths,
      },
    ]
    cache.set(gen, entries)
  }
  return entries
}
