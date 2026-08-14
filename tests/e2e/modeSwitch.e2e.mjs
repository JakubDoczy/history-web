/**
 * WHAT THE TOGGLE COSTS — the stagger at the moment map mode is entered.
 *
 * `drawnPerf.e2e.mjs` measures a GESTURE inside drawn mode and `framePerf.e2e.mjs`
 * measures a resting or panning FRAME in either mode. Neither can see the thing
 * the field reported after round 60 — *"switching to it is slow / staggers"* —
 * because both of them arrive at map mode by setting the mode and then waiting
 * for the page to go quiet, which is precisely the interval being complained
 * about, discarded as setup.
 *
 * So this file measures the interval itself, and it measures it three times,
 * because the switch is three different events wearing one name:
 *
 *   cold    the first switch of a session. The rasterizer worker does not
 *           exist, the vector data is not downloaded, the drawn world texture
 *           is not decoded, and no program the drawn surface uses has been
 *           linked.
 *   back    schematic → realistic, which is the same watchers running the other
 *           way and should cost almost nothing.
 *   warm    the second (and every later) switch into map mode. Everything the
 *           cold switch paid for is resident; whatever is left is per-switch
 *           cost, and is what a reader who toggles twice actually feels.
 *   hover   a cold switch on a page where the pointer reached the control
 *           first — round 61's prewarm signal. On a build without one it is a
 *           cold switch with a pause in front of it, which is the control.
 *
 * WHAT IS RECORDED, and how much of it to believe:
 *
 *   longtasks       {t, ms} for every main-thread block over 50 ms, stamped
 *                   against the toggle. This is the stagger, definitionally: a
 *                   frame cannot be produced while one is running. Main-thread
 *                   JS is the one thing SwiftShader does not inflate — EXCEPT
 *                   where a GL call is inside the task, which is why the GL
 *                   timeline below is recorded separately and subtracted in the
 *                   reading rather than in the number.
 *   gl              every texImage2D / texSubImage2D / generateMipmap /
 *                   compileShader / linkProgram, with size, bytes, and the ms
 *                   the call itself took. Sizes name the call: 4096x2048 is a
 *                   base texture, 512 is an atlas slot, 64 the reduced tap, 16
 *                   the index. Under SwiftShader an upload is memory bandwidth
 *                   and a draw is a rasteriser, so upload ms is inflated by
 *                   little and draw ms by a lot; NO draw time is reported here.
 *   frames          rAF gaps across the switch. Inflated wall clock, reported
 *                   only as a same-machine A/B and never as a budget.
 *   worker          tile requests and answers, so a switch that asks for a
 *                   screenful at once is visible as a burst rather than
 *                   inferred.
 *   settle          the last atlas upload before the picture goes quiet — i.e.
 *                   when the drawn map is actually finished — and the first,
 *                   which is when it starts to appear.
 *
 * The reported figure for every run is the MEDIAN over `RUNS` page loads.
 * A mean is useless here: this sandbox is two cores running a software
 * rasteriser and a preempted sample is worth ten of everything else (round 58's
 * note on the 8 ms budget, which is the same trap).
 *
 * Run:  node tests/e2e/modeSwitch.e2e.mjs
 * Env:  TAG                label on /tmp/modeswitch-$TAG.json
 *       RUNS               page loads to take the median over (default 3)
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
const RUNS = Number(process.env.RUNS ?? 3)
/** Camera altitude the toggle is thrown at. See the note where it is applied. */
const ALT = Number(process.env.ALT ?? 1.0)
/** How long a pointer sits on the control before the click. A slow reach. */
const HOVER_MS = Number(process.env.HOVER_MS ?? 1200)

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

