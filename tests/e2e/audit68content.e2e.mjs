/**
 * ROUND 68 CONTENT AUDIT — the majors' paintings, photographed at their own
 * cameras so they can be convicted or acquitted of the user's charge:
 * misplaced arrows, confusing compositions, unlabeled axes.
 *
 * Same rig as tests/e2e/contentDrawings.e2e.mjs (dev server, SwiftShader,
 * corpusQuiet, band-as-premise). Each camera selects an event via mapTarget;
 * a camera with a `step` walks into that step (window.__events.selectStep)
 * and frames the step's own camera, which is what a reader inside the saga
 * actually sees.
 *
 * Run:  node tests/e2e/audit68content.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots68/content/audit), SHOT_TAG
 *       (default 'before'), SHOT_ONLY (regex over camera names),
 *       PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots68/content/audit'
const tag = process.env.SHOT_TAG ?? 'before'
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
  // Band as premise: span every year these cameras visit.
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
  await page.evaluate(() => {
    window.__events.selectStep()
    window.__events.dismiss()
  })
  await page.waitForTimeout(500)
}

const stateOf = (page) =>
  page.evaluate(() => ({
    selected: window.__events.selectedId ?? null,
    step: window.__events.stepId ?? null,
    layers: (window.__events.focusDrawing?.layers ?? []).map((l) => l.type),
  }))

const page = await open(1280, 860)

/**
 * id + the year the reader is at. `step` walks into a saga step; `alt`
 * multiplies the event's own camera altitude (to stand back / lean in).
 */
const CAMERAS = [
  { name: 'barbarossa', id: 'barbarossa', year: 1941.6 },
  { name: 'stalingrad', id: 'stalingrad', year: 1942.9 },
  { name: 'd-day', id: 'd-day', year: 1944.45 },
  { name: 'ww1', id: 'ww1', year: 1916 },
  { name: 'napoleonic', id: 'napoleonic-wars', year: 1812.8 },
  { name: 'us-civil-war', id: 'us-civil-war', year: 1863 },
  { name: 'verdun', id: 'verdun', year: 1916.2 },
  { name: 'midway', id: 'midway', year: 1942.45 },
  { name: 'pearl-harbor', id: 'pearl-harbor', year: 1941.94 },
  { name: 'korean-war', id: 'korean-war', year: 1950.7 },
  { name: 'mohacs', id: 'mohacs', year: 1526.65 },
  { name: 'hastings', id: 'hastings', year: 1066.8 },
  { name: 'alexander', id: 'alexander-conquests', year: -330 },
  { name: 'crusades', id: 'crusades', year: 1097 },
  { name: 'punic-wars', id: 'punic-wars', year: -216 },
  { name: 'hundred-years-war', id: 'hundred-years-war', year: 1415 },
  { name: 'viking-age', id: 'viking-age', year: 900 },
  { name: 'thirty-years-war', id: 'thirty-years-war', year: 1632 },
  { name: 'ottoman-wars', id: 'ottoman-wars-europe', year: 1529.5 },
  { name: 'vienna-1683', id: 'vienna-1683', year: 1683.7 },
  { name: 'blenheim', id: 'blenheim', year: 1704.6 },
  { name: 'marathon', id: 'marathon', year: -489 },
  { name: 'thermopylae', id: 'thermopylae', year: -479 },
  { name: 'kiev-pocket', id: 'kiev-pocket', year: 1941.7 },
  { name: 'moscow-1941', id: 'moscow-1941', year: 1941.9 },
  { name: 'leningrad', id: 'leningrad-siege', year: 1942 },
  { name: 'brest-fortress', id: 'brest-fortress', year: 1941.5 },
  { name: 'russian-revolution', id: 'russian-revolution', year: 1917.9 },
  { name: 'greco-persian', id: 'greco-persian-wars', year: -480 },
  { name: 'sevastopol-crimean', id: 'crimean-war', year: 1855 },
  { name: 'fall-constantinople', id: 'fall-constantinople', year: 1453.35 },
  // --- inside the tactical sagas -----------------------------------------
  { name: 'waterloo-hougoumont', id: 'waterloo', step: 'hougoumont', year: 1815.462 },
  { name: 'waterloo-derlon', id: 'waterloo', step: 'derlon', year: 1815.462 },
  { name: 'waterloo-prussians', id: 'waterloo', step: 'prussians', year: 1815.462 },
  { name: 'waterloo-guard', id: 'waterloo', step: 'the-guard', year: 1815.462 },
  { name: 'gettysburg-first', id: 'gettysburg', step: 'first-day', year: 1863.498 },
  { name: 'gettysburg-second', id: 'gettysburg', step: 'second-day', year: 1863.5 },
  { name: 'gettysburg-pickett', id: 'gettysburg', step: 'pickett', year: 1863.502 },
  { name: 'somme-first-day', id: 'somme', step: 'first-day', year: 1916.5 },
  { name: 'somme-november', id: 'somme', step: 'november', year: 1916.87 },
  { name: 'cannae-deployment', id: 'cannae', step: 'deployment', year: -216 },
  { name: 'cannae-envelopment', id: 'cannae', step: 'envelopment', year: -216 },
  { name: 'fc-four-ships', id: 'fall-constantinople', step: 'four-ships', year: 1453.3 },
  { name: 'fc-final-assault', id: 'fall-constantinople', step: 'final-assault', year: 1453.4 },
]

const only = process.env.SHOT_ONLY ? new RegExp(process.env.SHOT_ONLY) : undefined
const results = []
for (const cam of CAMERAS) {
  if (only && !only.test(cam.name)) continue
  console.log(`\n${cam.name}`)
  await clear(page)
  await setMode(page, cam.mode ?? 'schematic')
  await page.evaluate((y) => window.__setTime(y), cam.year)
  await page.waitForTimeout(600)
  await corpusQuiet(page, 500, 8000)
  const ok = await page.evaluate((id) => !!window.__events.byId(id), cam.id)
  if (!ok) console.log(`      [warn] ${cam.id} is not in the loaded corpus at ${cam.year}`)
  await page.evaluate(
    ({ id, step, alt }) => {
      window.__events.select(id)
      if (step) {
        window.__events.enterFocus(id)
        window.__events.selectStep(step)
        const s = window.__events.focusSteps.find((x) => x.id === step)
        if (s?.camera) {
          window.__globe.pointOfView(
            { lat: s.camera.lat, lng: s.camera.lng, altitude: s.camera.altitude * (alt ?? 1) },
            0,
          )
          return
        }
      }
      const t = window.__events.mapTarget(id)
      if (t) window.__globe.pointOfView({ ...t, altitude: t.altitude * (alt ?? 1) }, 0)
    },
    { id: cam.id, step: cam.step, alt: cam.alt },
  )
  await page.waitForTimeout(4500)
  await page.evaluate(() => window.__wake?.(600))
  await page.waitForTimeout(1200)
  const state = await stateOf(page)
  const file = await shot(page, cam.name)
  console.log(`      ${file}`)
  console.log(
    `      selected ${state.selected} step ${state.step} layers [${state.layers.join(', ')}]`,
  )
  results.push({ ...cam, ...state })
}

writeFileSync(join(shots, `${tag}-summary.json`), JSON.stringify(results, null, 2))
console.log(`\nwrote ${results.length} frames to ${shots} as "${tag}-*"`)

await browser.close()
await server.close()
