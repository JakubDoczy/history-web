/**
 * THE RESTING PICTURE, photographed only once it really is resting.
 *
 * Round 54's levers all change what a GESTURE costs and are defined to converge
 * on the level the camera stopped at, so the claim to be held is that a settled
 * drawn view is the same view it was. `drawnMap.e2e.mjs` photographs at fixed
 * waits, which is right for what it asserts and wrong for a pixel comparison:
 * under SwiftShader a regional drawn view needs tens of seconds to finish
 * streaming, and a build that finishes sooner then differs from one that has
 * not finished — a difference in CONVERGENCE RATE photographed as a difference
 * in appearance.
 *
 * So this waits on the pipeline's own fixed point — the camera still, nothing
 * fading, nothing queued, and every tile the view wants addressed by the index
 * — and only then captures. Anything left after that is a real difference.
 *
 * Run:  SHOT_DIR=/tmp/rest-x node tests/e2e/restShots.mjs
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const SHOTS = process.env.SHOT_DIR ?? '/tmp/rest-shots'
mkdirSync(SHOTS, { recursive: true })

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
const page = await browser.newPage({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.log('PAGE ERR', e.message))
await page.goto(base, { timeout: 120_000 })
await page.addStyleTag({
  content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
})
await page.waitForFunction(() => !!window.__globe && !!window.__detail, null, { timeout: 60_000 })
// Everything that is not the surface, hidden: a pin or a label is not the map,
// and its position depends on the event data's own arrival order.
await page.addStyleTag({
  content:
    '.event-pin, .drawing-label, .scene-label, [data-test="mode-toggle"], .top-bar, .bottom-rail, .timeline-bar { visibility: hidden !important; }',
})
await page.evaluate(() => window.__settings.setMode('schematic'))
await page.evaluate(() => window.__setTime(1941))
await page.evaluate(() => window.__globe.pointOfView({ lat: 46.2, lng: 8, altitude: 0.3 }))
await page.waitForFunction(() => window.__drawn?.source?.label?.includes('50m'), null, {
  timeout: 180_000,
})
await page.waitForTimeout(15000)

/** The pipeline's own fixed point, or the truth about how far it got. */
const settled = async (tries = 90) => {
  let calm = 0
  let last = null
  for (let i = 0; i < tries; i++) {
    last = await page.evaluate(() => {
      const d = window.__detail
      const w = d.want?.plan
      return {
        still: d.still === true,
        animating: d.animating === true,
        z: d.index?.z ?? null,
        resident: d.index?.resident ?? 0,
        wanted: w ? w.level.length + w.fallback.length : 0,
      }
    })
    const done = last.still && !last.animating && (last.wanted === 0 || last.resident >= last.wanted)
    calm = done ? calm + 1 : 0
    if (calm >= 3) return last
    await page.waitForTimeout(1000)
  }
  return last
}

const views = [
  ['world', { lat: 20, lng: 10, altitude: 2.4 }],
  ['continental', { lat: 48, lng: 8, altitude: 0.6 }],
  ['regional', { lat: 43.5, lng: 7.2, altitude: 0.12 }],
  /**
   * …and a fourth, because the three above never reach the 10m rung.
   *
   * Level 7 is what asks for the fine file, and 0.12 on this window is level 6:
   * a comparison over those three says nothing about the layer round 58 moved
   * to another worker. The Sognefjord at 0.05 streams level 8 and is the worst
   * case the rung has — it is also where a layer rebuilt from transferred
   * buffers would show first, since every shape there is a clipped cell.
   */
  ['coastal', { lat: 61.3, lng: 6.0, altitude: 0.05 }],
]

for (const [name, pov] of views) {
  await page.evaluate((p) => window.__globe.pointOfView(p), pov)
  const state = await settled()
  await page.evaluate(() => window.__wake?.(600))
  await page.waitForTimeout(1200)
  const buf = await page.screenshot()
  writeFileSync(join(SHOTS, `${name}.png`), buf)
  console.log(name, JSON.stringify(state))
}

await browser.close()
await server.close()
