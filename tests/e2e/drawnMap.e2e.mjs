/**
 * The drawn map, in a browser.
 *
 * Every claim the drawn map makes is a claim about PIXELS: that no blue-marble
 * texel survives anywhere in map mode, that the ink reads on parchment, that a
 * battle plan drawn over it is still legible, that the toggle switches the
 * whole surface. None of that is decidable from a unit test, so this drives the
 * real app through the real pipeline under SwiftShader and both looks and
 * measures.
 *
 * What it checks, in order:
 *
 *   a. drawn world view — and the strongest assertion in the file: sample the
 *      globe's pixels and assert none of them is blue. Blue Marble's ocean is
 *      the most distinctive thing on the realistic globe and it is what would
 *      show through anywhere the drawn base texture had not taken over.
 *   b. continental zoom (Europe) — the streamed drawn tiles have arrived.
 *   c. regional zoom — the coastline detail: double ink and the shoreline wash.
 *   d. a WWII battle plan over the drawn map.
 *   e. the side toggle, both states and hovered.
 *   f. a phone.
 *   g. a paleo year in drawn mode — the paper grade.
 *   h. realistic mode, unchanged.
 *
 * Run:  node tests/e2e/drawnMap.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots49), PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots49'
mkdirSync(shots, { recursive: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

let passed = 0
const failures = []
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(`${name}: ${err.message}`)
    console.log(`  FAIL ${name}\n       ${err.message}`)
  }
}
const ok = (cond, what) => {
  if (!cond) throw new Error(what)
}

const server = await createServer({ root, server: { port: 0 }, logLevel: 'warn' })
await server.listen()
const base = `http://localhost:${server.httpServer.address().port}`

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
})

const sessions = new Map()
const shot = async (target, name) => {
  let cdp = sessions.get(target)
  if (!cdp) sessions.set(target, (cdp = await target.context().newCDPSession(target)))
  await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 })
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = join(shots, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

/**
 * Colour statistics over a captured frame.
 *
 * From the SCREENSHOT rather than from the live canvas, and that is not a
 * convenience: the globe's WebGL context has no preserveDrawingBuffer, so
 * `drawImage(glCanvas)` after the frame has been composited copies a cleared
 * buffer — measured, 0 samples above the background threshold. The compositor's
 * own capture is the only readback that is guaranteed to be the frame that was
 * on screen.
 *
 * The mask keeps the middle of the globe and nothing else: a centred disc of
 * 60% of the frame height, minus anything as dark as the board it sits on. That
 * excludes the bars, the timeline, the pins round the rim and the limb's own
 * antialiasing. What it does NOT exclude is a pin in the MIDDLE of the disc,
 * which is why (a) hides them before it captures — see `hideOverlays`.
 *
 * `warm`, `cool` and `chroma` are round 52's: the drawn map is two grounds now
 * (warm parchment, a duck-egg sea), so "is it a drawing" is no longer a claim
 * about one tone. See the checks in (a).
 */
async function frameStats(file) {
  const img = await loadImage(file)
  const c = createCanvas(img.width, img.height)
  const g = c.getContext('2d')
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, c.width, c.height).data
  const cx = c.width / 2
  const cy = c.height / 2
  const rr = (c.height * 0.3) ** 2
  let n = 0
  let blue = 0
  let warm = 0
  let cool = 0
  let chroma = 0
  let chromaMax = 0
  let sr = 0
  let sg = 0
  let sb = 0
  let min = 255
  let max = 0
  for (let y = 0; y < c.height; y += 2) {
    for (let x = 0; x < c.width; x += 2) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > rr) continue
      const i = (y * c.width + x) * 4
      const [r, gr, b] = [d[i], d[i + 1], d[i + 2]]
      if (r + gr + b < 110) continue
      n++
      sr += r
      sg += gr
      sb += b
      const l = 0.2126 * r + 0.7152 * gr + 0.0722 * b
      min = Math.min(min, l)
      max = Math.max(max, l)
      const ch = Math.max(r, gr, b) - Math.min(r, gr, b)
      chroma += ch
      chromaMax = Math.max(chromaMax, ch)
      if (b > r + 18 && b > gr + 10) blue++
      if (r > b + 12) warm++
      if (b > r + 4) cool++
    }
  }
  return {
    n,
    blue: blue / n,
    warm: warm / n,
    cool: cool / n,
    chroma: chroma / n,
    chromaMax,
    mean: [sr / n, sg / n, sb / n],
    min,
    max,
  }
}

