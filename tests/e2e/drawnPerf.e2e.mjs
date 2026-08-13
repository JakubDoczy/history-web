/**
 * WHAT A DRAWN-MAP GESTURE COSTS, counted as events rather than as milliseconds.
 *
 * The field report is "zooming in the drawn map is incredibly choppy / slow;
 * panning is also not optimal, especially at higher zoom levels". Under
 * SwiftShader a wall-clock answer is worthless — a megapixel upload is inflated
 * roughly tenfold and the surface shader runs at about a megapixel a second —
 * so every number this file reports is a COUNT of something that happens, on a
 * virtual 60 Hz clock, over a camera path driven from inside the page.
 *
 * What is counted, and where it is counted from:
 *
 *   GL, at WebGL2RenderingContext        atlas texSubImage2D calls and bytes,
 *                                        index re-uploads, full-texture uploads,
 *                                        generateMipmap, draw calls — per frame.
 *   The worker, at `Worker.prototype`    tile requests posted, bitmaps
 *                                        transferred back, queue depth over
 *                                        time, worker render ms.
 *   The pipeline, at its own prototypes  `update`, `pin`, `pump`, `absorb`,
 *                                        `reindex` and `TileAtlas.put` are
 *                                        wrapped and timed, so "what runs on the
 *                                        main thread during a zoom frame" is
 *                                        attributed rather than guessed.
 *   The main thread, at PerformanceObserver  longtask count and duration.
 *   The caches, by snapshot per frame    decoded-tile keys and atlas slot keys,
 *                                        so eviction (including satellite tiles
 *                                        evicted by drawn ones) is a difference
 *                                        of sets rather than an inference.
 *
 * From those, the two numbers the round is actually about:
 *
 *   rendered-per-level    how many tiles the worker draws for each pyramid level
 *                         a zoom passes through, and
 *   wasted                how many of them never reach a frame the reader sees —
 *                         rendered, or even uploaded, for a level the camera had
 *                         already left.
 *
 * Run:  node tests/e2e/drawnPerf.e2e.mjs
 * Env:  TAG                label on /tmp/drawnperf-$TAG.json
 *       CHROME_PATH        Chromium executable
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 */
import { createServer } from 'vite'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const TAG = process.env.TAG ?? 'before'

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
const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 })

