/**
 * ROUND 62 — the two charges from the field, photographed and probed.
 *
 *   1. "I can sometimes see a block of satellite map on the edges of screen"
 *      while in map mode.
 *   2. "switching between satellite and map when viewing a path event produces
 *      a weird map / satellite hybrid map."
 *
 * Both are claims about PIXELS, so the instrument is a screenshot and a
 * classifier — plus a probe of the uniforms and the index the surface shader is
 * actually assembling from, because a hybrid picture has two possible sources
 * and only the probe tells them apart:
 *
 *   · the BASE MAP under map mode may still be the photographed one.
 *     `applyEra` holds the last decoded frame while the new one loads, which is
 *     right for a scrub through deep time and wrong across a change of mode.
 *     CONVICTED, twice: whole-frame at the instant of the toggle (53.1% of the
 *     frame photographic, in a mode whose shader says `uDetailPaint = 1`), and
 *     as blocks at the EDGES four seconds later, once the drawn tiles have
 *     painted the middle of it — 39.9% photographic with 16.3% of the frame
 *     uncovered and all of that in the outer eighth.
 *   · the ATLAS INDEX may still address the other mode's tiles. `setPlan` drops
 *     `DetailImagery.index`, but nothing republished that to the shader, and
 *     `uDetailPaint` flips in the same tick. NOT convicted here: the component's
 *     settings watcher re-syncs inside the same flush, so the index never once
 *     addressed an imagery source while map mode was painting. It is closed
 *     anyway (a plan change now publishes), because "empty because of the order
 *     two watchers happen to run in" is not an invariant. The verdict at the
 *     bottom of this file keeps checking it.
 *
 * THE STAND-IN SOURCE. This sandbox has no route to GIBS or EOX, so realistic
 * mode never streams anything here and neither defect can appear on its own.
 * Both WMS hosts are intercepted and answered with SATURATED MAGENTA on dark
 * magenta — a colour the drawn palette (duck-egg sea `#b1bfbb`, parchment land
 * `#ece2c8`, brown-black ink) cannot produce at any lighting. "A streamed
 * imagery tile is being painted" is then one predicate over a pixel.
 * The photographed BASE map needs its own predicate, and it is the ocean: the
 * modern basemap's sea is deeply blue and the drawn map's is a warm-leaning
 * duck-egg (b − max(r,g) = −4), so a cool pixel in map mode is a photograph.
 *
 * THE NETWORK IS PART OF THE DEFECT. Map mode's base map is fetched at the
 * switch and its tiles need only 54 kB of coarse geometry, so over a real
 * connection the tiles win the race and paint the middle of a photograph. Off
 * the dev server they cannot — the texture is a memcpy away — so `DRAWN_DELAY_MS`
 * puts a modest network in front of that one file. Without it the defect is a
 * frame or two and this instrument sees only the whole-frame case.
 *
 * Run:  DRAWN_DELAY_MS=12000 node tests/e2e/repro62.e2e.mjs
 * Env:  TAG          label on the screenshots (default "before")
 *       SHOT_DIR     where they land (default /tmp/shots62)
 *       SECTIONS     which of A (cold switch), B (warm switch), C (a focused
 *                    path event) and D (a gesture inside map mode) to run
 *       DRAWN_DELAY_MS  how long to hold `drawn-world.webp` on the wire
 *       CHROME_PATH  Chromium executable
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const TAG = process.env.TAG ?? 'before'
const SHOTS = process.env.SHOT_DIR ?? '/tmp/shots62'
mkdirSync(SHOTS, { recursive: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

/** The stand-in photograph: magenta, in a grid so a block reads as tiles. */
const synthetic = (w, h) => {
  const cell = Math.max(4, Math.round(Math.min(w, h) / 8))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><pattern id="p" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">
    <rect width="${cell * 2}" height="${cell * 2}" fill="rgb(255,0,255)"/>
    <rect width="${cell}" height="${cell}" fill="rgb(150,0,150)"/>
    <rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="rgb(150,0,150)"/>
  </pattern></defs><rect width="100%" height="100%" fill="url(#p)"/></svg>`
}

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
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGE ERR', e.message))

let wmsRequests = 0
await page.route(/(gibs\.earthdata\.nasa\.gov|tiles\.maps\.eox\.at)/, async (route) => {
  const q = Object.fromEntries(new URL(route.request().url()).searchParams)
  wmsRequests++
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' },
    body: synthetic(+q.width, +q.height),
  })
})

/**
 * THE ONE THING LOCALHOST GETS WRONG about a cold switch into map mode.
 *
 * Map mode's base map (`drawn-world.webp`, 391 kB decoding to 4096x2048) is
 * fetched at the switch — the drawn map is lazy by contract — while its TILES
 * come from a worker that only needs the 54 kB coarse geometry. Over a real
 * connection those two races, and the tiles can easily win. Off the dev server
 * they cannot: the texture is a memcpy away. `DRAWN_DELAY_MS` puts a modest
 * network in front of that one file and nothing else, which is the reader's
 * ordinary condition rather than a contrived one.
 */
const DRAWN_DELAY_MS = Number(process.env.DRAWN_DELAY_MS ?? 0)
if (DRAWN_DELAY_MS) {
  await page.route(/drawn-world/, async (route) => {
    console.log(`   [net] drawn-world requested, holding it ${DRAWN_DELAY_MS} ms`)
    await new Promise((r) => setTimeout(r, DRAWN_DELAY_MS))
    await route.continue()
  })
}

let cdp
const shot = async (name) => {
  if (!cdp) cdp = await page.context().newCDPSession(page)
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = join(SHOTS, `${TAG}-${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

/**
 * What the frame is made of, by hue.
 *
 *  · `painted` — strongly magenta: a streamed IMAGERY tile painted as ground.
 *  · `photo` — the photographed BASE map, by the two directions the drawn
 *    palette never goes: COOL (b above both others — the sea of a photograph
 *    against a duck-egg wash whose b is 4 BELOW its own g) and GREEN (g above
 *    both others by a margin the duck-egg's own 4 cannot reach — vegetation).
 *    One test alone is not enough: a frame over land has almost no blue water
 *    in it, and a frame over ocean almost no vegetation.
 *
 * Both are counted twice: over the whole frame, and over the outer eighth,
 * which is where charge 1 puts them ("on edges of screen").
 */
const classify = async (file) => {
  const img = await loadImage(file)
  const c = createCanvas(img.width, img.height)
  c.getContext('2d').drawImage(img, 0, 0)
  const { data, width, height } = c.getContext('2d').getImageData(0, 0, img.width, img.height)
  let painted = 0
  let paintedEdge = 0
  let photo = 0
  let photoEdge = 0
  const bx = Math.round(width / 8)
  const by = Math.round(height / 8)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const rim = x < bx || x >= width - bx || y < by || y >= height - by
      if (r >= 60 && b >= 60 && g < 0.5 * Math.min(r, b)) {
        painted++
        if (rim) paintedEdge++
      } else if (b - Math.max(r, g) > 20 || g - Math.max(r, b) > 12) {
        photo++
        if (rim) photoEdge++
      }
    }
  }
  const pc = (n) => +((n / (width * height)) * 100).toFixed(2)
  // `painted` rather than `paint`: the probe below reports the uDetailPaint
  // UNIFORM under that name, and one of the two would have silently won.
  return {
    painted: pc(painted),
    paintedEdge: pc(paintedEdge),
    photo: pc(photo),
    photoEdge: pc(photoEdge),
  }
}

