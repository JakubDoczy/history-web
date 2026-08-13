/**
 * THE SELECTED PIN — round 58, and the reader's report is the whole of it.
 *
 * *"Selected event pin should be always displayed on top and it should be
 * visible it's selected. Rework how it's shown that something is selected —
 * right now the circle is crossing the pin in a weird way — it should either
 * circle the bottom/base of the pin or somehow else be visible."*
 *
 * Two claims, and neither can be settled by a unit test:
 *
 *  1. ON TOP. The pins are CSS2D elements and three.js depth-sorts them by
 *     stamping an INLINE z-index on every one of them, every frame. A
 *     stylesheet rule at normal weight loses to that silently — which is what
 *     the old `.event-pin--selected { z-index: 2 }` did — so the only honest
 *     check is to read the COMPUTED z-index of the selected pin off a live
 *     globe and compare it with every other pin and every drawing label.
 *  2. VISIBLY SELECTED, and without a ring drawn across the artwork. That is a
 *     picture, taken on both grounds and at both pin sizes; the structural half
 *     (no circle round the head, a rim and a ground ring instead) is asserted
 *     over the artwork harness, where the SVG can be read back.
 *
 * Run:  node tests/e2e/pinSelect.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR, PLAYWRIGHT_MODULE — as the other e2e files.
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? join(here, 'shots')
const tag = process.env.SHOT_TAG ?? 'pinselect'
mkdirSync(shots, { recursive: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

let passed = 0
const failures = []
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(`${name}: ${err.message}`)
    console.log(`  FAIL ${name}\n       ${err.message}`)
  }
}
const ok = (cond, what) => {
  if (!cond) throw new Error(what)
}

const server = await createServer({ root, server: { port: 0 }, logLevel: 'warn' })
await server.listen()
const base = `http://localhost:${server.httpServer.address().port}`
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
})

const sessions = new Map()
/** See tests/e2e/steps.e2e.mjs: page.screenshot times out on a swiftshader globe. */
const shot = async (target, name, clip) => {
  let cdp = sessions.get(target)
  if (!cdp) sessions.set(target, (cdp = await target.context().newCDPSession(target)))
  await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 })
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  })
  writeFileSync(join(shots, `${tag}-${name}.png`), Buffer.from(data, 'base64'))
}

/* ============================================== (a) the artwork, read back */

console.log('\n(a) the selection mark, over tests/e2e/pins.harness.ts')
{
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 })
  await page.goto(`${base}/history-web/tests/e2e/pins.harness.html`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)
  const bands = await page.locator('.band').count()
  for (let i = 1; i <= bands; i++)
    await page
      .locator(`.band:nth-of-type(${i})`)
      .screenshot({ path: join(shots, `${tag}-0${i}-band${i}.png`) })

  const marks = await page.evaluate(() => {
    const svg = (cap) =>
      [...document.querySelectorAll('.cap')].find((c) => c.textContent.trim() === cap)
        ?.parentElement.querySelector('svg').outerHTML ?? ''
    return {
      selected: svg('SELECTED top 30px'),
      plain: svg('plain top 30px'),
      saga: svg('saga top 30px'),
      area: svg('area top 30px'),
      minor: svg('SELECTED minor 18px'),
      stack: svg('stack'),
      selectedStack: svg('SELECTED stack'),
    }
  })
  await check('the selected pin no longer carries a circle round its head', () => {
    // the defect, as a string: r=10.5 at (12,11) is a ring wide enough to clear
    // the head and therefore wide enough to come back down across the tail
    ok(!/cx="12" cy="11" r="10.5"/.test(marks.selected), 'the crossing circle is still drawn')
    ok(marks.selected.length > 0 && marks.plain.length > 0, 'the harness lost its cells')
  })
  await check('it carries a rim on its own outline and a ring on the ground', () => {
    for (const [what, svg] of [['top', marks.selected], ['minor', marks.minor]]) {
      ok(/class="pin-rim"/.test(svg), `no rim on the ${what} pin`)
      ok(/class="pin-base"/.test(svg), `no ground ring on the ${what} pin`)
      // the rim is BEHIND the body: the teardrop is drawn after it
      ok(svg.indexOf('pin-rim') < svg.indexOf('stroke-width="1.5"'), `the ${what} rim is on top`)
    }
  })
  await check('an area pin’s own footprint is its ground ring, not a second one', () => {
    ok(/class="pin-footprint"/.test(marks.area), 'the selected area pin lost its footprint')
    ok(!/class="pin-base"/.test(marks.area), 'a second ellipse was stacked on the footprint')
  })
  await check('the saga ring survives it, inside the head where it always was', () => {
    ok(/r="7.1"/.test(marks.saga), 'no saga ring on the selected saga pin')
    ok(/class="pin-rim"/.test(marks.saga), 'no rim on the selected saga pin')
  })
  await check('a badge says it when the stack holds the open event', () => {
    ok(/r="21"/.test(marks.selectedStack), 'the selected badge has no ring')
    ok(!/r="21"/.test(marks.stack), 'an ordinary badge is ringed as if selected')
  })
  await page.close()
}