/**
 * Hide everything that is not the map: the CSS2D pins, their labels and the
 * chrome that floats over the globe.
 *
 * (a) asserts a property of the DRAWN SURFACE — that no blue-marble texel
 * survives anywhere in map mode — and a pin is not the surface. It used to get
 * away with measuring both: a blue cluster badge in the middle of the disc is
 * about half a percent of the samples, and the threshold was half a percent.
 * Round 52 spent that margin (the sea is a duck-egg wash now and the check had
 * to be re-read anyway), so the measurement is made to mean what it says instead
 * of being tuned around what it accidentally included.
 */
const hideOverlays = async (page, hidden) =>
  page.evaluate((on) => {
    const id = 'e2e-hide-overlays'
    document.getElementById(id)?.remove()
    if (!on) return
    const el = document.createElement('style')
    el.id = id
    el.textContent =
      '.event-pin, .drawing-label, .scene-label, [data-test="mode-toggle"] { visibility: hidden !important; }'
    document.head.append(el)
  }, hidden)

/**
 * DPR 1 for the desktop pass, and this is a measurement rather than a taste:
 * SwiftShader renders this surface shader at roughly a megapixel a second, so a
 * 1280x800 frame at DPR 2 is four megapixels — and a deep-zoom frame, where the
 * atlas branch adds four texture taps per fragment, took minutes to capture.
 * The phone pass keeps a retina ratio, because a phone frame is small.
 */
async function open(width, height, deviceScaleFactor = 1) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor })
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
  await page.goto(base, { timeout: 90_000 })
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
  await page.waitForTimeout(1500)
  return page
}

/** Put the camera somewhere exact and let the streamer catch up. */
const look = async (page, lat, lng, altitude, ms = 5000) => {
  await page.evaluate(
    ([a, b, c]) => window.__globe.pointOfView({ lat: a, lng: b, altitude: c }),
    [lat, lng, altitude],
  )
  await page.waitForTimeout(ms)
  // the pump parks when nothing is changing; a wake guarantees the frame the
  // screenshot is about actually got drawn
  await page.evaluate(() => window.__wake?.(400))
  await page.waitForTimeout(600)
}

const setMode = async (page, mode) => {
  await page.evaluate((m) => window.__settings.setMode(m), mode)
  await page.waitForTimeout(300)
}

/* ================================================== (a) the drawn world view */
console.log('\n(a) drawn world view')
const page = await open(1280, 800)
await setMode(page, 'schematic')
await look(page, 20, 10, 2.4, 7000)
await hideOverlays(page, true)
await page.evaluate(() => window.__wake?.(400))
await page.waitForTimeout(600)
const drawnWorld = await frameStats(await shot(page, 'a-drawn-world'))
await hideOverlays(page, false)
console.log(`      surface mean rgb ${drawnWorld.mean.map((v) => v.toFixed(0)).join(',')}`)
console.log(
  `      blue-dominant ${(drawnWorld.blue * 100).toFixed(2)}%   ` +
    `warm ${(drawnWorld.warm * 100).toFixed(1)}%   cool ${(drawnWorld.cool * 100).toFixed(1)}%   ` +
    `chroma ${drawnWorld.chroma.toFixed(1)} mean / ${drawnWorld.chromaMax} worst`,
)

await check('no blue-marble pixel survives in drawn mode', () => {
  ok(drawnWorld.n > 5000, `only ${drawnWorld.n} surface samples`)
  ok(drawnWorld.blue < 0.005, `${(drawnWorld.blue * 100).toFixed(2)}% of the globe is blue`)
})
/**
 * ROUND 52 — this check used to read "the drawn globe is parchment: warm
 * everywhere", and 99% of the globe reading warm was exactly the reported
 * defect: *"the sea is just another shade"*. Warm sea under warm land is one
 * tone with the continents embossed on it.
 *
 * So the claim becomes the one the palette now makes, and it is harder to
 * satisfy than the one it replaces — a poster passes "warm everywhere" as easily
 * as a drawing does, and it cannot pass a bound on chroma:
 *
 *  · there is real parchment (the land is warm), and real water (the sea is not);
 *  · together they cover the sheet — nothing on it is neither;
 *  · and the whole plate is LOW CHROMA. This is the "not a crazy coloured
 *    painting" line, expressed as a number: the drawn map's most colourful tone
 *    is its own warm paper.
 */
