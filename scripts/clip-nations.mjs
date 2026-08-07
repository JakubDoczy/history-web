#!/usr/bin/env node
/**
 * BUILD THE POLITIES: clip them to the coast, agree their frontiers, classify
 * their edges, and refuse to ship an overlap.
 *
 *   npx tsx scripts/clip-nations.mjs            build, validate, write
 *   npx tsx scripts/clip-nations.mjs --check    validate what is on disk only
 *   npx tsx scripts/clip-nations.mjs --report   build, print the numbers, write
 *
 * WHICH FILE IS WHICH — the design decision this script exists to make.
 *
 *   src/data/nations.json          AUTHORING. Hand-drawn extents, open CW
 *                                  rings, smooth inland frontiers, coastlines
 *                                  drawn approximately or not at all. A human
 *                                  edits this and nothing else.
 *   src/data/frontiers.json        AUTHORING. Who yields, where two authored
 *                                  extents claim the same ground, with the
 *                                  reason written down beside it.
 *   src/data/nations.clipped.json  GENERATED, committed, imported by the store.
 *                                  Clipped to `public/data/map/land-50m.json`,
 *                                  frontiers resolved, edges classified, sea
 *                                  edges thinned. Never hand-edited.
 *
 * The alternative — rewriting nations.json in place — was rejected for one
 * reason: it is not reversible. Clipping is lossy at the coast (a hand-drawn
 * bay is replaced by six hundred vertices of Natural Earth) and an author who
 * then wanted to move a frontier would be editing the *output*, whose sea edges
 * would be re-clipped into slightly different sea edges on the next run. Two
 * files keep the thing a human writes small, smooth and diffable, and keep the
 * thing the renderer reads exact.
 *
 * Bundled import rather than a fetch from `public/data/` is also deliberate:
 * the nation store is synchronous, every getter reads `all` without awaiting,
 * and the drawn map's own vectors are already two fetches on the critical path.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyCoastal,
  clipToLand,
  coastIndex,
  describeOverlap,
  encodeRuns,
  findOverlaps,
  isNotableAt,
  keyframeAt,
  landPolygons,
  multiPolygonArea,
  multiPolygonOf,
  orient,
  robustOp,
  simplifyRing,
} from './nations-clip-lib.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'))

const args = new Set(process.argv.slice(2))
const wantReport = args.has('--report')
const checkOnly = args.has('--check')

/**
 * How far a sea edge may be moved to make it cheaper, in degrees.
 *
 * `land-50m.json` is quantised at 0.0036° of longitude (~400 m), so a tolerance
 * at the quantum removes only detail the source cannot assert in the first
 * place, and the drawn map re-inks the coastline over the top of the fill at
 * every zoom — what the thinning can cost is a hairline of paper between a fill
 * and its own shore, never a visible disagreement about where the shore is.
 * Inland frontiers are never touched: see `simplifyRing`.
 */
const SEA_TOLERANCE_DEG = Number(process.env.NATIONS_SEA_TOL ?? 0.0036)

/** Edge i of a reversed ring is edge (n-1-i) of the original. */
const reverseEdgeFlags = (flags) => {
  const n = flags.length
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = flags[n - 1 - i]
  return out
}

/* --------------------------------------------------------------- the land */

const { encodeRing, decodeRing, decodeKeyframe, QUANTUM } = await import('../src/lib/nations.ts')

const authored = read('src/data/nations.json')
const frontiers = read('src/data/frontiers.json')
const byId = new Map(authored.map((n) => [n.id, n]))
const key = (id, time) => `${id}@${time}`

/* --------------------------------------------------------- check-only mode */

if (checkOnly) {
  const onDisk = read('src/data/nations.clipped.json')
  const found = validate(onDisk)
  report(found, onDisk, undefined)
  process.exit(found.length ? 1 : 0)
}

/* --------------------------------------------------------------- the land */

// Decoded here rather than at the top because `--check` does not need it: the
// validator judges the built file, and 550 kB of Natural Earth is three
// seconds it would spend to answer a question about a different file.
const { buildWorld } = await import('../src/lib/drawnGeometry.ts')
const mapFile = (f) => read(`public/data/map/${f}`)
const world = buildWorld(mapFile('land-110m.json'), mapFile('land-50m.json'))
const land = landPolygons(world.land)
const coasts = coastIndex(land)

/* ------------------------------------------------------------------- clip */

const t0 = performance.now()
const clipped = new Map()
for (const nation of authored)
  for (const kf of nation.keyframes)
    clipped.set(key(nation.id, kf.time), clipToLand(multiPolygonOf(kf.rings), land))
const clipMs = performance.now() - t0

const empty = []
for (const nation of authored)
  for (const kf of nation.keyframes)
    if (!clipped.get(key(nation.id, kf.time)).length) empty.push(`${nation.id}@${kf.time}`)
if (empty.length) {
  console.error(`clip-nations: keyframes that clipped away to nothing: ${empty.join(', ')}`)
  process.exit(1)
}

/* -------------------------------------------------------------- frontiers */

