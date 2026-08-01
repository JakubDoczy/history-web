/**
 * What the globe's event query costs, at the size the dataset is now and at the
 * sizes the requirements ask for.
 *
 *   node scripts/bench-eventIndex.mjs              # 1x, 10x, 100x
 *   node scripts/bench-eventIndex.mjs --scales 1,10,100,1000
 *   node scripts/bench-eventIndex.mjs --naive      # also time the linear scan
 *   node scripts/bench-eventIndex.mjs --spatial    # only the space index, on its own
 *   node scripts/bench-eventIndex.mjs --no-spatial # only the end-to-end index
 *   node --expose-gc scripts/bench-eventIndex.mjs  # trustworthy memory figures
 *
 * The budget this exists to answer: index build under 100 ms and query under
 * 2 ms at 100x (≈68 000 pins), on this machine. Anything the TypeScript index
 * cannot hit is a candidate for the compiled path the Lanczos kernel already
 * uses (scripts/wasm/, npm run build:wasm); anything it hits is a compiled path
 * not worth having.
 *
 * The synthetic corpus is generated to the shape of the real one — measured
 * from public/data/events, see SHAPE below — because the query's cost is almost
 * entirely a function of that shape. Uniformly scattered events would make both
 * indexes look better than they are: real history is clustered in space (a
 * third of it within 20° of ten cities) and hyperbolic in time (half the events
 * are in the last five centuries, and the tail runs to 4.5 billion years).
 */
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// The app's sources import each other without file extensions, which Node's ESM
// resolver will not do on its own. One hook, and the bench runs the shipped code
// rather than a copy of it.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) {
      const from = ctx.parentURL ? dirname(fileURLToPath(ctx.parentURL)) : process.cwd()
      if (existsSync(resolve(from, `${spec}.ts`))) return next(`${spec}.ts`, ctx)
    }
    return next(spec, ctx)
  },
})

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const { EventIndex, visibleEvents, eventRadiusDeg } = await import(resolve(root, 'src/lib/events.ts'))
const { cameraScope } = await import(resolve(root, 'src/lib/viewport.ts'))
const { GeoGrid, separationDeg } = await import(resolve(root, 'src/lib/queryIndex.ts'))

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const scales = flag('--scales', '1,10,100')
  .split(',')
  .map(Number)
const withNaive = args.includes('--naive')
const onlySpatial = args.includes('--spatial')
const withSpatial = !args.includes('--no-spatial')
const withEndToEnd = !onlySpatial

/* ------------------------------------------------------------------ corpus */

/**
 * The real dataset, measured (683 items, of which 643 are pinnable events):
 *
 *   priority   52..100 ranked, a thin minor tier
 *   time       10% deep time (−4.5e9 .. −1e6), then hyperbolic toward now:
 *              median start 1492, 75th percentile 1909, 90th 1969
 *   spans      51% points; of the rest, median 146 years, 90th 29 Myr
 *   place      clustered — 643 events fall in 26 five-degree latitude bands
 *   areas      5% of events, ~10-vertex rings
 */
const SHAPE = { items: 683, deepTimeShare: 0.1, pointShare: 0.51, areaShare: 0.05, minorShare: 0.2 }

const HUBS = [
  [48.85, 2.35], [51.5, -0.13], [41.9, 12.5], [37.98, 23.73], [55.75, 37.6],
  [39.9, 116.4], [35.68, 139.7], [28.61, 77.2], [30.05, 31.23], [33.3, 44.4],
  [40.71, -74.0], [19.43, -99.13], [-23.55, -46.63], [-33.87, 151.2], [-1.29, 36.82],
  [41.0, 28.98], [21.03, 105.85], [-34.6, -58.4], [59.33, 18.07], [6.52, 3.38],
]

const rng = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}

