/**
 * In-browser check of SAGAS (docs/design/sagas.md), in two halves.
 *
 * THE ARTWORK, over tests/e2e/pins.harness.ts — the same resolver the globe
 * uses, at the sizes a pin is really drawn at, on a bright ocean and on dark
 * land. What only a picture can settle: that the category glyphs are legible
 * at 12–16 px, that the saga ring is visible without being mistaken for the
 * selection halo, and that a badge hiding a saga says so.
 *
 * THE RECURSION, over the shipped corpus and the real globe:
 *
 *   · World War II opens as a saga, on its overview, with a strip whose chips
 *     are ENTRANCES — each one carrying the descend cue;
 *   · pressing "D-Day landings" pushes a second focus context: the war's plan
 *     goes, D-Day's plan comes up, and the strip is D-Day's own steps;
 *   · one more press goes deeper still, into a step of D-Day;
 *   · and the way back out is the ordinary one — back to the war's OVERVIEW,
 *     not to the chip that was pressed.
 *
 * Run:  node tests/e2e/saga.e2e.mjs
 * Env:  CHROME_PATH        Chromium/Chrome executable
 *       SHOT_DIR           where screenshots land
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? join(here, 'shots')
const tag = process.env.SHOT_TAG ?? 'saga'
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
const eq = (a, b, what) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

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
  // `clip` needs a scale, and it is 1 on purpose: these crops are the argument
  // that a mark is legible at the size it is really drawn, and re-rendering the
  // vector at 3x would be an argument about a screen nobody has.
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  })
  writeFileSync(join(shots, `${tag}-${name}.png`), Buffer.from(data, 'base64'))
}

/* ============================================================= the artwork */

console.log('\n(a) pin artwork at real size — glyphs, the ring, and a stacked saga')
{
  // 1x, because the question is what a normal display shows: at 2x every mark
  // gets twice the pixels it will really have and the comparison is a lie.
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 1 })
  await page.goto(`${base}/history-web/tests/e2e/pins.harness.html`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)
  await shot(page, '01-pin-artwork')
  const box = async (sel) => {
    const b = await page.locator(sel).boundingBox()
    return { x: Math.round(b.x) - 8, y: Math.round(b.y) - 8, width: Math.round(b.width) + 16, height: Math.round(b.height) + 16 }
  }
  // close crops of the three claims, so each is a picture of one thing
  await shot(page, '02-glyphs-close', await box('.band:nth-of-type(2) .row:nth-of-type(1)'))
  await shot(page, '03-saga-ring-and-stack', await box('.band:nth-of-type(2) .row:nth-of-type(2)'))
  await shot(page, '04-magnified', await box('.band:last-of-type .row'))

  const marks = await page.evaluate(() => {
    // matched on the CAPTION, not on the cell: a badge's own SVG carries the
    // count as text, so the cell's textContent starts with "3"
    const svg = (cap) =>
      [...document.querySelectorAll('.cap')].find((c) => c.textContent.trim() === cap)
        ?.parentElement.querySelector('svg').outerHTML ?? ''
    return {
      war: svg('war minor 18px'),
      trade: svg('trade minor 18px'),
      plain: svg('plain minor 18px'),
      saga: svg('saga'),
      stack: svg('stack with a saga'),
      plainStack: svg('stack without'),
    }
  })
  await check('a war pin carries swords and a trade pin carries coins, at the minor size', () => {
    ok(/M8.1 15.1L16 7.2/.test(marks.war), 'no swords on the war pin')
    ok(/a3.8 1.5 0 1 0/.test(marks.trade), 'no coins on the trade pin')
    ok(/r="3.6"/.test(marks.plain), 'the default pin lost its plain dot')
  })
  await check('the saga ring is drawn, and a badge carries it for a member', () => {
    ok(/r="7.1"/.test(marks.saga), 'no ring on the saga pin')
    ok(/r="15.8"/.test(marks.stack), 'the badge hides a saga and does not say so')
    ok(!/r="15.8"/.test(marks.plainStack), 'a badge with no saga in it is ringed')
  })
  await page.close()
}

/* =========================================================== the recursion */

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

const stateOf = (page) =>
  page.evaluate(() => ({
    stack: [...window.__events.focusStack],
    focus: window.__events.focus?.itemId,
    selected: window.__events.selectedId,
    step: window.__events.stepId ?? null,
    count: document.querySelector('[data-test="step-count"]')?.textContent ?? null,
    chips: [...document.querySelectorAll('[data-test="step-chip"]')].map((b) => ({
      step: b.dataset.step,
      entrance: b.dataset.entrance !== undefined,
      on: b.classList.contains('on'),
    })),
    layers: (window.__events.focusDrawing?.layers ?? []).length,
    sagaPins: document.querySelectorAll('.event-pin--saga').length,
    title: document.querySelector('article h2')?.textContent ?? null,
    back: document.querySelector('[data-test="focus-back"]')?.textContent.trim() ?? null,
    cursor: window.__time.currentTime,
  }))