/** Everything below runs before the app's first line, so nothing escapes it. */
const INSTRUMENT = () => {
  const G = WebGL2RenderingContext.prototype
  const sized = new WeakMap()
  let bound2d = null

  const S = {
    on: false,
    t0: 0,
    gl: [],
    longs: [],
    frames: [],
    workers: [],
    reqs: [],
    resps: [],
    compiles: 0,
    links: 0,
    compileMs: 0,
    linkMs: 0,
    linkWaitMs: 0,
    polyCalls: 0,
    polyMs: 0,
    renders: 0,
    renderMs: 0,
  }
  window.__sw = S

  const px = (a, from) => {
    if (a.length >= 9) return a[from] * a[from + 1]
    const src = a[a.length - 1]
    return src && src.width ? src.width * src.height : 0
  }
  const chan = (f) => ({ 6403: 1, 33319: 2, 6407: 3, 6408: 4 })[f] ?? 4
  const dims = (a, from) => {
    if (a.length >= 9) return [a[from], a[from + 1]]
    const src = a[a.length - 1]
    return src && src.width ? [src.width, src.height] : [0, 0]
  }
  /**
   * WHICH map an upload is, straight from the element it is uploading.
   *
   * "A 4096x2048 upload happened" does not say whether the switch fetched the
   * drawn world or re-fetched the photographed one, and those are different
   * defects. three hands the image itself as the last argument, so the file
   * name is right there and nothing has to be inferred from the size.
   */
  const named = (a) => {
    const src = a[a.length - 1]
    const u = src && (src.src || src.currentSrc)
    return u ? String(u).split('/').pop().slice(0, 24) : ''
  }
  const now = () => performance.now()
  /** Time a GL call, and record it if the run is live. */
  const timed = (name, tag) => {
    const inner = G[name]
    if (!inner) return
    G[name] = function (...a) {
      if (!S.on) return inner.apply(this, a)
      const t = now()
      const r = inner.apply(this, a)
      S.gl.push(tag.call(this, a, +(now() - t).toFixed(2), +(t - S.t0).toFixed(1)))
      return r
    }
  }
  const wrap = (name, fn) => {
    const inner = G[name]
    if (!inner) return
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
  timed('texImage2D', function (a, ms, t) {
    const [w, h] = dims(a, 3)
    if (a.length >= 9) sized.set(bound2d, { w, h })
    return { k: 'texImage2D', src: named(a), w, h, mb: +((w * h * chan(a.length >= 9 ? a[6] : a[3])) / 1048576).toFixed(2), ms, t }
  })
  timed('texSubImage2D', function (a, ms, t) {
    const [w, h] = dims(a, 4)
    return { k: 'texSubImage2D', src: named(a), w, h, mb: +((w * h * chan(a.length >= 9 ? a[6] : a[4])) / 1048576).toFixed(2), ms, t }
  })
  timed('generateMipmap', function (a, ms, t) {
    const s = sized.get(bound2d)
    return { k: 'generateMipmap', w: s?.w ?? 0, h: s?.h ?? 0, mb: 0, ms, t }
  })
  timed('compileShader', function (a, ms, t) {
    S.compiles++
    S.compileMs += ms
    return { k: 'compileShader', w: 0, h: 0, mb: 0, ms, t }
  })
  timed('linkProgram', function (a, ms, t) {
    S.links++
    S.linkMs += ms
    return { k: 'linkProgram', w: 0, h: 0, mb: 0, ms, t }
  })
  /**
   * The one that actually stalls: reading LINK_STATUS.
   *
   * A driver with KHR_parallel_shader_compile returns from `linkProgram`
   * immediately and does the work on its own threads; the pipeline stall lands
   * on whoever first asks whether it succeeded. Timing `linkProgram` alone
   * would therefore report zero on exactly the drivers where the cost is real.
   */
  {
    const inner = G.getProgramParameter
    G.getProgramParameter = function (...a) {
      if (!S.on || a[1] !== this.LINK_STATUS) return inner.apply(this, a)
      const t = now()
      const r = inner.apply(this, a)
      const ms = +(now() - t).toFixed(2)
      S.linkWaitMs += ms
      S.gl.push({ k: 'linkStatus', w: 0, h: 0, mb: 0, ms, t: +(t - S.t0).toFixed(1) })
      return r
    }
  }

  /**
   * GEOMETRY CHURN, counted as objects rather than inferred from its symptoms.
   *
   * A layer that REBUILDS rather than updates shows up here and nowhere else:
   * `bufferData` bytes could be an update in place, but a `createBuffer` is a
   * new attribute, and a `createBuffer` with no matching `deleteBuffer` in the
   * same window is a rebuild whose predecessor three has not collected yet.
   */
  const B = { newBuffers: 0, delBuffers: 0, bufCalls: 0, bufBytes: 0 }
  S.buffers = B
  wrap('createBuffer', () => S.on && B.newBuffers++)
  wrap('deleteBuffer', () => S.on && B.delBuffers++)
  for (const n of ['bufferData', 'bufferSubData']) {
    wrap(n, (a) => {
      if (!S.on) return
      B.bufCalls++
      const v = a[1]
      B.bufBytes += typeof v === 'number' ? v : (v?.byteLength ?? 0)
    })
  }

  // ------------------------------------------------------------ worker hooks
  const OrigWorker = window.Worker
  window.Worker = function (...args) {
    const w = new OrigWorker(...args)
    if (S.on) S.workers.push({ t: +(now() - S.t0).toFixed(1), url: String(args[0]).slice(-40) })
    const post = w.postMessage.bind(w)
    w.postMessage = (msg, transfer) => {
      if (S.on && msg && typeof msg.z === 'number')
        S.reqs.push({ t: +(now() - S.t0).toFixed(1), z: msg.z })
      return post(msg, transfer)
    }
    w.addEventListener('message', (e) => {
      if (!S.on || !e.data) return
      if (e.data.upgraded) S.resps.push({ t: +(now() - S.t0).toFixed(1), stage: e.data.upgraded })
      else if (e.data.bitmap) S.resps.push({ t: +(now() - S.t0).toFixed(1), ms: e.data.ms ?? 0 })
    })
    return w
  }
  window.Worker.prototype = OrigWorker.prototype

  /**
   * What the switch had to go and GET, and when it landed.
   *
   * The drawn world texture (391 kB of WebP that decodes to 4096x2048) and the
   * vector files are all fetched lazily, so a cold switch is partly a download.
   * That part is a property of the network, not of this machine, and is
   * reported apart from everything else for exactly that reason.
   */
  S.fetches = []
  try {
    new PerformanceObserver((list) => {
      if (!S.on) return
      for (const e of list.getEntries()) {
        if (!/drawn-world|land-|rivers|lakes|\.worker/.test(e.name)) continue
        S.fetches.push({
          n: e.name.split('/').pop().slice(0, 28),
          t: +(e.startTime - S.t0).toFixed(1),
          ms: +e.duration.toFixed(1),
        })
      }
    }).observe({ entryTypes: ['resource'] })
  } catch {
    /* no resource timing: the list stays empty and says so */
  }

  // ------------------------------------------------------------- long tasks
  try {
    new PerformanceObserver((list) => {
      if (!S.on) return
      for (const e of list.getEntries())
        S.longs.push({ t: +(e.startTime - S.t0).toFixed(1), ms: +e.duration.toFixed(1) })
    }).observe({ entryTypes: ['longtask'] })
  } catch {
    /* no longtask support: the list stays empty and says so */
  }

  // ---------------------------------------------------------------- the run
  let prev = 0
  const beat = (t) => {
    if (S.on) {
      S.frames.push({ t: +(t - S.t0).toFixed(1), gap: prev ? +(t - prev).toFixed(1) : 0 })
      prev = t
    }
    requestAnimationFrame(beat)
  }
  requestAnimationFrame(beat)

  /**
   * Toggle, then watch until the picture stops changing.
   *
   * "Stops changing" is not `DetailImagery.animating`: at the instant of the
   * toggle the backlog is empty and nothing is dissolving, so `animating` is
   * false before a single drawn tile has been asked for. What settles a switch
   * is atlas traffic — the last 512 upload before a quiet window — and the
   * status the pipeline itself publishes.
   */
  window.__switchTo = (mode, quietMs = 2500, floorMs = 6000, capMs = 90000) =>
    new Promise((resolve) => {
      S.gl = []
      S.longs = []
      S.frames = []
      S.workers = []
      S.reqs = []
      S.resps = []
      S.buffers.newBuffers = S.buffers.delBuffers = 0
      S.buffers.bufCalls = S.buffers.bufBytes = 0
      S.polyCalls = 0
      S.polyMs = 0
      S.renderMs = 0
      S.renders = 0
      S.compiles = S.links = 0
      S.compileMs = S.linkMs = S.linkWaitMs = 0
      prev = 0
      S.t0 = performance.now()
      S.on = true
      let seen = 0
      let last = S.t0
      window.__settings.setMode(mode)
      const tick = () => {
        const t = performance.now()
        // ACTIVITY, not frames: the settle has to survive a rasteriser whose
        // frames are a second long, so it is measured in wall time since the
        // last thing that changed the picture — an upload, a compile, a tile
        // still waiting for a slot — rather than in animation frames.
        if (S.gl.length !== seen || window.__detail?.animating === true) last = t
        seen = S.gl.length
        if (t - last < quietMs || t - S.t0 < floorMs) {
          if (t - S.t0 < capMs) return requestAnimationFrame(tick)
        }
        S.on = false
        resolve({
          settledAt: +(last - S.t0).toFixed(1),
          gl: S.gl,
          longs: S.longs,
          frames: S.frames,
          workers: S.workers,
          reqs: S.reqs,
          resps: S.resps,
          fetches: S.fetches,
          polyCalls: S.polyCalls,
          polyMs: +S.polyMs.toFixed(1),
          buffers: { ...S.buffers },
          renders: S.renders,
          renderMs: +S.renderMs.toFixed(1),
          compiles: S.compiles,
          links: S.links,
          compileMs: +S.compileMs.toFixed(1),
          linkMs: +S.linkMs.toFixed(1),
          linkWaitMs: +S.linkWaitMs.toFixed(1),
          status: window.__detail?.status ?? '?',
          label: window.__detail?.sourceLabel ?? '?',
        })
      }
      requestAnimationFrame(tick)
    })
}

const med = (xs) => {
  const s = [...xs].filter((x) => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b)
  return s.length ? +s[s.length >> 1].toFixed(1) : 0
}
const sum = (xs) => +xs.reduce((a, b) => a + b, 0).toFixed(1)

/** Everything one switch came to, from the raw timeline. */
const digest = (raw) => {
  // Classified by SIZE and not by entry point: three uploads a whole texture
  // through `texStorage2D` + a 9-argument `texSubImage2D`, which is the same
  // call an atlas slot arrives through and four thousand times the pixels.
  const up = (g) => g.k === 'texImage2D' || g.k === 'texSubImage2D'
  const atlas = raw.gl.filter((g) => up(g) && g.w === 512 && g.h === 512)
  const lowTap = raw.gl.filter((g) => up(g) && g.w === 64)
  const bigTex = raw.gl.filter((g) => up(g) && g.w * g.h >= 1e6)
  const mips = raw.gl.filter((g) => g.k === 'generateMipmap' && g.w * g.h >= 1e6)
  const longs = raw.longs
  const gaps = raw.frames.map((f) => f.gap).filter((g) => g > 0)
  return {
    // THE STAGGER: the blocks the reader cannot get a frame through.
    longWorstMs: Math.max(0, ...longs.map((l) => l.ms)),
    longTotalMs: sum(longs.map((l) => l.ms)),
    longCount: longs.length,
    longFirst3: longs
      .slice()
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3)
      .map((l) => `${l.ms}ms@${l.t}`),
    // …and the frames it cost, which is inflated wall clock and marked as such.
    frameWorstGapMs: Math.max(0, ...gaps),
    frameMedGapMs: med(gaps),
    frames: raw.frames.length,
    // WHAT WAS DONE, in counts that no rasteriser can inflate.
    bigTexUploads: bigTex.length,
    bigTexMB: sum(bigTex.map((g) => g.mb)),
    bigTexMs: sum(bigTex.map((g) => g.ms)),
    mipCalls: mips.length,
    mipMs: sum(mips.map((g) => g.ms)),
    atlasUploads: atlas.length,
    lowUploads: lowTap.length,
    atlasMs: sum(atlas.map((g) => g.ms)),
    compiles: raw.compiles,
    links: raw.links,
    compileMs: raw.compileMs,
    linkMs: raw.linkMs,
    linkWaitMs: raw.linkWaitMs,
    workersSpawned: raw.workers.length,
    tileReqs: raw.reqs.length,
    tileResps: raw.resps.filter((r) => r.ms !== undefined).length,
    polyCalls: raw.polyCalls,
    polyMs: raw.polyMs,
    buffersMade: raw.buffers.newBuffers,
    buffersFreed: raw.buffers.delBuffers,
    bufferKB: +(raw.buffers.bufBytes / 1024).toFixed(1),
    renders: raw.renders,
    renderMs: raw.renderMs,
    // WHEN: first pixel of the new mode, first tile, last activity of any kind.
    msToBaseTex: bigTex.length ? bigTex[0].t : 0,
    msToFirstTile: atlas.length ? atlas[0].t : 0,
    msToSettled: raw.settledAt,
    fetched: raw.fetches.map((f) => `${f.n}@${f.t}+${f.ms}`),
    bigTexList: bigTex.map((g) => `${g.src || g.w + 'x' + g.h}@${g.t}=${g.ms}ms`),
    status: raw.status,
    label: raw.label,
  }
}

