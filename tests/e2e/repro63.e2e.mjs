/**
 * ROUND 63 — "for many drawings (operations/steps) with higher zoom, drawings
 * are still floating."
 *
 * Round 59 took every overlay down to `SURFACE_ALT` (0.0006 R, 3.8 km) and the
 * slide got eight times smaller. The reader says it is still there, and this
 * file is the instrument that says by how much, in kilometres and in pixels,
 * rather than in adjectives.
 *
 * WHAT IT MEASURES. For a lat/lng, three points that all claim to be the same
 * place:
 *
 *   ink     — where the DrawingLayer puts it: on the ideal sphere, lifted.
 *   ground  — where the globe's own mesh is along that radial. three-globe
 *             builds SphereGeometry(R, 90, 45), so the rendered planet is a
 *             90x45 polyhedron INSCRIBED in the ideal sphere: its facets dip
 *             below the sphere between their corners.
 *   texel   — where the imagery for that lat/lng actually lands, which is the
 *             mesh point whose interpolated UV is that lat/lng. Not the same as
 *             `ground`: barycentric interpolation across a 4° facet is not the
 *             radial projection.
 *
 * The gap ink→ground is HOVER, and it turns into a screen-space SLIDE against
 * the ground as the camera moves off nadir. The gap ink→texel is the constant
 * part: the ink is simply next to the coastline it was drawn on. Both are fixed
 * distances on the planet, so both are invisible at world view and enormous at
 * 100 km — which is exactly the shape of the report.
 *
 * Run:  node tests/e2e/repro63.e2e.mjs
 * Env:  SHOT_DIR (default /tmp/shots63/ink), SHOT_TAG (default 'before'),
 *       PLAYWRIGHT_MODULE, CHROME_PATH, SHOT_ONLY
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots63/ink'
const tag = process.env.SHOT_TAG ?? 'before'
mkdirSync(shots, { recursive: true })

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

const sessions = new Map()
const shot = async (page, name) => {
  let cdp = sessions.get(page)
  if (!cdp) sessions.set(page, (cdp = await page.context().newCDPSession(page)))
  await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 })
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = join(shots, `${tag}-${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

const corpusQuiet = async (page, still = 700, timeout = 25_000) => {
  const t0 = Date.now()
  let last = -1
  let since = Date.now()
  while (Date.now() - t0 < timeout) {
    const n = await page.evaluate(() => window.__events.all.length)
    if (n !== last) {
      last = n
      since = Date.now()
    } else if (Date.now() - since >= still) return
    await page.waitForTimeout(150)
  }
}

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
  await page.goto(base, { timeout: 90_000 })
  await page.addStyleTag({
    content:
      '*, *::before, *::after { animation: none !important; transition: none !important; }' +
      '.panel { display: none !important; }',
  })
  await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
  // The band is the premise: every camera below has to be inside it or the
  // event is culled before it can be focused.
  await page.evaluate(() => {
    window.__time.setRange({ start: -3000, end: 2026 })
    window.__time.setSelection(-600, 2026)
  })
  await page.evaluate(() => window.__setTime(1944))
  await corpusQuiet(page)
  await page.waitForTimeout(1500)
  return page
}

/**
 * The probe, in the page: everything above, measured against the real scene
 * graph rather than against a model of it.
 */