/* ================================================= (b) the live globe */

const settle = async (page, ms = 1500) => {
  await page.waitForTimeout(ms)
  await page
    .waitForFunction(
      () => document.querySelectorAll('.event-pin').length === window.__globe.htmlElementsData().length,
      null,
      { timeout: 15000 },
    )
    .catch(() => console.log('  [warn] pins never caught up with the data'))
}

/** Every pin's stacking order, as the browser computed it. */
const stacking = (page) =>
  page.evaluate(() => {
    const zOf = (el) => Number(getComputedStyle(el).zIndex) || 0
    const pins = [...document.querySelectorAll('.event-pin')]
    const sel = pins.filter((p) => p.classList.contains('event-pin--selected'))
    const others = pins.filter((p) => !p.classList.contains('event-pin--selected'))
    return {
      pins: pins.length,
      selected: sel.map(zOf),
      maxOther: Math.max(0, ...others.map(zOf)),
      maxLabel: Math.max(0, ...[...document.querySelectorAll('.drawing-label')].map(zOf)),
      // the container the whole overlay lives in: whatever the pin's number is,
      // it is trapped inside this one (tokens.css)
      overlay: zOf(document.querySelector('.globe-css2d')),
    }
  })

const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
await page.goto(base, { timeout: 90_000 })
await page.addStyleTag({
  content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
})
await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
await page.evaluate(() => {
  window.__time.setRange({ start: -550, end: 2026 })
  window.__time.setSelection(500, 1945)
})
await page.evaluate(() => window.__setTime(1941))
await settle(page, 2500)

console.log('\n(b) the pin the reader opened, on a globe of pins')
await page.evaluate(() => window.__events.select('ww2'))
await settle(page, 2000)
const z = await stacking(page)
console.log(`    ${z.pins} pins; selected z=${z.selected}, next best ${z.maxOther}, labels ${z.maxLabel}`)
await check('the selected pin outranks every other pin and every label', () => {
  ok(z.selected.length === 1, `${z.selected.length} pins claim the selection`)
  ok(z.selected[0] > z.maxOther, `selected ${z.selected[0]} vs ${z.maxOther}`)
  ok(z.selected[0] > z.maxLabel, `selected ${z.selected[0]} vs label ${z.maxLabel}`)
  // …and it is still inside the overlay's own stacking context, so it cannot
  // paint over a panel however large the number is
  ok(z.overlay === 1, `the overlay is at ${z.overlay}`)
})

/** The selected pin's own box, for a close crop. */
const selBox = async (pad = 60) => {
  const b = await page.locator('.event-pin--selected').first().boundingBox()
  return {
    x: Math.max(0, Math.round(b.x) - pad),
    y: Math.max(0, Math.round(b.y) - pad),
    width: Math.round(b.width) + pad * 2,
    height: Math.round(b.height) + pad * 2,
  }
}
await shot(page, '05-globe-satellite')

console.log('\n(c) a dense stack, and the open pin inside it')
// Europe is where this corpus crowds, and the pin that is chosen is the one
// with the most NEIGHBOURS on screen — the case the report is about, where a
// selected pin is one teardrop among several overlapping ones.
await page.evaluate(() => window.__events.dismiss())
await page.evaluate(() => window.__globe.pointOfView({ lat: 44, lng: 14, altitude: 0.45 }, 0))
await settle(page, 2400)
const crowded = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.event-pin')].map((el) => {
    const r = el.getBoundingClientRect()
    return { el, x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  const near = (b) => boxes.filter((o) => Math.hypot(o.x - b.x, o.y - b.y) < 220).length
  const data = window.__globe.htmlElementsData()
  const pins = data.filter((d) => d.kind !== 'cluster')
  // …and clear of the panel, which opens over the left of the globe on
  // selection: a crop of the pin is no use if the panel is standing on it
  const clear = (b) => b.x > 560 && b.x < innerWidth - 120 && b.y > 140 && b.y < innerHeight - 260
  // pair each datum with its element by title, which is the pin's own name
  const best = pins
    .map((d) => {
      const el = boxes.find((b) => b.el.title?.startsWith(d.event.name))
      return { id: d.id, crowd: el && clear(el) ? near(el) : 0 }
    })
    .sort((a, b) => b.crowd - a.crowd)[0]
  if (best) window.__events.select(best.id)
  return best
})
await settle(page, 2200)
const dense = await stacking(page)
console.log(`    ${dense.pins} pins, opened ${crowded?.id} with ${crowded?.crowd} in reach`)
await shot(page, '06-dense-stack-satellite', await selBox(150))
await shot(page, '07-dense-frame-satellite')
await check('it is still on top with a crowd of pins around it', () => {
  ok(dense.pins > 5, `only ${dense.pins} pins on screen`)
  ok(crowded?.crowd > 1, `the busiest pin had ${crowded?.crowd} neighbours`)
  ok(dense.selected[0] > dense.maxOther, `selected ${dense.selected[0]} vs ${dense.maxOther}`)
})

