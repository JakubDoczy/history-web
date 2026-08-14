/**
 * WHAT A FRAME OF THE SURFACE COSTS, in the one currency this sandbox can pay.
 *
 * Every other instrument in this directory refuses wall-clock time, and is
 * right to: `drawnPerf` counts events because SwiftShader inflates GL, and
 * `framePerf` says so in its own header. This file is the exception, and the
 * exception needs its reason written down.
 *
 * SwiftShader is not a slow GPU. It is a CPU running the fragment program, one
 * fragment at a time, and a frame of this globe is a full-screen sphere whose
 * fragment program is by far the longest one in the app. So the wall clock here
 * measures SHADER WORK almost purely — with the camera pinned, the year pinned
 * and the scene otherwise identical, the only thing that can move the number is
 * how much arithmetic and how many texture fetches each fragment does.
 *
 * What that buys and what it does not:
 *
 *  · It DOES answer "did map mode stop running the photograph's pipeline" —
 *    which is round 61's sustained-cost claim, and which is otherwise
 *    unmeasurable without a GPU.
 *  · It does NOT translate to a real GPU as a ratio. A discrete GPU runs
 *    thousands of fragments in parallel and is often bandwidth-bound rather
 *    than ALU-bound, so removing transcendentals buys less there than here. The
 *    machine-independent half of the claim is the op count, which
 *    tests/shader.test.ts asserts structurally; this is the half that says the
 *    ops were actually on the hot path.
 *
 * THE CAMERA IS STILL AND FRAMES THAT DID WORK ARE THROWN AWAY. Both halves
 * are necessary, and the second one was learned the hard way: holding the pump
 * awake at a still camera is exactly the condition under which the prefetch
 * ring is spent, so map mode kept rasterising and uploading tiles all the way
 * through the measurement and the "shader cost" swung by a factor of three
 * between runs of the same build. A frame with an atlas upload in it is a frame
 * that measured the streamer, and it is dropped; `busy` says how many were.
 *
 * The reported figure is the MEDIAN of the frames that survive that, over the
 * MEDIAN of `RUNS` page loads: two cores and a software rasteriser make a mean
 * meaningless.
 *
 * Run:  node tests/e2e/surfaceCost.e2e.mjs
 * Env:  TAG    label on /tmp/surfacecost-$TAG.json
 *       RUNS   page loads to take the median over (default 3)
 *       FRAMES frames per mode per run (default 24)
 */
import { createServer } from 'vite'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const TAG = process.env.TAG ?? 'before'
const RUNS = Number(process.env.RUNS ?? 3)
const FRAMES = Number(process.env.FRAMES ?? 24)
/** Subsets, for bisecting a change: `VIEWS=world MODES=schematic`. */
const ONLY_VIEWS = process.env.VIEWS ? new Set(process.env.VIEWS.split(',')) : null
const ONLY_MODES = process.env.MODES ? new Set(process.env.MODES.split(',')) : null

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const server = await createServer({ root, server: { port: 0 }, logLevel: 'warn' })
await server.listen()
const base = `http://localhost:${server.httpServer.address().port}`

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
})

/** One counter, so a frame can say whether the streamer was in it. */
const COUNT_UPLOADS = () => {
  const G = WebGL2RenderingContext.prototype
  const U = { n: 0 }
  window.__uploads = U
  for (const name of ['texSubImage2D', 'texImage2D']) {
    const inner = G[name]
    G[name] = function (...a) {
      // The 16x16 index goes up every frame by design and is not the streamer;
      // anything bigger is a tile, a base map or a mip of one.
      const w = a.length >= 9 ? a[name === 'texImage2D' ? 3 : 4] : (a[a.length - 1]?.width ?? 0)
      if (w > 64) U.n++
      return inner.apply(this, a)
    }
  }
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? +s[s.length >> 1].toFixed(1) : 0
}
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : 0
}

/**
 * Hold the pump awake and time `n` frames, two ways.
 *
 * THE FRAME GAP IS THE MEASUREMENT and `renderer.render` is the control. Under
 * SwiftShader `render` returns as soon as the GL commands are ISSUED — measured
 * at 1-2 ms against a frame of 700 — because the rasterisation happens on
 * SwiftShader's own threads and the browser waits for it at composite. So the
 * rAF interval is where fragment cost shows up, and `render` is what says the
 * JS side of a frame did not change while it moved.
 *
 * The gap is quantised to the display's 16.7 ms tick, which is the resolution
 * of every number below: a 700 ms frame is 42 ticks, so one tick is 2.4%.
 */
