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
  COAST_TOL_DEG,
  coastIndex,
  describeOverlap,
  encodeRuns,
  findInkDisagreements,
  findOverlaps,
  isNotableAt,
  keyframeAt,
  landPolygons,
  multiPolygonArea,
  multiPolygonOf,
  OVERLAP_WIDTH_DEG,
  orient,
  robustOp,
  simplifyRing,
} from './nations-clip-lib.mjs'
import {
  buildModernBorders,
  decodeArcs,
  frontierArcs,
  MERGES,
  MODERN_FROM,
  MODERN_TO,
} from './modern-borders-lib.mjs'
import {
  DECLARED_TOL_DEG,
  declaredShare,
  decodeRivers,
  errorTable,
  resolveKeyframe,
  segmentIndex,
  SNAP_WARN_KM,
} from './follows-lib.mjs'
import { areaKm2, resolveClaimant, zoneFaults } from './contested-lib.mjs'

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

/**
 * TWO KINDS OF DATED THING in one authoring file, which is what round 60 turned
 * the top-level array into an object for.
 *
 *   nations    the polities: who held this ground, in this year.
 *   contested  the ground no single polity honestly held — Crimea after 2014,
 *              Kashmir since 1947 (docs/design/contested-territory.md). Carved
 *              out of its claimants below, so the "exactly one holder" promise
 *              the overlap validator enforces survives contact with a dispute.
 */
const authoredFile = read('src/data/nations.json')
const authored = authoredFile.nations
const zonesAuthored = authoredFile.contested ?? []
const frontiers = read('src/data/frontiers.json')
const byId = new Map(authored.map((n) => [n.id, n]))
const key = (id, time) => `${id}@${time}`

/** A zone's dates, with the open end the format allows: `to` defaults to now-ish. */
const ZONE_TO = 2100
const zoneSpan = (z) => [z.from, z.to ?? ZONE_TO]

/**
 * A zone as the overlap validator and the ink-disagreement validator see it:
 * a polity with one keyframe that is notable for exactly its own dates.
 *
 * Both validators exist to police the promise that every point has one holder,
 * and a contested zone IS a holder of that ground — the whole design is that it
 * takes the ground away from its claimants rather than sitting on top of them —
 * so it has to be judged by the same rules. What it must never become is a
 * polity: nothing here reaches `nations.clipped.json`'s `nations`, and the
 * runtime has its own layer (src/lib/contested.ts).
 */
const asPolity = (zone, keyframes) => {
  const [from, to] = zoneSpan(zone)
  return { id: `contested:${zone.id}`, name: zone.name, color: '#000000', from, to, visibleFrom: from, visibleTo: to, keyframes }
}

/* ------------------------------------------ what a frontier says it follows */

/**
 * BORDERS V3, at the top of the pipeline: a keyframe that DECLARES what its
 * frontier follows gets the feature's own geometry spliced into its rings
 * before anything else happens to them (docs/design/borders-v3.md,
 * scripts/follows-lib.mjs).
 *
 * It runs HERE, first, because nothing downstream should have to know. The clip
 * cuts a spliced ring against the coast exactly as it cut a freehand one,
 * `classifyCoastal` classifies its edges, the frontier rules subtract it, the
 * codec stores it and round 55's densification draws it. A declaration is an
 * authoring convenience that has already become geometry by the time the rest
 * of this file sees a ring.
 *
 * Both modes need it: the build needs the rings, and `--check` needs the
 * resolved polylines to measure what share of the SHIPPED frontier lies on
 * them. It is cheap either way — 306 kB of rivers, plus (only if a `modern`
 * declaration exists) the country topology the modern-border layer reads
 * anyway.
 */
const rivers = decodeRivers(read('src/data/rivers-named.json'))
let arcCache
const features = {
  rivers,
  get modernArcs() {
    return (arcCache ??= frontierArcs(read('node_modules/world-atlas/countries-50m.json')))
  },
}