/** Everything below runs before the app's first line, so nothing escapes it. */
await ctx.addInitScript(() => {
  // ---------------------------------------------------------------- GL hooks
  const G = WebGL2RenderingContext.prototype
  const sized = new WeakMap()
  let bound2d = null
  const fresh = () => ({
    atlasBytes: 0,
    atlasCalls: 0,
    lowCalls: 0,
    indexCalls: 0,
    otherBytes: 0,
    bigUploads: 0,
    mips: 0,
    draws: 0,
    // filled by the beat, from the app's own state
    reqs: 0,
    resps: 0,
    depth: 0,
  })
  const gl = { frame: fresh(), frames: [], on: false }
  window.__gl = gl

  const px = (a, from) => {
    if (a.length >= 9) return a[from] * a[from + 1]
    const src = a[a.length - 1]
    return src && src.width ? src.width * src.height : 0
  }
  const chan = (f) => ({ 6403: 1, 33319: 2, 6407: 3, 6408: 4 })[f] ?? 4
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
    sized.set(bound2d, { w: a[3], h: a[4] })
  })
  wrap('texImage2D', function (a) {
    const n = px(a, 3)
    if (a.length >= 9) sized.set(bound2d, { w: a[3], h: a[4] })
    if (!gl.on) return
    const w = which()
    if (w === 'index') gl.frame.indexCalls++
    if (a[a.length - 1] && n >= 1e6) {
      gl.frame.bigUploads++
      gl.frame.otherBytes += n * chan(a.length >= 9 ? a[6] : a[3])
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
      if (w === 'atlas') gl.frame.atlasCalls++
      else if (w === 'atlasLow') gl.frame.lowCalls++
      else gl.frame.indexCalls++
    }
    if (n >= 1e6) gl.frame.bigUploads++
  })
  wrap('generateMipmap', function () {
    if (gl.on) gl.frame.mips++
  })
  for (const n of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    wrap(n, () => {
      if (gl.on) gl.frame.draws++
    })
  }

  // ------------------------------------------------------------ worker hooks
  // The drawn source's messages, both ways. Nothing here changes a message; it
  // is a tap on the wire between the scheduler and the rasterizer.
  //
  // ROUND 58 adds the clock to this tap, and it is the only wall-clock number
  // this file trusts. Every OTHER measurement here is a count, because
  // SwiftShader inflates GL time — but the wire between the scheduler and the
  // rasterizer has no GL on it. What a request spends there is
  //
  //     latency  =  the render the worker reports  +  WAIT
  //
  // and `wait` is time the request sat in the worker's message queue behind
  // something else. That is the number that convicts a stall: a worker that is
  // parsing 3.3 MB of TopoJSON cannot answer a tile, and the tiles it cannot
  // answer are the ones the reader is zooming through.
  const W = {
    reqs: 0,
    resps: 0,
    bitmaps: 0,
    depth: 0,
    maxDepth: 0,
    ms: 0,
    byZ: {},
    keys: [],
    /** Render ms and queue-wait ms, per level, as samples. */
    msByZ: {},
    waitByZ: {},
    queueByZ: {},
    /** Gaps between consecutive answers while the queue was NOT empty. */
    gaps: [],
    /** `{t, stage}` for each upgrade announcement — 50m, then 10m. */
    upgrades: [],
    /** Requests posted while the worker owed an answer it had not sent. */
    lastResp: 0,
    t0: 0,
  }
  window.__worker = W
  const OrigWorker = window.Worker
  const zOf = new Map()
  const sentAt = new Map()
  window.Worker = function (...args) {
    const w = new OrigWorker(...args)
    const post = w.postMessage.bind(w)
    w.postMessage = (msg, transfer) => {
      if (msg && typeof msg.z === 'number') {
        W.reqs++
        W.depth++
        W.maxDepth = Math.max(W.maxDepth, W.depth)
        zOf.set(msg.id, msg)
        // Epoch, not `performance.now`: it is compared against the worker's own
        // stamp (`DrawnTileResponse.at`) and the two contexts have different
        // time origins. `Date.now` is virtualised in this file and cannot be
        // used for a wall-clock question at all.
        sentAt.set(msg.id, performance.timeOrigin + performance.now())
      }
      return post(msg, transfer)
    }
    w.addEventListener('message', (e) => {
      const d = e.data
      const now = performance.now()
      if (!d) return
      if (d.upgraded) {
        W.upgrades.push({ t: +(now - W.t0).toFixed(1), stage: d.upgraded, ms: d.ms || 0 })
        return
      }
      // A gap is only a gap if somebody was waiting: the interval between two
      // answers with an empty queue in between is the reader looking at a
      // finished picture, which is not a stall.
      if (W.depth > 0 && W.lastResp) {
        W.gaps.push({
          ms: +(now - W.lastResp).toFixed(1),
          t: +(now - W.t0).toFixed(1),
          queued: W.depth,
        })
      }
      W.lastResp = now
      W.resps++
      W.depth = Math.max(0, W.depth - 1)
      if (d.bitmap) W.bitmaps++
      W.ms += d.ms || 0
      const req = zOf.get(d.id)
      const sent = sentAt.get(d.id)
      zOf.delete(d.id)
      sentAt.delete(d.id)
      if (!req) return
      W.byZ[req.z] = (W.byZ[req.z] || 0) + 1
      ;(W.msByZ[req.z] ??= []).push(+(d.ms || 0).toFixed(2))
      // TWO WAITS, and the difference between them is the point.
      //
      //   queue — from the post to the moment the WORKER picked the message up
      //           (`d.at`). Nothing but the worker's own event loop is in it,
      //           so a number here is the rasterizer being unable to answer.
      //   wait  — the same interval plus delivery back to a main thread that,
      //           under SwiftShader, is often inside a multi-second GL call.
      //           Kept because it is what round 57's harness could see, and
      //           discarded as evidence for exactly that reason.
      if (sent) {
        const epoch = performance.timeOrigin + now
        ;(W.waitByZ[req.z] ??= []).push(+(epoch - sent - (d.ms || 0)).toFixed(1))
        if (d.at) (W.queueByZ[req.z] ??= []).push(+Math.max(0, d.at - sent).toFixed(1))
      }
      W.keys.push(`${req.z}/${req.x}/${req.y}`)
    })
    return w
  }
  window.Worker.prototype = OrigWorker.prototype

  // ------------------------------------------------------------- long tasks
  const LT = { count: 0, total: 0, max: 0 }
  window.__longtasks = LT
  try {
    new PerformanceObserver((list) => {
      if (!gl.on) return
      for (const e of list.getEntries()) {
        LT.count++
        LT.total += e.duration
        LT.max = Math.max(LT.max, e.duration)
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch {
    /* no longtask support: the count stays zero and says so */
  }

  // -------------------------------------------- the virtual clock and a beat
  let vt = Date.now()
  Date.now = () => vt
  window.__vt = () => vt
  let last = 0
  const beat = (t) => {
    vt += 16
    if (gl.on) {
      gl.frame.ms = last ? +(t - last).toFixed(1) : 0
      gl.frame.reqs = W.reqs
      gl.frame.resps = W.resps
      gl.frame.depth = W.depth
      // Wall time since the run began, so a stall in the answer stream can be
      // put beside the frame the camera was on when it happened.
      gl.frame.t = +(t - W.t0).toFixed(1)
      window.__sample?.(gl.frame)
      gl.frames.push(gl.frame)
      gl.frame = fresh()
    }
    last = t
    requestAnimationFrame(beat)
  }
  requestAnimationFrame(beat)
  window.__glStart = () => {
    gl.frames = []
    gl.frame = fresh()
    gl.on = true
  }
  window.__glStop = () => {
    gl.on = false
    return { frames: gl.frames.slice() }
  }
})

const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGE ERR', e.message))

await page.goto(base, { timeout: 120_000 })
await page.waitForFunction(() => !!window.__globe && !!window.__detail, null, { timeout: 60_000 })
await page.evaluate(() => window.__settings.setMode('schematic'))
await page.evaluate(() => window.__setTime(1941))
// The worker fetches and parses the vector data on its FIRST tile request, so
// the geometry only loads once the camera is inside streaming range at all.
// The 50m stage has to have landed before anything is measured, or the source
// label changes mid-run and every cache key with it.
await page.evaluate(() => window.__globe.pointOfView({ lat: 46.2, lng: 8.0, altitude: 0.3 }))
await page.waitForFunction(() => window.__drawn?.source?.label?.includes('50m'), null, {
  timeout: 180_000,
})
// the deferred base maps, the cloud upscale and the drawn world texture all
// upload once on their own schedule; none of it is the streamer
await page.waitForTimeout(15000)

/**
 * Attribution: wrap the pipeline's own methods so main-thread time inside a
 * zoom frame has a name on it.
 *
 * Prototype wrapping, applied to the live objects' classes, so a wrapped method
 * calls exactly the method it replaced. Nothing is reordered and nothing is
 * skipped: this only measures.
 */
await page.evaluate(() => {
  const M = {}
  window.__mt = M
  const time = (obj, name, label) => {
    const proto = Object.getPrototypeOf(obj)
    const inner = proto[name]
    if (typeof inner !== 'function') return
    M[label] = { calls: 0, ms: 0, max: 0, samples: [] }
    proto[name] = function (...a) {
      const t0 = performance.now()
      try {
        return inner.apply(this, a)
      } finally {
        const d = performance.now() - t0
        M[label].calls++
        M[label].ms += d
        M[label].max = Math.max(M[label].max, d)
        // Kept so the report can quote a MEDIAN. Under SwiftShader a single
        // 512 upload can stall for seconds when the machine is busy, and a
        // total or a maximum then describes the machine rather than the code.
        M[label].samples.push(d)
      }
    }
  }
  const d = window.__detail
  // `pump`, `absorb`, `reindex` and `pin` are called from inside `update`, so
  // `update` is the sum and the others are its parts.
  for (const n of ['update', 'pin', 'pump', 'absorb', 'reindex']) time(d, n, n)
  time(d.atlas, 'put', 'atlas.put')
  time(d.atlas, 'reduce', 'atlas.reduce')
  time(d.atlas, 'blit', 'atlas.blit')
  window.__mtReset = () => {
    for (const k of Object.keys(M)) M[k] = { calls: 0, ms: 0, max: 0, samples: [] }
    const W = window.__worker
    W.reqs = W.resps = W.bitmaps = W.ms = W.maxDepth = 0
    W.byZ = {}
    W.keys = []
    W.msByZ = {}
    W.waitByZ = {}
    W.queueByZ = {}
    W.gaps = []
    W.upgrades = []
    W.lastResp = 0
    W.t0 = performance.now()
    const L = window.__longtasks
    L.count = L.total = L.max = 0
  }

  /**
   * Per-frame snapshots of what is held where, so eviction is a difference of
   * sets. Both maps are small (a few hundred keys, at most 64 slots).
   */
  const S = {
    cacheAdds: new Set(),
    cacheEvicts: 0,
    evictByLabel: {},
    slotWrites: 0,
    slotEvicts: 0,
    everSlotted: new Set(),
    everCached: new Set(),
    zSeq: [],
    lastCache: new Set(),
    lastSlots: new Set(),
    firstSeen: new Map(),
  }
  window.__snap = S
  window.__sample = (frame) => {
    const det = window.__detail
    const cache = det.tiles?.held
    const slots = det.atlas?.slots?.held
    if (cache) {
      const now = new Set(cache.keys())
      for (const k of now)
        if (!S.lastCache.has(k)) {
          S.cacheAdds.add(k)
          S.everCached.add(k)
        }
      for (const k of S.lastCache)
        if (!now.has(k)) {
          S.cacheEvicts++
          const label = k.split('/').slice(3).join('/')
          S.evictByLabel[label] = (S.evictByLabel[label] || 0) + 1
        }
      S.lastCache = now
      frame.cacheSize = now.size
    }
    if (slots) {
      const now = new Set(slots.keys())
      for (const k of now)
        if (!S.lastSlots.has(k)) {
          S.slotWrites++
          S.everSlotted.add(k)
        }
      for (const k of S.lastSlots) if (!now.has(k)) S.slotEvicts++
      S.lastSlots = now
      frame.slots = now.size
    }
    const idx = det.index
    frame.z = idx?.z ?? 0
    frame.resident = idx?.resident ?? 0
    S.zSeq.push(frame.z)
  }
  window.__snapReset = () => {
    S.cacheAdds = new Set()
    S.cacheEvicts = 0
    S.evictByLabel = {}
    S.slotWrites = 0
    S.slotEvicts = 0
    S.everSlotted = new Set()
    S.everCached = new Set()
    S.zSeq = []
    S.firstSeen = new Map()
  }
})

const pov = (p, ms = 0) => page.evaluate(([p, ms]) => window.__globe.pointOfView(p, ms), [p, ms])

/**
 * Wait for a fixed point, and `still` is part of what fixes it.
 *
 * Nothing on the wire and nothing fading is not the same as settled: the
 * pipeline's own clock is `Date.now`, which this harness advances 16 ms per
 * animation frame, so the 280 ms settle takes eighteen frames of virtual time
 * however fast the wall clock runs. A check that only asked about the queues
 * returned before the settle had happened and measured the next gesture from a
 * mid-gesture state — which is exactly the state a reader never sees.
 */
const quiesce = async (tries = 60) => {
  let calm = 0
  for (let i = 0; i < tries; i++) {
    const state = await page.evaluate(() => ({
      busy: window.__detail.animating === true || window.__worker.depth > 0,
      still: window.__detail.still === true,
    }))
    calm = !state.busy && state.still ? calm + 1 : 0
    if (calm >= 2) return
    await page.waitForTimeout(400)
  }
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
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    [fn, arg],
  )

/** p-th of a sample, sorted here so the caller may hand it in any order. */
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2) : 0
}