/**
 * The three uniforms that decide what is assembled, and WHOSE tiles the index
 * addresses.
 *
 * The index texture is the published one — the bytes the shader reads — so
 * decoding its slot codes and looking each up in the atlas's own slot map
 * answers "is map mode painting Sentinel tiles" as a fact rather than as an
 * inference from colour.
 */
const probe = () =>
  page.evaluate(() => {
    const u = window.__globe.globeMaterial().uniforms
    const d = window.__detail
    const held = d.atlas.slots.held
    const bySlot = new Map()
    for (const [key, slot] of held) bySlot.set(slot.index, key)
    const bytes = d.atlas.index.image.data
    const labels = new Set()
    for (let i = 0; i < bytes.length; i += 4) {
      if (!bytes[i]) continue
      const key = bySlot.get(bytes[i] - 1)
      if (key) labels.add(key.split('/').slice(3).join('/'))
    }
    /** Which file the base-map samplers are actually bound to, by name. */
    const bound = (s) => {
      const img = s.value?.image
      const url = img && (img.currentSrc || img.src)
      return url ? String(url).split('/').pop() : null
    }
    return {
      mix: +u.uDetailMix.value.toFixed(2),
      paint: u.uDetailPaint.value,
      z: u.uDetailZ.value,
      eraA: bound(u.uEraA),
      eraB: bound(u.uEraB),
      paper: +u.uPaperMix.value.toFixed(2),
      indexed: [...labels],
      slots: [...new Set([...held.keys()].map((k) => k.split('/').slice(3).join('/')))],
      status: d.status,
      label: d.sourceLabel,
      resident: d.index?.resident ?? 0,
    }
  })