const HOLD = (n) =>
  new Promise((done) => {
    const g = window.__globe
    const r = g.renderer()
    const inner = window.__renderInner ?? (window.__renderInner = r.render.bind(r))
    const gaps = []
    const renders = []
    const busy = []
    let last = 0
    let i = 0
    let uploads = window.__uploads?.n ?? 0
    r.render = (...a) => {
      const t0 = performance.now()
      try {
        return inner(...a)
      } finally {
        renders.push(performance.now() - t0)
      }
    }
    const tick = (t) => {
      const now = window.__uploads?.n ?? 0
      if (last) {
        gaps.push(t - last)
        busy.push(now - uploads)
      }
      uploads = now
      last = t
      window.__wake?.()
      if (++i > n) {
        r.render = inner
        return done({ gaps, renders, busy })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

/** Nothing on the wire, nothing fading, the camera where it was left. */
const quiesce = async (page, tries = 40) => {
  let calm = 0
  for (let i = 0; i < tries; i++) {
    const busy = await page.evaluate(() => window.__detail?.animating === true)
    calm = busy ? 0 : calm + 1
    if (calm >= 3) return
    await page.waitForTimeout(500)
  }
}

const VIEWS = [
  // The whole planet OVERFLOWING the lens, which is the one camera where
  // `detailWanted` streams nothing at all (see `planetFillsFrame`): the most
  // surface fragments a frame can have and no tile pipeline underneath them.
  ['world', { lat: 20, lng: 10, altitude: 2.4 }],
  // …and a continental view, where the streamed layer is resident and the
  // detail block is actually resolving tiles rather than sitting at mix 0.
  ['continental', { lat: 48, lng: 8, altitude: 0.5 }],
]

const onePass = async () => {
  const ctx = await browser.newContext({
    viewport: { width: 1000, height: 750 },
    deviceScaleFactor: 1,
  })
  await ctx.addInitScript(COUNT_UPLOADS)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('PAGE ERR', e.message))
  await page.goto(base, { timeout: 120_000 })
  await page.waitForFunction(() => !!window.__globe && !!window.__detail, null, { timeout: 120_000 })
  await page.evaluate(() => window.__setTime(1941))
  const out = {}
  for (const mode of ['realistic', 'schematic']) {
    if (ONLY_MODES && !ONLY_MODES.has(mode)) continue
    await page.evaluate((m) => window.__settings.setMode(m), mode)
    for (const [name, pov] of VIEWS) {
      if (ONLY_VIEWS && !ONLY_VIEWS.has(name)) continue
      await page.evaluate((p) => window.__globe.pointOfView(p), pov)
      await quiesce(page)
      // …and once more, so the first frame of the measurement is not the one
      // that absorbed the last tile.
      await page.waitForTimeout(2000)
      const r = await page.evaluate(HOLD, FRAMES)
      // A frame that uploaded is a frame that measured the streamer.
      const quiet = r.gaps.filter((_, i) => r.busy[i] === 0)
      const tag = `${mode === 'realistic' ? 'globe' : 'map'}:${name}`
      out[tag] = {
        renderMed: med(r.renders),
        renderP25: pct(r.renders, 0.25),
        renderP75: pct(r.renders, 0.75),
        gapMed: med(quiet.length >= 4 ? quiet : r.gaps),
        gapAllMed: med(r.gaps),
        quiet: quiet.length,
        frames: r.gaps.length,
      }
    }
  }
  await ctx.close()
  return out
}

const passes = []
for (let i = 0; i < RUNS; i++) {
  const p = await onePass()
  passes.push(p)
  console.log(
    `run ${i + 1}/${RUNS}  ` +
      Object.entries(p)
        .map(([k, v]) => `${k} ${v.gapMed}ms`)
        .join('  '),
  )
}

const report = { tag: TAG, runs: RUNS, frames: FRAMES }
for (const key of Object.keys(passes[0])) {
  report[key] = {
    renderMed: med(passes.map((p) => p[key].renderMed)),
    renderP25: med(passes.map((p) => p[key].renderP25)),
    renderP75: med(passes.map((p) => p[key].renderP75)),
    gapMed: med(passes.map((p) => p[key].gapMed)),
    gapAllMed: med(passes.map((p) => p[key].gapAllMed)),
    quiet: med(passes.map((p) => p[key].quiet)),
    frames: med(passes.map((p) => p[key].frames)),
    perRun: passes.map((p) => p[key].renderMed),
    perRunGap: passes.map((p) => p[key].gapMed),
  }
  const r = report[key]
  console.log(
    `${key.padEnd(20)} FRAME ${r.gapMed} ms over ${r.quiet}/${r.frames} quiet frames` +
      `   (all frames ${r.gapAllMed} ms, issue ${r.renderMed} ms)   per run ${r.perRunGap.join(', ')}`,
  )
}

writeFileSync(`/tmp/surfacecost-${TAG}.json`, JSON.stringify(report, null, 1))
await browser.close()
await server.close()