/**
 * What each pyramid level cost, and how much of that cost was WAITING.
 *
 * The median render is the tile; the median wait is the queue in front of it.
 * They are reported side by side because the round is about the second one:
 * a tile that draws in 0.4 ms and lands 900 ms after it was asked for did not
 * get slower, it got stuck behind something.
 */
const perLevel = (worker) =>
  Object.fromEntries(
    Object.keys(worker.byZ)
      .sort((a, b) => a - b)
      .map((z) => [
        z,
        {
          n: worker.byZ[z],
          renderMed: pct(worker.msByZ[z] ?? [], 0.5),
          renderP95: pct(worker.msByZ[z] ?? [], 0.95),
          waitMed: pct(worker.waitByZ[z] ?? [], 0.5),
          waitMax: Math.max(0, ...(worker.waitByZ[z] ?? [])),
          queueMed: pct(worker.queueByZ[z] ?? [], 0.5),
          queueMax: Math.max(0, ...(worker.queueByZ[z] ?? [])),
        },
      ]),
  )

const summarise = (label, out, extra) => {
  const f = out.frames.filter((x) => x.ms > 0)
  const ms = f.map((x) => x.ms).sort((a, b) => a - b)
  const at = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] ?? 0
  const sum = (k) => f.reduce((s, x) => s + (x[k] || 0), 0)
  const zs = f.map((x) => x.z).filter(Boolean)
  const gaps = extra.worker.gaps
  const worst = gaps.reduce((a, b) => (b.ms > (a?.ms ?? 0) ? b : a), null)
  return {
    label,
    frames: f.length,
    levelsCrossed: [...new Set(zs)].sort((a, b) => a - b),
    levelChanges: zs.filter((z, i) => i && z !== zs[i - 1]).length,
    workerReqs: extra.worker.reqs,
    workerResps: extra.worker.resps,
    workerBitmaps: extra.worker.bitmaps,
    workerMaxQueue: extra.worker.maxDepth,
    workerRenderMs: +extra.worker.ms.toFixed(1),
    renderedByZ: extra.worker.byZ,
    /** Per level: how long a tile took to draw, and how long it waited first. */
    byLevel: perLevel(extra.worker),
    /**
     * THE STALL. Longest interval between two answers with the queue not empty,
     * how deep the queue was when it broke, and how much of the run's whole
     * answer stream those gaps account for.
     */
    worstGapMs: worst?.ms ?? 0,
    worstGapAtMs: worst?.t ?? 0,
    worstGapQueued: worst?.queued ?? 0,
    gapsOver100ms: gaps.filter((g) => g.ms > 100).length,
    gapMsOver100: +gaps.filter((g) => g.ms > 100).reduce((s, g) => s + g.ms, 0).toFixed(1),
    /** When each finer file announced itself, relative to the run's start. */
    upgrades: extra.worker.upgrades,
    atlasCalls: sum('atlasCalls'),
    lowCalls: sum('lowCalls'),
    atlasMB: +(sum('atlasBytes') / 1048576).toFixed(2),
    maxAtlasBytesPerFrame: Math.max(0, ...f.map((x) => x.atlasBytes)),
    indexCalls: sum('indexCalls'),
    fullUploads: sum('bigUploads'),
    generateMipmap: sum('mips'),
    medianDraws: [...f.map((x) => x.draws)].sort((a, b) => a - b)[Math.floor(f.length / 2)] ?? 0,
    slotWrites: extra.snap.slotWrites,
    slotEvicts: extra.snap.slotEvicts,
    cacheAdds: extra.snap.cacheAdds,
    cacheEvicts: extra.snap.cacheEvicts,
    evictByLabel: extra.snap.evictByLabel,
    maxCacheSize: Math.max(0, ...f.map((x) => x.cacheSize || 0)),
    /** Tiles the worker drew that never reached an atlas slot at all. */
    renderedNeverSlotted: extra.wasted,
    mainThread: extra.mt,
    longTasks: extra.lt,
    medianFrameMs: at(0.5),
    p95FrameMs: at(0.95),
    otherMB: +(sum('otherBytes') / 1048576).toFixed(2),
    ...extra.pump,
  }
}