const KEYS = [
  'longWorstMs',
  'longTotalMs',
  'longCount',
  'frameWorstGapMs',
  'frameMedGapMs',
  'frames',
  'bigTexUploads',
  'bigTexMB',
  'bigTexMs',
  'mipCalls',
  'mipMs',
  'atlasUploads',
  'lowUploads',
  'atlasMs',
  'compiles',
  'links',
  'compileMs',
  'linkMs',
  'linkWaitMs',
  'workersSpawned',
  'tileReqs',
  'tileResps',
  'polyCalls',
  'polyMs',
  'buffersMade',
  'buffersFreed',
  'bufferKB',
  'renders',
  'renderMs',
  'msToBaseTex',
  'msToFirstTile',
  'msToSettled',
]

const medianOf = (list) => {
  const out = {}
  for (const k of KEYS) out[k] = med(list.map((d) => d[k]))
  out.runs = list.length
  out.worst3 = list.map((d) => d.longFirst3?.[0] ?? '-')
  return out
}

/** A loaded, settled page with the instrument on it, at the toggle's camera. */
const freshPage = async () => {
  const ctx = await browser.newContext({
    viewport: { width: 1000, height: 750 },
    deviceScaleFactor: 1,
  })
  await ctx.addInitScript(INSTRUMENT)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('PAGE ERR', e.message))
  await page.goto(base, { timeout: 120_000 })
  await page.waitForFunction(() => !!window.__globe && !!window.__detail, null, { timeout: 120_000 })
  await page.evaluate(() => window.__setTime(1941))
  /**
   * Two hooks that need live objects, so they cannot live in the init script.
   *
   *  · `polygonsData` — the political layer's whole rebuild: three-globe's data
   *    join and, inside it, a fresh `ConicPolygonGeometry` (earcut plus an
   *    interior grid) for every entry whose rings are a new object. The mode is
   *    a dependency of that watcher, so a switch runs it; whether it also
   *    rebuilds geometry is exactly what this measures.
   *  · `WebGLRenderer.render` — the frame itself, so the GL time inside a long
   *    task can be told apart from the JS time beside it.
   */
  await page.evaluate(() => {
    const g = window.__globe
    const inner = g.polygonsData.bind(g)
    g.polygonsData = (...a) => {
      if (!a.length) return inner()
      const t0 = performance.now()
      try {
        return inner(...a)
      } finally {
        const S = window.__sw
        if (S.on) {
          S.polyCalls++
          S.polyMs += performance.now() - t0
        }
      }
    }
    const r = g.renderer()
    const render = r.render.bind(r)
    r.render = (...a) => {
      const t0 = performance.now()
      try {
        return render(...a)
      } finally {
        const S = window.__sw
        if (S.on) {
          S.renders++
          S.renderMs += performance.now() - t0
        }
      }
    }
  })
  // A WORLD VIEW WITH THE PLANET INSIDE THE LENS, which is the camera a reader
  // toggles from and the one that makes the switch worst: the whole visible
  // hemisphere becomes a set of drawn tiles at once. Above ~1.37 the planet
  // overflows the frame and `detailWanted` streams nothing at all, so a switch
  // measured there measures only the base texture — see `planetFillsFrame`.
  await page.evaluate((alt) => window.__globe.pointOfView({ lat: 46.2, lng: 8.0, altitude: alt }), ALT)
  // Let the realistic mode finish arriving, so nothing it owes is charged to
  // the switch. There is no imagery service in this sandbox, so what settles
  // here is the base textures and the first frames, not a tile stream.
  await page.waitForTimeout(6000)
  return { ctx, page }
}