const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
await page.goto(base, { timeout: 90_000 })
await page.addStyleTag({
  content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
})
await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
await page.waitForFunction(() => window.__events.byId('ww2')?.steps)
await page.evaluate(() => window.__setTime(1941))
await settle(page, 2500)

console.log('\n(b) World War II — a saga whose steps are its parts')
await page.evaluate(() => window.__events.showOnMap('ww2'))
await settle(page, 2800)
const war = await stateOf(page)
await shot(page, '05-ww2-strip')
console.log(`    ${war.count}, ${war.chips.length} chips, ${war.sagaPins} saga pins on the globe`)
await check('it opens on its overview, with the strip saying what it is', () => {
  ok(war.step === null, `landed on step ${war.step}`)
  ok(/^SAGA/i.test(war.count.trim()), `the strip says "${war.count}"`)
  ok(war.count.includes('11'), `the strip counts "${war.count}"`)
})
await check('every chip is an entrance, and says so', () => {
  const steps = war.chips.filter((c) => c.step !== 'overview')
  ok(steps.length === 11, `${steps.length} chips`)
  ok(steps.every((c) => c.entrance), 'a step chip is not marked as an entrance')
  ok(!war.chips.find((c) => c.step === 'overview').entrance, 'Overview reads as an entrance')
})
const stripBox = await page.locator('[data-test="step-strip"]').boundingBox()
await shot(page, '06-entrance-chips', {
  x: Math.round(stripBox.x) - 6,
  y: Math.round(stripBox.y) - 6,
  width: Math.round(stripBox.width) + 12,
  height: Math.round(stripBox.height) + 12,
})

console.log('\n(c) descending — WWII → D-Day landings')
await page.click('[data-step="d-day"]')
await settle(page, 2800)
const dday = await stateOf(page)
await shot(page, '07-descended-d-day')
console.log(`    stack ${dday.stack.join(' > ')}, chips: ${dday.chips.map((c) => c.step).join(' ')}`)
await check('the child becomes the context, on the existing stack', () => {
  eq(dday.stack, ['ww2', 'd-day'], 'focus stack')
  ok(dday.selected === 'd-day', `panel on ${dday.selected}`)
  ok(dday.step === null, 'the descent left a step open')
  // No breadcrumb here, and that is the EXISTING rule rather than anything the
  // descent introduced: `focusReturnTo` names the context only while the panel
  // is on a *part* of it, and after a push the panel is on the context itself.
  // The way back is the ladder — Escape, or the panel's close — checked in (e).
  ok(dday.back === null, `an unexpected breadcrumb: "${dday.back}"`)
})
await check('the map is the child’s: its own plan, its own steps', () => {
  ok(dday.layers > 0, 'no plan on the globe')
  eq(
    dday.chips.map((c) => c.step),
    ['overview', 'six-june', 'beachhead', 'cherbourg', 'breakout'],
    'chips',
  )
  ok(dday.chips.slice(1).every((c) => !c.entrance), 'D-Day’s own steps read as entrances')
})

console.log('\n(d) one deeper — a step of the campaign inside the war')
await page.click('[data-step="cherbourg"]')
await settle(page, 2200)
const deep = await stateOf(page)
await shot(page, '08-step-inside-child')
await check('a page step still behaves as a page step, two contexts down', () => {
  ok(deep.step === 'cherbourg', `step is ${deep.step}`)
  eq(deep.stack, ['ww2', 'd-day'], 'focus stack')
  ok(deep.layers < dday.layers, 'the plan was not filtered to the step')
})

console.log('\n(e) climbing back out')
await page.click('[data-step="overview"]')
await settle(page, 1600)
await page.keyboard.press('Escape') // one rung of the ladder — see HomeView
await settle(page, 2600)
const out = await stateOf(page)
await shot(page, '09-back-out-to-ww2')
await check('back to the war, on its OVERVIEW rather than on the chip pressed', () => {
  eq(out.stack, ['ww2'], 'focus stack')
  ok(out.selected === 'ww2', `panel on ${out.selected}`)
  ok(out.step === null, `came back into step ${out.step}`)
  ok(out.chips.length === war.chips.length, 'the strip did not come back')
})

console.log('\n(f) map mode — the ring and the glyphs are not a photographic trick')
await page.evaluate(() => (window.__settings.mode = 'schematic'))
await settle(page, 2400)
const flat = await stateOf(page)
await shot(page, '10-schematic')
await check('the saga pins keep their ring in schematic mode', () => {
  ok(flat.sagaPins > 0, 'no saga pins in map mode')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  - ${f}`)
console.log(`shots in ${shots}`)
await browser.close()
await server.close()
process.exit(failures.length ? 1 : 0)