const measure = async (label, body) => {
  await page.evaluate(() => {
    window.__mtReset()
    window.__snapReset()
  })
  const wakes0 = await page.evaluate(() => window.__frameStats())
  await page.evaluate(() => window.__glStart())
  await body()
  const out = await page.evaluate(() => window.__glStop())
  const extra = await page.evaluate(
    (w0) => ({
      worker: {
        reqs: window.__worker.reqs,
        resps: window.__worker.resps,
        bitmaps: window.__worker.bitmaps,
        maxDepth: window.__worker.maxDepth,
        ms: window.__worker.ms,
        byZ: window.__worker.byZ,
        msByZ: window.__worker.msByZ,
        waitByZ: window.__worker.waitByZ,
        queueByZ: window.__worker.queueByZ,
        gaps: window.__worker.gaps,
        upgrades: window.__worker.upgrades,
      },
      snap: {
        slotWrites: window.__snap.slotWrites,
        slotEvicts: window.__snap.slotEvicts,
        cacheAdds: window.__snap.cacheAdds.size,
        cacheEvicts: window.__snap.cacheEvicts,
        evictByLabel: window.__snap.evictByLabel,
      },
      wasted: [...window.__snap.everCached].filter((k) => !window.__snap.everSlotted.has(k)).length,
      mt: Object.fromEntries(
        Object.entries(window.__mt).map(([k, v]) => {
          const s = [...v.samples].sort((a, b) => a - b)
          const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0
          return [
            k,
            {
              calls: v.calls,
              ms: +v.ms.toFixed(1),
              median: +at(0.5).toFixed(3),
              p95: +at(0.95).toFixed(3),
              max: +v.max.toFixed(2),
            },
          ]
        }),
      ),
      lt: { ...window.__longtasks, total: +window.__longtasks.total.toFixed(1) },
      // The pump's own ledger. `resumes` is the one that can hide a second
      // full-screen pass inside a frame: `onResume` calls `resumeAnimation`,
      // which renders SYNCHRONOUSLY, so a park-and-wake cycle inside one
      // animation frame draws the scene twice.
      pump: {
        wakes: window.__frameStats().wakes - w0.wakes,
        resumes: window.__frameStats().resumes - w0.resumes,
        pauses: window.__frameStats().pauses - w0.pauses,
      },
    }),
    wakes0,
  )
  return summarise(label, out, extra)
}

