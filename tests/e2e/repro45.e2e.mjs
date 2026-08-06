/**
 * ROUND 45 — the four reported regressions, reproduced in a browser.
 *
 * Scratch harness: it measures rather than asserts, so the same file can be run
 * before and after the fix and the two numbers compared. Everything it looks at
 * is layout — where a glyph sits inside its button, whether a tick label is
 * inside the box that clips it — which is why none of it could be settled in a
 * unit test.
 *
 * Run:  node tests/e2e/repro45.e2e.mjs
 * Env:  SHOT_DIR (default /tmp/shots45/repro), CHROME_PATH, PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots45/repro'
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
const shot = async (page, name, clip) => {
  let cdp = sessions.get(page)
  if (!cdp) sessions.set(page, (cdp = await page.context().newCDPSession(page)))
  await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 })
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  })
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'))
}
const settle = (page, ms = 1400) => page.waitForTimeout(ms)

async function open(width, height, dsf) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dsf })
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
  await page.goto(base, { timeout: 90_000 })
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
  await page.evaluate(() => window.__setTime(1941))
  await page.waitForFunction(() => window.__events.byId('ww2')?.steps, null, { timeout: 60_000 })
  await settle(page, 2200)
  return page
}

/**
 * The restore control, and where its glyph actually sits inside it.
 *
 * ROUND 46: this measures the <svg> ELEMENT's box, which is what round 45
 * thought the question was — it read 0.00 here and the phone still disagreed.
 * The measurement that settles it is the rendered PATH's own bounding box
 * (tests/e2e/repro46.e2e.mjs, `inkOf`). Keep reading `dx` here only for the
 * phone, where the control is an icon-only square: on a desktop it is a chip
 * with the word "Restore" on it and the glyph is deliberately 14px from the
 * left edge, so `dx` is about -33 by design (`labelShown` says which case it
 * is).
 */
const restoreOf = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('[data-test="pill-restore"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    const svg = b.querySelector('svg').getBoundingClientRect()
    const label = b.querySelector('.pill-restore-label')
    const cs = getComputedStyle(b)
    return {
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      // the signed offset of the glyph's centre from the button's centre
      dx: +(svg.x + svg.width / 2 - (r.x + r.width / 2)).toFixed(2),
      dy: +(svg.y + svg.height / 2 - (r.y + r.height / 2)).toFixed(2),
      display: cs.display,
      justify: cs.justifyContent,
      padding: cs.padding,
      labelShown: label ? getComputedStyle(label).display !== 'none' : false,
      labelW: label ? Math.round(label.getBoundingClientRect().width) : 0,
    }
  })

/** The rail's rule: every tick, and whether its LABEL is inside what clips it. */
const railOf = (page) =>
  page.evaluate(() => {
    const nav = document.querySelector('[data-test="saga-timeline"]')
    if (!nav) return null
    const track = nav.querySelector('.track')
    const tb = track.getBoundingClientRect()
    const nb = nav.getBoundingClientRect()
    const ticks = [...nav.querySelectorAll('[data-test="saga-tick"]')].map((t) => {
      const i = t.querySelector('i')
      const r = i.getBoundingClientRect()
      return {
        label: i.textContent.trim(),
        x: Math.round(r.x),
        top: Math.round(r.y),
        bottom: Math.round(r.bottom),
        // inside the track's own box, horizontally and vertically?
        inX: r.x >= tb.x - 1 && r.right <= tb.right + 1,
        inY: r.y >= tb.y - 1 && r.bottom <= tb.bottom + 1,
        vis: getComputedStyle(i).visibility !== 'hidden' && +getComputedStyle(i).opacity > 0,
      }
    })
    return {
      nav: [Math.round(nb.x), Math.round(nb.y), Math.round(nb.width), Math.round(nb.height)],
      track: [Math.round(tb.x), Math.round(tb.y), Math.round(tb.width), Math.round(tb.height)],
      scrollW: track.scrollWidth,
      clientW: track.clientWidth,
      dashed: !!nav.querySelector('.inner.dateless'),
      ticks,
      stations: [...nav.querySelectorAll('[data-test="saga-station"]')].map((b) => ({
        step: b.dataset.step,
        cx: Math.round(b.getBoundingClientRect().x + b.getBoundingClientRect().width / 2),
        lane: +b.dataset.lane,
        named: b.classList.contains('named'),
      })),
      list: [...nav.querySelectorAll('[data-test="saga-list-item"]')].map((r) =>
        r.textContent.replace(/\s+/g, ' ').trim(),
      ),
    }
  })