/**
 * WHAT FRACTION OF THE FRAME HAS A TILE UNDER IT, sampled on the screen.
 *
 * The pixel classifiers above can only see a source they can name by colour;
 * this asks the question charge 1 actually asks — "is there a block of the
 * frame the streamed layer is not covering, and is it at the edge" — by
 * unprojecting a grid of screen points back to the sphere and resolving each
 * one through the same two grids the shader resolves through. A point with
 * neither a target nor a parent slot is a point painted with the BASE MAP,
 * which in map mode is the drawn world at level 3 and in the moments after a
 * switch may still be the photograph.
 */
const coverage = (n = 20) =>
  page.evaluate((n) => {
    const g = window.__globe
    const d = window.__detail
    const idx = d.index
    const canvas = document.querySelector('.scene-container canvas') ?? document.querySelector('canvas')
    const r = canvas.getBoundingClientRect()
    const bytes = d.atlas.index.image.data
    const cell = (grid, row, col, rowIdx, cols) => {
      const gx = (((col - grid[0]) % cols) + cols) % cols
      const gy = rowIdx - grid[1]
      if (gx < 0 || gy < 0 || gx >= grid[2] || gy >= grid[3] || gx >= 16 || gy >= 8) return 0
      return bytes[((row + gy) * 16 + gx) * 4]
    }
    let on = 0
    let off = 0
    let offEdge = 0
    const misses = []
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const sx = r.left + ((ix + 0.5) / n) * r.width
        const sy = r.top + ((iy + 0.5) / n) * r.height
        const c = g.toGlobeCoords(sx, sy)
        if (!c) continue
        let covered = false
        if (idx) {
          const span = 360 / 2 ** idx.z
          const col = Math.floor((c.lng + 180) / span)
          const row = Math.floor((90 - c.lat) / span)
          const t = cell(idx.grid, 0, col, row, 2 ** idx.z)
          const p = cell(idx.parent, 8, col >> 1, row >> 1, 2 ** (idx.z - 1))
          covered = t !== 0 || p !== 0
        }
        if (covered) on++
        else {
          off++
          const edge = ix < n / 8 || ix >= n - n / 8 || iy < n / 8 || iy >= n - n / 8
          if (edge) offEdge++
          if (misses.length < 12) misses.push([ix, iy])
        }
      }
    }
    return {
      onGlobe: on + off,
      uncoveredPct: on + off ? +((off / (on + off)) * 100).toFixed(1) : 0,
      uncoveredEdgePct: on + off ? +((offEdge / (on + off)) * 100).toFixed(1) : 0,
      misses,
      z: idx?.z ?? null,
      grid: idx?.grid ?? null,
    }
  }, n)

const report = []
const record = async (name, note) => {
  const p = await probe()
  const cov = await coverage()
  // A FRAME, BEFORE THE PHOTOGRAPH OF IT. The render loop is frame-on-demand
  // and a frame of this surface costs about a second on a software rasteriser,
  // so a screenshot taken the instant a uniform changes shows the frame BEFORE
  // it — which reads as the fix not working when what it is, is a stale
  // framebuffer.
  await page.evaluate(() => window.__wake?.(1500))
  await page.waitForTimeout(1300)
  const file = await shot(name)
  const k = await classify(file)
  report.push({ name, note, ...k, ...p, cov })
  console.log(
    `  ${name.padEnd(26)} painted-imagery ${String(k.painted).padStart(6)}% ` +
      `photographic-base ${String(k.photo).padStart(6)}% (edge ${String(k.photoEdge).padStart(6)}%)  ` +
      `uncovered ${String(cov.uncoveredPct).padStart(5)}% (edge ${String(cov.uncoveredEdgePct).padStart(5)}%)  ` +
      `base ${p.eraA} paper ${p.paper} mix ${p.mix} paint ${p.paint} indexed[${p.indexed.join(' | ')}]`,
  )
  return k
}