const report = { tag: TAG, runs: [] }
const HOME = { lat: 46.2, lng: 8.0 }
/** A coast far from HOME, so the cold run leaves the pan's tiles uncached. */
const COAST = { lat: 61.3, lng: 6.0 }

/**
 * THE ZOOM FLOOR, measured rather than assumed.
 *
 * Round 57 took `DRAWN_Z_MAX` from 9 to 11, so the old script's 0.025 (level 8
 * here) no longer reaches the bottom of the pyramid and a zoom that stops there
 * stops measuring exactly the levels the round added. The camera's own floor is
 * `MIN_ALTITUDE_DETAIL` — a 100 km view — and this harness runs a 1000×750
 * window at DPR 1, where that floor wants LEVEL 10. A 2× desktop wants 11 out
 * of the same altitude; the levels crossed are reported, not assumed, so the
 * table says which ones this machine actually saw.
 */
const FLOOR_ALT = 0.0035

/**
 * PROBE_ONLY — the mechanism without the gesture. See `probe` at the foot.
 *
 * The four scripted runs below cost half an hour of wall time under
 * SwiftShader; the probe costs a minute and answers the one question this round
 * turned on. Both are kept: the runs say what a gesture costs in counts, the
 * probe says what a tile waits for in milliseconds.
 */
