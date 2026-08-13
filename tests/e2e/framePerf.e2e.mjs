/**
 * WHERE A FRAME GOES NOW — the whole picture, not the tile pipeline.
 *
 * `drawnPerf.e2e.mjs` is the streamer's instrument: tiles, slots, bytes, the
 * worker queue. Rounds 54 and 58 tuned that pipeline against it and it is well
 * tuned. This file is the OTHER half of a frame — the part that runs whether or
 * not a tile is streaming, in realistic mode as much as in drawn mode:
 *
 *   draws          GL draw calls per frame, attributed to a program, and the
 *                  programs named by what is declared in their source, so
 *                  "the ink" and "the planet" are separate columns.
 *   passes         `gl.clear` per frame. Two in one animation frame means the
 *                  scene was drawn twice — which `resumeAnimation` really can
 *                  do, since it renders synchronously.
 *   uploads        texSubImage2D / texImage2D calls and bytes, and separately
 *                  bufferData / bufferSubData, which is geometry churn: a
 *                  polygon layer rebuilt mid-gesture shows up here and nowhere
 *                  else.
 *   objects        createBuffer/deleteBuffer/createTexture/deleteTexture, so a
 *                  layer that rebuilds rather than updates is visible as churn
 *                  rather than inferred from a rebuild's symptoms.
 *   matInvalidations  `material.needsUpdate = true` per frame. A transparent
 *                  DOUBLE-SIDED material is rendered twice by three — back
 *                  faces then front — and each of those flips invalidates the
 *                  material, so `setProgram` re-derives its parameters and
 *                  rebuilds a fifty-field program cache key to find the program
 *                  it already had. Two per such object per frame.
 *   css2d          the CSS2D pin pass, timed on the instance the library hands
 *                  to every pin it positions (`onBeforeRender`), plus the DOM
 *                  records its writes produce (display, transform, z-index per
 *                  pin per rendered frame).
 *   traverseVisible  the z-order pass CSS2D runs over the WHOLE scene once per
 *                  frame, timed at `Object3D.prototype` — the one place a
 *                  scene-sized cost hides behind a pin-sized feature.
 *   longtasks      count, total and max, with the frame they landed on.
 *   wakes          the app's own pump ledger (`__frameStats`).
 *
 * Every number is a COUNT or a main-thread JS millisecond. Wall-clock frame
 * time is deliberately NOT reported: this runs under SwiftShader, where a frame
 * of this surface is about a second, and round 54's note on that stands — a
 * millisecond of GL here describes the machine. Main-thread JS between GL calls
 * is the one thing the software rasteriser does not inflate, and the material
 * invalidations, the DOM records and the traversals are exactly that.
 *
 * Run:  node tests/e2e/framePerf.e2e.mjs
 * Env:  TAG                label on /tmp/frameperf-$TAG.json
 *       CHROME_PATH        Chromium executable
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 *       ROUTES             comma-separated subset of route names to run
 */
import { createServer } from 'vite'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const TAG = process.env.TAG ?? 'before'
const ONLY = process.env.ROUTES ? new Set(process.env.ROUTES.split(',')) : null

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

