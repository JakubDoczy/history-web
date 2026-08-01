/**
 * What the globe's event query costs, at the size the dataset is now and at the
 * sizes the requirements ask for.
 *
 *   node scripts/bench-eventIndex.mjs              # 1x, 10x, 100x
 *   node scripts/bench-eventIndex.mjs --scales 1,10,100,1000
 *   node scripts/bench-eventIndex.mjs --naive      # also time the linear scan
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
const { EventIndex, visibleEvents } = await import(resolve(root, 'src/lib/events.ts'))
const { cameraScope } = await import(resolve(root, 'src/lib/viewport.ts'))

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const scales = flag('--scales', '1,10,100')
  .split(',')
  .map(Number)
const withNaive = args.includes('--naive')

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
  return process.memoryUsage().heapUsed / 2 ** 20
}

const fmt = (v, digits = 3) => v.toFixed(digits).padStart(8)

/* ------------------------------------------------------------------- run */

console.log(`node ${process.version} · ${scales.map((s) => `${s}x`).join(', ')} of ${SHAPE.items} items`)
if (!globalThis.gc) console.log('(run with --expose-gc for memory figures worth reading)')

for (const scale of scales) {
  const n = SHAPE.items * scale
  const data = synth(n)
  console.log(`\n=== ${scale}x — ${n.toLocaleString()} events ==========================`)

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