/** The span a keyframe holds over: hold-first backwards, hold-last forwards. */
const holdSpan = (nation, i) => [
  i === 0 ? nation.from : nation.keyframes[i].time,
  i + 1 < nation.keyframes.length ? nation.keyframes[i + 1].time - 1 : nation.to,
]

/**
 * A frontier resolution: one polity gives up whatever it shares with another,
 * over a stated period.
 *
 * The subtraction runs against the *clipped* geometry of the polity that keeps
 * the ground, so the two share one line rather than two opinions of one — and
 * that line is the keeper's authored frontier, which is what makes the choice
 * of which side yields a historical judgement rather than an arithmetic
 * accident. Entries apply in file order and read the current state, so a chain
 * (A yields to B, B yields to C) resolves the way it is written down.
 *
 * A keyframe holds over a span and the keeper may have several keyframes inside
 * it, so what is subtracted is the union of every keeper keyframe in force
 * while this one is — the only answer representable without inventing keyframes
 * the author did not draw. Where that over-yields, the fix is a narrower
 * `from`/`to` on the entry, or a keyframe in nations.json at the year the
 * frontier actually moved.
 */
for (const rule of frontiers) {
  const a = byId.get(rule.yields)
  const b = byId.get(rule.toward)
  if (!a || !b) throw new Error(`frontiers.json: unknown polity in ${JSON.stringify(rule)}`)
  const from = rule.from ?? -Infinity
  const to = rule.to ?? Infinity
  for (const [i, kf] of a.keyframes.entries()) {
    const [holdFrom, holdTo] = holdSpan(a, i)
    const lo = Math.max(holdFrom, from, b.from)
    const hi = Math.min(holdTo, to, b.to)
    if (lo > hi) continue
    const cut = []
    for (const [j, kb] of b.keyframes.entries()) {
      const [bFrom, bTo] = holdSpan(b, j)
      if (bTo < lo || bFrom > hi) continue
      cut.push(...clipped.get(key(b.id, kb.time)))
    }
    if (!cut.length) continue
    const k = key(a.id, kf.time)
    clipped.set(k, robustOp('difference', clipped.get(k), cut, `${a.id} yields to ${b.id}`))
  }
}

/* ----------------------------------------------- classify, thin, and orient */

let vertsIn = 0
let vertsClipped = 0
let vertsOut = 0
let piecesOut = 0
let holesOut = 0
let coastalEdges = 0
let inlandEdges = 0
const shrunk = []

const built = authored.map((nation) => ({
  ...nation,
  keyframes: nation.keyframes.map((kf) => {
    const mp = clipped.get(key(nation.id, kf.time))
    const authoredArea = multiPolygonArea(multiPolygonOf(kf.rings))
    shrunk.push({ id: nation.id, time: kf.time, kept: multiPolygonArea(mp) / authoredArea })
    vertsIn += kf.rings.reduce((n, r) => n + r.length, 0)
    vertsClipped += mp.reduce((n, p) => n + p.reduce((m, r) => m + r.length - 1, 0), 0)
    const polys = []
    const coast = []
    for (const poly of mp) {
      const rings = []
      const runs = []
      const flagsOf = []
      for (const [i, ring] of poly.entries()) {
        const flags = classifyCoastal(ring, coasts)
        const thin = simplifyRing(ring, flags, SEA_TOLERANCE_DEG)
        // CW for an outer ring, CCW for a hole. On a sphere a ring bounds two
        // regions and the globe's polygon layer fills the clockwise one (see
        // the winding note in lib/nations.ts). Reversing a ring reverses the
        // order of its EDGES too, so the flags come with it.
        const oriented = orient(thin.ring, i === 0)
        const flipped = oriented !== thin.ring
        const open = oriented.slice(0, -1)
        const encoded = encodeRing(open)
        // A ring the codec cannot represent is not a ring. Thinning a fifty-metre
        // coastal sliver at the 400 m tolerance, or quantising it to 1e-4°,
        // collapses it to a line — an outer ring of zero area is a cap the
        // tessellator cannot build and a winding assertion nothing can satisfy,
        // and a hole of zero area subtracts nothing. This is why the test is
        // here, on the ENCODED ring, and not on what came out of the clipper.
        const decoded = decodeRing(encoded)
        if (decoded.length < 3 || Math.abs(shoelace(decoded)) < QUANTUM * QUANTUM) {
          if (i === 0) break // the piece itself is gone; its holes go with it
          continue
        }
        rings.push(encoded)
        flagsOf.push(flipped ? reverseEdgeFlags(thin.flags) : thin.flags)
        runs.push(encodeRuns(flagsOf[flagsOf.length - 1]))
        vertsOut += open.length
      }
      if (!rings.length) continue
      for (const f of flagsOf)
        for (const bit of f) if (bit) coastalEdges++
          else inlandEdges++
      polys.push(rings)
      coast.push(runs)
      holesOut += rings.length - 1
      piecesOut++
    }
    const entry = { time: kf.time, polys }
    // A keyframe with no coastal edge at all — a landlocked polity — carries no
    // `coast` field rather than a nest of empty arrays.
    if (coast.some((p) => p.some((r) => r.length))) entry.coast = coast
    return entry
  }),
}))