await ctx.addInitScript(() => {
  const G = WebGL2RenderingContext.prototype
  const sized = new WeakMap()
  const srcOf = new WeakMap()
  const progSrc = new WeakMap()
  const progName = new WeakMap()
  let bound2d = null
  let program = null

  const fresh = () => ({
    draws: 0,
    byProgram: {},
    passes: 0,
    texCalls: 0,
    texBytes: 0,
    bufCalls: 0,
    bufBytes: 0,
    newBuffers: 0,
    delBuffers: 0,
    newTextures: 0,
    delTextures: 0,
    compiles: 0,
    domWrites: 0,
    /**
     * `material.needsUpdate = true`, counted.
     *
     * This is the one number that says what a DOUBLE-SIDED TRANSPARENT material
     * costs beyond its extra draw call: three flips `side` to BackSide and then
     * back on every such object on every frame, and each flip invalidates the
     * material — so `setProgram` re-derives the parameters and rebuilds the
     * ~50-field program cache key before finding the same program it had. It is
     * pure main-thread JS, so SwiftShader does not inflate it, and it scales
     * with objects on screen rather than with pixels.
     */
    matInvalidations: 0,
    css2dMs: 0,
    polyDigestMs: 0,
    polyDigests: 0,
    traverseCalls: 0,
    traverseMs: 0,
    longMs: 0,
  })
  const S = { frame: fresh(), frames: [], on: false }
  window.__frames = S

  /**
   * What a program IS, from what its source declares.
   *
   * three writes `#define SHADER_NAME <material.name>`, and most materials here
   * are unnamed, so the name is derived from uniforms and attributes instead —
   * which is stable across a rebuild and does not need the app to cooperate.
   */
  const nameProgram = (p) => {
    const held = progName.get(p)
    if (held) return held
    const s = (progSrc.get(p) ?? []).join('\n')
    const has = (re) => re.test(s)
    let n = 'other'
    if (has(/uDetailPaint|uAtlas|uEra|uCloudDrift/)) n = 'surface'
    else if (has(/aTaper/)) n = 'ink:route'
    else if (has(/dashSize|linewidth/)) n = 'ink:line'
    else if (has(/uRim|atmosphere|uSunDir/i)) n = 'atmosphere'
    else if (has(/backgroundCube|envMap.*background/i)) n = 'background'
    else if (has(/#define SHADER_NAME (\S+)/)) n = 'named:' + RegExp.$1
    else if (has(/vDash|dashTranslate/)) n = 'arc'
    else if (has(/diffuse/) && has(/gl_PointSize/)) n = 'points'
    else if (has(/diffuse/)) n = 'basic'
    progName.set(p, n)
    return n
  }

  const px = (a, from) => {
    if (a.length >= 9) return a[from] * a[from + 1]
    const src = a[a.length - 1]
    return src && src.width ? src.width * src.height : 0
  }
  const chan = (f) => ({ 6403: 1, 33319: 2, 6407: 3, 6408: 4 })[f] ?? 4
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
  wrap('useProgram', (a) => {
    program = a[0]
  })
  wrap('shaderSource', (a) => srcOf.set(a[0], a[1]))
  wrap('attachShader', (a) => {
    const list = progSrc.get(a[0]) ?? []
    list.push(srcOf.get(a[1]) ?? '')
    progSrc.set(a[0], list)
  })
  wrap('compileShader', () => {
    if (S.on) S.frame.compiles++
  })
  for (const n of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    wrap(n, () => {
      if (!S.on) return
      S.frame.draws++
      const k = program ? nameProgram(program) : 'none'
      S.frame.byProgram[k] = (S.frame.byProgram[k] || 0) + 1
    })
  }
  wrap('clear', () => {
    if (S.on) S.frame.passes++
  })
  wrap('texImage2D', function (a) {
    if (a.length >= 9) sized.set(bound2d, { w: a[3], h: a[4] })
    if (!S.on) return
    S.frame.texCalls++
    S.frame.texBytes += px(a, 3) * chan(a.length >= 9 ? a[6] : a[3])
  })
  wrap('texSubImage2D', function (a) {
    if (!S.on) return
    S.frame.texCalls++
    S.frame.texBytes += px(a, 4) * chan(a.length >= 9 ? a[6] : a[4])
  })
  for (const n of ['bufferData', 'bufferSubData']) {
    wrap(n, (a) => {
      if (!S.on) return
      S.frame.bufCalls++
      const v = a[1]
      S.frame.bufBytes += typeof v === 'number' ? v : (v?.byteLength ?? 0)
    })
  }
  wrap('createBuffer', () => S.on && S.frame.newBuffers++)
  wrap('deleteBuffer', () => S.on && S.frame.delBuffers++)
  wrap('createTexture', () => S.on && S.frame.newTextures++)
  wrap('deleteTexture', () => S.on && S.frame.delTextures++)

  /**
   * THE DOM SIDE, counted as mutations rather than as setter calls.
   *
   * The camel-case CSS properties are not accessors on
   * `CSSStyleDeclaration.prototype` in this engine — they are named properties
   * on the instance — so there is no one place to wrap. A MutationObserver on
   * the pin container answers the same question from the other end: every
   * inline style write the CSS2D layer makes is one `style` attribute record,
   * and the layer writes `display`, `transform` and `z-index` per pin per
   * rendered frame.
   */
  const DOM = { records: 0 }
  window.__dom = DOM
  const observeCss2d = () => {
    const host = document.querySelector('.globe-css2d')
    if (!host) return false
    new MutationObserver((recs) => {
      DOM.records += recs.length
      if (S.on) S.frame.domWrites += recs.length
    }).observe(host, { attributes: true, subtree: true, childList: true })
    return true
  }
  const findHost = setInterval(() => observeCss2d() && clearInterval(findHost), 500)

  const LT = { count: 0, total: 0, max: 0 }
  window.__longtasks = LT
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!S.on) continue
        LT.count++
        LT.total += e.duration
        LT.max = Math.max(LT.max, e.duration)
        S.frame.longMs += e.duration
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch {
    /* no longtask support */
  }

  const beat = () => {
    if (S.on) {
      S.frames.push(S.frame)
      S.frame = fresh()
    }
    requestAnimationFrame(beat)
  }
  requestAnimationFrame(beat)
  window.__framesStart = () => {
    S.frames = []
    S.frame = fresh()
    window.__dom.records = 0
    const L = window.__longtasks
    L.count = L.total = L.max = 0
    S.on = true
  }
  window.__framesStop = () => {
    S.on = false
    return { frames: S.frames.slice() }
  }
})

const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGE ERR', e.message))
await page.goto(base, { timeout: 120_000 })
await page.waitForFunction(() => !!window.__globe && !!window.__events?.all.length, null, {
  timeout: 120_000,
})
await page.evaluate(() => {
  window.__time.setRange({ start: -550, end: 2026 })
  window.__time.setSelection(500, 1945)
})
await page.evaluate(() => window.__setTime(1941))

/**
 * The three hooks that need a live object to reach a prototype.
 *
 * Nothing in the app exposes three's classes, and nothing needs to: a scene, a
 * material and a CSS2D pin are all reachable from the globe, and their
 * prototypes are the same objects the library uses.
 *
 *  · `Material.prototype.needsUpdate` — the double-sided transparent flip.
 *  · `Object3D.prototype.onBeforeRender` — CSS2D calls it with ITSELF as the
 *    first argument, which is the only handle on that renderer from outside.
 *  · `Object3D.prototype.traverseVisible` — CSS2D's z-order pass, which walks
 *    the whole scene once a frame to sort a handful of pins.
 */
await page.evaluate(() => {
  const scene = window.__globe.scene()
  let mat = null
  scene.traverse((o) => {
    if (!mat && o.material) mat = Array.isArray(o.material) ? o.material[0] : o.material
  })
  if (mat) {
    let p = Object.getPrototypeOf(mat)
    while (p && !Object.getOwnPropertyDescriptor(p, 'needsUpdate')) p = Object.getPrototypeOf(p)
    const d = p && Object.getOwnPropertyDescriptor(p, 'needsUpdate')
    if (d?.set) {
      Object.defineProperty(p, 'needsUpdate', {
        ...d,
        set(v) {
          const S = window.__frames
          if (S.on && v === true) S.frame.matInvalidations++
          d.set.call(this, v)
        },
      })
    }
  }
  // CSS2D hands its own instance to every pin it positions; the first frame
  // after this runs captures it, and the wrap times the whole pass from then on.
  const O3D = (() => {
    let p = Object.getPrototypeOf(scene)
    while (p && !Object.prototype.hasOwnProperty.call(p, 'onBeforeRender')) p = Object.getPrototypeOf(p)
    return p
  })()
  if (O3D) {
    const inner = O3D.onBeforeRender
    O3D.onBeforeRender = function (r, ...rest) {
      if (r && !window.__css2d && typeof r.render === 'function' && r.domElement && !r.getContext) {
        window.__css2d = r
        const render = r.render.bind(r)
        r.render = (...a) => {
          const t0 = performance.now()
          try {
            return render(...a)
          } finally {
            const S = window.__frames
            if (S.on) S.frame.css2dMs += performance.now() - t0
          }
        }
      }
      return inner.call(this, r, ...rest)
    }
  }
})
/**
 * The political layer's digest, timed where the app calls it.
 *
 * `polygonsData` is the whole rebuild: three-globe's data join, and inside it a
 * fresh `ConicPolygonGeometry` — earcut plus an interior grid at
 * `AREA_CAP_RESOLUTION_DEG` — for every entry whose ring array is a different
 * object than last time. It is the one thing an era scrub does that a pan does
 * not, so it is timed apart from everything else.
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
      const S = window.__frames
      if (S.on) {
        S.frame.polyDigests++
        S.frame.polyDigestMs += performance.now() - t0
      }
    }
  }
})

await page.evaluate(() => {
  const scene = window.__globe.scene()
  let proto = Object.getPrototypeOf(scene)
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'traverseVisible'))
    proto = Object.getPrototypeOf(proto)
  if (!proto) return
  const inner = proto.traverseVisible
  let depth = 0
  proto.traverseVisible = function (...a) {
    if (depth++) {
      try {
        return inner.apply(this, a)
      } finally {
        depth--
      }
    }
    const t0 = performance.now()
    try {
      return inner.apply(this, a)
    } finally {
      depth--
      const S = window.__frames
      if (S.on) {
        S.frame.traverseCalls++
        S.frame.traverseMs += performance.now() - t0
      }
    }
  }
})

const pov = (p, ms = 0) => page.evaluate(([p, ms]) => window.__globe.pointOfView(p, ms), [p, ms])

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

/** Nothing on the wire, nothing fading, and the camera where it was left. */
const quiesce = async (tries = 30) => {
  let calm = 0
  for (let i = 0; i < tries; i++) {
    const busy = await page.evaluate(() => window.__detail?.animating === true)
    calm = busy ? 0 : calm + 1
    if (calm >= 2) return
    await page.waitForTimeout(400)
  }
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? +s[s.length >> 1].toFixed(3) : 0
}
const sum = (xs) => +xs.reduce((a, b) => a + b, 0).toFixed(1)

const summarise = (label, out, pump, pins) => {
  // A frame the renderer skipped draws nothing: the pump had parked it. Those
  // are counted, not averaged into the ones that drew.
  const drawn = out.frames.filter((f) => f.draws > 0)
  const col = (k) => drawn.map((f) => f[k])
  const progs = {}
  for (const f of drawn) for (const [k, v] of Object.entries(f.byProgram)) progs[k] = (progs[k] || 0) + v
  return {
    label,
    pins,
    ticks: out.frames.length,
    rendered: drawn.length,
    medDraws: med(col('draws')),
    maxDraws: Math.max(0, ...col('draws')),
    drawsByProgram: Object.fromEntries(
      Object.entries(progs)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, +(v / Math.max(1, drawn.length)).toFixed(1)]),
    ),
    medPasses: med(col('passes')),
    texCalls: sum(col('texCalls')),
    texMB: +(sum(col('texBytes')) / 1048576).toFixed(2),
    bufCalls: sum(col('bufCalls')),
    bufKB: +(sum(col('bufBytes')) / 1024).toFixed(1),
    buffersMade: sum(col('newBuffers')),
    buffersFreed: sum(col('delBuffers')),
    texturesMade: sum(col('newTextures')),
    compiles: sum(col('compiles')),
    matInvalidationsPerFrame: med(col('matInvalidations')),
    polyDigests: sum(col('polyDigests')),
    polyDigestMsTotal: sum(col('polyDigestMs')),
    polyDigestMsMax: Math.max(0, ...col('polyDigestMs')),
    domWritesPerFrame: med(col('domWrites')),
    css2dMsPerFrame: med(col('css2dMs')),
    traverseMsPerFrame: med(col('traverseMs')),
    traverseCallsPerFrame: med(col('traverseCalls')),
    ...pump,
  }
}

