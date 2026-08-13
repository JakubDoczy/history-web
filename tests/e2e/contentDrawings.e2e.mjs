/**
 * ROUND 60 PART 3 — the corpus's new ink, photographed.
 *
 * Same rig as tests/e2e/drawings.e2e.mjs (dev server, SwiftShader, corpusQuiet,
 * band-as-premise): what changes is the subject. Each camera SELECTS a plain
 * event and frames it the way the app does — `mapTarget` — so what is
 * photographed is exactly what a reader gets when they click the pin, which is
 * the whole point of Part 2 and the only honest way to judge Part 3's content.
 *
 * Run:  node tests/e2e/contentDrawings.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots60/content), SHOT_TAG,
 *       SHOT_ONLY (a regex over camera names), PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots60/content'
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

const corpusQuiet = async (page, still = 800, timeout = 25_000) => {
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
  console.log('  [warn] the corpus never stopped growing')
}

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
  await page.goto(base, { timeout: 90_000 })
  await page.addStyleTag({
    content:
      '*, *::before, *::after { animation: none !important; transition: none !important; }' +
      '.panel { display: none !important; }',
  })
  await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
  // The band is the premise: it has to span every year these cameras visit, or
  // the events later than the open band are culled before they can be selected.
  await page.evaluate(() => {
    window.__time.setRange({ start: -3000, end: 2026 })
    window.__time.setSelection(-600, 2026)
  })
  await page.evaluate(() => window.__setTime(1941))
  await corpusQuiet(page)
  await page.waitForTimeout(2000)
  return page
}

const setMode = async (page, mode) => {
  await page.evaluate((m) => window.__settings.setMode(m), mode)
  await page.waitForTimeout(1000)
}

const clear = async (page) => {
  await page.evaluate(() => window.__events.dismiss())
  await page.waitForTimeout(500)
}

const stateOf = (page) =>
  page.evaluate(() => ({
    selected: window.__events.selectedId ?? null,
    layers: (window.__events.focusDrawing?.layers ?? []).map((l) => l.type),
    caps: window.__globe.polygonsData().filter((p) => p.kind === 'area').length,
  }))

const page = await open(1280, 860)

/** id + the year the reader would be at when the event is on the globe. */
const CAMERAS = [
  { name: 'a-leningrad', id: 'leningrad-siege', year: 1942, mode: 'schematic' },
  { name: 'b-stalingrad', id: 'stalingrad', year: 1942.9, mode: 'schematic' },
  { name: 'c-kiev-pocket', id: 'kiev-pocket', year: 1941.7, mode: 'schematic' },
  { name: 'd-six-day-war', id: 'six-day-war', year: 1967, mode: 'schematic' },
  { name: 'e-first-partition-poland', id: 'first-partition-poland', year: 1772.6, mode: 'schematic' },
  { name: 'f-great-wall', id: 'great-wall', year: 1500, mode: 'schematic' },
  { name: 'g-thera', id: 'thera-eruption', year: -1609, mode: 'schematic' },
  { name: 'h-spanish-armada', id: 'spanish-armada', year: 1588, mode: 'realistic' },
  { name: 'i-vienna-1683', id: 'vienna-1683', year: 1683.6, mode: 'schematic' },
  { name: 'j-partition', id: 'partition', year: 1947, mode: 'schematic' },
  { name: 'k-chernobyl', id: 'chernobyl', year: 1986, mode: 'realistic' },
  { name: 'l-acre', id: 'acre-1291', year: 1291, mode: 'schematic' },
  { name: 'm-marathon', id: 'marathon', year: -489, mode: 'schematic' },
  { name: 'n-boer-war', id: 'boer-war', year: 1900, mode: 'schematic' },
  { name: 'o-midway', id: 'midway', year: 1942, mode: 'realistic' },
  { name: 'p-suez-canal', id: 'suez-canal', year: 1869, mode: 'schematic' },
  { name: 'q-minsk-pocket', id: 'minsk-pocket', year: 1941.5, mode: 'schematic' },
  { name: 'r-first-crusade', id: 'first-crusade', year: 1099, mode: 'schematic' },
  { name: 's-tenochtitlan', id: 'tenochtitlan', year: 1521, mode: 'schematic' },
  { name: 't-ukraine', id: 'ukraine-invasion', year: 2022, mode: 'schematic' },
  { name: 'u-russo-japanese', id: 'russo-japanese-war', year: 1905, mode: 'schematic' },
  { name: 'v-granada', id: 'granada', year: 1492, mode: 'schematic' },
]

const only = process.env.SHOT_ONLY ? new RegExp(process.env.SHOT_ONLY) : undefined
const results = []
for (const cam of CAMERAS) {
  if (only && !only.test(cam.name)) continue
  console.log(`\n${cam.name}`)
  await clear(page)
  await setMode(page, cam.mode)
  await page.evaluate((y) => window.__setTime(y), cam.year)
  await page.waitForTimeout(600)
  await corpusQuiet(page, 500, 8000)
  const ok = await page.evaluate((id) => !!window.__events.byId(id), cam.id)
  if (!ok) {
    console.log(`      [warn] ${cam.id} is not in the loaded corpus at ${cam.year}`)
  }
  await page.evaluate((id) => {
    window.__events.select(id)
    const t = window.__events.mapTarget(id)
    if (t) window.__globe.pointOfView(t, 0)
  }, cam.id)
  await page.waitForTimeout(4500)
  await page.evaluate(() => window.__wake?.(600))
  await page.waitForTimeout(1200)
  const state = await stateOf(page)
  const file = await shot(page, cam.name)
  console.log(`      ${file}`)
  console.log(`      selected ${state.selected}  layers [${state.layers.join(', ')}]  caps ${state.caps}`)
  results.push({ ...cam, ...state })
}

writeFileSync(join(shots, `${tag}-summary.json`), JSON.stringify(results, null, 2))
console.log(`\nwrote ${results.length} frames to ${shots} as "${tag}-*"`)

await browser.close()
await server.close()
