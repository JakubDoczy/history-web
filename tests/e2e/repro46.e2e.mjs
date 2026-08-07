/**
 * ROUND 46 — the three things the phone reported, measured in a browser.
 *
 *   (1) "the minimised icon (that circle with ^) is still not shown properly on
 *       mobile (^ is not centered)" — reported a SECOND time, after round 45
 *       measured dx = 0.00 in this very harness. So this file no longer asks
 *       where the <svg> element is; it asks where the rendered PATH's own
 *       bounding box is (getBBox through getScreenCTM), and it asks it again
 *       with the button's layout DEGRADED — `display: block`, which is what an
 *       engine that will not make a <button> a flex or grid container falls
 *       back to, and where a glyph centred by alignment lands on a font's
 *       baseline instead. A centring that survives that is a centring no device
 *       can disagree with.
 *   (2) the rail zooms, and its rule refines year → month → day as it does.
 *   (3) the phone's rail is taller, and the step you are on is drawn on top.
 *
 * It measures rather than asserts where a number is the answer, so the same
 * file can be run before and after and the two compared.
 *
 * Run:  node tests/e2e/repro46.e2e.mjs
 * Env:  SHOT_DIR (default /tmp/shots46), CHROME_PATH, PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots46'
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
const shot = async (page, name, clip, scale = 1) => {
  let cdp = sessions.get(page)
  if (!cdp) sessions.set(page, (cdp = await page.context().newCDPSession(page)))
  await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 })
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale } } : {}),
  })
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'))
}
const settle = (page, ms = 1200) => page.waitForTimeout(ms)

async function open(width, height, dsf, { safe = false, touch = true } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dsf,
    isMobile: touch && width <= 640,
    hasTouch: touch,
  })
  const page = await ctx.newPage()
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
  await page.goto(base, { timeout: 90_000 })
  await page.addStyleTag({
    content:
      '*, *::before, *::after { animation: none !important; transition: none !important; }' +
      // a notch, simulated: --safe-b is nonzero on the device the report came from
      (safe ? ':root { --safe-b: 34px !important; --safe-t: 47px !important; }' : ''),
  })
  await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
  await page.waitForFunction(() => window.__events.byId('ww2')?.steps, null, { timeout: 60_000 })
  await page.evaluate(() => window.__setTime(1941))
  await settle(page, 1800)
  return page
}

/**
 * Where a control's INK actually is, relative to the button that frames it.
 *
 * `getBBox` is the path's own geometry in user units; `getScreenCTM` is the
 * matrix the browser will paint it with. Multiplying the two is the only
 * measurement that answers "is the shape in the middle of the ring" — the
 * <svg> element's box, which is what round 45 measured, says nothing about
 * where the path inside it sits.
 */
const inkOf = (page, sel) =>
  page.evaluate((s) => {
    const b = document.querySelector(s)
    if (!b) return null
    const r = b.getBoundingClientRect()
    const path = b.querySelector('svg path, svg circle')
    const svg = path.ownerSVGElement
    // the union of every drawable in the icon, in screen px
    const m = svg.getScreenCTM()
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const el of svg.querySelectorAll('path, circle, rect, line')) {
      const bb = el.getBBox()
      for (const [x, y] of [[bb.x, bb.y], [bb.x + bb.width, bb.y + bb.height]]) {
        const p = { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y)
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
      }
    }
    const cs = getComputedStyle(b)
    return {
      box: [r.x, r.y, r.width, r.height].map((v) => +v.toFixed(2)),
      ink: [x0, y0, x1 - x0, y1 - y0].map((v) => +v.toFixed(2)),
      dx: +((x0 + x1) / 2 - (r.x + r.width / 2)).toFixed(3),
      dy: +((y0 + y1) / 2 - (r.y + r.height / 2)).toFixed(3),
      display: cs.display,
      padding: cs.padding,
      font: cs.fontFamily.split(',')[0].replace(/"/g, ''),
    }
  }, sel)

