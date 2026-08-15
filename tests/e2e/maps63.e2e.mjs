/**
 * ROUND 63 — "it's still full of mistakes even after so many tries. For example
 * modern India."
 *
 * Two jobs, one script. REPRODUCE: South Asia at 1995 / 2010 / 2024, where the
 * reader says the map is wrong. AUDIT: a camera tour of the whole planet at
 * 2024 (and spot years), so the next defect is found by looking rather than by
 * waiting for the reader to find it.
 *
 * Run:  node tests/e2e/maps63.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots63/maps), SHOT_TAG
 *       (default 'after'), SHOT_ONLY (regex over camera names),
 *       PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots63/maps'
const tag = process.env.SHOT_TAG ?? 'after'
mkdirSync(shots, { recursive: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const server = await createServer({ root, server: { port: 0 }, logLevel: 'warn' })
await server.listen()
const base = `http://localhost:${server.httpServer.address().port}`

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--no-proxy-server'],
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

const ready = (page) =>
  page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe, null, { timeout: 90_000 })

const look = async (page, lat, lng, altitude, ms = Number(process.env.SETTLE_MS ?? 9000)) => {
  await page.evaluate(
    ([a, b, c]) => window.__globe.pointOfView({ lat: a, lng: b, altitude: c }),
    [lat, lng, altitude],
  )
  await page.waitForTimeout(ms)
  await page.evaluate(() => window.__wake?.(400))
  await page.waitForTimeout(700)
}

/** A year, with a selection band tight enough that the borders layer is on. */
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
 * THE REPRODUCTION first (a*), then the world tour (b*..).
 *
 * Every tour camera is at 2024 unless it says otherwise: the modern layer is
 * the one a reader lands on, and it is the one the corpus has least to say
 * about. The spot years exist because the polity fills are dated and the
 * modern ink mostly is not.
 */
const CAMERAS = [
  // ---- the complaint, framed the way the reader framed it
  { name: 'a1-india2024-map', year: 2024, mode: 'schematic', view: [22, 80, 0.55] },
  { name: 'a2-india1995-map', year: 1995, mode: 'schematic', view: [22, 80, 0.55] },
  { name: 'a3-india2010-map', year: 2010, mode: 'schematic', view: [22, 80, 0.55] },
  // close on the two frontiers a fill can get wrong: the Gangetic north
  // (Nepal, Bhutan, Sikkim) and the delta (Bangladesh).
  { name: 'a4-nepal2024-map', year: 2024, mode: 'schematic', view: [28, 84, 0.25] },
  { name: 'a5-bengal2024-map', year: 2024, mode: 'schematic', view: [23.5, 90, 0.25] },
  { name: 'a6-kashmir2024-map', year: 2024, mode: 'schematic', view: [34, 76, 0.25] },
  { name: 'a7-india2024-realistic', year: 2024, mode: 'realistic', view: [22, 80, 0.55] },

  // ---- the world at 2024, region by region
  { name: 'b1-world2024-asia', year: 2024, mode: 'schematic', view: [25, 90, 1.9] },
  { name: 'b3-europe2024', year: 2024, mode: 'schematic', view: [50, 15, 0.7] },
  { name: 'b5-eastasia2024', year: 2024, mode: 'schematic', view: [35, 110, 0.7] },
  { name: 'b6-seasia2024', year: 2024, mode: 'schematic', view: [10, 105, 0.7] },
  { name: 'b7-centralasia2024', year: 2024, mode: 'schematic', view: [43, 75, 0.7] },
  { name: 'b8-africa2024', year: 2024, mode: 'schematic', view: [5, 20, 1.4] },
  { name: 'c1-namerica2024', year: 2024, mode: 'schematic', view: [45, -100, 0.9] },
  { name: 'c2-samerica2024', year: 2024, mode: 'schematic', view: [-15, -60, 0.9] },
  { name: 'c4-mongolia2024', year: 2024, mode: 'schematic', view: [46, 103, 0.5] },
  { name: 'c5-indochina2024', year: 2024, mode: 'schematic', view: [17, 106, 0.4] },
  { name: 'c6-ukraine2024', year: 2024, mode: 'schematic', view: [48, 34, 0.5] },
  { name: 'c7-alaska2024', year: 2024, mode: 'schematic', view: [62, -152, 0.6] },

  // ---- the spot years: the fills are dated, the modern ink mostly is not
  { name: 'd1-world1995-asia', year: 1995, mode: 'schematic', view: [25, 90, 1.9] },
  { name: 'd2-eastasia2005', year: 2005, mode: 'schematic', view: [35, 110, 0.7] },
  { name: 'd3-namerica1995', year: 1995, mode: 'schematic', view: [45, -100, 0.9] },
  { name: 'd4-india1950-map', year: 1950, mode: 'schematic', view: [22, 80, 0.55] },
  { name: 'd5-india1970-map', year: 1970, mode: 'schematic', view: [22, 80, 0.55] },
]

const only = process.env.SHOT_ONLY ? new RegExp(process.env.SHOT_ONLY) : undefined
const results = []
for (const cam of CAMERAS) {
  if (only && !only.test(cam.name)) continue
  console.log(`\n${cam.name}`)
  await ready(page)
  await setMode(page, cam.mode)
  await setYear(page, cam.year)
  await look(page, ...cam.view)
  const file = await shot(page, cam.name)
  const drawn = await page.evaluate(() => ({
    polys: window.__globe.polygonsData().length,
    nations: (window.__nations?.current ?? []).map((n) => n.id),
    calls: window.__globe.renderer?.().info?.render?.calls ?? null,
    triangles: window.__globe.renderer?.().info?.render?.triangles ?? null,
  }))
  console.log(`      ${file}`)
  console.log(`      ${drawn.polys} polygons, polities [${drawn.nations.join(', ')}]`)
  results.push({ ...cam, ...drawn })
}

writeFileSync(join(shots, `${tag}-summary.json`), JSON.stringify(results, null, 2))
console.log(`\nwrote ${results.length} frames to ${shots} as "${tag}-*"`)

await browser.close()
await server.close()