/* --------------------------------------------------------------- validate */

function validate(nations) {
  const cache = new Map()
  const geometryOf = (n, kf) => {
    const k = key(n.id, kf.time)
    let g = cache.get(k)
    if (!g) cache.set(k, (g = decodeKeyframe(kf).pieces.map((rings) => rings.map((r) => [...r, r[0]]))))
    return g
  }
  return findOverlaps(nations, geometryOf)
}

const convictions = validate(built)

/* ----------------------------------------------------------- the numbers */

/** What is on the globe at t: notable, largest first, capped like the store. */
function onGlobe(nations, t, limit = 10) {
  const ranked = []
  for (const n of nations) {
    if (!isNotableAt(n, t)) continue
    const kf = keyframeAt(n, t)
    if (!kf) continue
    const area = kf.polys
      ? decodeKeyframe(kf).pieces.reduce((a, rings) => a + Math.abs(shoelace(rings[0])), 0)
      : kf.rings.reduce((a, r) => a + Math.abs(shoelace(r)), 0)
    ranked.push({ n, kf, area })
  }
  return ranked.sort((a, b) => b.area - a.area).slice(0, limit)
}
function shoelace(ring) {
  let s = 0
  for (let i = 0; i < ring.length; i++) {
    const [x, y] = ring[i]
    const [nx, ny] = ring[(i + 1) % ring.length]
    s += x * ny - nx * y
  }
  return s / 2
}

/**
 * The budget the globe actually pays: not the corpus, but the worst single
 * year of it — at most ten polities are ever on the planet at once.
 */
function budget(nations, countOf) {
  const years = new Set()
  for (const n of nations) {
    years.add(n.visibleFrom)
    for (const k of n.keyframes) years.add(k.time)
  }
  let worst = { year: 0, verts: 0, polys: 0 }
  for (const t of years) {
    let verts = 0
    let polys = 0
    for (const { kf } of onGlobe(nations, t)) {
      verts += countOf(kf).verts
      polys += countOf(kf).polys
    }
    if (verts > worst.verts) worst = { year: t, verts, polys }
  }
  return worst
}

function report(convictions, builtNations, sourceNations) {
  if (sourceNations) {
    const before = budget(sourceNations, (kf) => ({
      verts: kf.rings.reduce((n, r) => n + r.length, 0),
      polys: kf.rings.length,
    }))
    const after = budget(builtNations, (kf) => ({
      verts: kf.polys.reduce((n, p) => n + p.reduce((m, r) => m + r.length / 2, 0), 0),
      polys: kf.polys.length,
    }))
    console.log(`clip: ${clipMs.toFixed(0)} ms over ${land.length} land pieces`)
    console.log(
      `corpus vertices: authored ${vertsIn} -> clipped ${vertsClipped} -> shipped ${vertsOut}` +
        ` (${(vertsOut / vertsIn).toFixed(2)}x), ${piecesOut} pieces, ${holesOut} holes`,
    )
    console.log(
      `edges: ${coastalEdges} coastal (not inked), ${inlandEdges} inland frontier (inked)` +
        ` — ${((100 * coastalEdges) / (coastalEdges + inlandEdges)).toFixed(1)}% coastal`,
    )
    console.log(
      `worst year on the globe: before ${before.verts} vertices in ${before.polys} rings (year ${before.year});` +
        ` after ${after.verts} vertices in ${after.polys} rings (year ${after.year})`,
    )
    const worstShrink = [...shrunk].sort((a, b) => a.kept - b.kept).slice(0, 8)
    console.log(
      `least area kept after clip+frontiers: ` +
        worstShrink.map((s) => `${s.id}@${s.time} ${(s.kept * 100).toFixed(0)}%`).join(', '),
    )
  }
  if (!convictions.length) {
    console.log(`overlap validator: green over ${builtNations.length} polities`)
    return
  }
  console.error(`overlap validator: ${convictions.length} conviction(s)`)
  for (const o of convictions) console.error(`  ${describeOverlap(o)}  bbox ${o.bbox.map((v) => v.toFixed(1)).join(',')}`)
}

report(convictions, built, wantReport ? authored : undefined)

/* ------------------------------------------------------------------ write */

if (convictions.length) process.exit(1)

const path = join(root, 'src/data/nations.clipped.json')
// One polity per line, one keyframe per line inside it: a 900 kB generated file
// that `git diff` can still say something useful about.
const body =
  '[\n' +
  built
    .map((n) => {
      const head = JSON.stringify({
        id: n.id,
        name: n.name,
        color: n.color,
        from: n.from,
        to: n.to,
        visibleFrom: n.visibleFrom,
        visibleTo: n.visibleTo,
      }).slice(1, -1)
      const kfs = n.keyframes.map((kf) => JSON.stringify(kf)).join(',\n  ')
      return `{${head},"keyframes":[\n  ${kfs}\n]}`
    })
    .join(',\n') +
  '\n]\n'
writeFileSync(path, body)
console.log(`wrote src/data/nations.clipped.json (${(body.length / 1024).toFixed(0)} kB)`)
