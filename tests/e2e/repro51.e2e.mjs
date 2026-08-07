/**
 * Round 51 — the four reported defects, photographed.
 *
 * One script, run twice: once against the broken tree (SHOT_DIR=…/repro) and
 * once against the fixed one (SHOT_DIR=…/fixed), so every claim below is a pair
 * of frames of the same camera and the same rail window.
 *
 *   1. the chord across the Indian Ocean — a world view in map mode.
 *   2. the antimeridian seam — a Pacific view straddling ±180 at streaming
 *      zoom, in both map and globe mode, plus the wanted-set arithmetic, plus
 *      a pan across the seam.
 *   3. the rail's zoom control — geometry and position.
 *   4. the period bands — WWII zoomed to June 1944 and to a 1942 week.
 *
 * Run:  node tests/e2e/repro51.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots51/repro), PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots51/repro'
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
const shot = async (target, name, clip) => {
  let cdp = sessions.get(target)
  if (!cdp) sessions.set(target, (cdp = await target.context().newCDPSession(target)))
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
  const file = join(shots, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

async function open(width, height, deviceScaleFactor = 1) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor })
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
  await page.waitForFunction(() => !!window.__globe)
  await page.evaluate(
    ([a, b, c]) => window.__globe.pointOfView({ lat: a, lng: b, altitude: c }),
    [lat, lng, altitude],
  )
  await page.waitForTimeout(ms)
  await page.evaluate(() => window.__wake?.(400))
  await page.waitForTimeout(700)
}
const setMode = async (page, mode) => {
  await page.evaluate((m) => window.__settings.setMode(m), mode)
  await page.waitForTimeout(1200)
  await page.waitForFunction(() => !!window.__globe)
}
const detailOf = (page) =>
  page.evaluate(() => ({
    z: window.__detail?.index?.z,
    grid: window.__detail?.index?.grid,
    parent: window.__detail?.index?.parent,
    resident: window.__detail?.index?.resident,
    sharp: window.__detail?.index?.sharp,
    want: window.__detail?.wanted,
  }))

// `ONLY=rail` skips the two map sections, which take twelve minutes of
// SwiftShader between them and have nothing to do with the rail.
const only = process.env.ONLY ?? 'all'
console.log(`\nshots -> ${shots}`)
const page = await open(1280, 800)
if (only !== 'rail') {

/* ---------------------------------------------- 1. the chord across the ocean */
console.log('\n(1) drawn world view — the reported streak')
await setMode(page, 'schematic')
await look(page, 12, 78, 2.6, 9000)
await shot(page, '1a-world-indian-ocean')
await look(page, 30, 120, 1.4, 8000)
await shot(page, '1b-world-east-asia')

/* --------------------------------------------------- 2. the antimeridian seam */
console.log('\n(2) the antimeridian — drawn and satellite')
for (const [mode, tag] of [
  ['schematic', 'drawn'],
  ['realistic', 'satellite'],
]) {
  await setMode(page, mode)
  for (const [lng, name] of [
    [180, 'on'],
    [174, 'west'],
    [-174, 'east'],
  ]) {
    await look(page, 56, lng, 0.09, 10_000)
    const s = await detailOf(page)
    console.log(
      `    ${tag} @${lng}: z${s.z} grid ${JSON.stringify(s.grid)} parent ${JSON.stringify(s.parent)} ` +
        `resident ${s.resident} sharp ${s.sharp} want ${s.want && `${s.want.minLng.toFixed(1)}..${s.want.maxLng.toFixed(1)}`}`,
    )
    await shot(page, `2-${tag}-seam-${name}`)
  }
}

console.log('\n(2b) a pan across the seam, one degree at a time')
await setMode(page, 'schematic')
await look(page, 56, 176, 0.09, 9000)
for (const lng of [178, 179.5, -179.5, -178, -176]) {
  await page.evaluate((l) => window.__globe.pointOfView({ lat: 56, lng: l, altitude: 0.09 }), lng)
  await page.waitForTimeout(3500)
  const s = await detailOf(page)
  console.log(`    @${lng}: grid ${JSON.stringify(s.grid)} resident ${s.resident} sharp ${s.sharp}`)
}
await page.waitForTimeout(4000)
await shot(page, '2c-drawn-seam-after-pan')

} // end of the map sections

/* ------------------------------------------------------- 3+4. the saga rail */
console.log('\n(3,4) the saga rail')
await setMode(page, 'schematic')
await page.evaluate(() => window.__setTime(1941))
await page.waitForFunction(() => window.__events.byId('ww2')?.steps)
await page.evaluate(() => window.__events.showOnMap('ww2'))
await page.waitForTimeout(2500)

const railBox = () =>
  page.evaluate(() => {
    const r = document.querySelector('[data-test="saga-timeline"]').getBoundingClientRect()
    return { x: 0, y: Math.round(r.y) - 4, width: 1280, height: Math.round(r.height) + 8 }
  })
