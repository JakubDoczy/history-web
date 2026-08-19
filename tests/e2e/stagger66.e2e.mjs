/**
 * ROUND 66 — WHAT A PENDING DRAWN TILE SHOWS, counted per frame and photographed.
 *
 * The user's report: *"frustrating staggering in map mode … normal mode doesn't
 * stagger even when it loads tiles because it uses lower res map in the
 * meantime."* The claim to test is about the FALLBACK CHAIN: when a drawn tile
 * has not rasterized yet, what is under it — the parent level, or the level-3
 * base texture (a 4096-wide world map magnified up to ~90x at the zoom floor)?
 *
 * What this file measures, per animation frame of a scripted world→country→city
 * zoom, the settles between them, a pan, and a zoom back out:
 *
 *   z          the level the index streams (detail.index.z)
 *   nL/nF      tiles in the plan at the target level / the fallback level
 *   covT/covP  how many of each have an atlas slot this frame
 *   bare       target tiles with NEITHER their own slot NOR their parent's —
 *              every one of those is a rectangle of screen showing the level-3
 *              base texture. `bareFrac` is the stagger, as a number.
 *
 * And per request (DetailImagery.request wrapped): whether the tile was in the
 * plan's level, fallback or ring at the moment it was asked for, and whether
 * the same key was ever asked twice (a cache miss that should have been a hit).
 *
 * Machine-independence: counts, tiles, requests and fractions here do not
 * depend on SwiftShader; the wall-clock milliseconds do and are not reported.
 * The pipeline runs on a virtual 60 Hz clock exactly as drawnPerf.e2e.mjs does.
 *
 * Run:  node tests/e2e/stagger66.e2e.mjs
 * Env:  TAG, SHOT_DIR, CHROME_PATH, PLAYWRIGHT_MODULE as the other e2e files.
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const TAG = process.env.TAG ?? 'before'
const SHOTS = process.env.SHOT_DIR ?? '/tmp/shots66'
mkdirSync(SHOTS, { recursive: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const server = await createServer({ root, server: { port: 0 }, logLevel: 'warn' })
await server.listen()
const base = `http://localhost:${server.httpServer.address().port}`

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-proxy-server',
  ],
})
const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 })

await ctx.addInitScript(() => {
  // The pipeline's own clock, virtualised exactly as drawnPerf.e2e.mjs does:
  // 16 ms per animation frame, so SETTLE_MS and FADE_MS are frame counts.
  let vt = Date.now()
  Date.now = () => vt
  const S = { frames: [], on: false }
  window.__stag = S
  const beat = () => {
    vt += 16
    if (S.on) window.__stagSample?.()
    requestAnimationFrame(beat)
  }
  requestAnimationFrame(beat)
})

const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGE ERR', e.message))

await page.goto(base, { timeout: 120_000 })
await page.waitForFunction(() => !!window.__globe && !!window.__detail, null, { timeout: 60_000 })
await page.evaluate(() => window.__settings.setMode('schematic'))
await page.evaluate(() => window.__setTime(1941))
await page.evaluate(() => window.__globe.pointOfView({ lat: 46.2, lng: 8.0, altitude: 0.3 }))
await page.waitForFunction(() => window.__drawn?.source?.label?.includes('50m'), null, {
  timeout: 180_000,
})
await page.waitForTimeout(12_000)

/** Wire the sampler and the request classifier to the live pipeline. */
await page.evaluate(() => {
  const d = window.__detail
  const S = window.__stag
  const keyOf = (t, label) => `${t.z}/${t.x}/${t.y}/${label}`
  const parentKey = (t, label) => `${t.z - 1}/${t.x >> 1}/${t.y >> 1}/${label}`
  window.__stagSample = () => {
    const w = d.want
    const idx = d.index
    const slots = d.atlas.slots
    const label = w ? d.sourceAt(w.plan.z).label : ''
    // A tile SHOWING through its previous label's slot is not bare: the index
    // resolves new-label first, then the handoff's stand-in (see prevLabel in
    // lib/detailImagery.ts), and this counts what the shader can resolve.
    const prev = d.prevLabel
    const own = (t) =>
      slots.has(keyOf(t, label)) || (prev !== undefined && slots.has(keyOf(t, prev)))
    const parent = (t) =>
      slots.has(parentKey(t, label)) || (prev !== undefined && slots.has(parentKey(t, prev)))
    let covT = 0
    let covP = 0
    let bare = 0
    if (w) {
      for (const t of w.plan.fallback) if (own(t)) covP++
      for (const t of w.plan.level) {
        const o = own(t)
        if (o) covT++
        if (!o && !parent(t)) bare++
      }
    }
    S.frames.push({
      z: idx?.z ?? 0,
      resident: idx?.resident ?? 0,
      nL: w?.plan.level.length ?? 0,
      nF: w?.plan.fallback.length ?? 0,
      covT,
      covP,
      bare,
      slots: slots.size,
      label,
      lagging: d.lagging === true,
      backlog: d.backlog ?? 0,
      inflight: d.inflight?.size ?? 0,
      refused: d.refused?.size ?? 0,
      worker: !!window.__drawn?.worker,
    })
  }
  // ---- request classification, at the scheduler's own request method -------
  const R = {
    total: 0,
    level: 0,
    fallback: 0,
    ring: 0,
    other: 0,
    dup: 0,
    byZ: {},
    keys: [],
    seen: new Set(),
  }
  window.__req = R
  const proto = Object.getPrototypeOf(d)
  const inner = proto.request
  proto.request = function (tile, key, src) {
    R.total++
    R.byZ[tile.z] = (R.byZ[tile.z] || 0) + 1
    R.keys.push(key)
    if (R.seen.has(key)) R.dup++
    R.seen.add(key)
    const w = this.want
    const at = (list) => list.some((t) => t.z === tile.z && t.x === tile.x && t.y === tile.y)
    if (!w) R.other++
    else if (at(w.plan.level)) R.level++
    else if (at(w.plan.fallback)) R.fallback++
    else if (at(w.plan.ring)) R.ring++
    else R.other++
    return inner.call(this, tile, key, src)
  }
  window.__reqReset = () => {
    R.total = R.level = R.fallback = R.ring = R.other = R.dup = 0
    R.byZ = {}
    R.keys = []
    R.seen = new Set()
  }
})