/** The rail, as the reader sees it: rule, stations, lanes, and who is on top. */
const railOf = (page) =>
  page.evaluate(() => {
    const nav = document.querySelector('[data-test="saga-timeline"]')
    if (!nav) return null
    const nb = nav.getBoundingClientRect()
    const track = nav.querySelector('.track').getBoundingClientRect()
    return {
      rail: [nb.x, nb.y, nb.width, nb.height].map(Math.round),
      trackW: Math.round(track.width),
      scrollW: nav.querySelector('.track').scrollWidth,
      clientW: nav.querySelector('.track').clientWidth,
      ticks: [...nav.querySelectorAll('[data-test="saga-tick"]')].map((t) => ({
        label: t.querySelector('i').textContent.trim(),
        x: Math.round(t.getBoundingClientRect().x),
      })),
      stations: [...nav.querySelectorAll('[data-test="saga-station"]')]
        .map((b) => {
          const r = b.getBoundingClientRect()
          return {
            step: b.dataset.step,
            cx: Math.round(r.x + r.width / 2),
            lane: +b.dataset.lane,
            z: +getComputedStyle(b).zIndex || 0,
            on: b.classList.contains('on'),
            named: b.classList.contains('named'),
            label: b.querySelector('.label')?.textContent.replace(/\s+/g, ' ').trim(),
          }
        })
        .filter((s) => s.cx > -400 && s.cx < 2000),
      window: nav.querySelector('.track').dataset.window,
      // round 51: one magnifier became [−] [+] [fit] at the rail's right edge
      zoom: (() => {
        const at = (k) => {
          const b = document.querySelector(`[data-test="saga-zoom-${k}"]`)
          return b && !b.disabled
        }
        return { out: at('out'), in: at('in'), fit: at('fit') }
      })(),
    }
  })

/**
 * Wait for the rail to have panned the cursor's station into the window.
 *
 * The pan is an eased glide driven by requestAnimationFrame, and under
 * swiftshader a WebGL globe starves rAF badly enough that a 240 ms tween lands
 * whole seconds later (it is time-based, so it arrives — just not on a wall
 * clock). Waiting on the OUTCOME rather than on a sleep is what makes this
 * measure the behaviour instead of the harness.
 */
const panned = (page) =>
  page.waitForFunction(
    () => {
      const b = document.querySelector('.station.cursor')
      const t = document.querySelector('[data-test="saga-timeline"] .track')
      if (!b || !t) return false
      const [r, tb] = [b.getBoundingClientRect(), t.getBoundingClientRect()]
      const cx = r.x + r.width / 2
      return cx >= tb.x && cx <= tb.right
    },
    null,
    { timeout: 15_000 },
  )

/** One notch of the wheel over the rail, anchored on a station if named. */
async function wheelOver(page, step, dy, times = 1) {
  for (let i = 0; i < times; i++) {
    const at = await page.evaluate((id) => {
      const t = document.querySelector('[data-test="saga-timeline"] .track').getBoundingClientRect()
      const s = document.querySelector(`[data-test="saga-station"][data-step="${id}"]`)
      const r = s?.getBoundingClientRect()
      const x = r ? Math.min(Math.max(r.x + r.width / 2, t.x + 8), t.right - 8) : t.x + t.width / 2
      return { x, y: t.y + t.height / 2 }
    }, step)
    await page.mouse.move(at.x, at.y)
    await page.mouse.wheel(0, dy)
    await page.waitForTimeout(90)
  }
}

const report = {}

/* ======================================================================== (1)
   THE CHEVRON, ON THREE PHONES, WITH AND WITHOUT A LAYOUT TO LEAN ON        */
