/**
 * What a pan costs, as a function of how fast it is.
 *
 * The field report was the wrong way round: a *very slow* drag staggered while
 * a rapid one was smooth. This counts the work each speed actually does, where
 * it does it — publishes (a full composite upload plus `generateMipmap` each,
 * so the pixel count is the bill), composites, Lanczos jobs, tile requests.
 *
 * Two things make it deterministic rather than a wall-time guess.
 *
 * The camera is driven from inside the page on requestAnimationFrame, not by
 * Playwright's mouse: a scripted pointer costs a round trip per step, which
 * destroys the cadence being measured. A drag moves the view by a fixed
 * fraction of its own span per frame (globe.gl scales `rotateSpeed` with
 * altitude), which is exactly what this does.
 *
 * And the pipeline's clock is virtual: `Date.now` advances 16 ms per animation
 * frame. It has to. Under SwiftShader one publish costs ~1 s, so on the real
 * clock every gesture — including a flick — is slower than SETTLE_MS per frame
 * and *everything* classifies as a still camera; the bug under investigation
 * would then reproduce at every speed for the wrong reason. On the virtual
 * clock a frame is a frame, motion classification and the settle timer see the
 * 60 Hz world the user has, and the counters below are exact. Real frame times
 * are still reported, but as a cost signal (SwiftShader inflates a publish
 * ~10x), never as a frame-rate claim.
 *
 * Run:  node tests/e2e/slowPan.e2e.mjs
 * Env:  TAG          label on the report written to /tmp/slowpan-$TAG.json
 *       CHROME_PATH  Chromium executable
 *       SHOT_DIR     where screenshots land
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const TAG = process.env.TAG ?? 'before'
const SHOTS = process.env.SHOT_DIR ?? '/tmp/shots39'
mkdirSync(SHOTS, { recursive: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

/** A cheap tile whose colour says which pyramid level it came from. */
const synthetic = (w, h, span) => {
  const level = Math.round(Math.log2(360 / span))
  const hue = (level * 47) % 360
  const cell = Math.max(8, Math.round(Math.min(w, h) / 16))
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
await page.waitForTimeout(2500)

/** Wrap the pipeline's own methods; the app ships no counters of its own. */
await page.evaluate(() => {
  const proto = Object.getPrototypeOf(window.__detail)
  const zero = () => ({
    frames: 0,
    stillFrames: 0,
    publishes: 0,
    publishPx: 0,
    allocations: 0,
    composites: 0,
    upscales: 0,
    by: {},
  })
  window.__c = zero()
  window.__where = 'none'
  window.__lastPublishVt = 0
  window.__reset = () => {
    window.__c = zero()
    window.__raf = []
  }

  const wrap = (name, fn) => {
    const inner = proto[name]
    proto[name] = function (...a) {
      return fn.call(this, inner, a)
    }
  }
  /** Attribute each publish to the path that caused it. */
  for (const name of ['arm', 'adopt', 'requestUpscale', 'update'])
    wrap(name, function (inner, a) {
      const prev = window.__where
      window.__where = name
      try {
        return inner.apply(this, a)
      } finally {
        window.__where = prev
      }
    })

  wrap('publish', function (inner, a) {
    const c = window.__c
    const before = this.texture
    c.publishes++
    c.by[window.__where] = (c.by[window.__where] ?? 0) + 1
    c.publishPx += (a[0]?.width ?? 0) * (a[0]?.height ?? 0)
    window.__lastPublishVt = Date.now()
    const r = inner.apply(this, a)
    if (this.texture !== before) c.allocations++
    return r
  })
  wrap('recomposite', function (inner, a) {
    window.__c.composites++
    return inner.apply(this, a)
  })
  wrap('requestUpscale', function (inner, a) {
    window.__c.upscales++
    return inner.apply(this, a)
  })
  wrap('update', function (inner, a) {
    window.__c.frames++
    const r = inner.apply(this, a)
    if (this.still) window.__c.stillFrames++
    return r
  })

  // The virtual clock, and the frame cadence, on one beat. See the file header.
  window.__raf = []
  let vt = Date.now()
  Date.now = () => vt
  window.__vt = () => vt
  let last = 0
  const beat = (t) => {
    vt += 16
    if (last && window.__raf.length < 20000) window.__raf.push(+(t - last).toFixed(1))
    last = t
    requestAnimationFrame(beat)
  }
  requestAnimationFrame(beat)
})

const START = { lat: 46.2, lng: 8.0, altitude: 0.02 }
const pov = (p, ms = 0) => page.evaluate(([p, ms]) => window.__globe.pointOfView(p, ms), [p, ms])

/** Wait until the pipeline has been quiet for `quiet` virtual ms. */
const quiesce = (quiet = 1200) =>
  page.waitForFunction((q) => Date.now() - window.__lastPublishVt > q, quiet, {
    timeout: 180_000,
    polling: 100,
  })

const settle = async () => {
  await pov(START)
  // the clock is virtual, so "quiet since the move" has to be marked from here
  await page.evaluate(() => (window.__lastPublishVt = Date.now()))
  await quiesce()
  await page.waitForFunction(() => !!window.__detail.want, null, { timeout: 60_000 })
  requests = 0
  await page.evaluate(() => window.__reset())
}

const harvest = async (extra) => {
  const c = await page.evaluate(() => ({ ...window.__c, raf: window.__raf.slice() }))
  const raf = c.raf.filter((d) => d > 0)
  const sorted = [...raf].sort((a, b) => a - b)
  return {
    ...extra,
    updates: c.frames,
    stillFrames: c.stillFrames,
    publishes: c.publishes,
    publishMPx: +(c.publishPx / 1e6).toFixed(1),
    allocations: c.allocations,
    composites: c.composites,
    upscales: c.upscales,
    requests,
    publishesBy: c.by,
    // SwiftShader: a cost signal, not a frame rate. See the file header.
    medianFrameMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    gestureSeconds: +(raf.reduce((s, d) => s + d, 0) / 1000).toFixed(1),
  }
}

/** A pan of `frames` frames, each moving the view east by `degPerFrame`. */
async function pan(label, degPerFrame, frames) {
  await settle()
  const span = await page.evaluate(() => {
    const b = window.__detail.want.target
    return b.maxLng - b.minLng
  })
  await page.evaluate(
    ([step, frames]) =>
      new Promise((done) => {
        const g = window.__globe
        const p = g.pointOfView()
        let i = 0
        const tick = () => {
          if (i++ >= frames) return done()
          g.pointOfView({ ...p, lng: p.lng + step * i })
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    [degPerFrame, frames],
  )
  const during = await harvest({
    label,
    degPerFrame,
    frames,
    spanFraction: +(degPerFrame / span).toFixed(5),
  })
  // Deferring publishes may not strand the screen: the gesture ends, and the
  // picture has to arrive. Virtual milliseconds from the last pan frame to the
  // publish that follows it — the settle's own promise, kept.
  const settleMs = await page.evaluate(() => {
    const had = window.__c.publishes
    const t0 = Date.now()
    return new Promise((done) => {
      const poll = () => {
        if (window.__c.publishes > had) return done(Date.now() - t0)
        if (Date.now() - t0 > 5000) return done(-1)
        setTimeout(poll, 4)
      }
      poll()
    })
  })
  await page.screenshot({ path: join(SHOTS, `${TAG}-${label}.png`) })
  await page.evaluate(() => (window.__lastPublishVt = Date.now()))
  await quiesce()
  return { ...during, settleAfterGestureMs: settleMs }
}

/**
 * How long a parked camera waits for its first picture.
 *
 * The deferral may not buy smoothness with a blank globe: a camera that arrives
 * somewhere new and stops must publish on the settle path as promptly as it
 * ever did. Virtual milliseconds from the jump to the first publish after it —
 * the same clock the deadline in `arm` is written against.
 */
async function firstPicture(lat, lng) {
  await pov({ lat, lng, altitude: 4 })
  await page.evaluate(() => (window.__lastPublishVt = Date.now()))
  await quiesce()
  await page.evaluate(() => window.__reset())
  return page.evaluate(
    ([lat, lng]) =>
      new Promise((done) => {
        const t0 = Date.now()
        window.__globe.pointOfView({ lat, lng, altitude: 0.02 }, 0)
        const poll = () => {
          if (window.__c.publishes > 0) return done(Date.now() - t0)
          if (Date.now() - t0 > 30000) return done(-1)
          setTimeout(poll, 4)
        }
        poll()
      }),
    [lat, lng],
  )
}

const report = { tag: TAG, runs: [] }
// 0.02 deg/frame is the reported "very slow" drag; the others bracket it.
// `subEps` is below what an integrated 0.002 per SETTLE_MS can see at all
// (~0.07 mouse px per frame): the honest edge of the new detector.
report.runs.push(await pan('subEps', 0.0002, 150))
report.runs.push(await pan('creep', 0.0004, 150))
report.runs.push(await pan('crawl', 0.005, 150))
report.runs.push(await pan('slow', 0.02, 150))
report.runs.push(await pan('rapid', 0.2, 150))
report.firstPictureMs = [await firstPicture(35.7, 139.7), await firstPicture(-23.5, -46.6)]

console.log(JSON.stringify(report, null, 1))
writeFileSync(`/tmp/slowpan-${TAG}.json`, JSON.stringify(report, null, 1))

await browser.close()
await server.close()