const report = {}
for (const [tag, w, h, dsf] of [
  ['p390', 390, 844, 3],
  ['p360', 360, 780, 2.75],
  ['pc', 1280, 860, 2],
]) {
  console.log(`\n===== ${tag} ${w}x${h} @${dsf} =====`)
  const page = await open(w, h, dsf)
  const phone = w <= 640
  const R = (report[tag] = {})

  /* (1) the minimised pill and its Restore control */
  await page.evaluate(() => window.__events.showOnMap('ww2'))
  await settle(page, 1800)
  if (!(await page.evaluate(() => window.__events.panelMinimised)))
    await page.evaluate(() => window.__events.toggleFocusExpanded())
  await page.waitForSelector('[data-test="panel-pill"]', { timeout: 20_000 })
  await settle(page, 400)
  const pillBox = await page.evaluate(() => {
    const r = document.querySelector('[data-test="panel-pill"]').getBoundingClientRect()
    return { x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 }
  })
  R.restore = await restoreOf(page)
  console.log('  (1) restore:', JSON.stringify(R.restore))
  await shot(page, `${tag}-1-pill`)
  await shot(page, `${tag}-1-pill-close`, pillBox)
  // hover + active, which must not break it either
  await page.hover('[data-test="pill-restore"]')
  await settle(page, 200)
  R.restoreHover = await restoreOf(page)
  await shot(page, `${tag}-1-pill-hover`, pillBox)

  /* (2) the WWII rail — is the rule visible at all? */
  R.ww2 = await railOf(page)
  console.log(
    `  (2) ww2 rail ticks=${R.ww2.ticks.map((t) => t.label).join(',') || '(none)'} ` +
      `inY=${R.ww2.ticks.map((t) => +t.inY).join('')} scroll=${R.ww2.scrollW}/${R.ww2.clientW}`,
  )
  console.log('      track box', R.ww2.track, 'nav', R.ww2.nav)
  for (const t of R.ww2.ticks.slice(0, 3)) console.log('      tick', JSON.stringify(t))
  await shot(page, `${tag}-2-ww2-rail`, {
    x: 0,
    y: R.ww2.nav[1] - 2,
    width: w,
    height: R.ww2.nav[3] + 4,
  })
  await shot(page, `${tag}-2-ww2-full`)

  /* (3) the D-Day rail — the point-dated, dashed, unruled axis */
  await page.evaluate(() => window.__events.showOnMap('d-day'))
  await settle(page, 1800)
  R.dday = await railOf(page)
  console.log(
    `  (3) d-day rail dashed=${R.dday.dashed} ticks=${R.dday.ticks.map((t) => t.label).join(',')}`,
  )
  console.log('      list:', JSON.stringify(R.dday.list))
  await shot(page, `${tag}-3-dday-rail`, {
    x: 0,
    y: R.dday.nav[1] - 2,
    width: w,
    height: R.dday.nav[3] + 4,
  })

  /* barbarossa too — the other point-dated saga */
  await page.evaluate(() => window.__events.showOnMap('barbarossa'))
  await settle(page, 1800)
  R.barb = await railOf(page)
  console.log(`  (3b) barbarossa dashed=${R.barb.dashed} list: ${JSON.stringify(R.barb.list)}`)
  await shot(page, `${tag}-3b-barbarossa-rail`, {
    x: 0,
    y: R.barb.nav[1] - 2,
    width: w,
    height: R.barb.nav[3] + 4,
  })

  /* (4) Show on map with a step open */
  await page.evaluate(() => window.__events.showOnMap('barbarossa'))
  await settle(page, 1200)
  await page.evaluate(() => window.__events.selectStep('kiev'))
  await settle(page, 800)
  const before = await page.evaluate(() => ({
    step: window.__events.stepId,
    min: window.__events.panelMinimised,
  }))
  // the generic button lives on the article, so bring it up the way a reader does
  if (await page.evaluate(() => window.__events.panelMinimised))
    await page.click('[data-test="pill-expand"]')
  await page.waitForSelector('[data-test="show-on-map"]', { timeout: 20_000 })
  await shot(page, `${tag}-4-before-show-on-map`)
  await page.click('[data-test="show-on-map"]')
  await settle(page, 1200)
  const after = await page.evaluate(() => ({
    step: window.__events.stepId,
    min: window.__events.panelMinimised,
    stack: [...window.__events.focusStack],
  }))
  R.showOnMap = { before, after }
  console.log(`  (4) step ${before.step} -> ${after.step}  (stack ${after.stack})`)
  await shot(page, `${tag}-4-after-show-on-map`)

  await page.close()
}

writeFileSync(join(shots, 'report.json'), JSON.stringify(report, null, 2))
console.log(`\nshots + report in ${shots}`)
await browser.close()
await server.close()