const controls = () =>
  page.evaluate(() => {
    const out = {}
    for (const key of ['saga-zoom', 'saga-zoom-out', 'saga-zoom-in', 'saga-zoom-fit', 'saga-prev', 'saga-next', 'saga-list-toggle']) {
      const el = document.querySelector(`[data-test="${key}"]`)
      if (!el) continue
      const r = el.getBoundingClientRect()
      const svg = el.querySelector('svg')
      const ink = svg?.getBBox?.() ?? null
      out[key] = {
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        right: Math.round(r.right),
        disabled: el.disabled ?? null,
        // how far the glyph's own ink sits from the button's centre
        off: svg
          ? [
              Math.round(svg.getBoundingClientRect().x + svg.getBoundingClientRect().width / 2 - (r.x + r.width / 2)),
              Math.round(svg.getBoundingClientRect().y + svg.getBoundingClientRect().height / 2 - (r.y + r.height / 2)),
            ]
          : null,
        inkBox: ink && [+ink.x.toFixed(1), +ink.y.toFixed(1), +ink.width.toFixed(1), +ink.height.toFixed(1)],
      }
    }
    return out
  })
const bands = () =>
  page.evaluate(() => {
    const track = document.querySelector('[data-test="saga-timeline"] .track').getBoundingClientRect()
    return [...document.querySelectorAll('[data-test="saga-station"]')].map((st) => {
      const b = st.querySelector('.band')
      const r = b?.getBoundingClientRect()
      return {
        step: st.dataset.step,
        markX: Math.round(st.getBoundingClientRect().x - track.x),
        band: r ? { x: Math.round(r.x - track.x), w: Math.round(r.width) } : null,
        cls: b ? b.className : null,
      }
    })
  })

await shot(page, '3a-rail-fitted', await railBox())
console.log('    controls:', JSON.stringify(await controls()))
console.log('    window:', await page.evaluate(() => document.querySelector('[data-test="saga-timeline"] .track').dataset.window))

// zoom the window in hard, the way the reader did: wheel over the rail
const wheelTo = async (u0, u1) => {
  await page.evaluate(
    ([a, b]) => {
      const el = document.querySelector('[data-test="saga-timeline"] .track')
      el.__setWindow ? el.__setWindow(a, b) : null
    },
    [u0, u1],
  )
}
// no test hook for the window, so use the real gesture: repeated wheel-up at a point
const wheelAt = async (fraction, times) => {
  const r = await page.evaluate(() => {
    const el = document.querySelector('[data-test="saga-timeline"] .track').getBoundingClientRect()
    return { x: el.x, y: el.y, w: el.width, h: el.height }
  })
  await page.mouse.move(r.x + r.w * fraction, r.y + r.h * 0.55)
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(60)
  }
  await page.waitForTimeout(500)
}

// June 1944 is ~0.79 of a 1939-09-01 … 1945-09-02 span
await wheelAt(0.79, 9)
console.log('    zoomed window:', await page.evaluate(() => document.querySelector('[data-test="saga-timeline"] .track').dataset.window))
await shot(page, '4a-rail-zoomed-1944', await railBox())
console.log('    bands @1944:', JSON.stringify(await bands(), null, 1))
console.log('    controls @1944:', JSON.stringify(await controls()))

// …and a week in 1942, which is about 0.48 of the span
await wheelAt(0.4, 8)
console.log('    deeper window:', await page.evaluate(() => document.querySelector('[data-test="saga-timeline"] .track').dataset.window))
await shot(page, '4b-rail-zoomed-1942-week', await railBox())
console.log('    bands @1942:', JSON.stringify(await bands(), null, 1))
console.log('    controls @1942:', JSON.stringify(await controls()))

/* a phone, where the icon centring shows */
const phone = await open(390, 844, 2)
await phone.evaluate(() => window.__setTime(1941))
await phone.waitForFunction(() => window.__events.byId('ww2')?.steps)
await phone.evaluate(() => window.__events.showOnMap('ww2'))
await phone.waitForTimeout(2500)
const pbox = await phone.evaluate(() => {
  const r = document.querySelector('[data-test="saga-timeline"]').getBoundingClientRect()
  return { x: 0, y: Math.round(r.y) - 4, width: 390, height: Math.round(r.height) + 8, scale: 1 }
})
{
  let cdp = sessions.get(phone)
  if (!cdp) sessions.set(phone, (cdp = await phone.context().newCDPSession(phone)))
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: pbox })
  writeFileSync(join(shots, '3b-rail-phone.png'), Buffer.from(data, 'base64'))
}
console.log(
  '    phone controls:',
  JSON.stringify(
    await phone.evaluate(() => {
      const out = {}
      for (const key of ['saga-zoom', 'saga-zoom-out', 'saga-zoom-in', 'saga-zoom-fit']) {
        const el = document.querySelector(`[data-test="${key}"]`)
        if (!el) continue
        const r = el.getBoundingClientRect()
        const s = el.querySelector('svg').getBoundingClientRect()
        out[key] = {
          box: [Math.round(r.width), Math.round(r.height)],
          off: [Math.round(s.x + s.width / 2 - (r.x + r.width / 2)), Math.round(s.y + s.height / 2 - (r.y + r.height / 2))],
        }
      }
      return out
    }),
  ),
)

console.log('\ndone')
await browser.close()
await server.close()