const pov = (p, ms = 0) => page.evaluate(([p, ms]) => window.__globe.pointOfView(p, ms), [p, ms])

const quiesce = async (tries = 150) => {
  let calm = 0
  for (let i = 0; i < tries; i++) {
    const state = await page.evaluate(() => ({
      busy:
        window.__detail.animating === true ||
        (window.__worker?.depth ?? 0) > 0 ||
        window.__detail.lagging === true,
      still: window.__detail.still === true,
    }))
    calm = !state.busy && state.still ? calm + 1 : 0
    if (calm >= 2) return
    await page.waitForTimeout(400)
  }
  console.log('   quiesce TIMED OUT')
}

const scripted = (fn, arg) =>
  page.evaluate(
    ([src, arg]) =>
      new Promise((done) => {
        const step = new Function('g', 'i', 'arg', src)
        const g = window.__globe
        let i = 0
        const tick = () => {
          if (!step(g, i++, arg)) return done()
          // A scripted pointOfView moves the camera without the pointer events
          // a real gesture fires, so a fully parked pump would sleep through
          // the gesture and wake to a teleported view. A real drag wakes the
          // loop per event; this is that, not a cheat.
          window.__wake?.(0)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    [fn, arg],
  )

let cdp
const shot = async (name) => {
  if (!cdp) cdp = await page.context().newCDPSession(page)
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = join(SHOTS, `${TAG}-${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`   shot ${file}`)
  return file
}

/**
 * Watch the run from outside and photograph the worst moment: the first frame
 * where over a quarter of the target grid resolves to NOTHING (no own slot, no
 * parent slot) while a picture had already been shown — that is the reader's
 * "stagger" as pixels. One shot per phase at most.
 */
const watch = async (name, body, snapAt = 0.25) => {
  await page.evaluate(() => {
    window.__stag.frames = []
    window.__stag.on = true
  })
  let shotTaken = false
  const poll = setInterval(async () => {
    if (shotTaken) return
    try {
      const f = await page.evaluate(() => window.__stag.frames[window.__stag.frames.length - 1])
      if (f && f.nL > 0 && f.bare / f.nL >= snapAt) {
        shotTaken = true
        await shot(`${name}-bare`)
      }
    } catch {
      /* page busy */
    }
  }, 250)
  await body()
  clearInterval(poll)
  const frames = await page.evaluate(() => {
    window.__stag.on = false
    return window.__stag.frames.slice()
  })
  const req = await page.evaluate(() => ({
    total: window.__req.total,
    level: window.__req.level,
    fallback: window.__req.fallback,
    ring: window.__req.ring,
    other: window.__req.other,
    dup: window.__req.dup,
    byZ: window.__req.byZ,
    keys: window.__req.keys.slice(),
  }))
  await page.evaluate(() => window.__reqReset())

  // ---- summarise the stagger out of the frame stream ----------------------
  const zs = frames.map((f) => f.z)
  const changes = zs.filter((z, i) => i && z && zs[i - 1] && z !== zs[i - 1]).length
  const shownFrom = frames.findIndex((f) => f.resident > 0)
  const withPlan = frames.filter((f, i) => f.nL > 0 && shownFrom >= 0 && i >= shownFrom)
  const bareFrames = withPlan.filter((f) => f.bare > 0)
  const worst = withPlan.reduce((a, f) => Math.max(a, f.nL ? f.bare / f.nL : 0), 0)
  // Frames on which the whole indexed picture vanished (nothing resident at
  // either level) — the "flash to base texture" in one number.
  const blank = withPlan.filter((f) => f.resident === 0).length
  // Time-to-settled: frames from the first bare frame to the first frame that
  // is fully covered again (covT == nL), counted on the virtual clock.
  let settleFrames = null
  const firstBare = withPlan.findIndex((f) => f.bare > 0)
  if (firstBare >= 0) {
    const rest = withPlan.slice(firstBare)
    const done = rest.findIndex((f) => f.covT === f.nL && f.nL > 0)
    settleFrames = done >= 0 ? done : rest.length
  }
  const out = {
    name,
    frames: frames.length,
    levels: [...new Set(zs.filter(Boolean))].sort((a, b) => a - b),
    levelChanges: changes,
    blankFrames: blank,
    bareFrames: bareFrames.length,
    worstBareFrac: +worst.toFixed(3),
    settleFramesAfterFirstHole: settleFrames,
    requests: req,
  }
  console.log(JSON.stringify({ ...out, requests: { ...req, keys: undefined } }))
  return { ...out, raw: frames }
}

const report = { tag: TAG, phases: [] }
const HOME = { lat: 46.2, lng: 8.0 }
const FLOOR = 0.0035

const ZOOM = `
  if (i >= arg.n) return false
  g.pointOfView({ lat: arg.lat, lng: arg.lng, altitude: arg.from * Math.pow(arg.to / arg.from, i / (arg.n - 1)) })
  return true
`
const PAN = `
  if (i >= 120) return false
  g.pointOfView({ lat: arg.lat, lng: arg.lng + 0.03 * i, altitude: arg.alt })
  return true
`

// world → country: the first descent into streaming range
await pov({ ...HOME, altitude: 2.4 })
await quiesce()
report.phases.push(
  await watch('zoom-world-country', async () => {
    await scripted(ZOOM, { ...HOME, from: 2.4, to: 0.25, n: 45 })
    await quiesce()
  }),
)
// country → city: crosses the most levels; the settle snap lives here
report.phases.push(
  await watch('zoom-country-city', async () => {
    await scripted(ZOOM, { ...HOME, from: 0.25, to: FLOOR, n: 60 })
    await quiesce()
  }),
)
await shot('city-settled')
// pan at the floor
report.phases.push(
  await watch('pan-city', async () => {
    await scripted(PAN, { ...HOME, alt: FLOOR })
    await quiesce()
  }),
)
// and back out to the world
report.phases.push(
  await watch('zoom-out', async () => {
    await scripted(ZOOM, { lat: HOME.lat, lng: HOME.lng + 3.6, from: FLOOR, to: 2.4, n: 60 })
    await quiesce()
  }),
)

writeFileSync(`/tmp/stagger66-${TAG}.json`, JSON.stringify(report, null, 1))
console.log(`\nwrote /tmp/stagger66-${TAG}.json`)

await browser.close()
await server.close()
