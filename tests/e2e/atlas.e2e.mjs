/**
 * What a gesture costs the GPU, counted at the GL call.
 *
 * Phase 1's instrument (slowPan.e2e.mjs) counted the pipeline's own publishes,
 * because the pipeline was where the cost was. Phase 2 moves the assembly into
 * the shader, so the question is no longer "how many composites" but "how many
 * bytes crossed the bus, in what call, on which frame" — and that has to be
 * measured underneath the app, at WebGL2RenderingContext, or it measures the
 * thing being changed rather than the thing being paid for.
 *
 * Hooks, installed before any context exists (addInitScript):
 *
 *   texStorage2D    immutable allocations, so a texture can be identified by
 *                   its size for the rest of the run
 *   texImage2D      mutable allocations *and* full uploads — the call the
 *                   composite path used, and the one that must not appear
 *   texSubImage2D   partial uploads: the atlas's tiles, and also how three
 *                   re-uploaded a composite into existing storage
 *   generateMipmap  the chain rebuild; must be zero on the atlas, and zero at
 *                   interaction time anywhere
 *   drawElements / drawArrays / drawElementsInstanced
 *
 * Counters roll per animation frame, so "bytes uploaded per frame" is exactly
 * that and not an average over a gesture.
 *
 * Deterministic on the same terms as slowPan.e2e.mjs: the camera is driven from
 * inside the page on rAF (a scripted pointer costs a round trip per step), and
 * `Date.now` advances 16 ms per frame so the pipeline's own clocks see the 60 Hz
 * world the user has. Real frame times are reported as a cost signal only —
 * SwiftShader inflates a megapixel upload roughly tenfold.
 *
 * The dev server, not a preview build: `__globe` and `__detail` only exist under
 * import.meta.env.DEV, and without them there is no way to put the camera
 * somewhere exact or to read what the streamer thinks it is doing.
 *
 * Run:  node tests/e2e/atlas.e2e.mjs
 * Env:  TAG          label on /tmp/atlas-$TAG.json and on the screenshots
 *       CHROME_PATH  Chromium executable
 *       SHOT_DIR     where screenshots land (default /tmp/shots40)
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const TAG = process.env.TAG ?? 'after'
const SHOTS = process.env.SHOT_DIR ?? '/tmp/shots40'
mkdirSync(SHOTS, { recursive: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

/**
 * A cheap tile whose colour says which pyramid level it came from, and whose
 * grid says how sharp it is. Level-coded hues make a fallback tile visibly
 * different from a target tile, which is what the mid-pan screenshot is for.
 */
const synthetic = (w, h, span) => {
  const level = Math.round(Math.log2(360 / span))
  const hue = (level * 47) % 360
  const cell = Math.max(4, Math.round(Math.min(w, h) / 16))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><pattern id="p" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">
    <rect width="${cell * 2}" height="${cell * 2}" fill="hsl(${hue},55%,${level % 2 ? 62 : 44}%)"/>
    <rect width="${cell}" height="${cell}" fill="hsl(${hue},60%,20%)"/>
    <rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="hsl(${hue},60%,20%)"/>
  </pattern></defs><rect width="100%" height="100%" fill="url(#p)"/></svg>`
}

const server = await createServer({ root, server: { port: 0 }, logLevel: 'warn' })
await server.listen()
const base = `http://localhost:${server.httpServer.address().port}`

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
})
const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 })