console.log('\n===== (1) the pill’s controls: where the INK is =====')
for (const [tag, w, h, dsf, safe] of [
  ['390', 390, 844, 3, false],
  ['360', 360, 780, 2.75, false],
  ['414', 414, 896, 2, false],
  ['390-safe', 390, 844, 3, true],
]) {
  const page = await open(w, h, dsf, { safe })
  await page.evaluate(() => window.__events.showOnMap('ww2'))
  await settle(page, 1500)
  if (!(await page.evaluate(() => window.__events.panelMinimised)))
    await page.evaluate(() => window.__events.toggleFocusExpanded())
  await page.waitForSelector('[data-test="panel-pill"]')
  await settle(page, 300)

  const R = (report[tag] = {})
  for (const sel of ['pill-restore', 'pill-close']) {
    R[sel] = await inkOf(page, `[data-test="${sel}"]`)
    console.log(`  ${tag} ${sel}: dx=${R[sel].dx} dy=${R[sel].dy} ink=${R[sel].ink} box=${R[sel].box}`)
  }
  // …and the same measurement with the button's layout taken away. An engine
  // that will not lay a <button> out as flex or grid falls back to this, and a
  // glyph centred by alignment lands wherever the font's strut puts it.
  await page.addStyleTag({
    content: '[data-test="pill-restore"], [data-test="pill-close"] { display: block !important; }',
  })
  await settle(page, 120)
  for (const sel of ['pill-restore', 'pill-close']) {
    const d = await inkOf(page, `[data-test="${sel}"]`)
    R[`${sel}-degraded`] = d
    console.log(`  ${tag} ${sel} (display:block): dx=${d.dx} dy=${d.dy}`)
  }
  await page.evaluate(() => document.querySelectorAll('style').forEach((s) => {
    if (s.textContent.includes('display: block !important')) s.remove()
  }))
  await settle(page, 120)

  const clip = await page.evaluate(() => {
    const r = document.querySelector('[data-test="pill-restore"]').getBoundingClientRect()
    return { x: r.x - 5, y: r.y - 5, width: r.width + 10, height: r.height + 10 }
  })
  await shot(page, `a-chevron-${tag}-4x`, clip, 4)
  const pill = await page.evaluate(() => {
    const r = document.querySelector('[data-test="panel-pill"]').getBoundingClientRect()
    return { x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 }
  })
  await shot(page, `a-pill-${tag}`, pill, 2)
  await page.context().close()
}

/* ======================================================================== (2)
   THE RULE REFINES AS THE WINDOW CLOSES ON D-DAY                            */
console.log('\n===== (2) the rail zooms, and the rule refines =====')
{
  const page = await open(1280, 860, 2, { touch: false })
  await page.evaluate(() => window.__events.showOnMap('ww2'))
  await settle(page, 2200)
  const y = (await railOf(page)).rail[1]
  const band = { x: 0, y: y - 2, width: 1280, height: 100 }

  const full = await railOf(page)
  report.railFull = full
  console.log(`  full span: ${full.ticks.map((t) => t.label).join(' ')}  (${full.ticks.length} ticks)`)
  console.log(`  scrollW=${full.scrollW} clientW=${full.clientW}  zoom control: ${JSON.stringify(full.zoom)}`)
  await shot(page, 'b-ww2-full-span', band)

  await wheelOver(page, 'd-day', -120, 6)
  const y44 = await railOf(page)
  report.rail1944 = y44
  console.log(`  zoomed once: ${y44.ticks.map((t) => t.label).join(' ')}`)
  await shot(page, 'b-ww2-1944', { ...band, y: (await railOf(page)).rail[1] - 2 })

  await wheelOver(page, 'd-day', -120, 8)
  const june = await railOf(page)
  report.railJune = june
  console.log(`  zoomed twice: ${june.ticks.map((t) => t.label).join(' ')}`)
  console.log(`  zoom control now: ${JSON.stringify(june.zoom)}`)
  await shot(page, 'b-ww2-june-1944', { ...band, y: june.rail[1] - 2 })

  /* (e) NEXT pans a station that is off the window back into view.
     Every step of the war is an ENTRANCE, so prev/next move the cursor and
     never descend (docs/design/sagas.md, rule 2) — which is exactly the case
     that has to pan: the target is a station the window is not showing. */
  const before = await railOf(page)
  const walk = []
  for (let i = 0; i < 4; i++) {
    await page.click('[data-test="saga-next"]')
    await panned(page).catch(() => console.log('  [warn] the station never came into view'))
    const r = await railOf(page)
    const cur = await page.evaluate(() => {
      const b = document.querySelector('.station.cursor')
      if (!b) return null
      const t = document.querySelector('[data-test="saga-timeline"] .track').getBoundingClientRect()
      const r = b.getBoundingClientRect()
      return {
        step: b.dataset.step,
        cx: Math.round(r.x + r.width / 2 - t.x),
        inWindow: r.x + r.width / 2 >= t.x && r.x + r.width / 2 <= t.right,
      }
    })
    walk.push({ ...cur, win: r.window, rule: `${r.ticks[0]?.label}…${r.ticks.at(-1)?.label}` })
  }
  const after = await railOf(page)
  report.pannedIn = { before: before.ticks.map((t) => t.label), walk }
  for (const w of walk)
    console.log(`  next → ${w.step} at x=${w.cx} inWindow=${w.inWindow} win=${w.win}, rule ${w.rule}`)
  await shot(page, 'e-desktop-next-panned-in', { ...band, y: after.rail[1] - 2 })

  await page.click('[data-test="saga-zoom-fit"]')
  await page.waitForFunction(
    () => document.querySelector('[data-test="saga-timeline"] .track').dataset.window === '0.0000,1.0000',
    null,
    { timeout: 15_000 },
  )
  console.log(`  Fit: ${(await railOf(page)).ticks.map((t) => t.label).join(' ')}`)
  await shot(page, 'e-desktop-fit-again', { ...band, y: (await railOf(page)).rail[1] - 2 })
  await page.context().close()
}

