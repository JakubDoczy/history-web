/**
 * ROUND 64b — saga overviews, photographed.
 *
 * Two kinds of frame: OVERVIEW (saga selected, no step open — the summary map
 * the new at:'overview' layers exist for) and PROOF (same saga, a step open —
 * the overview crowd must be gone).
 *
 * Run:  node tests/e2e/overview64.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots64/content), SHOT_ONLY, PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots64/content'
const tag = process.env.SHOT_TAG ?? 'r64'
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

const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
await page.goto(base, { timeout: 90_000 })
await page.addStyleTag({
  content:
    '*, *::before, *::after { animation: none !important; transition: none !important; }' +
    '.panel { display: none !important; }',
})
await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
// The band is the premise: span every year these cameras visit.
await page.evaluate(() => {
  window.__time.setRange({ start: -3000, end: 2026 })
  window.__time.setSelection(-600, 2026)
})
await page.evaluate(() => window.__setTime(1941))
await corpusQuiet(page)
await page.waitForTimeout(2000)
await page.evaluate(() => window.__settings.setMode('schematic'))
await page.waitForTimeout(1000)

/** name, saga id, year for the band, optional stepId => proof shot. */
const CAMERAS = [
  { name: 'a-ww1', id: 'ww1', year: 1916 },
  { name: 'b-napoleonic', id: 'napoleonic-wars', year: 1812 },
  { name: 'c-us-civil-war', id: 'us-civil-war', year: 1863 },
  { name: 'd-ottoman', id: 'ottoman-wars-europe', year: 1600 },
  { name: 'e-gnw', id: 'great-northern-war', year: 1709 },
  { name: 'f-imjin', id: 'imjin-war', year: 1593 },
  { name: 'g-hussite', id: 'hussite-wars', year: 1426 },
  { name: 'h-alexander', id: 'alexander-conquests', year: -328 },
  { name: 'i-punic', id: 'punic-wars', year: -210 },
  { name: 'j-black-death', id: 'black-death', year: 1348 },
  { name: 'k-crusades', id: 'crusades', year: 1150 },
  { name: 'l-thirty-years', id: 'thirty-years-war', year: 1632 },
  { name: 'm-sengoku', id: 'sengoku-unification', year: 1584 },
  { name: 'n-deluge', id: 'deluge', year: 1656 },
  { name: 'o-reformation', id: 'reformation', year: 1540 },
  { name: 'p-viking', id: 'viking-age', year: 900 },
  { name: 'q-barbarossa', id: 'barbarossa', year: 1941.6 },
  // proof: step open, overview crowd hidden
  { name: 'z1-ww1-marne-step', id: 'ww1', year: 1916, step: 'marne' },
  { name: 'z2-hussite-tachov-step', id: 'hussite-wars', year: 1426, step: 'tachov' },
  { name: 'z3-gnw-russia-step', id: 'great-northern-war', year: 1709, step: 'russia' },
  { name: 'z4-uscw-march-step', id: 'us-civil-war', year: 1864.9, step: 'march-to-the-sea' },
]

const only = process.env.SHOT_ONLY ? new RegExp(process.env.SHOT_ONLY) : undefined
const results = []
for (const cam of CAMERAS) {
  if (only && !only.test(cam.name)) continue
  console.log(`\n${cam.name}`)
  await page.evaluate(() => {
    window.__events.exitFocus?.()
    window.__events.dismiss()
  })
  await page.waitForTimeout(500)
  await page.evaluate((y) => window.__setTime(y), cam.year)
  await page.waitForTimeout(600)
  await corpusQuiet(page, 500, 8000)
  const ok = await page.evaluate((id) => !!window.__events.byId(id), cam.id)
  if (!ok) {
    console.log(`      [warn] ${cam.id} not loaded at ${cam.year}`)
    continue
  }
  if (cam.step) {
    await page.evaluate((id) => window.__events.showOnMap(id), cam.id)
    await page.waitForTimeout(1500)
    await page.evaluate((s) => window.__events.selectStep(s), cam.step)
  } else {
    await page.evaluate((id) => {
      window.__events.select(id)
      const t = window.__events.mapTarget(id)
      if (t) window.__globe.pointOfView(t, 0)
    }, cam.id)
  }
  await page.waitForTimeout(4500)
  await page.evaluate(() => window.__wake?.(600))
  await page.waitForTimeout(1200)
  const state = await page.evaluate(() => ({
    selected: window.__events.selectedId ?? null,
    step: window.__events.stepId ?? null,
    layers: (window.__events.focusDrawing?.layers ?? []).map((l) => `${l.type}${l.at === 'overview' ? '*' : ''}`),
  }))
  const file = await shot(page, cam.name)
  console.log(`      ${file}`)
  console.log(`      selected ${state.selected} step ${state.step} layers [${state.layers.join(', ')}]`)
  results.push({ ...cam, ...state })
}

writeFileSync(join(shots, `${tag}-summary.json`), JSON.stringify(results, null, 2))
console.log(`\nwrote ${results.length} frames to ${shots} as "${tag}-*"`)

await browser.close()
await server.close()