await check('the drawn globe is two grounds of one aged sheet', () => {
  ok(drawnWorld.warm > 0.25, `only ${(drawnWorld.warm * 100).toFixed(1)}% of the globe reads warm`)
  ok(drawnWorld.cool > 0.25, `only ${(drawnWorld.cool * 100).toFixed(1)}% of the globe reads cool`)
  ok(
    drawnWorld.warm + drawnWorld.cool > 0.9,
    `${((1 - drawnWorld.warm - drawnWorld.cool) * 100).toFixed(1)}% of the globe is neither ground`,
  )
  // measured 25.2 with the era's nation washes on the globe; a poster is 60+
  ok(drawnWorld.chroma < 34, `mean chroma ${drawnWorld.chroma.toFixed(1)} is a poster, not paper`)
})

/* ============================================== (b) continental zoom, Europe */
console.log('\n(b) continental zoom — Europe')
await look(page, 48, 10, 0.35, 9000)
await shot(page, 'b-drawn-europe')
const streamed = await page.evaluate(() => ({
  status: window.__detail.status,
  source: window.__detail.sourceLabel,
  z: window.__detail.index?.z,
  resident: window.__detail.index?.resident,
  ms: window.__drawn?.times.slice(-40) ?? [],
  rendering: window.__rendering?.(),
}))
const ms = streamed.ms
const mean = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0
console.log(`      pump still awake after the settle: ${streamed.rendering}`)
console.log(
  `      ${streamed.source} @ z${streamed.z}, ${streamed.resident} tiles resident; ` +
    `render ${mean.toFixed(2)} ms mean / ${Math.max(0, ...ms).toFixed(2)} ms worst (n=${ms.length})`,
)
await check('drawn tiles stream through the imagery pipeline', () => {
  ok(streamed.status === 'ready', `status ${streamed.status}`)
  ok(/Drawn/.test(streamed.source), `source is ${streamed.source}`)
  ok(streamed.resident > 4, `only ${streamed.resident} tiles resident`)
})
await check('a tile renders inside the 8 ms budget in the worker', () => {
  ok(ms.length > 0, 'no render times were recorded')
  ok(mean < 8, `mean render ${mean.toFixed(2)} ms`)
})

/* ============================================ (c) regional zoom — coast ink */
console.log('\n(c) regional zoom — coastline detail')
// the Aegean: coast and islands, at the density that shows the double ink
await look(page, 37.6, 24.5, 0.055, 9000)
const contrast = await frameStats(await shot(page, 'c-drawn-coast'))
console.log(`      luminance ${contrast.min.toFixed(0)} … ${contrast.max.toFixed(0)}`)
await check('the ink reaches the page: a dark line on light paper', () => {
  // this is the shader's uDetailRange doing its work — under the imagery clamp
  // the same coastline came back at 0.55 of the paper, i.e. grey
  ok(contrast.min < 110, `darkest surface pixel is ${contrast.min.toFixed(0)}`)
  ok(contrast.max > 170, `lightest surface pixel is only ${contrast.max.toFixed(0)}`)
})

/* ================================================ (d) a battle plan on paper */
console.log('\n(d) a WWII battle plan over the drawn map')
await page.evaluate(() => window.__setTime(1941))
await page.waitForFunction(() => window.__events.byId('barbarossa'), null, { timeout: 60_000 })
await page.evaluate(() => {
  window.__events.select('barbarossa')
  window.__events.enterFocus?.('barbarossa')
})
await page.waitForTimeout(1200)
await look(page, 52, 30, 0.5, 7000)
await shot(page, 'd-drawn-battleplan')
const plan = await page.evaluate(() => ({
  labels: document.querySelectorAll('.drawing-label').length,
  paper: document.querySelectorAll('.drawing-label--paper').length,
  ink: getComputedStyle(document.querySelector('.drawing-label') ?? document.body).color,
}))
console.log(`      ${plan.labels} labels, ${plan.paper} on paper, ink ${plan.ink}`)
await check('drawing labels invert for paper', () => {
  ok(plan.labels > 0, 'the plan drew no labels')
  ok(plan.paper === plan.labels, `${plan.paper} of ${plan.labels} labels know they are on paper`)
  // dark letters, not the white ones tuned for satellite ground
  const [r, g, b] = plan.ink.match(/\d+/g).map(Number)
  ok(r + g + b < 240, `label ink is ${plan.ink}`)
})
await page.evaluate(() => {
  window.__events.focusBack?.()
  window.__events.select(null)
})
await page.waitForTimeout(600)