const PROBE = () => {
  const R = 6371 // km, for reporting only
  const D = Math.PI / 180
  const globe = window.__globe
  const radius = globe.getGlobeRadius()
  const cam = globe.camera()
  const renderer = renderer_size()
  function renderer_size() {
    const c = globe.renderer().domElement
    const dpr = globe.renderer().getPixelRatio() || 1
    return { x: c.width / dpr, y: c.height / dpr }
  }
  const size = renderer
  // the globe's own sphere: the biggest mesh whose geometry is a SphereGeometry
  let mesh = null
  globe.scene().traverse((o) => {
    if (!o.isMesh || !o.geometry?.parameters) return
    const p = o.geometry.parameters
    if (p.widthSegments === undefined || p.heightSegments === undefined) return
    if (Math.abs((p.radius ?? 0) - radius) > 1e-6) return
    if (!mesh || p.widthSegments > mesh.geometry.parameters.widthSegments) mesh = o
  })
  const dir = (lng, lat) => {
    const p = lat * D
    const l = lng * D
    const c = Math.cos(p)
    return [c * Math.sin(l), Math.sin(p), c * Math.cos(l)]
  }
  // project a scene-space point to CSS pixels, by hand — the camera's own
  // matrices, so nothing here can disagree with what was drawn
  const project = (v) => {
    const mv = cam.matrixWorldInverse.elements
    const pr = cam.projectionMatrix.elements
    const ap = (m, a) => [
      m[0] * a[0] + m[4] * a[1] + m[8] * a[2] + m[12] * a[3],
      m[1] * a[0] + m[5] * a[1] + m[9] * a[2] + m[13] * a[3],
      m[2] * a[0] + m[6] * a[1] + m[10] * a[2] + m[14] * a[3],
      m[3] * a[0] + m[7] * a[1] + m[11] * a[2] + m[15] * a[3],
    ]
    const e = ap(pr, ap(mv, [v[0], v[1], v[2], 1]))
    if (!(Math.abs(e[3]) > 1e-9)) return null
    return [((e[0] / e[3]) * 0.5 + 0.5) * size.x, (-(e[1] / e[3]) * 0.5 + 0.5) * size.y]
  }
  // where the mesh is along a radial: brute-force ray/triangle over the sphere
  // mesh, in the mesh's own frame, then back to world
  const pos = mesh.geometry.getAttribute('position')
  const idx = mesh.geometry.getIndex()
  mesh.updateWorldMatrix(true, false)
  const m = mesh.matrixWorld.elements
  const toWorld = (a) => [
    m[0] * a[0] + m[4] * a[1] + m[8] * a[2] + m[12],
    m[1] * a[0] + m[5] * a[1] + m[9] * a[2] + m[13],
    m[2] * a[0] + m[6] * a[1] + m[10] * a[2] + m[14],
  ]
  const uvAttr = mesh.geometry.getAttribute('uv')
  const tri = (i) => {
    const a = idx.getX(i * 3)
    const b = idx.getX(i * 3 + 1)
    const c = idx.getX(i * 3 + 2)
    return [a, b, c].map((k) => ({
      p: toWorld([pos.getX(k), pos.getY(k), pos.getZ(k)]),
      uv: [uvAttr.getX(k), uvAttr.getY(k)],
    }))
  }
  const nTri = idx.count / 3
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const crs = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  /** Möller–Trumbore from the origin along `d`, over every facet. */
  const hitRadial = (d) => {
    for (let i = 0; i < nTri; i++) {
      const [A, B, C] = tri(i).map((t) => t.p)
      const e1 = sub(B, A)
      const e2 = sub(C, A)
      const h = crs(d, e2)
      const a = dot(e1, h)
      if (Math.abs(a) < 1e-12) continue
      const f = 1 / a
      const s = [-A[0], -A[1], -A[2]]
      const u = f * dot(s, h)
      if (u < -1e-9 || u > 1 + 1e-9) continue
      const q = crs(s, e1)
      const v = f * dot(d, q)
      if (v < -1e-9 || u + v > 1 + 1e-9) continue
      const t = f * dot(e2, q)
      if (t <= 0) continue
      return [d[0] * t, d[1] * t, d[2] * t]
    }
    return null
  }
  /** Where the IMAGERY for a lat/lng lands: the mesh point whose uv is that. */
  const hitTexel = (lng, lat) => {
    const want = [(lng + 180) / 360, (lat + 90) / 180]
    let best = null
    let bestErr = Infinity
    for (let i = 0; i < nTri; i++) {
      const t = tri(i)
      // barycentric solve in uv
      const [a, b, c] = t.map((k) => k.uv)
      // uv seams: skip a triangle whose u range wraps
      if (Math.max(a[0], b[0], c[0]) - Math.min(a[0], b[0], c[0]) > 0.5) continue
      const d00 = b[0] - a[0]
      const d01 = c[0] - a[0]
      const d10 = b[1] - a[1]
      const d11 = c[1] - a[1]
      const det = d00 * d11 - d01 * d10
      if (Math.abs(det) < 1e-14) continue
      const px = want[0] - a[0]
      const py = want[1] - a[1]
      const w1 = (px * d11 - d01 * py) / det
      const w2 = (d00 * py - px * d10) / det
      const err = Math.max(0, -w1, -w2, w1 + w2 - 1)
      if (err < bestErr) {
        bestErr = err
        best = [0, 1, 2].map(
          (k) => t[0].p[k] * (1 - w1 - w2) + t[1].p[k] * w1 + t[2].p[k] * w2,
        )
      }
      if (bestErr <= 0) break
    }
    return best
  }
  /**
   * THE INK ITSELF, in world space: every vertex the DrawingLayer put on the
   * globe, with the group's own transform applied.
   *
   * Read off the scene rather than recomputed, so this measures what is drawn
   * and not a second copy of the placement rule. Fat lines keep their real
   * vertices in `instanceStart`; `position` on those is the unit quad the
   * shader extrudes and means nothing here.
   */
  const inkPoints = (limit = 400) => {
    const out = []
    globe.scene().traverse((o) => {
      if (!o.isGroup || o.renderOrder !== 12) return
      o.updateWorldMatrix(true, true)
      o.traverse((c) => {
        const geom = c.geometry
        if (!geom) return
        const attr = geom.getAttribute('instanceStart') ?? geom.getAttribute('position')
        if (!attr || !attr.count) return
        const e = c.matrixWorld.elements
        const step = Math.max(1, Math.floor(attr.count / 60))
        for (let i = 0; i < attr.count; i += step) {
          const a = [attr.getX(i), attr.getY(i), attr.getZ(i)]
          if (Math.hypot(a[0], a[1], a[2]) < radius * 0.5) continue
          out.push([
            e[0] * a[0] + e[4] * a[1] + e[8] * a[2] + e[12],
            e[1] * a[0] + e[5] * a[1] + e[9] * a[2] + e[13],
            e[2] * a[0] + e[6] * a[1] + e[10] * a[2] + e[14],
          ])
          if (out.length >= limit) return
        }
      })
    })
    return out
  }
  return (samples) => {
    const out = []
    // Every measurement is taken AT A REAL INK VERTEX that is on screen: the
    // hover is between that vertex and the mesh directly below it, and the
    // slide is the same pair projected. `samples` only decides which corner of
    // the frame the imagery comparison is taken at.
    const pts = inkPoints()
    const onScreen = pts.filter((p) => {
      const s = project(p)
      return s && s[0] > 0 && s[0] < size.x && s[1] > 0 && s[1] < size.y
    })
    for (const p of (onScreen.length ? onScreen : pts).slice(0, 60)) {
      const len = Math.hypot(p[0], p[1], p[2])
      const d = [p[0] / len, p[1] / len, p[2] / len]
      const g = hitRadial(d)
      if (!g) continue
      const gl = Math.hypot(g[0], g[1], g[2])
      const pi = project(p)
      const pg = project(g)
      out.push({
        kind: 'ink',
        hoverKm: ((len - gl) / radius) * R,
        slidePx: pi && pg ? Math.hypot(pi[0] - pg[0], pi[1] - pg[1]) : null,
      })
    }
    // …and the imagery term, which the ink placement deliberately leaves alone:
    // where the texture for a lat/lng lands against where the sphere puts it.
    for (const [lng, lat] of samples) {
      const d = dir(lng, lat)
      const tx = hitTexel(lng, lat)
      if (!tx) continue
      const txl = Math.hypot(tx[0], tx[1], tx[2])
      const pi = project(d.map((x) => x * txl))
      const pt = project(tx)
      out.push({
        kind: 'texel',
        lng,
        lat,
        texelPx: pi && pt ? Math.hypot(pi[0] - pt[0], pi[1] - pt[1]) : null,
        texelKm:
          (Math.acos(Math.min(1, dot(d, [tx[0] / txl, tx[1] / txl, tx[2] / txl]))) / D) * 111.32,
      })
    }
    return { rows: out, inkVertices: pts.length, onScreen: onScreen.length }
  }
}