/**
 * One measurement set: two page loads, because a cold switch happens once.
 *
 *  · the first page throws the toggle from a store call, then back, then in
 *    again — cold, back, warm;
 *  · the second HOVERS THE CONTROL FIRST, which is round 61's prewarm signal
 *    (`warmMap` in stores/settings.ts), waits the length of a slow reach, and
 *    then throws it. On a build with no prewarm this is a cold switch with a
 *    pause in front of it, which is exactly the control it needs to be.
 */
const onePass = async () => {
  const a = await freshPage()
  const cold = digest(await a.page.evaluate(() => window.__switchTo('schematic')))
  const back = digest(await a.page.evaluate(() => window.__switchTo('realistic')))
  await a.page.waitForTimeout(1500)
  const warm = digest(await a.page.evaluate(() => window.__switchTo('schematic')))
  // …and round the loop again, which is the gesture the whole round is about:
  // a reader toggling to compare two looks. Every whole-texture upload in
  // `back2` or `warm2` is one the session has already paid for once.
  const back2 = digest(await a.page.evaluate(() => window.__switchTo('realistic')))
  await a.page.waitForTimeout(1500)
  const warm2 = digest(await a.page.evaluate(() => window.__switchTo('schematic')))
  await a.ctx.close()

  const b = await freshPage()
  await b.page.hover('[data-test="mode-toggle"]').catch(() => {})
  await b.page.waitForTimeout(HOVER_MS)
  const hover = digest(await b.page.evaluate(() => window.__switchTo('schematic')))
  await b.ctx.close()
  return { cold, back, warm, back2, warm2, hover }
}

