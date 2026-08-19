/**
 * ROUND 65 — the deep-time surface, photographed.
 *
 * Three charges from the field: map (drawn) mode is ugly in deep time,
 * satellite mode is questionable in places, and there is "at least one weird
 * discontinuity ... around 200 MA". This script is the instrument: a sweep of
 * both modes across deep time at world view plus one closer frame, and a
 * fine-step scrub across the Triassic (the discontinuity's neighbourhood),
 * before and after the fix.
 *
 * Run:  node tests/e2e/paleo65.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots65/paleo/audit), SHOT_TAG
 *       (default 'before'), SHOT_ONLY (regex over shot names),
 *       PLAYWRIGHT_MODULE, SETTLE_MS
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots65/paleo/audit'
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
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--no-proxy-server'],
})

const sessions = new Map()
const shot = async (page, name) => {
  let cdp = sessions.get(page)
  if (!cdp) sessions.set(page, (cdp = await page.context().newCDPSession(page)))
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = join(shots, `${tag}-${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
await page.goto(base, { timeout: 90_000 })
await page.addStyleTag({
  content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
})
await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
await page.waitForTimeout(1500)

/** A deep-time year, selection band set first (the band-premise pattern). */
const setYear = async (page, year, settle = 2500) => {
  await page.evaluate((y) => {
    const w = Math.max(800, Math.abs(y) * 0.002)
    window.__time.setRange({ start: y - w, end: y + w })
    window.__time.setSelection(y - w / 2, y + w / 2)
    window.__time.setTime(y)
  }, year)
  await page.waitForTimeout(settle)
  await page.evaluate(() => window.__wake?.(400))
  await page.waitForTimeout(400)
}

const setMode = async (page, mode) => {
  await page.evaluate((m) => window.__settings.setMode(m), mode)
  await page.waitForTimeout(800)
}

const look = async (page, lat, lng, altitude, ms = Number(process.env.SETTLE_MS ?? 4000)) => {
  await page.evaluate(
    ([a, b, c]) => window.__globe.pointOfView({ lat: a, lng: b, altitude: c }),
    [lat, lng, altitude],
  )
  await page.waitForTimeout(ms)
  await page.evaluate(() => window.__wake?.(400))
  await page.waitForTimeout(400)
}

const only = process.env.SHOT_ONLY ? new RegExp(process.env.SHOT_ONLY) : null

// ---- the sweep: world view, both modes -------------------------------------
const SWEEP_MA = [50, 100, 150, 200, 250, 300, 400, 500]
for (const mode of ['realistic', 'schematic']) {
  const m = mode === 'realistic' ? 'sat' : 'map'
  if (only && !only.test(m) && !only.test('sweep')) continue
  await setMode(page, mode)
  for (const ma of SWEEP_MA) {
    const name = `sweep-${m}-${String(ma).padStart(3, '0')}ma`
    if (only && !only.test(name) && !(only.test(m) || only.test('sweep'))) continue
    await setYear(page, -ma * 1e6)
    await look(page, 15, 30, 2.2)
    console.log('  shot', await shot(page, name))
  }
  // one closer frame: the Tethys margin at 200 Ma, where the shelf detail is
  await setYear(page, -200e6)
  await look(page, 10, 40, 0.8)
  console.log('  shot', await shot(page, `close-${m}-200ma`))
}

// ---- the fine scrub across the Triassic ------------------------------------
if (!only || only.test('scrub')) {
  await setMode(page, 'realistic')
  await look(page, 15, 30, 2.2)
  for (const ma of [255, 250, 245, 240, 235, 230, 225, 220, 215, 210, 205, 200, 195, 190, 185, 180, 175, 170]) {
    await setYear(page, -ma * 1e6, 1800)
    console.log('  shot', await shot(page, `scrub-${String(ma).padStart(3, '0')}ma`))
  }
}

await browser.close()
await server.close()
console.log('done')