const GESTURES = !process.env.PROBE_ONLY

if (GESTURES) {
/**
 * RUN 0 — THE COLD ZOOM, which is the run the field report is about.
 *
 * "Map mode is slow again, especially when zooming in." The three runs below it
 * are round 54's and they all start from a world whose geometry is fully
 * parsed. That is not the state a reader is in the first time they zoom to a
 * coast: crossing level 7 is what asks for the 3.3 MB 10m file (`requestFine`),
 * and whatever that costs is paid in the middle of the gesture that triggered
 * it. So the first thing measured is a zoom from the world to the floor at a
 * coast nobody has looked at yet, and the numbers to read out of it are
 * `worstGapMs` (the longest the rasterizer went without answering while tiles
 * were queued) and `byLevel[…].waitMed`.
 *
 * It is measured at COAST rather than at HOME so that the pan below still
 * starts from a cache that has never held its own tiles.
 */
const ZOOM_COLD = `
  if (i >= 90) return false
  g.pointOfView({ lat: arg.lat, lng: arg.lng, altitude: 2.4 * Math.pow(arg.to / 2.4, i / 89) })
  return true
`
await pov({ ...COAST, altitude: 2.4 })
await quiesce()
report.runs.push(
  await measure('cold zoom world->floor (first 10m rung)', () =>
    scripted(ZOOM_COLD, { ...COAST, to: FLOOR_ALT }),
  ),
)
// …and then let the rung finish arriving, so everything below is measured
// against a fully parsed world — which is what round 54's table assumed.
await page
  .waitForFunction(() => /10m/.test(window.__detail.sourceLabel), null, { timeout: 240_000 })
  .catch(() => console.log('      NOTE: the 10m label never arrived'))
await quiesce()
report.afterCold = await page.evaluate(() => ({
  label: window.__detail.sourceLabel,
  z: window.__detail.index?.z ?? null,
  resident: window.__detail.index?.resident ?? null,
}))

/**
 * THE PAN FIRST, and that ordering is a measurement rather than a preference.
 *
 * A pan is cheap or expensive depending on what is already in the decoded
 * cache, and what is in the cache depends on whatever ran before it. Measured
 * with the pan after the zoom, the OLD build's pan looked cheaper — because the
 * zoom before it had speculatively drawn 240 tiles, which is precisely the
 * waste this round removes. Panning from a state both builds reach the same way
 * (one jump to the altitude, then settled) is the only way the two numbers are
 * about panning.
 */
const PAN = `
  if (i >= 120) return false
  g.pointOfView({ lat: arg.lat, lng: arg.lng + 0.03 * i, altitude: 0.028 })
  return true
`
await pov({ ...HOME, altitude: 0.028 })
await quiesce()
report.beforePan = await page.evaluate(() => ({
  z: window.__detail.index?.z ?? null,
  resident: window.__detail.index?.resident ?? null,
  slots: window.__detail.atlas.slots.size,
}))
report.runs.push(await measure('pan z9', () => scripted(PAN, HOME)))

// --- the scripted zoom: world view down to level 9 over ~90 frames ----------
// The altitudes bracket the whole streaming range: 2.4 is outside it entirely,
// 0.025 is level 9, and the geometric step is well inside globe.gl's own
// per-event zoom floor so every frame's request lands.
const ZOOM = `
  if (i >= 90) return false
  g.pointOfView({ lat: arg.lat, lng: arg.lng, altitude: 2.4 * Math.pow(arg.to / 2.4, i / 89) })
  return true
`
await pov({ ...HOME, altitude: 2.4 })
await quiesce()
report.runs.push(
  await measure('warm zoom world->floor', () => scripted(ZOOM, { ...HOME, to: FLOOR_ALT })),
)
await quiesce()
report.zoomed = await page.evaluate(() => ({
  altitude: window.__globe.pointOfView().altitude,
  z: window.__detail.index?.z ?? null,
  resident: window.__detail.index?.resident ?? null,
  wanted: (window.__detail.want?.plan?.level?.length ?? 0) + (window.__detail.want?.plan?.fallback?.length ?? 0),
  slots: window.__detail.atlas.slots.size,
  writes: window.__detail.atlas.writes,
}))

// --- a zoom back out, which is where a re-render of evicted coarse levels
//     would show ------------------------------------------------------------
const OUT = `
  if (i >= 90) return false
  g.pointOfView({ lat: arg.lat, lng: arg.lng, altitude: arg.from * Math.pow(2.4 / arg.from, i / 89) })
  return true
`
await pov({ ...HOME, altitude: FLOOR_ALT })
await quiesce()
report.runs.push(
  await measure('zoom out floor->world', () => scripted(OUT, { ...HOME, from: FLOOR_ALT })),
)

// --- rest: nothing should be happening at all -------------------------------
await pov({ ...HOME, altitude: 0.3 })
await quiesce()
report.runs.push(
  await measure('rest', async () => {
    await page.waitForTimeout(2000)
  }),
)
report.rested = await page.evaluate(() => ({
  z: window.__detail.index?.z ?? null,
  resident: window.__detail.index?.resident ?? null,
  wanted: (window.__detail.want?.plan?.level?.length ?? 0) + (window.__detail.want?.plan?.fallback?.length ?? 0),
}))
}