const followed = new Map() // `id@time` -> { rings, segments, checks }
const resolveFollows = (at, rings, decls) => {
  try {
    const res = resolveKeyframe(rings, decls, features)
    for (const c of res.checks)
      if (!c.closed || !c.windingKept)
        throw new Error(`splicing ring ${c.ring} left it ${c.closed ? 'wound the wrong way' : 'open'}`)
    followed.set(at, res)
  } catch (err) {
    console.error(`follows: ${at}: ${err.message}`)
    process.exit(1)
  }
}
for (const nation of authored)
  for (const kf of nation.keyframes)
    if (kf.follows?.length) resolveFollows(key(nation.id, kf.time), kf.rings, kf.follows)
// A ZONE DECLARES WHAT IT FOLLOWS TOO, and it goes through exactly this code:
// an occupation line that follows the Dnipro follows the Dnipro, and the
// boundary of Western Sahara is three arcs of Natural Earth's own topology.
for (const zone of zonesAuthored)
  if (zone.follows?.length) resolveFollows(key(zone.id, 'zone'), zone.rings, zone.follows)

/** The rings the rest of the pipeline works on: derived where declared. */
const ringsOf = (nation, kf) => followed.get(key(nation.id, kf.time))?.rings ?? kf.rings
const zoneRingsOf = (zone) => followed.get(key(zone.id, 'zone'))?.rings ?? zone.rings

/* --------------------------------------------------------- check-only mode */

if (checkOnly) {
  const onDisk = read('src/data/nations.clipped.json')
  const judgedOnDisk = withZones(onDisk.nations, onDisk.contested ?? [])
  const found = validate(judgedOnDisk)
  const split = inkSplits(judgedOnDisk)
  report(found, onDisk.nations, undefined, split, (onDisk.contested ?? []).length)
  const { bad } = followsReport(onDisk.nations)
  // The shipped zones, judged without re-clipping anything: the geometric
  // claims need Natural Earth and `--check` deliberately does not decode it, so
  // what is checkable here is the shape of the payload and the snap numbers.
  const shipFaults = checkContested(onDisk.contested ?? [])
  const modernFaults = checkModern(read('src/data/borders.modern.json'))
  reportModern(modernFaults)
  process.exit(found.length || split.length || modernFaults.length || bad.length || shipFaults.length ? 1 : 0)
}

/**
 * What the shipped contested payload has to satisfy on its own — the same
 * question `checkModern` asks of the modern lines, and for the same reason:
 * `npm run build` runs `--check`, and a check that needed 550 kB of Natural
 * Earth decoded first would not be run on every build.
 */
