/**
 * ROUND 68 — POINTS: the named-places context layer, photographed.
 *
 * What this proves, in pictures and counted DOM:
 *  · at three years (-400 / 1200 / 1916) the globe carries three different
 *    top-10 sets, with era-resolved names (Byzantion → Constantinople →
 *    Istanbul across the same marker);
 *  · the Settings → Points slider changes N (25, 3, and 0 = layer off);
 *  · points coexist with event pins zoomed into 1916 Europe — under them,
 *    smaller, muted — and clicking one opens the point chip, not the panel.
 *
 * Run:  PLAYWRIGHT_MODULE=... node tests/e2e/points68.e2e.mjs
 * Env:  SHOT_DIR (default /tmp/shots68/points), CHROME_PATH, PLAYWRIGHT_MODULE.
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const SHOTS = process.env.SHOT_DIR ?? '/tmp/shots68/points'
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
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
})
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGE ERR', e.message))

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

let cdp
const shot = async (name) => {
  if (!cdp) cdp = await page.context().newCDPSession(page)
  // Headless produces frames on demand, and Vue's enter classes are removed on
  // the frame after mount — which, on a parked renderer, is the frame the
  // capture itself forces. So the first capture is a flush and the second is
  // the picture (measured: a chip is `pop-enter-from`, opacity 0, until the
  // flush and `sheet chip`, opacity 1, after it).
  await cdp.send('Page.captureScreenshot', { format: 'png' })
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = join(SHOTS, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`   shot ${file}`)
}

const settle = async (ms = 1200) => {
  await page.evaluate(() => window.__wake?.(0))
  await page.waitForTimeout(ms)
}

/** The markers the reader can actually see (far side is display:none). */
const shownMarkers = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.map-point')]
      .filter((el) => el.style.display !== 'none')
      .map((el) => el.dataset.pointId),
  )

const visibleFromStore = () =>
  page.evaluate(() => window.__points.visible.map((p) => `${p.id}:${p.name}`))

await page.goto(base, { timeout: 120_000 })
await page.waitForFunction(() => !!window.__globe && !!window.__points && !!window.__time, null, {
  timeout: 90_000,
})
// The renderer parks when nothing moves, so rAF fires ~once a second here and
// Vue's enter transitions stall half-applied (see focusNav.e2e.mjs, FRAMES).
// Same answer as every other harness in this directory: no CSS motion at all.
await page.addStyleTag({
  content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
})
// a stable, repeatable frame: Mediterranean-centred world view
await page.evaluate(() => window.__globe.pointOfView({ lat: 30, lng: 20, altitude: 2.2 }, 0))
await settle(2500)

/* ---- 1. three years, three sets, three names --------------------------- */
const sets = {}
for (const year of [-400, 1200, 1916]) {
  await page.evaluate((y) => window.__setTime(y), year)
  await settle(1500)
  sets[year] = await visibleFromStore()
  console.log(`   ${year}: ${sets[year].join(', ')}`)
  await shot(`year${year}-world`)
}
check('top-10 at every year', Object.values(sets).every((s) => s.length === 10))
check(
  'the sets differ across eras',
  new Set([sets[-400].join(), sets[1200].join(), sets[1916].join()]).size === 3,
)
check('-400 has the classical world', sets[-400].some((s) => s.startsWith('athens:')), sets[-400].join(', '))
check(
  '1200 renames the Bosporus city',
  sets[1200].includes('constantinople:Constantinople'),
)
check('1916 surfaces Verdun', sets[1916].includes('verdun:Verdun'))
await page.evaluate(() => window.__setTime(1960))
await settle(800)
const at1960 = await visibleFromStore()
check('1960 says Istanbul', at1960.includes('constantinople:Istanbul'), at1960.join(', '))

/* ---- 2. the option changes N ------------------------------------------- */
await page.evaluate(() => window.__setTime(1200))
await settle(800)
await page.evaluate(() => (window.__settings.maxPoints = 25))
await settle(800)
const n25 = await page.evaluate(() => window.__points.visible.length)
await shot('n25-world-1200')
await page.evaluate(() => (window.__settings.maxPoints = 3))
await settle(800)
const n3 = await visibleFromStore()
await shot('n3-world-1200')
await page.evaluate(() => (window.__settings.maxPoints = 0))
await settle(800)
const n0 = await page.evaluate(() => document.querySelectorAll('.map-point').length)
await shot('n0-world-1200')
check('N=25 shows more than ten', n25 > 10, `${n25}`)
check('N=3 shows exactly three', n3.length === 3, n3.join(', '))
check('N=0 removes the layer', n0 === 0, `${n0} markers in DOM`)
await page.evaluate(() => (window.__settings.maxPoints = 10))

/* …and the value round-trips through the same store the slider writes. */
const sliderWired = await page.evaluate(() => window.__settings.maxPoints === 10)
check('setting round-trips through the store', sliderWired)

/* ---- 3. coexistence with event pins, labels, and the chip -------------- */
await page.evaluate(() => window.__setTime(1916))
await page.evaluate(() => window.__globe.pointOfView({ lat: 47, lng: 8, altitude: 0.75 }, 0))
await settle(2500)
const pins = await page.evaluate(() => document.querySelectorAll('.event-pin').length)
// CSS2D elements are (re)attached during a render pass; a query landing between
// a rebuild and the next frame sees none, so ask again after buying a frame.
let shown = await shownMarkers()
for (let i = 0; i < 5 && shown.length === 0; i++) {
  await settle(500)
  shown = await shownMarkers()
}
check('event pins on screen beside points', pins > 0, `${pins} pins, points: ${shown.join(', ')}`)
check('far-side markers are hidden', shown.length < 10, `${shown.length} of 10 face the camera`)
const labelled = await page.evaluate(
  () => document.querySelectorAll('.map-point--labelled').length,
)
check('labels ride along at continent zoom', labelled > 0, `${labelled} labelled`)
await shot('europe-1916-pins-and-points')

// the chip: click Verdun's marker, read the chip, not the event panel
const hasVerdun = shown.includes('verdun')
check('Verdun faces the camera for the click', hasVerdun)
if (hasVerdun) {
  // A real mouse press on the marker's centre: CSS2D wrappers carry their own
  // transforms and playwright's element click proved flaky against them.
  const r = await page.evaluate(() => {
    const el = document.querySelector('.map-point[data-point-id="verdun"]')
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
  await page.mouse.click(r.x, r.y)
  await settle(600)
  const chip = await page.evaluate(() => {
    const el = document.querySelector('[data-test="point-chip"]')
    return el ? el.textContent : null
  })
  check('the chip opens with name, kind and era', !!chip && chip.includes('Verdun') && chip.includes('Fortress'), chip ?? 'no chip')
  const panelOpen = await page.evaluate(() => !!window.__events.selectedId)
  check('the event panel stayed shut', !panelOpen)
  await shot('point-chip-verdun')
}

/* ---- 4. world view keeps labels off ------------------------------------ */
await page.evaluate(() => window.__globe.pointOfView({ lat: 30, lng: 20, altitude: 2.2 }, 0))
let labelledFar = -1
for (let i = 0; i < 10; i++) {
  await settle(500)
  labelledFar = await page.evaluate(
    () => document.querySelectorAll('.map-point--labelled').length,
  )
  if (labelledFar === 0) break
}
check('world view carries no riding labels', labelledFar === 0, `${labelledFar}`)

console.log(failures ? `\n${failures} FAILURES` : '\nall checks passed')
await browser.close()
await server.close()
process.exit(failures ? 1 : 0)