/** A corpus of `n` pinnable events with the shape above. */
function synth(n, seed = 42) {
  const rand = rng(seed)
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    // time: a deep-time tail, then a hyperbolic march toward the present
    const deep = rand() < SHAPE.deepTimeShare
    const start = deep
      ? -Math.round(10 ** (6 + rand() * 3.65)) // 1 Ma .. 4.5 Ga
      : Math.round(2026 - 10 ** (rand() * 3.7)) // now .. ~3000 BC
    // spans: half of everything is a point; the rest is log-uniform, and a deep
    // time event's span is as long as the epoch it names
    const point = rand() < SHAPE.pointShare
    const span = point ? 0 : Math.round(10 ** (rand() * (deep ? 8 : 3.2)))
    // place: mostly around the hubs, a fifth scattered
    const near = rand() < 0.8
    const [hLat, hLng] = HUBS[Math.floor(rand() * HUBS.length)]
    const lat = near
      ? Math.max(-89, Math.min(89, hLat + (rand() - 0.5) * 16))
      : (rand() - 0.5) * 170
    const lng = near ? hLng + (rand() - 0.5) * 16 : (rand() - 0.5) * 360
    const e = {
      id: `e${i}`,
      name: `Event ${i}`,
      start,
      priority: rand() < SHAPE.minorShare ? 0 : 52 + Math.floor(rand() * 49),
      tags: [['war', 'science', 'culture', 'politics'][Math.floor(rand() * 4)]],
      summary: '',
      lat,
      lng,
    }
    if (span) e.end = start + span
    if (rand() < SHAPE.areaShare) {
      const r = 0.4 + rand() * 6
      e.area = Array.from({ length: 10 }, (_, k) => {
        const a = (k / 10) * 2 * Math.PI
        return [lng + (Math.cos(a) * r) / Math.max(0.2, Math.cos((lat * Math.PI) / 180)), lat + Math.sin(a) * r]
      })
    }
    out[i] = e
  }
  return out
}

/* ------------------------------------------------------------------ cases */

/** Selections a user actually makes, from a single year to the whole timeline. */
const SELECTIONS = [
  ['year 1969', 1969, 1969],
  ['decade 1990s', 1990, 1999],
  ['century 20th', 1900, 1999],
  ['millennium', 1000, 2000],
  ['all of history', -4.6e9, 2026],
]

/**
 * Cameras, by altitude in globe radii, with the aspect of a typical window.
 * The first is the default view (no scope at all); the rest are the zoom levels
 * the culling exists for.
 */
const CAMERAS = [
  ['world (default)', 2.5],
  ['continent', 0.35],
  ['region', 0.08],
  ['country', 0.02],
  ['city', 0.004],
]

const bench = (fn, minMs = 120) => {
  // warm up, so the first timed call is not the one that compiles the function
  for (let i = 0; i < 5; i++) fn()
  let runs = 0
  const t0 = performance.now()
  let elapsed = 0
  do {
    fn()
    runs++
    elapsed = performance.now() - t0
  } while (elapsed < minMs)
  return elapsed / runs
}

const heapMb = () => {
  // twice: one pass leaves the timing loop's discarded indexes on the heap
  // often enough to double the figure it is asked for
  if (globalThis.gc) {
    globalThis.gc()
    globalThis.gc()
  }
  // `arrayBuffers`, not just `heapUsed`. Both indexes are almost entirely typed
  // arrays, and V8 keeps a typed array's backing store *outside* the JS heap
  // once it is any size at all — so heapUsed alone reported these structures as
  // costing nothing at 10x and 100x, which is where the cost actually is.
  const m = process.memoryUsage()
  return (m.heapUsed + m.arrayBuffers) / 2 ** 20
}

const fmt = (v, digits = 3) => v.toFixed(digits).padStart(8)

/* ------------------------------------------------------------------- run */

console.log(`node ${process.version} · ${scales.map((s) => `${s}x`).join(', ')} of ${SHAPE.items} items`)
if (!globalThis.gc) console.log('(run with --expose-gc for memory figures worth reading)')

/* ------------------------------------------------- the space-index race */

/**
 * Grid against quadtree, on the one thing they disagree about.
 *
 * Both answer "which items are in this cap" behind the same interface, so the
 * fair comparison is that call and nothing else — the time index, the heap and
 * the scoring are shared and would only dilute the figure. Cases are a zoom
 * ladder crossed with the places where a lat/lng structure is at its worst: a
 * dense hub, the seam, and a pole.
 */
const PLACES = [
  ['hub (Paris)', 48.85, 2.35],
  ['equator', 0.0, 20.0],
  ['high lat 70°', 70.0, 25.0],
  ['pole 89.5°', 89.5, 0.0],
  ['seam ±180', 5.0, 179.7],
]

const columnsOf = (data) => {
  const n = data.length
  const lats = new Float64Array(n)
  const lngs = new Float64Array(n)
  const radii = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lats[i] = data[i].lat
    lngs[i] = data[i].lng
    radii[i] = eventRadiusDeg(data[i])
  }
  return { lats, lngs, radii }
}

/**
 * Fresh columns per build: both indexes take ownership of what they are given
 * (the quadtree folds longitudes in place), so a timing loop cannot reuse one
 * set. The columns are built once and copied per run rather than recomputed —
 * `eventRadiusDeg` over the corpus costs more than either index does, and
 * charging it to both would hide the difference between them behind a constant.
 */
const buildWith = (Ctor, cols, hint) =>
  Ctor.fromColumns(cols.lats.slice(), cols.lngs.slice(), cols.radii.slice(), hint)

