/**
 * ROUND 63, the second half — *"and they should be painted more nicely."*
 *
 * A camera per thing that gets painted, framed close enough that the painting
 * is what is on screen: a thrust's taper and its tail, an arrowhead at the zoom
 * where its proportions show, a zone's wash and the edge of it, a front's
 * joints and its teeth, a battle cross against its casing. Both grounds for
 * every one, because the drawn map and the photograph fail differently.
 *
 * Pairs by name with its own earlier run: SHOT_TAG=before, change, SHOT_TAG=after.
 *
 * Run:  node tests/e2e/ink63.e2e.mjs
 * Env:  SHOT_DIR (default /tmp/shots63/ink), SHOT_TAG (default 'paint'),
 *       PLAYWRIGHT_MODULE, CHROME_PATH, SHOT_ONLY
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots63/ink'
const tag = process.env.SHOT_TAG ?? 'paint'
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
      // the rails are not the subject and they eat a third of the frame
      '.panel, .bottom-rail, .saga-timeline { display: none !important; }',
  })
  await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
  await page.evaluate(() => {
    window.__time.setRange({ start: -3000, end: 2026 })
    window.__time.setSelection(-600, 2026)
  })
  await page.evaluate(() => window.__setTime(1944))
  await corpusQuiet(page)
  await page.waitForTimeout(1500)
  return page
}

/** Camera altitude for a frame that spans this many km, at globe.gl's 50° lens. */
const KM = (km) => {
  const half = (km / 2 / 111.32) * (Math.PI / 180)
  const theta = (25 * Math.PI) / 180
  return Math.sin(half + theta) / Math.sin(theta) - 1
}

const page = await open(1100, 800)

const CAMERAS = [
  // THRUSTS: the beach arrows, at the zoom their taper and tail are the picture
  { name: 'thrust', id: 'd-day', year: 1944.4, at: [49.42, -0.6], km: 60 },
  // …and one arrowhead, as close as a reader can get to it
  { name: 'head', id: 'd-day', year: 1944.4, at: [49.36, -0.85], km: 18 },
  // MARKS: the battle crosses and a star, against their casings
  { name: 'marks', id: 'd-day', year: 1944.4, at: [49.15, -0.5], km: 40 },
  // ZONES: the ring round Leningrad — a wash, its dashed edge, and teeth
  { name: 'zone', id: 'leningrad-siege', year: 1942, at: [59.9, 30.4], km: 220 },
  { name: 'zoneclose', id: 'leningrad-siege', year: 1942, at: [59.95, 30.2], km: 70 },
  // …and four of them at once, where a wash has to stay a wash
  { name: 'zones', id: 'six-day-war', year: 1967, at: [31.2, 34.6], km: 400 },
  // FRONTS: a long dashed front with teeth, at operational and at close range
  { name: 'front', id: 'stalingrad', year: 1942.9, at: [48.7, 44.5], km: 300 },
  { name: 'frontclose', id: 'stalingrad', year: 1942.9, at: [48.75, 44.4], km: 90 },
  // …and the continental case, where a plan is authored coarsely
  { name: 'wide', id: 'barbarossa', year: 1941.6, at: [52, 30], km: 2600 },
  // TEETH ON A CONTINENTAL FRONT, close in: the tooth is a fraction of the
  // FRONT'S own length, so a 2000 km front zoomed to a city is the case where
  // that rule has to be shown to still hold.
  { name: 'teeth', id: 'barbarossa', year: 1941.6, at: [55.4, 24.6], km: 120 },
]

const only = process.env.SHOT_ONLY ? new RegExp(process.env.SHOT_ONLY) : undefined
const results = []
for (const cam of CAMERAS) {
  for (const mode of ['schematic', 'realistic']) {
    const name = `${cam.name}-${mode === 'schematic' ? 'map' : 'photo'}`
    if (only && !only.test(name)) continue
    await page.evaluate((m) => window.__settings.setMode(m), mode)
    await page.evaluate(() => window.__events.dismiss())
    await page.evaluate((y) => window.__setTime(y), cam.year)
    await page.waitForTimeout(600)
    await corpusQuiet(page, 400, 8000)
    const ok = await page.evaluate((id) => !!window.__events.byId(id), cam.id)
    if (!ok) console.log(`  [warn] ${cam.id} is not loaded at ${cam.year}`)
    await page.evaluate((id) => {
      window.__events.select(id)
      window.__events.enterFocus(id)
    }, cam.id)
    await page.waitForTimeout(1800)
    await page.evaluate(
      ([a, b, c]) => window.__globe.pointOfView({ lat: a, lng: b, altitude: c }, 0),
      [cam.at[0], cam.at[1], KM(cam.km)],
    )
    await page.waitForTimeout(2200)
    await page.evaluate(() => window.__wake?.(500))
    await page.waitForTimeout(900)
    const state = await page.evaluate(() => ({
      layers: (window.__events.focusDrawing?.layers ?? []).map((l) => l.type),
      draws: window.__frameStats?.().draws ?? null,
    }))
    const file = await shot(page, name)
    console.log(`${name}  ${file}  [${state.layers.join(',')}]`)
    results.push({ name, ...cam, ...state })
  }
}

writeFileSync(join(shots, `${tag}-summary.json`), JSON.stringify(results, null, 2))
console.log(`\nwrote ${results.length} frames to ${shots} as "${tag}-*"`)

await browser.close()
await server.close()