/** Everything below runs before the app's first line, so no context escapes it. */
await ctx.addInitScript(() => {
  const G = WebGL2RenderingContext.prototype
  const sized = new WeakMap() // texture -> { w, h } from its allocation
  let bound2d = null
  const fresh = () => ({
    atlasBytes: 0,
    atlasCalls: 0,
    otherBytes: 0,
    bigUploads: 0,
    mips: 0,
    atlasMips: 0,
    draws: 0,
  })
  const gl = { frame: fresh(), frames: [], allocations: [], big: [], on: false }
  window.__gl = gl

  /**
   * Pixels in one upload call.
   *
   * The overloads have to be told apart by arity, not by "are these two numbers"
   * — the short form's format and type *are* two numbers (6408, 5121), and
   * multiplying them bills a 1280x1024 composite as 33 megapixels.
   *
   *   texSubImage2D(target, level, x, y, w, h, format, type, src)   9 args
   *   texSubImage2D(target, level, x, y, format, type, source)      7 args
   *   texImage2D(target, level, internal, w, h, border, fmt, type, src)  9
   *   texImage2D(target, level, internal, fmt, type, source)             6
   */
  const px = (a, from) => {
    if (a.length >= 9) return a[from] * a[from + 1]
    const src = a[a.length - 1]
    return src && src.width ? src.width * src.height : 0
  }
  // Channels per texel, so a single-channel 8192 cloud mask is not billed as
  // RGBA. 6403 RED, 33319 RG, 6407 RGB, 6408 RGBA.
  const chan = (f) => ({ 6403: 1, 33319: 2, 6407: 3, 6408: 4 })[f] ?? 4
  /** Which of this app's textures is bound: the atlas, its reduction, or a map. */
  const which = () => {
    const s = sized.get(bound2d)
    if (!s) return 'other'
    if (s.w === 4096 && s.h === 4096) return 'atlas'
    if (s.w === 512 && s.h === 512) return 'atlasLow'
    if (s.w === 16 && s.h === 16) return 'index'
    return 'other'
  }

  const wrap = (name, fn) => {
    const inner = G[name]
    G[name] = function (...a) {
      fn.call(this, a)
      return inner.apply(this, a)
    }
  }

  wrap('bindTexture', function (a) {
    if (a[0] === this.TEXTURE_2D) bound2d = a[1]
  })
  wrap('texStorage2D', function (a) {
    sized.set(bound2d, { w: a[3], h: a[4], levels: a[1] })
    if (gl.on) gl.allocations.push({ kind: 'storage', w: a[3], h: a[4], levels: a[1] })
  })
  wrap('texImage2D', function (a) {
    const n = px(a, 3)
    if (a.length >= 9) sized.set(bound2d, { w: a[3], h: a[4], levels: 1 })
    if (!gl.on) return
    gl.allocations.push({ kind: 'image', px: n })
    // A texImage2D carrying pixels is a full-texture upload by definition: it
    // allocates and fills in one call. That is what a composite publish was.
    if (a[a.length - 1] && n >= 1e6) {
      gl.frame.bigUploads++
      gl.frame.otherBytes += n * chan(a.length >= 9 ? a[6] : a[3])
      gl.big.push({ call: 'texImage2D', px: n })
    }
  })
  wrap('texSubImage2D', function (a) {
    if (!gl.on) return
    const n = px(a, 4)
    const bytes = n * chan(a.length >= 9 ? a[6] : a[4])
    const w = which()
    if (w === 'other') gl.frame.otherBytes += bytes
    else {
      gl.frame.atlasBytes += bytes
      if (w !== 'index') gl.frame.atlasCalls++
    }
    // A megapixel in one call is a whole picture, not a tile: the composite
    // path's re-upload into existing storage looked exactly like this.
    if (n >= 1e6) {
      gl.frame.bigUploads++
      const s = sized.get(bound2d)
      gl.big.push({ call: 'texSubImage2D', px: n, into: s && `${s.w}x${s.h}` })
    }
  })
  wrap('generateMipmap', function (a) {
    if (!gl.on) return
    gl.frame.mips++
    const s = sized.get(bound2d)
    // 4096 square is the atlas; the base maps are 4096x2048 and the cloud mask
    // 8192x4096, so the shape is enough to tell them apart.
    if (a[0] === this.TEXTURE_2D && s && s.w === 4096 && s.h === 4096) gl.frame.atlasMips++
  })
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    wrap(name, () => {
      if (gl.on) gl.frame.draws++
    })
  }

  // The virtual clock and the frame boundary, on one beat.
  let vt = Date.now()
  Date.now = () => vt
  window.__vt = () => vt
  let last = 0
  const beat = (t) => {
    vt += 16
    if (gl.on) {
      gl.frame.ms = last ? +(t - last).toFixed(1) : 0
      gl.frames.push(gl.frame)
      gl.frame = fresh()
    }
    last = t
    requestAnimationFrame(beat)
  }
  requestAnimationFrame(beat)
  window.__glStart = () => {
    gl.frames = []
    gl.allocations = []
    gl.big = []
    gl.frame = fresh()
    gl.on = true
  }
  window.__glStop = () => {
    gl.on = false
    return { frames: gl.frames.slice(), allocations: gl.allocations.slice(), big: gl.big.slice() }
  }
})

const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGE ERR', e.message))