/**
 * The space indexes to measure.
 *
 * This was a two-horse race — the shipped CSR lat/lng grid against a
 * capacity-splitting quadtree — and the grid won it, though not on this table:
 * the quadtree was up to 5x faster on isolated cap queries and still lost
 * end-to-end, because the wide caps it wins are ones the app never issues. The
 * numbers and the reasoning are recorded where the choice is made, at the top
 * of the space index in src/lib/queryIndex.ts; the quadtree is not in the tree.
 *
 * What survives is the harness — build, memory, and cap queries across zooms
 * and latitudes with every answer checked against brute force. Adding a second
 * entry here is how the next candidate gets the same treatment, and the lesson
 * from the last one is to read `--no-spatial` (the end-to-end table) before
 * believing anything here.
 */
const CONTENDERS = [['grid', GeoGrid]]

/**
 * The brute-force check, run at every scale before any timing is believed.
 *
 * A faster index that answers a different question is not faster. The corpus
 * here is the clustered one, and the caps deliberately include the seam and
 * both poles — the two places a lat/lng decomposition goes wrong.
 */
function verifySpatial(data, indexes, trials = 200, seed = 77) {
  const rand = rng(seed)
  const collect = (ix, cap) => {
    const out = []
    ix.forEach(cap, (i) => out.push(i))
    return out.sort((a, b) => a - b)
  }
  const caps = []
  for (let t = 0; t < trials; t++)
    caps.push({
      lat: (rand() - 0.5) * 178,
      lng: (rand() - 0.5) * 360,
      radiusDeg: 10 ** (rand() * 2 - 1),
    })
  // the awkward ones, stated rather than hoped for
  caps.push(
    { lat: 90, lng: 0, radiusDeg: 6 },
    { lat: -90, lng: 0, radiusDeg: 6 },
    { lat: 89.9, lng: 180, radiusDeg: 2 },
    { lat: 0, lng: 180, radiusDeg: 1.5 },
    { lat: 0, lng: -180, radiusDeg: 1.5 },
    { lat: 0, lng: 0, radiusDeg: 180 },
    { lat: 0, lng: 0, radiusDeg: 0 },
  )
  let bad = 0
  for (const cap of caps) {
    const want = []
    for (let i = 0; i < data.length; i++) {
      const e = data[i]
      if (separationDeg(cap.lat, cap.lng, e.lat, e.lng) <= cap.radiusDeg + eventRadiusDeg(e))
        want.push(i)
    }
    const key = want.join(',')
    for (const [name, ix] of indexes) {
      if (collect(ix, cap).join(',') !== key) {
        bad++
        if (bad <= 3) console.log(`  MISMATCH ${name} at`, cap)
      }
      // the planner trusts this bound; an under-count silently drops pins
      if (ix.candidateCount(cap) < want.length) {
        bad++
        if (bad <= 3) console.log(`  UNDERCOUNT ${name} at`, cap)
      }
    }
  }
  console.log(
    `  correctness: ${caps.length} caps x ${indexes.length} index${indexes.length > 1 ? 'es' : ''} vs brute force — ` +
      (bad ? `${bad} FAILURES` : 'all agree, poles and seam included'),
  )
  return bad === 0
}

