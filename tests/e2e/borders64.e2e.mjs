/**
 * ROUND 64 — "Modern borders are really great whereas old borders are really
 * bad. Fix it."
 *
 * A camera tour over the corpus's most-viewed HISTORICAL eras and regions, in
 * map mode, so the defect list is written by looking rather than by waiting
 * for the reader. Modern (1992+) is round 63's solved problem; every camera
 * here is pre-modern.
 *
 * Run:  node tests/e2e/borders64.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots64/borders/audit), SHOT_TAG
 *       (default 'audit'), SHOT_ONLY (regex over camera names),
 *       PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots64/borders/audit'
const tag = process.env.SHOT_TAG ?? 'audit'
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

const look = async (page, lat, lng, altitude, ms = Number(process.env.SETTLE_MS ?? 7000)) => {
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
 * The corpus's most-viewed historical eras, region by region. Every camera is
 * map (schematic) mode: that is where a border reads as a claim.
 */
const CAMERAS = [
  // ---- Rome and late antiquity
  { name: 'a1-rome117-med', year: 117, view: [38, 18, 1.0] },
  { name: 'a2-rome117-limes', year: 117, view: [48, 10, 0.45] },
  { name: 'a3-rome117-east', year: 117, view: [35, 38, 0.5] },
  { name: 'a4-lateantiquity480', year: 480, view: [44, 20, 1.0] },
  { name: 'a5-justinian565', year: 565, view: [38, 18, 1.0] },
  // ---- the caliphates
  { name: 'b1-rashidun650', year: 650, view: [30, 42, 1.0] },
  { name: 'b2-umayyad720', year: 720, view: [30, 25, 1.2] },
  { name: 'b3-abbasid800', year: 800, view: [32, 45, 1.0] },
  { name: 'b4-abbasid800-east', year: 800, view: [35, 62, 0.6] },
  // ---- medieval Europe
  { name: 'c1-europe1000', year: 1000, view: [48, 15, 0.9] },
  { name: 'c2-europe1250', year: 1250, view: [48, 15, 0.9] },
  { name: 'c3-europe1500', year: 1500, view: [48, 15, 0.9] },
  { name: 'c4-byzantium1025', year: 1025, view: [40, 28, 0.6] },
  { name: 'c5-kievanrus1000', year: 1000, view: [52, 32, 0.8] },
  { name: 'c6-mongol1260', year: 1260, view: [45, 75, 1.6] },
  // ---- Ottoman peak, Safavid, Poland-Lithuania
  { name: 'd1-ottoman1560', year: 1560, view: [40, 30, 1.0] },
  { name: 'd2-ottoman1683-danube', year: 1683, view: [45, 22, 0.5] },
  { name: 'd3-safavid1600', year: 1600, view: [33, 50, 0.8] },
  { name: 'd4-poland1600', year: 1600, view: [52, 25, 0.7] },
  // ---- China: Han, Tang, Song, Ming, Qing
  { name: 'e1-han-100', year: -100, view: [35, 105, 1.0] },
  { name: 'e2-tang750', year: 750, view: [38, 95, 1.1] },
  { name: 'e3-song1100', year: 1100, view: [32, 110, 0.8] },
  { name: 'e4-ming1450', year: 1450, view: [35, 110, 1.0] },
  { name: 'e5-qing1800', year: 1800, view: [38, 100, 1.1] },
  { name: 'e6-qing1800-korea', year: 1800, view: [41, 126, 0.4] },
  // ---- India: Maurya, Gupta, Delhi, Mughal
  { name: 'f1-maurya-260', year: -260, view: [22, 78, 0.9] },
  { name: 'f2-gupta450', year: 450, view: [24, 80, 0.8] },
  { name: 'f3-delhi1330', year: 1330, view: [22, 78, 0.9] },
  { name: 'f4-mughal1690', year: 1690, view: [22, 78, 0.9] },
  { name: 'f5-mughal1690-indus', year: 1690, view: [30, 70, 0.5] },
  // ---- colonial 1750 / 1850
  { name: 'g1-namerica1763', year: 1763, view: [45, -85, 1.0] },
  { name: 'g2-samerica1750', year: 1750, view: [-15, -60, 1.2] },
  { name: 'g3-india1858', year: 1858, view: [22, 78, 0.9] },
  { name: 'g4-russia1800', year: 1800, view: [55, 70, 1.6] },
  { name: 'g5-usa1850', year: 1850, view: [40, -100, 0.9] },
  // ---- 1900: Europe, Africa, Asia
  { name: 'h1-europe1900', year: 1900, view: [48, 15, 0.9] },
  { name: 'h2-africa1900', year: 1900, view: [5, 20, 1.5] },
  { name: 'h3-asia1900', year: 1900, view: [35, 90, 1.6] },
  { name: 'h4-germany1900', year: 1900, view: [51, 12, 0.5] },
]

const only = process.env.SHOT_ONLY ? new RegExp(process.env.SHOT_ONLY) : undefined
const results = []
for (const cam of CAMERAS) {
  if (only && !only.test(cam.name)) continue
  console.log(`\n${cam.name}`)
  await ready(page)
  await setMode(page, cam.mode ?? 'schematic')
  await setYear(page, cam.year)
  await look(page, ...cam.view)
  const file = await shot(page, cam.name)
  const drawn = await page.evaluate(() => ({
    polys: window.__globe.polygonsData().length,
    nations: (window.__nations?.current ?? []).map((n) => n.id),
  }))
  console.log(`      ${file}`)
  console.log(`      ${drawn.polys} polygons, polities [${drawn.nations.join(', ')}]`)
  results.push({ ...cam, ...drawn })
}

writeFileSync(join(shots, `${tag}-summary.json`), JSON.stringify(results, null, 2))
console.log(`\nwrote ${results.length} frames to ${shots} as "${tag}-*"`)

await browser.close()
await server.close()