const measure = async (label, body) => {
  const w0 = await page.evaluate(() => window.__frameStats())
  await page.evaluate(() => window.__framesStart())
  await body()
  const out = await page.evaluate(() => window.__framesStop())
  const pump = await page.evaluate(
    (w0) => {
      const s = window.__frameStats()
      return {
        wakes: s.wakes - w0.wakes,
        resumes: s.resumes - w0.resumes,
        pauses: s.pauses - w0.pauses,
        longTasks: { ...window.__longtasks, total: +window.__longtasks.total.toFixed(1) },
      }
    },
    w0,
  )
  const pins = await page.evaluate(() => document.querySelectorAll('.globe-css2d > *').length)
  const r = summarise(label, out, pump, pins)
  console.log(
    `\n${label}\n  pins ${r.pins}  ticks ${r.ticks} rendered ${r.rendered}  draws ${r.medDraws} (max ${r.maxDraws})` +
      `  passes ${r.medPasses}\n  by program ${JSON.stringify(r.drawsByProgram)}` +
      `\n  matInvalidations/frame ${r.matInvalidationsPerFrame}  dom writes/frame ${r.domWritesPerFrame}` +
      `  css2d ${r.css2dMsPerFrame} ms  traverseVisible ${r.traverseMsPerFrame} ms` +
      `\n  polygon digests ${r.polyDigests} totalling ${r.polyDigestMsTotal} ms (worst frame ${r.polyDigestMsMax.toFixed(1)} ms)` +
      `\n  tex ${r.texCalls} calls ${r.texMB} MB   buffers ${r.bufCalls} calls ${r.bufKB} kB  made ${r.buffersMade}/freed ${r.buffersFreed}` +
      `\n  wakes ${r.wakes} resumes ${r.resumes} pauses ${r.pauses}  longtasks ${r.longTasks.count}/${r.longTasks.total} ms`,
  )
  return r
}