const measure = async (page, samples) =>
  page.evaluate(
    ([probeSrc, s]) => {
      const probe = new Function(`return (${probeSrc})()`)()
      return probe(s)
    },
    [PROBE.toString(), samples],
  )

const setMode = async (page, mode) => {
  await page.evaluate((m) => window.__settings.setMode(m), mode)
  await page.waitForTimeout(900)
}

const page = await open(1100, 800)

/**
 * One event, three zooms, both grounds. D-Day is the densest drawing in the
 * corpus (21 layers: fronts, thrusts, marks, labels) and it is authored at the
 * scale of a beach, so "close" is a camera the reader really does reach.
 */
const KM = (km) => {
  const half = (km / 2 / 111.32) * (Math.PI / 180)
  const theta = (25 * Math.PI) / 180
  return Math.sin(half + theta) / Math.sin(theta) - 1
}
const CAMERAS = [
  { name: 'world', view: [49.4, -0.8, 2.5] },
  { name: 'operational', view: [49.4, -0.8, KM(500)] },
  { name: 'close', view: [49.4, -0.8, KM(100)] },
  { name: 'closer', view: [49.4, -0.8, KM(40)] },
  // The zoom floor a post-1930 event really allows (`MIN_ALTITUDE_DETAIL`) is
  // far lower than this. Eight kilometres is where a fixed lift is already off
  // by more than a screen width, and where the ink has to still be drawn at all
  // — a lift of metres is a lift that could be eaten by the planet's own depth.
  { name: 'extreme', view: [49.34, -0.85, KM(8)] },
]

/**
 * …and the other two vocabularies, at one close camera each: a ZONE (a wash and
 * a dashed ring, the one kind that is not cut at the folds) and a ROUTE (the
 * selection layer rather than the focus layer, which is a second DrawingLayer
 * and has to be grounded by the same rule).
 */
