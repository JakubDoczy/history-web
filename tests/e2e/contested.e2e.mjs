/**
 * CONTESTED TERRITORY, in a browser — the hatch, the dashes, and the dates.
 *
 * Every claim round 60 makes is a claim about pixels: that disputed ground is
 * hatched rather than washed in one claimant's colour, that the hatch is fixed
 * to the GROUND and does not crawl when the camera turns, that the outline
 * reads as dashed at the zoom a reader looks at a zone from, and that none of
 * it appears in a year before the dispute existed. A unit test can reach none
 * of that, so this drives the real app under SwiftShader and photographs it.
 *
 * The crawl test is the one worth explaining. Two frames of the SAME ground are
 * taken from two camera bearings; the second is then compared by eye against
 * the first. If the stripes were computed in screen space they would be at a
 * different angle across the peninsula in the second shot, and if they are
 * computed from the cap's own coordinates they are the same stripes on the same
 * rock. `__freezeClock` holds the clouds and the running dashes still so that
 * nothing else in the frame moves.
 *
 * Run:  node tests/e2e/contested.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots60/contested), SHOT_TAG,
 *       SHOT_ONLY (a regex over camera names), BASE_URL (a `vite preview`
 *       origin; a dev server is started if unset), PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots60/contested'
const tag = process.env.SHOT_TAG ?? 'after'
mkdirSync(shots, { recursive: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

let server
let base = process.env.BASE_URL
if (!base) {
  server = await createServer({ root, server: { port: 0 }, logLevel: 'warn' })
  await server.listen()
  base = `http://localhost:${server.httpServer.address().port}`
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    // The app is served from this machine; an HTTP proxy in the environment
    // would tunnel localhost and fail every asset.
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

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
  page.on('requestfailed', (r) => console.log('  [failed]', r.url().slice(0, 120), r.failure()?.errorText))
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

const look = async (page, lat, lng, altitude, ms = 5000) => {
  await page.evaluate(
    ([a, b, c]) => window.__globe.pointOfView({ lat: a, lng: b, altitude: c }),
    [lat, lng, altitude],
  )
  await page.waitForTimeout(ms)
  await page.evaluate(() => window.__wake?.(400))
  await page.waitForTimeout(700)
}

/** A year, with a selection band tight enough that the overlays are on. */
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
  // The drawn map re-tiles on a mode change and the fade is not instant; a
  // frame taken too early photographs paper where the sea should be.
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__wake?.(600))
  await page.waitForTimeout(1200)
}

const page = await open(1280, 800)

const CAMERAS = [
  // CRIMEA and the occupied oblasts, 2023, close enough to read the hatch and
  // the dashes along the front. The map's own coastline is what bounds the
  // peninsula — almost every metre of Crimea's edge is coast, so the hatch is
  // what says "disputed" there and the dashes are what say it in the Donbas.
  { name: 'a-ukraine2023-map', year: 2023, mode: 'schematic', view: [47.5, 35.5, 0.35] },
  { name: 'b-crimea2023-map', year: 2023, mode: 'schematic', view: [45.3, 34.3, 0.16] },
  { name: 'c-ukraine2023-realistic', year: 2023, mode: 'realistic', view: [47.5, 35.5, 0.35] },
  // …and the date. The SAME camera at 2010: Crimea is Ukraine's, undisputed,
  // and there must be no hatch and no dashes anywhere in the frame.
  { name: 'd-crimea2010-map', year: 2010, mode: 'schematic', view: [45.3, 34.3, 0.16] },
  { name: 'e-ukraine2010-map', year: 2010, mode: 'schematic', view: [47.5, 35.5, 0.35] },
  // KASHMIR at 1990 — the only zone with a claimant the globe actually draws,
  // so its hatch alternates India's colour against neutral, and the carve is
  // visible as India's fill stopping at the dashes.
  { name: 'f-kashmir1990-map', year: 1990, mode: 'schematic', view: [34.5, 76, 0.3] },
  { name: 'g-kashmir1990-realistic', year: 1990, mode: 'realistic', view: [34.5, 76, 0.3] },
  // …and before it. 1940: British India, one holder, no zone.
  { name: 'h-kashmir1940-map', year: 1940, mode: 'schematic', view: [34.5, 76, 0.3] },
  // WESTERN SAHARA at 2000 — the largest zone, and the one whose whole eastern
  // and southern boundary is derived from Natural Earth's own arcs.
  { name: 'i-sahara2000-map', year: 2000, mode: 'schematic', view: [24.5, -13.5, 0.5] },
  { name: 'j-sahara2000-realistic', year: 2000, mode: 'realistic', view: [24.5, -13.5, 0.5] },
  // ABYEI at 2015 — the smallest, five stripes across, and the test of whether
  // a small zone is legible at all.
  { name: 'k-abyei2015-map', year: 2015, mode: 'schematic', view: [9.9, 28.4, 0.13] },
  { name: 'l-abyei2015-realistic', year: 2015, mode: 'realistic', view: [9.9, 28.4, 0.13] },
  // THE CRAWL TEST. globe.gl has no bearing control, so the camera is moved
  // instead: with Crimea centred, then out at the edge of the frame from two
  // other centres, where a sphere rotates the local north away from screen-up.
  // A ground-fixed hatch turns with the peninsula between these three and a
  // screen-space one stays at 45 degrees across all of them.
  { name: 'm-crimea-bearing-a', year: 2023, mode: 'schematic', view: [45.3, 34.3, 0.45] },
  { name: 'n-crimea-bearing-b', year: 2023, mode: 'schematic', view: [45.3, 15, 0.45] },
  { name: 'o-crimea-bearing-c', year: 2023, mode: 'schematic', view: [53, 51, 0.45] },
  // …and the whole world at 2023, where every stripe is under a pixel: the
  // check that the far view is a wash rather than a moiré.
  { name: 'p-world2023-map', year: 2023, mode: 'schematic', view: [25, 30, 2.1] },
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
    zones: (window.__nations?.contested ?? []).map((z) => `${z.zone.id}[${z.hatch.join('/')}]`),
    nations: (window.__nations?.current ?? []).map((n) => n.id),
    cost: window.__politicalCost?.() ?? null,
    calls: window.__globe.renderer?.().info?.render?.calls ?? null,
    triangles: window.__globe.renderer?.().info?.render?.triangles ?? null,
  }))
  console.log(`      ${file}`)
  console.log(`      ${drawn.polys} polygons, polities [${drawn.nations.join(', ')}]`)
  console.log(`      zones [${drawn.zones.join(', ')}]`)
  console.log(`      cost ${JSON.stringify(drawn.cost)}  draw calls ${drawn.calls}  triangles ${drawn.triangles}`)
  results.push({ ...cam, ...drawn })
}

writeFileSync(join(shots, `${tag}-summary.json`), JSON.stringify(results, null, 2))
console.log(`\nwrote ${results.length} frames to ${shots} as "${tag}-*"`)

await browser.close()
if (server) await server.close()