const report = { tag: TAG, runs: [] }
const HOME = { lat: 46.2, lng: 8.0 }
const run = async (name, fn) => {
  if (ONLY && !ONLY.has(name)) return
  report.runs.push(await fn())
}

const PAN = `
  if (i >= 40) return false
  g.pointOfView({ lat: arg.lat, lng: arg.lng + arg.step * i, altitude: arg.alt })
  return true
`
const ZOOM = `
  if (i >= 40) return false
  g.pointOfView({ lat: arg.lat, lng: arg.lng, altitude: 2.4 * Math.pow(arg.to / 2.4, i / 39) })
  return true
`
const SCRUB = `
  if (i >= 40) return false
  window.__time.focusTime(arg.from + (arg.to - arg.from) * (i / 39))
  return true
`

/* ------------------------------------------------------- realistic mode --- */
for (const mode of ['realistic', 'schematic']) {
  await page.evaluate((m) => window.__settings.setMode(m), mode)
  await pov({ ...HOME, altitude: 2.5 })
  await quiesce()
  const tag = mode === 'realistic' ? 'realistic' : 'drawn'

  await run(`${tag}:rest`, () =>
    measure(`${tag} — rest at world view`, () => page.waitForTimeout(6000)),
  )
  await run(`${tag}:pan-world`, () =>
    measure(`${tag} — pan at world view`, () => scripted(PAN, { ...HOME, step: 0.6, alt: 2.5 })),
  )
  await run(`${tag}:zoom`, async () => {
    await pov({ ...HOME, altitude: 2.4 })
    await quiesce()
    return measure(`${tag} — zoom world→z9`, () => scripted(ZOOM, { ...HOME, to: 0.02 }))
  })
  await run(`${tag}:pan-close`, async () => {
    await pov({ ...HOME, altitude: 0.028 })
    await quiesce()
    return measure(`${tag} — pan at z9`, () => scripted(PAN, { ...HOME, step: 0.02, alt: 0.028 }))
  })
  await run(`${tag}:scrub`, async () => {
    await pov({ ...HOME, altitude: 1.2 })
    await quiesce()
    return measure(`${tag} — era scrub 1200→1945`, () => scripted(SCRUB, { from: 1200, to: 1945 }))
  })
  /**
   * THE INK, and how many draw calls it is.
   *
   * A round-45 note said the route casings could be merged for "46 draws → 40"
   * and it was never done. This is the measurement that says whether that is
   * still worth anything: Cook's three voyages are the longest route geometry in
   * the corpus (123 authored ports), and with them selected the ink layer is
   * whatever `ink:*` comes to below.
   */
  await run(`${tag}:routes`, async () => {
    await page.evaluate(() => window.__events.showOnMap('cook-voyages'))
    await page.waitForTimeout(4000)
    await quiesce()
    const pv = await page.evaluate(() => window.__globe.pointOfView())
    const r = await measure(`${tag} — pan with Cook's voyages drawn`, () =>
      scripted(PAN, { lat: pv.lat, lng: pv.lng, step: pv.altitude * 0.3, alt: pv.altitude }),
    )
    await page.evaluate(() => window.__events.clearFocus())
    return r
  })
  await run(`${tag}:plan`, async () => {
    await page.evaluate(() => window.__events.showOnMap('barbarossa'))
    await page.waitForTimeout(3000)
    await quiesce()
    const pv = await page.evaluate(() => window.__globe.pointOfView())
    const r = await measure(`${tag} — pan with a battle plan open`, () =>
      scripted(PAN, { lat: pv.lat, lng: pv.lng, step: pv.altitude * 0.4, alt: pv.altitude }),
    )
    await page.evaluate(() => window.__events.clearFocus())
    return r
  })
}

console.log(JSON.stringify(report, null, 1))
writeFileSync(`/tmp/frameperf-${TAG}.json`, JSON.stringify(report, null, 1))
await browser.close()
await server.close()