// ---------------------------------------------------------------- the page
await page.goto(base, { timeout: 120_000 })
await page.waitForFunction(() => !!window.__globe && !!window.__detail, null, { timeout: 120_000 })
await page.addStyleTag({
  content:
    '*, *::before, *::after { animation: none !important; transition: none !important; }' +
    // The reader panel opens with a selection and covers half the frame; this
    // instrument is about the ground under it.
    '.panel { display: none !important; }',
})
await page.evaluate(() => {
  window.__time.setRange({ start: -3000, end: 2026 })
  window.__time.setSelection(-600, 2026)
  window.__setTime(1944.43)
})
// The deferred base maps, the cloud upscale and the first frames all land on
// their own schedule and none of them belongs inside a measured window.
await page.waitForTimeout(12000)

const pov = (p, ms = 0) => page.evaluate(([p, ms]) => window.__globe.pointOfView(p, ms), [p, ms])
const setMode = (m) => page.evaluate((m) => window.__settings.setMode(m), m)

/** Nothing on the wire, nothing waiting for a slot, nothing dissolving. */
const quiesce = async (tries = 40) => {
  let seen = -1
  for (let i = 0; i < tries; i++) {
    const busy = await page.evaluate(() => window.__detail.animating === true)
    if (!busy && seen === wmsRequests) return
    seen = wmsRequests
    await page.waitForTimeout(500)
  }
}

/**
 * Sample the switch as it happens.
 *
 * The name carries the WALL time since the toggle, not the nominal one: a
 * sample costs a screenshot, four hundred raycasts and a megapixel of
 * classification on a machine with a software rasteriser, so the interval
 * between samples is the machine's, and pretending otherwise would put the
 * wrong timestamp on the evidence.
 */
const burst = async (prefix, n = 6, every = 400) => {
  const t0 = Date.now()
  for (let i = 0; i < n; i++) {
    await record(`${prefix}-t${String(Date.now() - t0).padStart(5, '0')}`, `${Date.now() - t0} ms after the toggle`)
    await page.waitForTimeout(every)
  }
}

const SECTIONS = process.env.SECTIONS ?? 'ABCD'

// ------------------------------------- A. the COLD switch, camera parked at sea
if (SECTIONS.includes('A')) {
// The Channel at d-day's own camera: half water, so the photographed base map
// has somewhere to show and the classifier has something to count.
console.log('\nA. cold switch into map mode, camera parked over the Channel')
await setMode('realistic')
// Twice, and not for luck: globe.gl re-derives `controls.minDistance` from the
// camera's own near plane, so one jump from world view to a low altitude is
// clamped to the floor the PREVIOUS near plane implied and the descent stalls
// (recorded in docs/design/high-speed-imagery.md). The second call starts from
// the near plane the first one left.
await pov({ lat: 49.35, lng: -0.78, altitude: 0.05 })
await pov({ lat: 49.35, lng: -0.78, altitude: 0.05 })
await quiesce()
await page.waitForTimeout(1500)
await record('a0-realistic-settled', 'imagery mode, the stand-in source resident')
await setMode('schematic')
await burst('a1-cold', 10, 300)
await quiesce()
await page.waitForTimeout(2000)
await record('a2-cold-settled', 'map mode, settled')
}

// ------------------------------------------- B. the WARM switch, camera parked
if (SECTIONS.includes('B')) {
console.log('\nB. back to imagery, then a warm switch, camera never touched')
await setMode('realistic')
await quiesce()
await page.waitForTimeout(2500)
await record('b0-realistic-again', 'imagery mode again, same camera')
await setMode('schematic')
await burst('b1-warm', 6, 300)
await page.waitForTimeout(8000)
await record('b2-warm-later', 'ten seconds after the warm switch, camera untouched')
await pov({ lat: 49.4, lng: -0.7, altitude: 0.05 })
await quiesce()
await page.waitForTimeout(2000)
await record('b3-warm-after-nudge', 'after one small camera move')
}

