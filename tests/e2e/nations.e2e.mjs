/**
 * THE NATIONS REWORK, in a browser — the two defects, before and after.
 *
 * Every claim this round makes is a claim about pixels that a unit test cannot
 * reach: that a polity's fill stops exactly where the drawn map's coastline is,
 * that the coast is not inked twice, that a land frontier still is, and that no
 * year shows two empires over the same ground. So this drives the real app
 * under SwiftShader and photographs it.
 *
 * It shoots the SAME cameras against whatever tree it is run in, so running it
 * once in a worktree at the previous commit and once here produces a matched
 * before/after pair. `SHOT_TAG` is what keeps the two sets apart.
 *
 * Run:  node tests/e2e/nations.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots52/nations), SHOT_TAG
 *       (default 'after'), PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots52/nations'
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

const look = async (page, lat, lng, altitude, ms = 6000) => {
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
 * The cameras. Each is a defect the reader can point at, or the proof it is
 * gone; the list is the same in both trees, so the files pair up by name.
 */
const CAMERAS = [
  // The coastal empire. Rome at its greatest extent, framed on the Adriatic and
  // the Italian coast, in map mode: this is where a hand-drawn coastline and
  // Natural Earth 50m disagree most visibly, and where a second coastal stroke
  // in the polity's colour doubles the map's own ink.
  { name: 'a-rome117-italy-map', year: 117, mode: 'schematic', view: [42, 14, 0.28] },
  // …and the whole Mediterranean, where the fill's edge against the sea is the
  // whole picture.
  { name: 'b-rome117-med-map', year: 117, mode: 'schematic', view: [37, 18, 0.75] },
  // Japan: every metre of its boundary is coast, so it is the case that decides
  // whether a fill is needed at all.
  { name: 'c-japan1900-map', year: 1900, mode: 'schematic', view: [37, 137, 0.4] },
  // The overlap. 1900 over Manchuria: the Qing extent and the Russian one both
  // claimed the Amur and the Ussuri — 117 square degrees, for 113 years.
  { name: 'd-overlap1900-manchuria-map', year: 1900, mode: 'schematic', view: [48, 125, 0.6] },
  // The other overlap, and the largest by area in the corpus: Alexander's
  // empire drawn on top of the Achaemenid one it had not yet conquered.
  { name: 'e-overlap-333-persia-map', year: -333, mode: 'schematic', view: [35, 50, 0.9] },
  // A land frontier that must still be inked: the Rhine and the Danube.
  { name: 'f-rome117-limes-map', year: 117, mode: 'schematic', view: [49, 12, 0.35] },
  // The same coastal empire on the photograph — the regression check.
  { name: 'g-rome117-italy-realistic', year: 117, mode: 'realistic', view: [42, 14, 0.28] },
  { name: 'h-japan1900-realistic', year: 1900, mode: 'realistic', view: [37, 137, 0.4] },
  // The seam. Russia in 1900 reaches 178° E and its clipped pieces include the
  // islands off Chukotka; this is the frame where a ring that crossed 180 badly
  // would draw a chord across the world.
  { name: 'i-russia1900-seam-map', year: 1900, mode: 'schematic', view: [64, 178, 0.7] },
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
    calls: window.__globe.renderer?.().info?.render?.calls ?? null,
    triangles: window.__globe.renderer?.().info?.render?.triangles ?? null,
  }))
  console.log(`      ${file}`)
  console.log(`      ${drawn.polys} polygons, polities [${drawn.nations.join(', ')}]`)
  console.log(
    `      cost ${JSON.stringify(drawn.cost)}  draw calls ${drawn.calls}  triangles ${drawn.triangles}`,
  )
  results.push({ ...cam, ...drawn })
}

writeFileSync(join(shots, `${tag}-summary.json`), JSON.stringify(results, null, 2))
console.log(`\nwrote ${CAMERAS.length} frames to ${shots} as "${tag}-*"`)

await browser.close()
await server.close()