/* ========================================================= (e) the toggle */
console.log('\n(e) the side toggle')
await look(page, 20, 10, 2.4, 3000)
const box = await page.evaluate(() => {
  const el = document.querySelector('[data-test="mode-toggle"]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
})
console.log(`      toggle at ${box && `${box.x.toFixed(0)},${box.y.toFixed(0)} ${box.w}x${box.h}`}`)
await check('the toggle is on the right edge, clear of the bars', () => {
  ok(box, 'no toggle in the document')
  ok(box.right > 1280 - 60, `right edge at ${box.right}`)
  ok(box.y > 58 && box.y + box.h < 800 - 92, `vertically at ${box.y}..${box.y + box.h}`)
})
await shot(page, 'e1-toggle-map-state')
await page.hover('[data-test="mode-toggle-realistic"]')
await page.waitForTimeout(400)
await shot(page, 'e2-toggle-hover')
await page.click('[data-test="mode-toggle-realistic"]')
await page.waitForTimeout(2500)
await shot(page, 'e3-toggle-globe-state')
await check('the toggle drives the mode both ways', async () => {
  ok((await page.evaluate(() => window.__settings.mode)) === 'realistic', 'click did not switch')
  await page.click('[data-test="mode-toggle-schematic"]')
  await page.waitForTimeout(300)
  ok((await page.evaluate(() => window.__settings.mode)) === 'schematic', 'click back did not switch')
})
await check('and so does the keyboard', async () => {
  await page.focus('[data-test="mode-toggle-schematic"]')
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(200)
  ok((await page.evaluate(() => window.__settings.mode)) === 'realistic', 'ArrowUp did nothing')
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(200)
  ok((await page.evaluate(() => window.__settings.mode)) === 'schematic', 'ArrowDown did nothing')
})

/* ============================================================ (g) deep time */
console.log('\n(g) a paleo year in drawn mode')
await page.evaluate(() => window.__setTime(-200_000_000))
await page.waitForTimeout(1000)
await look(page, 10, 10, 2.4, 6000)
const paper = await frameStats(await shot(page, 'g-drawn-paleo'))
console.log(`      paleo surface mean rgb ${paper.mean.map((v) => v.toFixed(0)).join(',')}`)
await check('a deep-time frame is printed, not photographed', () => {
  ok(paper.blue < 0.02, `${(paper.blue * 100).toFixed(1)}% of the Triassic globe is blue`)
  const [r, , b] = paper.mean
  ok(r > b, `mean red ${r.toFixed(0)} is not above mean blue ${b.toFixed(0)}`)
})
await page.evaluate(() => window.__setTime(1941))
await page.waitForTimeout(800)

/* ======================================================== (h) realistic mode */
console.log('\n(h) realistic mode — the regression check')
await setMode(page, 'realistic')
await look(page, 20, 10, 2.4, 8000)
const real = await frameStats(await shot(page, 'h-realistic-world'))
console.log(`      realistic surface mean rgb ${real.mean.map((v) => v.toFixed(0)).join(',')}`)
console.log(`      blue-dominant ${(real.blue * 100).toFixed(1)}%`)
await check('the photographed planet is untouched', () => {
  // Blue Marble against the same disc the drawn map was measured over, at the
  // same point of view. The mean is NOT expected to be blue — the camera is
  // over the Sahara — so what is asserted is the presence of ocean the drawn
  // map cannot contain, and the two orders of magnitude between them.
  ok(real.blue > 0.2, `only ${(real.blue * 100).toFixed(1)}% of the realistic globe is blue`)
  ok(
    real.blue > drawnWorld.blue * 20,
    `realistic ${(real.blue * 100).toFixed(1)}% vs drawn ${(drawnWorld.blue * 100).toFixed(2)}%`,
  )
})

/* ================================================================ (f) phone */
console.log('\n(f) phone, 390x844')
const phone = await open(390, 844, 2)
await phone.evaluate(() => window.__settings.setMode('schematic'))
await phone.waitForTimeout(400)
await phone.evaluate(() => window.__globe.pointOfView({ lat: 30, lng: 15, altitude: 2.2 }))
await phone.waitForTimeout(7000)
await phone.evaluate(() => window.__wake?.(400))
await phone.waitForTimeout(600)
await shot(phone, 'f-drawn-phone')
const phoneBox = await phone.evaluate(() => {
  const el = document.querySelector('[data-test="mode-toggle"]')
  const r = el.getBoundingClientRect()
  return { right: r.right, y: r.y, bottom: r.bottom }
})
await check('the toggle stays reachable and clear on a phone', () => {
  ok(phoneBox.right > 390 - 50, `right edge at ${phoneBox.right}`)
  ok(phoneBox.bottom < 844 - 92, `bottom at ${phoneBox.bottom}, into the rail`)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  - ${f}`)
console.log(`shots in ${shots}`)
await browser.close()
await server.close()
process.exit(failures.length ? 1 : 0)