const SUBJECTS = [
  { id: 'leningrad-siege', year: 1942, at: [59.9, 30.3], name: 'zone' },
  { id: 'spanish-armada', year: 1588, at: [50.1, -1.5], name: 'route' },
]

const only = process.env.SHOT_ONLY ? new RegExp(process.env.SHOT_ONLY) : undefined
const results = []
for (const mode of ['schematic', 'realistic']) {
  await setMode(page, mode)
  await page.evaluate(() => window.__events.dismiss())
  await page.evaluate(() => window.__setTime(1944.4))
  await page.waitForTimeout(500)
  await corpusQuiet(page, 400, 8000)
  await page.evaluate(() => {
    window.__events.select('d-day')
    window.__events.enterFocus("d-day")
  })
  await page.waitForTimeout(2500)
  for (const cam of CAMERAS) {
    const name = `${cam.name}-${mode === 'schematic' ? 'map' : 'photo'}`
    if (only && !only.test(name)) continue
    await page.evaluate(
      ([a, b, c]) => window.__globe.pointOfView({ lat: a, lng: b, altitude: c }, 0),
      cam.view,
    )
    await page.waitForTimeout(2200)
    await page.evaluate(() => window.__wake?.(500))
    await page.waitForTimeout(900)
    // a fan of points across the frame: the middle, and off toward each corner
    const spanDeg = (cam.view[2] < 0.02 ? 0.4 : 1) * Math.min(6, cam.view[2] * 45)
    const samples = [
      [cam.view[1], cam.view[0]],
      [cam.view[1] + spanDeg * 0.5, cam.view[0]],
      [cam.view[1], cam.view[0] + spanDeg * 0.35],
      [cam.view[1] + spanDeg * 0.4, cam.view[0] + spanDeg * 0.3],
    ]
    const m = await measure(page, samples)
    const file = await shot(page, name)
    const ink = m.rows.filter((r) => r.kind === 'ink')
    const tex = m.rows.filter((r) => r.kind === 'texel')
    const worstHover = Math.max(0, ...ink.map((r) => Math.abs(r.hoverKm ?? 0)))
    const worstSlide = Math.max(0, ...ink.map((r) => r.slidePx ?? 0))
    const worstTexel = Math.max(0, ...tex.map((r) => r.texelPx ?? 0))
    console.log(`\n${name}   ${ink.length} ink vertices measured of ${m.inkVertices}`)
    console.log(`      ${file}`)
    console.log(
      `      hover ${worstHover.toFixed(3)} km   slide ${worstSlide.toFixed(1)} px   ` +
        `imagery-vs-sphere ${worstTexel.toFixed(1)} px (${Math.max(
          0,
          ...tex.map((r) => r.texelKm ?? 0),
        ).toFixed(2)} km)`,
    )
    results.push({ name, mode, view: cam.view, worstHover, worstSlide, worstTexel, ...m })
  }
}

for (const s of SUBJECTS) {
  for (const mode of ['schematic', 'realistic']) {
    const name = `${s.name}-${mode === 'schematic' ? 'map' : 'photo'}`
    if (only && !only.test(name)) continue
    await setMode(page, mode)
    await page.evaluate(() => window.__events.dismiss())
    await page.evaluate((y) => window.__setTime(y), s.year)
    await page.waitForTimeout(600)
    await corpusQuiet(page, 400, 8000)
    await page.evaluate((id) => {
      window.__events.select(id)
      window.__events.enterFocus(id)
    }, s.id)
    await page.waitForTimeout(2000)
    await page.evaluate(
      ([a, b, c]) => window.__globe.pointOfView({ lat: a, lng: b, altitude: c }, 0),
      [s.at[0], s.at[1], KM(120)],
    )
    await page.waitForTimeout(2200)
    await page.evaluate(() => window.__wake?.(500))
    await page.waitForTimeout(900)
    const m = await measure(page, [[s.at[1], s.at[0]]])
    const file = await shot(page, name)
    const ink = m.rows.filter((r) => r.kind === 'ink')
    const worstHover = Math.max(0, ...ink.map((r) => Math.abs(r.hoverKm ?? 0)))
    const worstSlide = Math.max(0, ...ink.map((r) => r.slidePx ?? 0))
    console.log(`\n${name}   ${ink.length} ink vertices measured of ${m.inkVertices}`)
    console.log(`      ${file}`)
    console.log(`      hover ${worstHover.toFixed(3)} km   slide ${worstSlide.toFixed(1)} px`)
    results.push({ name, mode, worstHover, worstSlide, ...m })
  }
}

writeFileSync(join(shots, `${tag}-summary.json`), JSON.stringify(results, null, 2))
console.log(`\nwrote ${results.length} frames to ${shots} as "${tag}-*"`)

await browser.close()
await server.close()