/* ------------------------------------------------ the probe, and why it exists
 *
 * THE GESTURE RUNS ABOVE CANNOT SEE A ONE-SECOND STALL, and that is a fact
 * about this harness rather than about the build. Under SwiftShader an animated
 * frame of this surface takes on the order of a second, so a scripted 90-frame
 * zoom lasts a minute and a half of wall time while asking for a hundred tiles
 * — one every second. A decode that blocks the rasterizer for a second
 * therefore delays about one tile, and the queue-wait column stays flat. In a
 * browser with a GPU the same gesture is 1.5 seconds and asks for the same
 * hundred tiles, so the same decode blocks the WHOLE gesture. Scaling frames
 * and leaving the decode at its true cost is precisely the distortion the
 * round-54 note warns about, and it is why that harness counts events.
 *
 * So the mechanism is measured directly instead, on a freshly loaded page that
 * has never asked for the rung: request tiles at the fine level at a steady
 * cadence, trigger the rung with the first of them, and record what each tile
 * WAITED in the worker's queue (`DrawnTileResponse.at`, which is stamped when
 * the worker picks the message up). Nothing here draws a frame, so nothing here
 * is inflated by the software rasteriser — and the question "can this worker
 * answer a tile while the 10m file is being parsed" is answered by the worker
 * itself.
 */