let requests = 0
await page.route(/(gibs\.earthdata\.nasa\.gov|tiles\.maps\.eox\.at)/, async (route) => {
  const q = Object.fromEntries(new URL(route.request().url()).searchParams)
  const n = (q.bbox ?? '').split(',').map(Number)
  requests++
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' },
    body: synthetic(+q.width, +q.height, Math.max(Math.abs(n[2] - n[0]), Math.abs(n[3] - n[1]))),
  })
})

await page.goto(base, { timeout: 120_000 })
await page.waitForFunction(() => !!window.__globe && !!window.__detail, null, { timeout: 60_000 })
// The three deferred base maps and the 8192 cloud upscale all upload once, on
// their own schedule, and under SwiftShader that schedule runs for several
// seconds. None of it is the streamer, and none of it may land inside a
// measured window.
await page.waitForTimeout(15000)

const START = { lat: 46.2, lng: 8.0, altitude: 0.02 }
const pov = (p, ms = 0) => page.evaluate(([p, ms]) => window.__globe.pointOfView(p, ms), [p, ms])

/**
 * Let the streamer reach a fixed point: nothing on the wire, nothing queued for
 * a slot, nothing fading.
 *
 * Both halves matter under SwiftShader, where a frame costs ~0.5 s and a view's
 * 21 tiles therefore take eight wall seconds to be absorbed at two a frame —
 * eleven frames, which is 180 ms on any real machine.
 */
const quiesce = async (tries = 60) => {
  let seen = -1
  for (let i = 0; i < tries; i++) {
    // `animating` only exists on the atlas pipeline; the composite one is
    // quiet when the wire is, which is what the request check covers.
    const busy = await page.evaluate(() => window.__detail.animating === true)
    if (!busy && seen === requests) return
    seen = requests
    await page.waitForTimeout(500)
  }
}

const summarise = (label, out) => {
  const f = out.frames.filter((x) => x.ms > 0)
  const ms = f.map((x) => x.ms).sort((a, b) => a - b)
  const at = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] ?? 0
  const median = at(0.5)
  return {
    label,
    frames: f.length,
    maxAtlasBytesPerFrame: Math.max(0, ...f.map((x) => x.atlasBytes)),
    maxAtlasCallsPerFrame: Math.max(0, ...f.map((x) => x.atlasCalls)),
    atlasMB: +(f.reduce((s, x) => s + x.atlasBytes, 0) / 1048576).toFixed(2),
    otherMB: +(f.reduce((s, x) => s + x.otherBytes, 0) / 1048576).toFixed(2),
    fullUploads: f.reduce((s, x) => s + x.bigUploads, 0),
    // …and what they were, so a base map decoding late is never mistaken for a
    // composite publish coming back
    fullUploadShapes: out.big,
    generateMipmap: f.reduce((s, x) => s + x.mips, 0),
    atlasMipmap: f.reduce((s, x) => s + x.atlasMips, 0),
    medianDraws: [...f.map((x) => x.draws)].sort((a, b) => a - b)[Math.floor(f.length / 2)] ?? 0,
    medianFrameMs: median,
    p95FrameMs: at(0.95),
    longFrames: f.filter((x) => x.ms > median * 3).length,
  }
}