console.log('\n(d) the same pin, the same camera, on paper')
// The mode switch is the whole comparison: same event, same crowd, same crop,
// and the only thing that changed is the ground the mark has to hold up on
// (lib/present/ink.ts, `inkOnPaper`).
await page.evaluate(() => (window.__settings.mode = 'schematic'))
await settle(page, 2600)
await shot(page, '08-dense-stack-paper', await selBox(150))
await shot(page, '09-dense-frame-paper')
const flat = await stacking(page)
await check('it keeps the top of the stack in map mode', () => {
  ok(flat.selected[0] > flat.maxOther, `selected ${flat.selected[0]} vs ${flat.maxOther}`)
})
// …and at the other size: the smallest pin on screen, which is where a mark
// either survives or does not (18 px of teardrop, ~24 selected)
const small = await page.evaluate(() => {
  const data = window.__globe.htmlElementsData().filter((d) => d.kind !== 'cluster')
  const els = [...document.querySelectorAll('.event-pin')]
  const clear = (r) => r.x > 560 && r.x < innerWidth - 120 && r.y > 140 && r.y < innerHeight - 260
  const ranked = data
    .map((d) => {
      const el = els.find((e) => e.title?.startsWith(d.event.name))
      const r = el?.getBoundingClientRect()
      return { id: d.id, h: r && clear(r) ? r.height : Infinity }
    })
    .sort((a, b) => a.h - b.h)[0]
  if (ranked && ranked.h < Infinity) window.__events.select(ranked.id)
  return ranked
})
await settle(page, 2200)
if (small?.h < Infinity) {
  await shot(page, '10-small-pin-paper', await selBox(110))
  await page.evaluate(() => (window.__settings.mode = 'realistic'))
  await settle(page, 2200)
  await shot(page, '11-small-pin-satellite', await selBox(110))
  const zs = await stacking(page)
  await check('a minor pin says it is open too, and is on top while it is', () => {
    ok(zs.selected.length === 1, `${zs.selected.length} pins claim the selection`)
    ok(zs.selected[0] > zs.maxOther, `selected ${zs.selected[0]} vs ${zs.maxOther}`)
  })
} else {
  await page.evaluate(() => (window.__settings.mode = 'realistic'))
  await settle(page, 2000)
}

console.log('\n(e) opening an event that was inside a stack')
/*
 * THE BADGE CASE, and it turns out to be an invariant rather than a treatment.
 *
 * `layoutPins` (lib/eventClusters.ts) lifts the open event OUT of its badge and
 * draws it on its own coordinates, leaving the badge to cover what is left. So
 * a badge cannot hide the selection while the layout is doing its job — which
 * is a better answer than marking the badge would have been, because a lifted
 * pin can carry the whole treatment and a badge could only carry a hint of it.
 *
 * What that leaves for this file is the case it creates: a full-size selected
 * pin standing ON TOP OF the badge it just came out of, at the same spot. That
 * is the stacking claim in its hardest form, and the badge's own fallback mark
 * (`ClusterSpec.select`) is tested in tests/eventPins.test.ts against the day
 * the lift is not there.
 */
const collapsed = await page.evaluate(() => {
  const data = window.__globe.htmlElementsData()
  const badge = data.find((d) => d.kind === 'cluster' && d.members.length > 1)
  if (!badge) return null
  window.__events.select(badge.members[0].id)
  return { count: badge.members.length, member: badge.members[0].id }
})
await settle(page, 2400)
if (collapsed)
  Object.assign(
    collapsed,
    await page.evaluate(() => {
      const sel = window.__events.selectedId
      const data = window.__globe.htmlElementsData()
      return {
        hidden: data.some((d) => d.kind === 'cluster' && d.members.some((m) => m.id === sel)),
        lifted: data.some((d) => d.kind !== 'cluster' && d.id === sel),
        badges: data.filter((d) => d.kind === 'cluster').length,
      }
    }),
  )
console.log(`    opened ${collapsed?.member} out of a stack of ${collapsed?.count}`)
await check('the open event is lifted out of the stack rather than hidden in it', () => {
  ok(collapsed, 'no stack on screen to open an event out of')
  ok(!collapsed.hidden, 'the open event is still inside a badge')
  ok(collapsed.lifted, 'the open event has no pin of its own')
})
const zc = await stacking(page)
await check('and the lifted pin is over the badge it came out of', () => {
  ok(zc.selected[0] > zc.maxOther, `selected ${zc.selected[0]} vs ${zc.maxOther}`)
})
await shot(page, '12-selection-lifted-from-stack', await selBox(150))

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  - ${f}`)
console.log(`shots in ${shots}`)
await browser.close()
await server.close()
process.exit(failures.length ? 1 : 0)