// ------------------------------------------------- C. with a path event focused
if (SECTIONS.includes('C')) {
console.log('\nC. the same switch with a path event focused')
await setMode('realistic')
await page.evaluate(() => {
  window.__events.select('d-day')
  const t = window.__events.mapTarget('d-day')
  if (t) window.__globe.pointOfView(t, 0)
})
await page.waitForTimeout(2500)
await quiesce()
await page.waitForTimeout(1500)
await record('c0-focus-realistic', 'the event focused, imagery mode')
await setMode('schematic')
await burst('c1-focus-switch', 8, 300)
await page.waitForTimeout(8000)
await record('c2-focus-later', 'ten seconds later, camera untouched')
}

/**
 * D. THE GESTURE INSIDE MAP MODE — the one charge 1 describes.
 *
 * A reader in map mode pans and zooms; what they report is a block at the edge
 * of the screen that is not the drawn map. `coverage` says whether the streamed
 * layer reaches the edge of the frame at all, at rest and in motion, so the
 * question is answered about the pipeline rather than about a colour.
 */
if (SECTIONS.includes('D')) {
console.log('\nD. pan and zoom inside map mode, watching the edges of the frame')
await page.evaluate(() => window.__events.dismiss())
await setMode('schematic')
await pov({ lat: 49.35, lng: -0.78, altitude: 0.05 })
await pov({ lat: 49.35, lng: -0.78, altitude: 0.05 })
await quiesce()
await page.waitForTimeout(2000)
await record('d0-settled', 'the control: settled map mode')
const STEPS = [
  { lat: 49.5, lng: -0.5, altitude: 0.05 },
  { lat: 49.8, lng: 0.1, altitude: 0.05 },
  { lat: 49.8, lng: 0.1, altitude: 0.012 },
  { lat: 49.9, lng: 0.3, altitude: 0.012 },
  { lat: 49.9, lng: 0.3, altitude: 0.2 },
  { lat: 50.4, lng: 1.2, altitude: 0.2 },
]
for (let i = 0; i < STEPS.length; i++) {
  await pov(STEPS[i])
  await page.waitForTimeout(900)
  await record(`d${i + 1}a-moving`, `step ${i + 1}, just after the move`)
  await quiesce()
  await page.waitForTimeout(2500)
  await record(`d${i + 1}b-rested`, `step ${i + 1}, rested`)
}
}

writeFileSync(join(SHOTS, `${TAG}-summary.json`), JSON.stringify(report, null, 2))
console.log(`\nwrote ${report.length} frames to ${SHOTS} as "${TAG}-*"`)
console.log(`WMS (stand-in) requests served: ${wmsRequests}`)

/**
 * THE VERDICT — two claims, both about map mode, both per frame.
 *
 * `paint === 1` is map mode saying so in the shader itself, which is the only
 * definition that cannot drift from what is drawn. Under it:
 *
 *  1. no PHOTOGRAPH. 1% is the floor this scene has anyway — the pins, the
 *    plan's teal thrusts and the blue route ink are all cool or green and are
 *    on screen throughout — so the bar is 2%, against the 39–52% the defect
 *    measured.
 *  2. no imagery TILE painted, and no imagery tile even addressed by the index:
 *    the atlas and the decoded cache are shared across the switch on purpose,
 *    and this is what says the sharing stays behind the label.
 */
const inMap = report.filter((r) => r.paint === 1)
const photographed = inMap.filter((r) => r.photo > 2)
const foreign = inMap.filter((r) => r.indexed.some((l) => !/^Drawn/.test(l)))
const magenta = inMap.filter((r) => r.painted > 0.2)
const failures = []
if (photographed.length)
  failures.push(
    `map mode showed the photographed base map in ${photographed.length} frame(s): ` +
      photographed.map((r) => `${r.name} ${r.photo}%`).join(', '),
  )
if (foreign.length)
  failures.push(
    `map mode's index addressed an imagery source in ${foreign.length} frame(s): ` +
      foreign.map((r) => `${r.name} [${r.indexed.join(' | ')}]`).join(', '),
  )
if (magenta.length)
  failures.push(
    `map mode painted imagery tiles in ${magenta.length} frame(s): ` +
      magenta.map((r) => `${r.name} ${r.painted}%`).join(', '),
  )
if (failures.length) {
  console.log(`\nFAIL\n  ${failures.join('\n  ')}`)
  process.exitCode = 1
} else {
  console.log(`\nPASS  ${inMap.length} map-mode frames: no photographed ground, no foreign tiles`)
}

await browser.close()
await server.close()