/** Drive the camera from inside the page, one step per animation frame. */
const scripted = (fn, arg) =>
  page.evaluate(
    ([src, arg]) =>
      new Promise((done) => {
        const step = new Function('g', 'i', 'arg', src)
        const g = window.__globe
        let i = 0
        const tick = () => {
          if (!step(g, i++, arg)) return done()
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    [fn, arg],
  )

const measure = async (label, body) => {
  await page.evaluate(() => window.__glStart())
  await body()
  const out = await page.evaluate(() => window.__glStop())
  return summarise(label, out)
}

const report = { tag: TAG, runs: [] }

// --- 1. a settled, fully covered close view ---------------------------------
await pov(START)
await quiesce()
report.runs.push(
  await measure('rest', async () => {
    await page.waitForTimeout(1500)
  }),
)
await page.screenshot({ path: join(SHOTS, `${TAG}-1-covered.png`) })
report.state = await page.evaluate(() => ({
  z: window.__detail.index?.z ?? null,
  resident: window.__detail.index?.resident ?? null,
  grid: window.__detail.index?.grid ?? null,
  slots: window.__detail.atlas?.slots?.size ?? null,
  writes: window.__detail.atlas?.writes ?? null,
  status: window.__detail.status,
  groundRes: window.__detail.groundRes,
}))

// --- 2. a pan, at the speed the field report was about ----------------------
const PAN = `
  if (i >= 120) return false
  const p = arg
  g.pointOfView({ ...p, lng: p.lng + 0.02 * i })
  return true
`
report.runs.push(await measure('pan', () => scripted(PAN, START)))
await page.screenshot({ path: join(SHOTS, `${TAG}-2-midpan.png`) })

// --- 3. a zoom, which crosses pyramid levels --------------------------------
await pov(START)
await quiesce()
const ZOOM = `
  if (i >= 90) return false
  const p = arg
  g.pointOfView({ ...p, altitude: p.altitude * Math.pow(0.25, i / 89) })
  return true
`
report.runs.push(await measure('zoom', () => scripted(ZOOM, START)))
await page.screenshot({ path: join(SHOTS, `${TAG}-3-zoomed.png`) })

// --- 4. the pre-1930 zoom clamp, which is what has been floor-ing everything --
// The app opens on a pre-1930 year, so `minAltitudeFor` has been holding the
// camera at MIN_ALTITUDE_PRE_ERA (a 100 km frame) for every run above — which is
// the era rule working exactly as designed, and worth recording as such before
// it is lifted.
report.preEra = await page.evaluate(() => ({
  year: window.__time?.currentTime ?? null,
  minDistance: window.__globe.controls().minDistance,
  altitude: window.__globe.pointOfView().altitude,
  z: window.__detail.index?.z ?? null,
  groundRes: window.__detail.groundRes,
}))

// --- 5. past Z_MAX: the terminal tiles, magnified ---------------------------
// Only reachable in the satellite era: before 1930 the clamp above stops the
// descent four levels short, and that is the point of the clamp.
await page.evaluate(() => window.__setTime(2000))
await page.waitForTimeout(2000)
// Descended in steps, not jumped. globe.gl re-derives controls.minDistance from
// the camera's own near plane on every zoom event, and GlobeView tracks near to
// the altitude — so a single jump to the floor is clamped by the near plane the
// camera had before it, and only relaxes as the two chase each other down.
// Driven a frame at a time, not jumped. globe.gl re-derives
// controls.minDistance from the camera's own near plane on every zoom event and
// GlobeView tracks near to the altitude, so a jump to the floor is clamped by
// the near plane the camera had before it and only relaxes as the two chase each
// other down. Level 12 is reached around altitude 0.003; everything below that
// is terminal — the sharp source has no more to give and the tile is magnified.
// Relative to where the camera *is*, not to where it started, and that is not a
// detail. globe.gl sets `controls.minDistance = globeR + near * 1.1` on every
// zoom event and GlobeView tracks `near` to the altitude, so the reachable floor
// is about 0.385x the current altitude and relaxes one step per *successful*
// move. A script that asks for the destination every frame is clamped to the
// same floor every frame, the point of view never changes, `applyPov` early-
// returns on that, and the floor never relaxes — the camera stalls at 0.0168,
// which is level 10. Asking for 0.9x of the current altitude is inside the floor
// every time, so each step lands, and the descent runs all the way to
// MIN_ALTITUDE_DETAIL.
const DESCEND = `
  if (i >= 130) return false
  const p = g.pointOfView()
  g.pointOfView({ ...p, altitude: p.altitude * 0.9 })
  return true
`
await scripted(DESCEND, START)
await quiesce()
report.runs.push(
  await measure('terminal', async () => {
    await page.waitForTimeout(1500)
  }),
)
report.terminal = await page.evaluate(() => ({
  altitude: window.__globe.pointOfView().altitude,
  z: window.__detail.index?.z ?? null,
  groundRes: window.__detail.groundRes,
}))
await page.screenshot({ path: join(SHOTS, `${TAG}-5-past-zmax.png`) })

// --- 6. the fixed reference camera, for a pixel comparison ------------------
// Back to the era the rest of the run was in, so the two builds are compared at
// a camera both of them can hold.
await page.evaluate(() => window.__setTime(1850))
await page.waitForTimeout(1500)
await pov({ lat: 46.2, lng: 8.0, altitude: 0.05 })
await page.waitForTimeout(1500)
await pov({ lat: 46.2, lng: 8.0, altitude: 0.017 })
await quiesce()
await page.screenshot({ path: join(SHOTS, `${TAG}-6-reference.png`) })

report.requests = requests
console.log(JSON.stringify(report, null, 1))
writeFileSync(`/tmp/atlas-${TAG}.json`, JSON.stringify(report, null, 1))

await browser.close()
await server.close()