function checkContested(entries) {
  const faults = []
  const authoredById = new Map(zonesAuthored.map((z) => [z.id, z]))
  if (entries.length !== zonesAuthored.length)
    faults.push(`the file ships ${entries.length} zone(s) and nations.json authors ${zonesAuthored.length}`)
  for (const e of entries) {
    const at = `contested "${e.id}"`
    const src = authoredById.get(e.id)
    if (!src) faults.push(`${at}: shipped but not authored in nations.json`)
    else if (src.from !== e.from) faults.push(`${at}: ships from ${e.from}, authored from ${src.from}`)
    if (!(e.claimants?.length >= 2)) faults.push(`${at}: ${e.claimants?.length ?? 0} claimant(s) in the payload`)
    if (!e.polys?.length) faults.push(`${at}: no geometry`)
    for (const rings of e.polys ?? [])
      for (const enc of rings) {
        const ring = decodeRing(enc)
        if (ring.length < 3) faults.push(`${at}: a ring has ${ring.length} vertex/vertices`)
        // The carve is a difference operation and a difference can open a ring;
        // the contract asks for this by name. Stored open, so "closes" is the
        // ring having area at all after the codec has been through it.
        if (Math.abs(shoelace(ring)) < QUANTUM * QUANTUM) faults.push(`${at}: a ring encloses nothing`)
      }
  }
  if (faults.length) {
    console.error(`contested territory: ${faults.length} fault(s) in the shipped payload`)
    for (const f of faults) console.error(`  ${f}`)
  } else console.log(`contested territory: green — ${entries.length} zone(s), every ring closed and claimed`)
  return faults
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
    clipped.set(key(nation.id, kf.time), clipToLand(multiPolygonOf(ringsOf(nation, kf)), land))
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

/* ------------------------------------------------- and the contested ground */

/**
 * CARVE, DO NOT OVERLAP — the whole of round 60's structural idea.
 *
 * A contested zone is subtracted from every claimant whose keyframe is in force
 * while the zone runs, exactly the way the sea is subtracted from everyone. By
 * construction, then, no claimant fill covers contested ground, the overlap
 * validator needs no exemption clause for a dispute, and the two layers cannot
 * disagree about where the disputed edge is: the polity's remaining frontier
 * IS the zone's boundary, the same vertices, so `findInkDisagreements` can
 * judge them as it judges any shared frontier.
 *
 * Zones carve EACH OTHER first, in file order, for the same reason the frontier
 * rules apply in file order: two zones may honestly overlap in the authoring
 * file (the occupied-Ukraine ring is drawn across the Syvash and into northern
 * Crimea rather than threading a lagoon Natural Earth draws as solid land), and
 * the earlier entry — here also the earlier date — keeps the ground.
 */
const zones = []
for (const zone of zonesAuthored) {
  const [from, to] = zoneSpan(zone)
  const mp = clipToLand(multiPolygonOf(zoneRingsOf(zone)), land)
  let carved = mp
  for (const prior of zones)
    if (prior.to >= from && prior.from <= to && carved.length && prior.carved.length)
      carved = robustOp('difference', carved, prior.carved, `${zone.id} yields to ${prior.zone.id}`)
  zones.push({ zone, from, to, mp, carved })
}

for (const z of zones) {
  z.carvedFrom = []
  if (!z.carved.length) continue
  for (const claimant of z.zone.claimants ?? []) {
    const a = byId.get(claimant)
    if (!a) continue // a present-day claimant has no fill here to take anything from
    for (const [i, kf] of a.keyframes.entries()) {
      const [holdFrom, holdTo] = holdSpan(a, i)
      if (holdTo < z.from || holdFrom > z.to) continue
      const k = key(a.id, kf.time)
      const before = clipped.get(k)
      const after = robustOp('difference', before, z.carved, `${a.id} yields to ${z.zone.id}`)
      clipped.set(k, after)
      const km2 = areaKm2(before) - areaKm2(after)
      if (km2 > 1) z.carvedFrom.push({ id: `${a.id}@${kf.time}`, km2 })
    }
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

/**
 * ONE CLIPPED MULTIPOLYGON, made shippable: classified, thinned, oriented and
 * encoded, with a `coast` field only where there is coast to record.
 *
 * A function rather than the loop body it used to be because a contested zone
 * needs precisely this and nothing else — it is a cap with a boundary of two
 * kinds like any polity's, and it must be classified by the SAME call so that a
 * carved frontier and the zone edge it now coincides with cannot get different
 * verdicts (see `findInkDisagreements`).
 */
function shippable(mp) {
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
    const entry = { polys }
    // Nothing with no coastal edge at all — a landlocked polity, a zone in
    // Ladakh — carries a `coast` field rather than a nest of empty arrays.
    if (coast.some((p) => p.some((r) => r.length))) entry.coast = coast
    return entry
}

const built = authored.map((nation) => ({
  ...nation,
  keyframes: nation.keyframes.map((kf) => {
    const mp = clipped.get(key(nation.id, kf.time))
    const authoredArea = multiPolygonArea(multiPolygonOf(ringsOf(nation, kf)))
    shrunk.push({ id: nation.id, time: kf.time, kept: multiPolygonArea(mp) / authoredArea })
    vertsIn += ringsOf(nation, kf).reduce((n, r) => n + r.length, 0)
    vertsClipped += mp.reduce((n, p) => n + p.reduce((m, r) => m + r.length - 1, 0), 0)
    return { time: kf.time, ...shippable(mp) }
  }),
}))

/**
 * …and the zones, in the same shape, with `claimants` resolved on the way out.
 *
 * The runtime is given names and colours rather than keys because it cannot
 * look a present-day state up: `ukraine` is not a polity in `nations.clipped`'s
 * `nations` and never will be (round 57). A `color` is therefore present only
 * for a claimant the map can actually draw, and its absence is what makes that
 * stripe of the hatch neutral — see lib/contested.ts.
 */
for (const z of zones) {
  vertsIn += zoneRingsOf(z.zone).reduce((n, r) => n + r.length, 0)
  vertsClipped += z.carved.reduce((n, p) => n + p.reduce((m, r) => m + r.length - 1, 0), 0)
}
const builtZones = zones.map((z) => ({
  id: z.zone.id,
  name: z.zone.name,
  from: z.from,
  to: z.to,
  claimants: (z.zone.claimants ?? []).map((k) => {
    const who = resolveClaimant(k, byId)
    const out = { id: k, name: who?.name ?? k }
    if (who?.color) out.color = who.color
    return out
  }),
  ...shippable(z.carved),
}))

/* --------------------------------------------------------------- validate */

/**
 * The polities and the zones, as one list, for the two validators that police
 * "every point has exactly one holder". See `asPolity`.
 */
function withZones(nations, zoneEntries) {
  return [
    ...nations,
    ...zoneEntries.map((z) => {
      const kf = { time: z.from, polys: z.polys }
      if (z.coast) kf.coast = z.coast
      return asPolity(z, [kf])
    }),
  ]
}

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

/**
 * The second half of "does the validator judge what the eye judges": one
 * frontier, one verdict about whether it is inked. See `findInkDisagreements`.
 */
function inkSplits(nations) {
  return findInkDisagreements(nations, (n, kf) => {
    const { pieces, coastal } = decodeKeyframe(kf)
    return pieces.flatMap((rings, p) => rings.map((ring, r) => ({ ring, coastal: coastal[p][r] })))
  })
}

/**
 * THE ERROR REPORT — the number the user's "error rate" becomes.
 *
 * Per polity: what share of its INLAND frontier lies on a declared feature, and
 * how far the declarations' endpoints had to move to reach the feature they
 * claim. Coastal edges are the map's own line and are not political ink, so
 * they are not this metric's business; freehand is the remainder, and the
 * remainder is the work list.
 *
 * It is measured against the SHIPPED rings rather than the authored ones, which
 * is why it can also run in `--check` on a file it did not build — and it is
 * the honest place to measure, because a declaration clipped away at the coast
 * or subtracted by a frontier rule stops counting. Provenance is recovered
 * geometrically rather than tracked through the clipper: see DECLARED_TOL_DEG.
 */
function followsReport(nations) {
  const rows = []
  let declarations = 0
  let branches = 0
  let joins = 0
  const worstSnap = []
  for (const n of nations) {
    const src = byId.get(n.id)
    let inlandKm = 0
    let declaredKm = 0
    const snaps = []
    for (const kf of n.keyframes) {
      const res = src ? followed.get(key(n.id, kf.time)) : undefined
      const { pieces, coastal } = decodeKeyframe(kf)
      const rings = pieces.flatMap((rs, p) => rs.map((ring, r) => ({ ring, coastal: coastal[p][r] })))
      const share = declaredShare(rings, segmentIndex(res ? res.segments.map((s) => s.path) : []), DECLARED_TOL_DEG)
      inlandKm += share.inlandKm
      if (res) declaredKm += share.declaredKm
      for (const s of res?.segments ?? []) {
        declarations++
        branches += s.dropped.length
        joins += s.joins?.length ?? 0
        snaps.push(s.snapFromKm, s.snapToKm)
        worstSnap.push({ at: `${n.id}@${kf.time}`, name: s.name, km: Math.max(s.snapFromKm, s.snapToKm) })
      }
    }
    rows.push({ id: n.id, inlandKm, declaredKm, snaps })
  }
  const table = errorTable(rows)
  const pad = (s, n) => String(s).padStart(n)
  console.log('')
  console.log('borders v3 — inland frontier: derived from a named feature, or still freehand')
  console.log(`  ${'polity'.padEnd(14)} ${pad('inland km', 10)} ${pad('declared', 9)} ${pad('share', 7)} ${pad('mean snap', 11)}`)
  for (const r of table.rows) {
    if (!r.declaredKm) continue
    console.log(
      `  ${r.id.padEnd(14)} ${pad(r.inlandKm.toFixed(0), 10)} ${pad(r.declaredKm.toFixed(0), 9)}` +
        ` ${pad((r.share * 100).toFixed(1) + '%', 7)} ${pad(r.meanSnapKm.toFixed(2) + ' km', 11)}`,
    )
  }
  const freehand = table.rows.filter((r) => !r.declaredKm).length
  console.log(
    `  ${'— CORPUS —'.padEnd(14)} ${pad(table.total.inlandKm.toFixed(0), 10)} ${pad(table.total.declaredKm.toFixed(0), 9)}` +
      ` ${pad((table.total.share * 100).toFixed(1) + '%', 7)} ${pad(table.total.meanSnapKm.toFixed(2) + ' km', 11)}`,
  )
  console.log(
    `  ${declarations} declaration(s) over ${table.rows.length - freehand} polities; ${freehand} still wholly` +
      ` freehand; ${branches} river branch(es) the mainline did not take; ${joins} seam(s) bridged`,
  )
  const bad = worstSnap.filter((w) => w.km > SNAP_WARN_KM).sort((a, b) => b.km - a.km)
  if (bad.length) {
    console.error(`  SNAP OVER ${SNAP_WARN_KM} km — a declared endpoint that is not on the feature it names:`)
    for (const w of bad.slice(0, 12)) console.error(`    ${w.at} ${w.name}: ${w.km.toFixed(1)} km`)
  }
  return { table, bad }
}

/**
 * THE CONTESTED SECTION of the error report, which the contract asks for by
 * name: zone count, the ground each takes, what it took it from, and the snap
 * error of any edge a zone declares it follows.
 *
 * km² rather than square degrees because this is the half of the report a
 * HUMAN checks against an almanac — Crimea is 27 000 km², the Abyei Area is
 * 10 460 — and a square degree is 12 300 km² at the equator and 6 200 in
 * Ladakh. `zoneFaults` is what fails the build; this is what makes a zone
 * whose numbers are quietly wrong visible before it ships.
 */
function contestedReport(entries) {
  const pad = (s, n) => String(s).padStart(n)
  console.log('')
  console.log('contested territory — ground carved out of its claimants, and what claims it')
  console.log(`  ${'zone'.padEnd(14)} ${pad('km²', 9)} ${pad('carved', 8)} ${pad('from', 6)} ${'claimants'}`)
  let totalKm2 = 0
  let totalCarved = 0
  const bad = []
  for (const e of entries) {
    const km2 = areaKm2(e.polys.map((rings) => rings.map((r) => decodeRing(r))))
    const src = e.carvedFrom ?? []
    const carved = src.reduce((n, s) => n + s.km2, 0)
    totalKm2 += km2
    totalCarved += carved
    console.log(
      `  ${e.id.padEnd(14)} ${pad(km2.toFixed(0), 9)} ${pad(carved.toFixed(0), 8)} ${pad(e.from, 6)}` +
        `  ${e.claimants.map((c) => `${c.id}${c.color ? '' : ' (no fill)'}`).join(', ')}` +
        `${src.length ? ` — out of ${src.map((s) => `${s.id} ${s.km2.toFixed(0)} km²`).join(', ')}` : ''}`,
    )
    for (const s of e.segments ?? []) {
      const km = Math.max(s.snapFromKm, s.snapToKm)
      console.log(
        `  ${''.padEnd(14)} ${pad('follows', 9)} ${s.name}: ${s.path.length} pts, ${s.km.toFixed(0)} km,` +
          ` snap ${s.snapFromKm.toFixed(2)}/${s.snapToKm.toFixed(2)} km, ${s.dropped.length} branch(es) not taken`,
      )
      if (km > SNAP_WARN_KM) bad.push({ at: e.id, name: s.name, km })
    }
  }
  console.log(
    `  ${'— ZONES —'.padEnd(14)} ${pad(totalKm2.toFixed(0), 9)} ${pad(totalCarved.toFixed(0), 8)}` +
      `  ${entries.length} zone(s); ${totalCarved.toFixed(0)} km² taken out of claimant fills`,
  )
  if (bad.length) {
    console.error(`  SNAP OVER ${SNAP_WARN_KM} km on a zone edge:`)
    for (const w of bad) console.error(`    ${w.at} ${w.name}: ${w.km.toFixed(1)} km`)
  }
  return bad
}

/** Filled by `countryGeometry` on first use; declared here to outlive the TDZ. */
let countryCache
const judged = withZones(built, builtZones)
const convictions = validate(judged)
const splits = inkSplits(judged)
const errors = followsReport(built)
for (const z of zones) {
  const e = builtZones.find((b) => b.id === z.zone.id)
  e.carvedFrom = z.carvedFrom
  e.segments = followed.get(key(z.zone.id, 'zone'))?.segments ?? []
}
const zoneSnaps = contestedReport(builtZones)
const faults = zoneFaults(zones, byId, claimGeometry, countryGeometry)
if (faults.length) {
  console.error(`contested territory: ${faults.length} fault(s)`)
  for (const f of faults) console.error(`  ${f}`)
} else console.log(`  contested validator: green — every zone has ≥2 checkable claimants and survives its carve`)

/** A claimant polity's pre-carve extent over a span: the union of its keyframes. */
function claimGeometry(id, from, to) {
  const n = byId.get(id)
  if (!n) return []
  const out = []
  for (const [i, kf] of n.keyframes.entries()) {
    const [holdFrom, holdTo] = holdSpan(n, i)
    if (holdTo < from || holdFrom > to) continue
    out.push(...clipToLand(multiPolygonOf(ringsOf(n, kf)), land))
  }
  return out
}

/** …and a present-day claimant's, out of the same topology the modern ink is built from. */
function countryGeometry(name) {
  if (!countryCache) {
    countryCache = new Map()
    const topo = read('node_modules/world-atlas/countries-50m.json')
    const arcs = decodeArcs(topo)
    const ringOf = (list) => {
      const pts = []
      for (const idx of list) {
        const arc = idx < 0 ? [...arcs[~idx]].reverse() : arcs[idx]
        for (const p of pts.length ? arc.slice(1) : arc) pts.push([p[0], p[1]])
      }
      const [fx, fy] = pts[0]
      const [lx, ly] = pts[pts.length - 1]
      if (fx !== lx || fy !== ly) pts.push([fx, fy])
      return pts
    }
    for (const g of topo.objects.countries.geometries) {
      const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs
      countryCache.set(g.properties?.name, polys.map((rings) => rings.map(ringOf)))
    }
  }
  return countryCache.get(name)
}

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

function report(convictions, builtNations, sourceNations, splits = [], zoneCount = 0) {
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
  if (splits.length) {
    console.error(`shared-frontier ink: ${splits.length} edge(s) inked by one side and not the other`)
    for (const s of splits.slice(0, 10))
      console.error(`  ${s.a} × ${s.b} @ ${s.year} at ${s.at.map((v) => v.toFixed(3)).join(',')}`)
  } else console.log(`shared-frontier ink: green — every shared edge has one verdict`)
  if (!convictions.length) {
    console.log(
      `overlap validator: green over ${builtNations.length} polities and ${zoneCount} contested` +
        ` zone(s) (nothing shared wider than ${(OVERLAP_WIDTH_DEG * 111 * 1000).toFixed(0)} m)`,
    )
    return
  }
  console.error(`overlap validator: ${convictions.length} conviction(s)`)
  for (const o of convictions) console.error(`  ${describeOverlap(o)}  bbox ${o.bbox.map((v) => v.toFixed(1)).join(',')}`)
}

report(convictions, built, wantReport ? authored : undefined, splits, builtZones.length)

/* ------------------------------------------------------------------ write */

if (convictions.length || splits.length || errors.bad.length || faults.length || zoneSnaps.length)
  process.exit(1)

const path = join(root, 'src/data/nations.clipped.json')
// One polity per line, one keyframe per line inside it: a 900 kB generated file
// that `git diff` can still say something useful about. The zones come after,
// in the same shape as the authoring file's two keys.
const body =
  '{"nations":[\n' +
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
  '\n],\n"contested":[\n' +
  builtZones
    .map((z) => {
      const head = JSON.stringify({ id: z.id, name: z.name, from: z.from, to: z.to, claimants: z.claimants }).slice(1, -1)
      const geom = JSON.stringify(z.coast ? { polys: z.polys, coast: z.coast } : { polys: z.polys }).slice(1, -1)
      return `{${head},\n  ${geom}}`
    })
    .join(',\n') +
  '\n]}\n'
writeFileSync(path, body)
console.log(`wrote src/data/nations.clipped.json (${(body.length / 1024).toFixed(0)} kB)`)

/* --------------------------------------------- and the modern states' ink */

/**
 * The other half of round 57, and it runs HERE rather than in a script of its
 * own for one reason: it needs the decoded land and the coast index this file
 * has already paid fifty seconds to build, and it answers the same question
 * ("where does political ink go, and where does the map already draw the
 * line?") with the same functions. `--check` validates both files; `npm run
 * build` runs `--check`.
 */
const countries = read('node_modules/world-atlas/countries-50m.json')
const modern = buildModernBorders(countries, coasts, { encode: encodeRing, tol: COAST_TOL_DEG })

// THE CLIP-PIPELINE CLAIM, measured rather than assumed. `countries` and `land`
// come off one arc table in one file, so a country cut against `land-50m.json`
// should lose nothing at all — this is the modern set's version of round 52's
// "the coast is the coast", and it is checked on the twelve countries whose
// coastlines are the ones a reader would notice.
const SAMPLE = [
  'France', 'Italy', 'Norway', 'Greece', 'Egypt', 'India',
  'Japan', 'Indonesia', 'Chile', 'United States of America', 'Australia', 'South Africa',
]
const countryArcs = decodeArcs(countries)
const geometryOfCountry = (name) => {
  const g = countries.objects.countries.geometries.find((x) => x.properties?.name === name)
  const arcs = countryArcs
  const ringOf = (list) => {
    const pts = []
    for (const idx of list) {
      const arc = idx < 0 ? [...arcs[~idx]].reverse() : arcs[idx]
      for (const p of pts.length ? arc.slice(1) : arc) pts.push([p[0], p[1]])
    }
    const [fx, fy] = pts[0]
    const [lx, ly] = pts[pts.length - 1]
    if (fx !== lx || fy !== ly) pts.push([fx, fy])
    return pts
  }
  const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs
  return polys.map((rings) => rings.map(ringOf))
}
let worstKept = { name: '', kept: Infinity }
for (const name of SAMPLE) {
  const mp = geometryOfCountry(name)
  const kept = multiPolygonArea(clipToLand(mp, land, 0)) / multiPolygonArea(mp)
  if (kept < worstKept.kept) worstKept = { name, kept }
}

const modernPath = join(root, 'src/data/borders.modern.json')
// One frontier per line, like the polity file: a generated payload `git diff`
// can still say something about.
const encLines = (ls) => ls.map((l) => JSON.stringify(l)).join(',\n  ')
const modernBody =
  `{"source":${JSON.stringify(modern.source)},\n` +
  `"from":${modern.from},"to":${modern.to},\n` +
  `"stats":${JSON.stringify(modern.stats)},\n` +
  `"dated":[\n` +
  modern.dated
    .map(
      (d) =>
        `{"from":${d.from},"pair":${JSON.stringify(d.pair)},"why":${JSON.stringify(d.why)},"lines":[\n  ${encLines(d.lines)}\n]}`,
    )
    .join(',\n') +
  `\n],\n"lines":[\n  ` +
  encLines(modern.lines) +
  `\n]}\n`
writeFileSync(modernPath, modernBody)
const modernFaults = checkModern(JSON.parse(modernBody))
console.log(
  `modern borders: ${modern.lines.length + modern.dated.reduce((n, d) => n + d.lines.length, 0)} polylines,` +
    ` ${modern.stats.vertices} vertices over ${modern.stats.pairs} country pairs,` +
    ` ${modern.dated.length} dated groups, ${modern.stats.droppedEdges} coastal edge(s) dropped`,
)
console.log(
  `modern clip integrity: worst of ${SAMPLE.length} sampled countries is ${worstKept.name} at` +
    ` ${(worstKept.kept * 100).toFixed(3)}% of its area on land-50m`,
)
reportModern(modernFaults)
console.log(`wrote src/data/borders.modern.json (${(modernBody.length / 1024).toFixed(0)} kB)`)
if (modernFaults.length || worstKept.kept < 0.999) process.exit(1)

/**
 * What the shipped modern payload has to satisfy, checkable without decoding
 * 550 kB of Natural Earth — which is the whole point of `--check`.
 */
function checkModern(payload) {
  const faults = []
  if (payload.from !== MODERN_FROM || payload.to !== MODERN_TO)
    faults.push(`window is ${payload.from}..${payload.to}, the library says ${MODERN_FROM}..${MODERN_TO}`)
  const groups = [{ from: payload.from, pair: '', lines: payload.lines }, ...payload.dated]
  let n = 0
  for (const g of groups) {
    if (g.from < payload.from) faults.push(`dated group ${g.pair} starts at ${g.from}, before the threshold`)
    for (const enc of g.lines) {
      const line = decodeRing(enc)
      n += line.length
      if (line.length < 2) faults.push(`a polyline in ${g.pair || 'the base set'} has ${line.length} point(s)`)
      for (const [x, y] of line)
        if (!(Math.abs(x) <= 180.001 && Math.abs(y) <= 90.001))
          faults.push(`a point in ${g.pair || 'the base set'} is off the planet: ${x},${y}`)
    }
  }
  if (n !== payload.stats?.vertices) faults.push(`stats say ${payload.stats?.vertices} vertices, the lines hold ${n}`)
  const shipped = payload.dated.map((d) => `${d.pair}@${d.from}`).sort()
  const table = MERGES.map((m) => `${[...m.pair].sort().join(' | ')}@${m.from}`).sort()
  if (shipped.join(',') !== table.join(','))
    faults.push(`dated groups ${shipped.join(', ')} do not match the merge table ${table.join(', ')}`)
  return faults
}

function reportModern(faults) {
  if (!faults.length) {
    console.log(`modern borders: green — payload decodes, and its dated groups are the merge table`)
    return
  }
  console.error(`modern borders: ${faults.length} fault(s)`)
  for (const f of faults) console.error(`  ${f}`)
}