function spatialRace(data, n) {
  console.log('\n  --- space index ---')
  const cols = columnsOf(data)
  const built = CONTENDERS.map(([name, Ctor]) => {
    // Memory, over several retained copies.
    //
    // One build is not measurable here: the collector's noise is the same size
    // as the answer, and a build allocates and drops enough scratch that a
    // single before/after can come out negative. Five kept alive, divided by
    // five, and the columns — which both indexes take ownership of rather than
    // copy, and which are identical for both — subtracted at their exact size.
    const COPIES = 5
    // The columns are allocated *before* the mark and kept alive across it, and
    // both indexes take ownership of them rather than copying — so the delta is
    // the structure alone, with nothing to subtract and nothing to estimate.
    const colSets = []
    for (let k = 0; k < COPIES; k++)
      colSets.push({ lats: cols.lats.slice(), lngs: cols.lngs.slice(), radii: cols.radii.slice() })
    const before = heapMb()
    const kept = colSets.map((c) => Ctor.fromColumns(c.lats, c.lngs, c.radii))
    const after = heapMb()
    const mb = (after - before) / COPIES
    const ix = kept[0]
    const build = bench(() => buildWith(Ctor, cols), 300)
    return { name, ix, build, mb }
  })
  for (const b of built)
    console.log(
      `  ${b.name.padEnd(9)} build ${fmt(b.build, 2)} ms   structure ${fmt(Math.max(0, b.mb), 2)} MB` +
        `   (${((Math.max(0, b.mb) * 2 ** 20) / n).toFixed(0)} B/event)` +
        (b.ix.nodeCount !== undefined ? `   ${b.ix.nodeCount.toLocaleString()} nodes` : ''),
    )

  verifySpatial(data, built.map((b) => [b.name, b.ix]))

  // One column group per contender, so a second entry needs no new formatting
  // and the numbers line up whatever is being raced.
  const head = built.map((b) => `${b.name} ms`.padStart(12) + 'cand'.padStart(9)).join('  |')
  console.log(`\n  place            camera        scope°     hits  |${head}`)
  const totals = Object.fromEntries(built.map((b) => [b.name, 0]))
  for (const [placeName, lat, lng] of PLACES) {
    for (const [camName, altitude] of CAMERAS) {
      const scope = cameraScope({ lat, lng, altitude, aspect: 1.6 })
      // world view publishes no scope; the space index is not consulted there,
      // so the honest stand-in is the widest cap it could ever be handed
      const cap = scope ?? { lat, lng, radiusDeg: 90 }
      let hits = 0
      let cells = ''
      for (const b of built) {
        let count = 0
        const run = () => {
          count = 0
          b.ix.forEach(cap, () => count++)
        }
        run()
        hits = count
        const ms = bench(run)
        totals[b.name] += ms
        cells += ms.toFixed(3).padStart(12) + String(b.ix.candidateCount(cap)).padStart(9) + '  |'
      }
      console.log(
        `  ${placeName.padEnd(15)} ${camName.padEnd(13)} ${cap.radiusDeg.toFixed(2).padStart(6)}` +
          ` ${String(hits).padStart(6)}  |${cells.replace(/\s*\|$/, '')}`,
      )
    }
  }
  console.log(
    '\n  total over all cases: ' +
      built.map((b) => `${b.name} ${totals[b.name].toFixed(3)} ms`).join(', ') +
      (built.length > 1
        ? `  →  ${(totals[built[0].name] / totals[built[built.length - 1].name]).toFixed(2)}x`
        : ''),
  )
}

for (const scale of scales) {
  const n = SHAPE.items * scale
  const data = synth(n)
  console.log(`\n=== ${scale}x — ${n.toLocaleString()} events ==========================`)
  if (withSpatial) spatialRace(data, n)
  if (!withEndToEnd) continue

  // memory first, on one index and nothing else: timing the build leaves a
  // dozen discarded copies behind, and they flatter or spoil the figure
  // depending on when the collector gets to them
  const before = heapMb()
  const idx = new EventIndex(data)
  const after = heapMb()
  const build = bench(() => new EventIndex(data), 300)
  console.log(
    `build ${fmt(build, 2)} ms   index ${fmt(after - before, 2)} MB` +
      `   (${(((after - before) * 2 ** 20) / n).toFixed(0)} B/event)`,
  )
  console.log(
    '\n  selection          camera            scope°      hits   plan        query ms' +
      (withNaive ? '   naive ms' : ''),
  )
  for (const [selName, s, e] of SELECTIONS) {
    for (const [camName, altitude] of CAMERAS) {
      const scope = cameraScope({ lat: 48.85, lng: 2.35, altitude, aspect: 1.6 })
      const hits = idx.query(s, e, {}, 30, scope).length
      const ms = bench(() => idx.query(s, e, {}, 30, scope))
      const naive = withNaive ? bench(() => visibleEvents(data, s, e, {}, 30, scope), 200) : 0
      console.log(
        `  ${selName.padEnd(18)} ${camName.padEnd(16)} ${(scope ? scope.radiusDeg.toFixed(2) : '—').padStart(7)}` +
          `  ${String(hits).padStart(4)}   ${idx.lastPlan.padEnd(9)} ${fmt(ms)}` +
          (withNaive ? `  ${fmt(naive)}` : ''),
      )
    }
  }

  // the two cases the app actually runs in a loop: scrubbing the timeline at
  // world view, and panning at close zoom
  const scrub = bench(() => {
    for (let y = 1900; y < 1920; y++) idx.query(y, y + 10, {}, 30)
  }, 200)
  const panScope = (i) =>
    cameraScope({ lat: 48.85 + i * 0.05, lng: 2.35 + i * 0.05, altitude: 0.02, aspect: 1.6 })
  const pan = bench(() => {
    for (let i = 0; i < 20; i++) idx.query(1800, 2000, {}, 30, panScope(i))
  }, 200)
  console.log(
    `\n  20-step scrub (world view)   ${fmt(scrub / 20)} ms/query` +
      `\n  20-step pan   (country zoom) ${fmt(pan / 20)} ms/query`,
  )
}