const passes = []
for (let i = 0; i < RUNS; i++) {
  const p = await onePass()
  passes.push(p)
  console.log(
    `run ${i + 1}/${RUNS}  cold: first tile ${p.cold.msToFirstTile} ms, ${p.cold.bigTexUploads} big uploads` +
      `  |  warm: ${p.warm.bigTexUploads} big uploads  |  back: ${p.back.bigTexUploads}` +
      `  |  second lap: back ${p.back2.bigTexUploads} / warm ${p.warm2.bigTexUploads}` +
      `  |  hovered first: first tile ${p.hover.msToFirstTile} ms, ${p.hover.bigTexUploads} big uploads`,
  )
}

const report = { tag: TAG, runs: RUNS, altitude: ALT, hoverMs: HOVER_MS }
for (const phase of ['cold', 'back', 'warm', 'back2', 'warm2', 'hover']) {
  report[phase] = medianOf(passes.map((p) => p[phase]))
  const r = report[phase]
  console.log(
    `\n${phase.toUpperCase()}  (median of ${RUNS})` +
      `\n  longtasks: worst ${r.longWorstMs} ms, total ${r.longTotalMs} ms over ${r.longCount}   worst per run: ${r.worst3.join(', ')}` +
      `\n  frames: ${r.frames}, worst gap ${r.frameWorstGapMs} ms, median gap ${r.frameMedGapMs} ms` +
      `\n  shaders: ${r.compiles} compiled (${r.compileMs} ms), ${r.links} linked (${r.linkMs} ms), LINK_STATUS wait ${r.linkWaitMs} ms` +
      `\n  textures: ${r.bigTexUploads} big uploads ${r.bigTexMB} MB in ${r.bigTexMs} ms, ${r.mipCalls} mipmaps in ${r.mipMs} ms` +
      `\n  atlas: ${r.atlasUploads} slots (+${r.lowUploads} reduced) in ${r.atlasMs} ms; workers ${r.workersSpawned}; tiles ${r.tileReqs} asked / ${r.tileResps} answered` +
      `\n  political layer: ${r.polyCalls} rebuilds in ${r.polyMs} ms;  buffers made ${r.buffersMade}/freed ${r.buffersFreed}, ${r.bufferKB} kB` +
      `\n  renderer.render ${r.renders} calls, ${r.renderMs} ms (SwiftShader, inflated)` +
      `\n  timeline: base texture at ${r.msToBaseTex} ms, first tile at ${r.msToFirstTile} ms, settled at ${r.msToSettled} ms`,
  )
}

console.log('\n' + JSON.stringify(report, null, 1))
writeFileSync(`/tmp/modeswitch-${TAG}.json`, JSON.stringify({ ...report, passes }, null, 1))
await browser.close()
await server.close()