/** When the 3.3 MB file was asked for and when it finished, off the wire. */
const fineNet = { asked: 0, done: 0 }
page.on('request', (r) => {
  if (r.url().includes('land-10m.json')) fineNet.asked = Date.now()
})
page.on('requestfinished', (r) => {
  if (r.url().includes('land-10m.json')) fineNet.done = Date.now()
})
await page.reload({ timeout: 120_000 })
await page.waitForFunction(() => !!window.__globe && !!window.__detail, null, { timeout: 60_000 })
await page.evaluate(() => window.__settings.setMode('schematic'))
await page.evaluate(() => window.__setTime(1941))
// Level 6: streaming, so the source exists and the 50m stage lands — and
// coarser than the rung, so nothing has asked for it.
await page.evaluate(() => window.__globe.pointOfView({ lat: 61.3, lng: 6.0, altitude: 0.3 }))
await page.waitForFunction(() => window.__drawn?.source?.label?.includes('50m'), null, {
  timeout: 180_000,
})
report.probe = await page.evaluate(async () => {
  const d = window.__drawn
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const y0 = Math.floor(((90 - 61.5) / 180) * 2 ** 6)
  const x0 = Math.floor(((6 + 180) / 360) * 2 ** 7)
  const from = d.waits.length
  const t0 = performance.now()
  let landed = 0
  // One tile every 100 ms — a tenth of what a real zoom asks for — until the
  // rung has landed, or twenty seconds have passed and it never will.
  for (let i = 0; i < 200; i++) {
    void d.source.render({ z: 7, x: x0 + (i % 8), y: y0 + ((i >> 3) % 4) }).catch(() => {})
    await sleep(100)
    if (!landed && /10m/.test(d.source.label)) {
      landed = performance.now() - t0
      // …and a second of cadence past the swap, because a rung that lands and
      // then blocks the worker while it is installed is the same defect.
      if (i < 190) i = 190
    }
  }
  await sleep(500)
  const waits = d.waits.slice(from)
  const s = [...waits].sort((a, b) => a - b)
  const at = (p) => +(s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0).toFixed(1)
  return {
    tiles: waits.length,
    label: d.source.label,
    rungLandedMs: +landed.toFixed(0),
    waitMed: at(0.5),
    waitP95: at(0.95),
    waitMax: +Math.max(0, ...waits).toFixed(1),
    over200ms: waits.filter((w) => w > 200).length,
    lostMs: +waits.filter((w) => w > 200).reduce((a, b) => a + b, 0).toFixed(0),
    renderMed: (() => {
      const r = [...d.times].sort((a, b) => a - b)
      return +(r[r.length >> 1] ?? 0).toFixed(2)
    })(),
    /** Absent on a build that decodes the rung on the render thread. */
    decodeMs: d.fineDecodeMs ? +d.fineDecodeMs.toFixed(0) : null,
  }
})
report.probe.fetchMs = fineNet.done && fineNet.asked ? fineNet.done - fineNet.asked : null

console.log(JSON.stringify(report, null, 1))
writeFileSync(`/tmp/drawnperf-${TAG}.json`, JSON.stringify(report, null, 1))

/** The one-screen reading of it, in the order the round argues from. */
console.log(`\n=== ${TAG} ===`)
for (const r of report.runs) {
  console.log(
    `\n${r.label}\n  levels ${r.levelsCrossed.join(',')}  renders ${r.workerReqs}` +
      ` (never slotted ${r.renderedNeverSlotted})  uploads ${r.atlasCalls}+${r.lowCalls}` +
      `  ${r.atlasMB} MB  maxQueue ${r.workerMaxQueue}\n` +
      `  worst answer gap ${r.worstGapMs} ms at t=${r.worstGapAtMs} with ${r.worstGapQueued} queued;` +
      ` ${r.gapsOver100ms} gaps > 100 ms totalling ${r.gapMsOver100} ms\n` +
      `  upgrades ${JSON.stringify(r.upgrades)}\n` +
      `  per level ${JSON.stringify(r.byLevel)}`,
  )
}
console.log(`\nthe probe — what a tile waited for while the rung arrived\n  ${JSON.stringify(report.probe)}`)

await browser.close()
await server.close()