/* ======================================================================== (3)
   THE PHONE'S RAIL: TALLER, AND THE OPEN STEP ON TOP OF THE PILE-UP         */
console.log('\n===== (3) the phone rail: height, pile-up, z-order =====')
{
  const page = await open(390, 844, 3)
  await page.evaluate(() => window.__events.showOnMap('ww2'))
  await settle(page, 2200)
  const r0 = await railOf(page)
  report.phoneRail = { h: r0.rail[3], scrollW: r0.scrollW, clientW: r0.clientW }
  console.log(`  rail ${r0.rail[2]}x${r0.rail[3]}, track ${r0.clientW} wide, scrollW ${r0.scrollW}`)
  console.log(`  lanes used: ${[...new Set(r0.stations.map((s) => s.lane))].sort().join(',')}`)
  await shot(page, 'c-phone-rail-fit', { x: 0, y: r0.rail[1] - 2, width: 390, height: r0.rail[3] + 4 }, 2)
  await shot(page, 'd-phone-zoom-affordance', {
    x: 0, y: r0.rail[1] - 2, width: 390, height: 30,
  }, 4)

  // The pile-up: the last four steps of the war, one of them open. Selected
  // through the store because every step of the war is an entrance and a press
  // would descend — the z-order question is about the rail, not the descent.
  await page.evaluate(() => void (window.__events.stepId = 'trinity'))
  await settle(page, 900)
  const piled = await railOf(page)
  const cur = piled.stations.find((s) => s.on)
  const others = piled.stations.filter((s) => !s.on && Math.abs(s.cx - cur.cx) < 40)
  report.pileUp = {
    open: { step: cur.step, cx: cur.cx, z: cur.z, lane: cur.lane, label: cur.label },
    neighbours: others.map((s) => ({ step: s.step, cx: s.cx, z: s.z, lane: s.lane })),
  }
  console.log(`  open ${cur.step} z=${cur.z} lane=${cur.lane} label="${cur.label}"`)
  console.log(`  neighbours within 40px: ${others.map((s) => `${s.step}(z${s.z},L${s.lane})`).join(' ')}`)
  await shot(page, 'c-phone-selected-on-pileup', {
    x: 0, y: piled.rail[1] - 2, width: 390, height: piled.rail[3] + 4,
  }, 3)

  // and the pill still clears the taller rail
  const gap = await page.evaluate(() => {
    const p = document.querySelector('[data-test="panel-pill"]')?.getBoundingClientRect()
    const r = document.querySelector('[data-test="saga-timeline"]').getBoundingClientRect()
    return p ? Math.round(r.top - p.bottom) : null
  })
  report.pillGap = gap
  console.log(`  pill clears the rail by ${gap}px`)
  await shot(page, 'c-phone-full', null)
  await page.context().close()
}

writeFileSync(join(shots, 'report46.json'), JSON.stringify(report, null, 2))
console.log(`\nshots + report46.json in ${shots}`)
await browser.close()
await server.close()
process.exit(0)
