/**
 * ROUND 55 — the two defects the reader reported *after* round 52 shipped:
 * "empires still ... sometimes overlap" and "border line sometimes vanishes in
 * certain places".
 *
 * Round 52's validator was green and its author said an overlap was no longer
 * possible. The reader was still right, twice, and this file is the camera that
 * shows why — so it is aimed at measurements, not at vibes:
 *
 *  1. OVERLAP. `OVERLAP_EPSILON` is a share of the SMALLER polygon. On an
 *     empire-scale polity half a percent is a province: France × Germany 1871
 *     shared 0.30 sq° of Alsace-Lorraine and passed, Han × Xiongnu shared a
 *     0.92 sq° band five degrees long down the Great Wall and passed. Both
 *     cameras are framed on the shared ground at a zoom where the double wash
 *     is the whole picture.
 *  2. VANISHED INK. The frontier is GL_LINES between the stored vertices, and a
 *     stored vertex pair can be thirty degrees apart (Russia's 1700 line along
 *     52°N). A straight chord thirty degrees long passes 217 km UNDER the
 *     surface it is supposed to be drawn on, so the planet eats all of it but
 *     the two stubs at its ends. The cap next to it does not do this because
 *     three-globe interpolates a contour along great circles at 2°.
 *
 * Run:  node tests/e2e/repro55.e2e.mjs
 * Env:  SHOT_DIR (default /tmp/shots55/repro), SHOT_TAG (default 'repro'),
 *       PLAYWRIGHT_MODULE, CHROME_PATH
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots55/repro'
const tag = process.env.SHOT_TAG ?? 'repro'
mkdirSync(shots, { recursive: true })

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

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
  await page.goto(base, { timeout: 90_000 })
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
  await page.waitForTimeout(1500)
  return page
}

const look = async (page, lat, lng, altitude, ms = 5000) => {
  await page.evaluate(
    ([a, b, c]) => window.__globe.pointOfView({ lat: a, lng: b, altitude: c }),
    [lat, lng, altitude],
  )
  await page.waitForTimeout(ms)
  await page.evaluate(() => window.__wake?.(400))
  await page.waitForTimeout(700)
}

const setYear = async (page, year) => {
  await page.evaluate((y) => {
    window.__time.setRange({ start: y - 400, end: y + 400 })
    window.__time.setSelection(y - 200, y + 200)
    window.__time.setTime(y)
  }, year)
  await page.waitForTimeout(600)
}

const setMode = async (page, mode) => {
  await page.evaluate((m) => window.__settings.setMode(m), mode)
  await page.waitForTimeout(500)
}

const page = await open(1280, 800)

/**
 * Each camera is a defect the reader can point at — polity, year, ground — or
 * the proof it is gone. Same list before and after, so the files pair by name.
 */
const CAMERAS = [
  // ---- OVERLAP the validator forgave, because 0.5% of a large polity is big.
  // Alsace-Lorraine: France and Germany both hold it 1871..1918. 0.30 sq°.
  { name: 'a-alsace1871-map', year: 1871, mode: 'schematic', view: [48.8, 7.6, 0.12] },
  { name: 'b-alsace1871-realistic', year: 1871, mode: 'realistic', view: [48.8, 7.6, 0.12] },
  // The Ordos loop: Han and Xiongnu both hold a 5°-long band, 0.92 sq°.
  { name: 'c-ordos-100bce-map', year: -100, mode: 'schematic', view: [42, 111, 0.25] },
  // Antioch / the Amuq: Egypt × Hittites, then Byzantium × Fatimid, same ground.
  { name: 'd-amuq-1450bce-map', year: -1450, mode: 'schematic', view: [36.1, 36.2, 0.1] },
  { name: 'e-amuq-1090-map', year: 1090, mode: 'schematic', view: [36.3, 36.2, 0.1] },
  // The Dniester mouth: Ottoman × Russia, 0.10 sq°.
  { name: 'f-dniester1840-map', year: 1840, mode: 'schematic', view: [46.1, 29.9, 0.1] },

  // ---- VANISHED INK: long stored chords buried under the sphere.
  // Russia 1700: one stored edge runs 120°E -> 70°E along 52°N. 30° of arc, a
  // chord 217 km under the surface at its middle.
  { name: 'g-siberia1700-map', year: 1700, mode: 'schematic', view: [52, 95, 1.4] },
  { name: 'h-siberia1700-realistic', year: 1700, mode: 'realistic', view: [52, 95, 1.4] },
  // The 49th parallel: -95 -> -122.8 in one edge, 18° of arc, both sides of it.
  { name: 'i-49th-1900-map', year: 1900, mode: 'schematic', view: [49, -108, 0.9] },
  { name: 'j-49th-1900-realistic', year: 1900, mode: 'realistic', view: [49, -108, 0.9] },
  // Rome's Saharan line: 29.5°N from 15°E to 29.5°E, 12.6° of arc.
  { name: 'k-rome117-sahara-map', year: 117, mode: 'schematic', view: [29.5, 22, 0.7] },
  // The USSR's southern line, and the widest year of the defect (1922: 28% of
  // all political ink on the globe is inside the planet).
  { name: 'l-world1922-map', year: 1922, mode: 'schematic', view: [40, 60, 2.2] },
  { name: 'm-world1922-realistic', year: 1922, mode: 'realistic', view: [40, 60, 2.2] },
  // Spain in the Andes, 1550: a 12° chord down the spine of South America.
  { name: 'n-andes1550-map', year: 1550, mode: 'schematic', view: [-13, -73, 0.9] },
]

const results = []
for (const cam of CAMERAS) {
  console.log(`\n${cam.name}`)
  await setMode(page, cam.mode)
  await setYear(page, cam.year)
  await look(page, ...cam.view)
  const file = await shot(page, cam.name)
  const drawn = await page.evaluate(() => ({
    polys: window.__globe.polygonsData().length,
    nations: (window.__nations?.current ?? []).map((n) => n.id),
    cost: window.__politicalCost?.() ?? null,
  }))
  console.log(`      ${file}`)
  console.log(`      ${drawn.polys} polygons, polities [${drawn.nations.join(', ')}]`)
  console.log(`      cost ${JSON.stringify(drawn.cost)}`)
  results.push({ ...cam, ...drawn })
}

writeFileSync(join(shots, `${tag}-summary.json`), JSON.stringify(results, null, 2))
console.log(`\nwrote ${CAMERAS.length} frames to ${shots} as "${tag}-*"`)

await browser.close()
await server.close()
