/**
 * ROUND 67 — the deep-time TRANSITION, photographed mid-blend.
 *
 * The complaint: "It's not very pretty how continents move in prehistoric
 * times, especially in map mode. The blending is very apparent." The blend is
 * `mix(uEraA, uEraB, uEraMix)` — a uniform crossfade — and in map mode the two
 * frames are drawn plates, so mid-blend is a double exposure of two inked
 * coastlines. This script parks the year at stated fractions BETWEEN adjacent
 * keyframes, in both modes, so before/after can be compared at matched blend
 * positions.
 *
 * Run:  node tests/e2e/paleoMorph67.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots67/audit), SHOT_TAG
 *       (default 'before'), SHOT_ONLY (regex), PLAYWRIGHT_MODULE, SETTLE_MS
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots67/audit'
const tag = process.env.SHOT_TAG ?? 'before'
mkdirSync(shots, { recursive: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

// The shipped keyframe ages, so a "mid-blend" year is derived from the real
// pair rather than guessed — a year that happens to sit ON a keyframe would
// photograph a settled frame and prove nothing about the blend.
const frames = JSON.parse(readFileSync(join(root, 'src/data/paleoFrames.json'), 'utf8'))
const ages = frames.map((f) => f.ma)
const pairFor = (ma) => {
  for (let i = 0; i < ages.length - 1; i++) {
    if (ages[i] >= ma && ma >= ages[i + 1]) return [ages[i], ages[i + 1]]
  }
  throw new Error(`no pair for ${ma}`)
}
/** Year at blend fraction f between the two keyframes bracketing `ma`. */
const blendYear = (ma, f) => {
  const [a, b] = pairFor(ma)
  return Math.round(-(a + (b - a) * f) * 1e6)
}

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
page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
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

const look = async (page, lat, lng, altitude, ms = Number(process.env.SETTLE_MS ?? 3500)) => {
  await page.evaluate(
    ([a, b, c]) => window.__globe.pointOfView({ lat: a, lng: b, altitude: c }),
    [lat, lng, altitude],
  )
  await page.waitForTimeout(ms)
  await page.evaluate(() => window.__wake?.(400))
  await page.waitForTimeout(400)
}

const only = process.env.SHOT_ONLY ? new RegExp(process.env.SHOT_ONLY) : null

// Pairs under scrutiny: the Triassic the user's earlier report named (round
// 65's fine scrub ran 250→200), one Pangaea-assembly pair, one early-Paleozoic
// pair with the widest spacing, and one Cenozoic pair (India's sprint).
const CASES = [
  ['triassic', 245],   // 252 → 233.6 Ma
  ['jurassic', 200],   // 204.9 → 190.8 Ma
  ['cambrian', 530],   // 541 → 515 Ma, the widest gap we ship
  ['paleogene', 60],   // 66 → 56 Ma
]
const BLENDS = [0.25, 0.5, 0.75]

for (const mode of ['schematic', 'realistic']) {
  const m = mode === 'schematic' ? 'map' : 'sat'
  await setMode(page, mode)
  await look(page, 15, 30, 2.2)
  for (const [label, ma] of CASES) {
    for (const f of BLENDS) {
      const name = `${m}-${label}-f${String(Math.round(f * 100)).padStart(2, '0')}`
      if (only && !only.test(name)) continue
      await setYear(page, blendYear(ma, f))
      await page.evaluate(() => window.__wake?.(400))
      await page.waitForTimeout(300)
      console.log('  shot', await shot(page, name))
    }
    // …and both settled ends of the same pair, the parity reference.
    for (const [end, f] of [['a', 0], ['b', 1]]) {
      const name = `${m}-${label}-settled-${end}`
      if (only && !only.test(name)) continue
      await setYear(page, blendYear(ma, f))
      console.log('  shot', await shot(page, name))
    }
  }
}

await browser.close()
await server.close()
console.log('done')
