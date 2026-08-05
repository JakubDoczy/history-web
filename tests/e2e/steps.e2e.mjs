/**
 * In-browser check of STEPPED FOCUS, over the shipped corpus and the real globe.
 *
 * What the product asked for, and what only a picture and a live store can show:
 *
 *   · a stepped event shows a STEP STRIP in focus mode, above the pill, with
 *     "Overview" first and one chip per step in time order;
 *   · Overview draws everything, exactly as before steps existed;
 *   · clicking a step filters the drawing to that step's layers plus the
 *     timeless ones, shows its page, and moves the time CURSOR (never the band);
 *   · Overview puts it all back;
 *   · the minor children — the regional battles that never make the global cut —
 *     are pinned inside the focus and nowhere else;
 *   · and it all fits on a phone.
 *
 * Run:  node tests/e2e/steps.e2e.mjs
 * Env:  CHROME_PATH        Chromium/Chrome executable
 *       SHOT_DIR           where screenshots land
 *       SHOT_TAG           prefix on every file
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? join(here, 'shots')
const tag = process.env.SHOT_TAG ?? 'steps'
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

/** Everything the stepped map is showing, as numbers a screenshot cannot be diffed on. */
const stateOf = (page) =>
  page.evaluate(() => ({
    focus: window.__events.focus?.itemId,
    step: window.__events.stepId ?? null,
    steps: window.__events.focusSteps.map((s) => s.id),
    mode: window.__settings.mode,
    highlights: [...window.__events.highlightedIds],
    accented: document.querySelectorAll('.event-pin--accent').length,
    // the layers actually handed to the renderer, by kind and by their caption
    layers: (window.__events.focusDrawing?.layers ?? []).map(
      (l) => `${l.type}:${l.label ?? l.text ?? ''}`,
    ),
    visible: window.__events.visible.map((e) => e.id).sort(),
    children: window.__events.focusChildren.map((e) => e.id).sort(),
    cursor: window.__time.currentTime,
    selection: { ...window.__time.selection },
    pins: document.querySelectorAll('.event-pin').length,
    chips: [...document.querySelectorAll('[data-test="step-chip"]')].map((b) => ({
      step: b.dataset.step,
      text: b.textContent.trim(),
      on: b.classList.contains('on'),
    })),
    page: document.querySelector('[data-test="step-page"] h3')?.textContent ?? null,
  }))

const settle = async (page, ms = 1400) => {
  await page.waitForTimeout(ms)
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('.event-pin').length ===
        window.__globe.htmlElementsData().length,
      null,
      { timeout: 15000 },
    )
    .catch(() => console.log('  [warn] pins never caught up with the data'))
}

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
  await page.goto(base, { timeout: 90_000 })
  // Under swiftshader the document timeline crawls, so a 0.24 s entrance is
  // still on its opening frame seconds later and every panel screenshots at
  // opacity 0. Nothing here is about the animations.
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
  await page.waitForFunction(() => window.__events.byId('barbarossa'))
  await settle(page, 2500)
  return page
}

/**
 * Screenshots go through CDP rather than through `page.screenshot`, which on a
 * WebGL page under swiftshader intermittently waits out its own timeout (the
 * shipped focusNav harness does the same, for the same reason). This asks the
 * renderer for the frame it has and writes it.
 */
const sessions = new Map()
const shot = async (target, name) => {
  let cdp = sessions.get(target)
  if (!cdp) sessions.set(target, (cdp = await target.context().newCDPSession(target)))
  await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 }) // the picture is the frame after this one
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, `${tag}-${name}.png`), Buffer.from(data, 'base64'))
}

const page = await open(1280, 860)
await page.evaluate(() => window.__setTime(1941))
await settle(page)

/* ------------------------------------------------- barbarossa, overview -- */
console.log('\n(a) Barbarossa in focus — the overview')
await page.evaluate(() => window.__events.showOnMap('barbarossa'))
await settle(page, 2800)
const overview = await stateOf(page)
await shot(page, '01-overview')
console.log(
  `    ${overview.layers.length} layers, ${overview.visible.length} pins, chips: ` +
    overview.chips.map((c) => c.text).join(' | '),
)
await check('the strip appears, Overview first, one chip per step in time order', () => {
  eq(
    overview.chips.map((c) => c.step),
    ['overview', 'border-battles', 'smolensk', 'kiev', 'typhoon', 'counteroffensive'],
    'chips',
  )
  ok(overview.chips[0].on, 'Overview is not the selected chip on arrival')
})
await check('the overview is the whole plan — every layer, no step', () => {
  ok(overview.step === null, `arrived on step ${overview.step}`)
  ok(overview.layers.length === 15, `overview draws ${overview.layers.length} layers, expected 15`)
})
await check('the minor children are pinned', () => {
  for (const id of ['brest-fortress', 'uman-pocket', 'tallinn-evacuation'])
    ok(overview.visible.includes(id), `${id} is not on the globe`)
  eq(overview.visible, ['barbarossa', ...overview.children].sort(), 'visible set')
})

/* ------------------------------------------------------ into a step ------ */
console.log('\n(b) clicking "Kiev (September)"')
await page.click('[data-step="kiev"]')
await settle(page, 2600)
const kiev = await stateOf(page)
await shot(page, '02-step-kiev')
console.log(`    layers: ${kiev.layers.join(', ')}`)
console.log(`    page heading: ${kiev.page}`)
await check('the drawing filters to the step plus the timeless layers', () => {
  ok(kiev.step === 'kiev', `step is ${kiev.step}`)
  ok(
    kiev.layers.length < overview.layers.length,
    `nothing was filtered out: ${kiev.layers.length} of ${overview.layers.length}`,
  )
  // the three army-group axes are true of the whole campaign and stay
  ok(kiev.layers.filter((l) => l.startsWith('thrust:')).length === 3, 'the axes were dropped')
  // …and the December front, which belongs to the last step, is gone
  ok(!kiev.layers.some((l) => l.includes('5 December')), 'the December front is still drawn')
  ok(kiev.layers.some((l) => l.includes('Kiev pocket')), 'the Kiev pocket is not drawn')
})
await check('the step page shows, headed with the step name', () => {
  ok(kiev.page?.includes('Kiev'), `step page heading: ${kiev.page}`)
})
await check('the chip is the selected one', () => {
  eq(kiev.chips.filter((c) => c.on).map((c) => c.step), ['kiev'], 'selected chips')
})
await check('the cursor moved and the selection band did not', () => {
  ok(kiev.cursor === 1941, `cursor at ${kiev.cursor}`)
  eq(kiev.selection, overview.selection, 'selection band')
})

console.log('\n(c) another step — "The counteroffensive (December)"')
await page.click('[data-step="counteroffensive"]')
await settle(page, 2000)
const dec = await stateOf(page)
await shot(page, '03-step-december')
await check('the December front is drawn and the June border is not', () => {
  ok(dec.layers.some((l) => l.includes('5 December')), 'the December front is missing')
  ok(!dec.layers.some((l) => l.includes('22 June')), 'the June border is still drawn')
  ok(dec.layers.some((l) => l.includes('Rostov')), 'the Rostov annotation is missing')
})
await check('per-step annotations do not leak between steps', () => {
  ok(!dec.layers.some((l) => l.includes('Brest')), 'a June annotation is on the December map')
  ok(!dec.layers.some((l) => l.includes('Uman')), 'a July annotation is on the December map')
})

/* ------------------------------------------------------- back out ------- */
console.log('\n(d) back to Overview')
await page.click('[data-step="overview"]')
await settle(page, 2600)
const back = await stateOf(page)
await shot(page, '04-back-to-overview')
await check('everything is restored', () => {
  ok(back.step === null, `still on step ${back.step}`)
  eq(back.layers, overview.layers, 'layers')
  eq(back.visible, overview.visible, 'pins')
  ok(back.page === null, 'the step page is still up')
})

/* --------------------------------------------------------- d-day -------- */
console.log('\n(e) D-Day — a second stepped exemplar')
await page.evaluate(() => window.__events.dismiss())
await settle(page, 800)
await page.evaluate(() => window.__events.showOnMap('d-day'))
await settle(page, 2800)
const dday = await stateOf(page)
await shot(page, '05-dday-overview')
await check('opens on its overview with four steps and its minor parts pinned', () => {
  eq(dday.steps, ['six-june', 'beachhead', 'cherbourg', 'breakout'], 'steps')
  ok(dday.step === null, `arrived on step ${dday.step}`)
  for (const id of ['pointe-du-hoc', 'villers-bocage', 'cherbourg-1944'])
    ok(dday.visible.includes(id), `${id} is not on the globe`)
})
await page.click('[data-step="cherbourg"]')
await settle(page, 2600)
const cherbourg = await stateOf(page)
await shot(page, '06-dday-cherbourg')
await check('a step with a camera flies there, and filters to its own annotations', () => {
  ok(cherbourg.step === 'cherbourg', `step is ${cherbourg.step}`)
  ok(cherbourg.layers.some((l) => l.includes('Cherbourg')), 'Cherbourg is not marked')
  ok(!cherbourg.layers.some((l) => l.includes('Airborne')), 'the 6 June drops are still drawn')
  ok(cherbourg.layers.filter((l) => l.startsWith('thrust:')).length === 0, 'the assaults are still drawn')
})

/* ------------------------------------------------- a hand on the globe --- */
console.log('\n(f) a gesture during a step flight')
await page.evaluate(() => window.__events.dismiss())
await settle(page, 900)
await page.evaluate(() => window.__events.showOnMap('barbarossa'))
await settle(page, 2600)
// Step to a step with a camera and grab the planet while it is still flying.
await page.click('[data-step="typhoon"]')
await page.waitForTimeout(120)
await page.mouse.move(900, 500)
await page.mouse.down()
for (let i = 0; i < 8; i++) await page.mouse.move(900 - i * 14, 500 + i * 6)
await page.mouse.up()
await page.waitForTimeout(1600)
const pov = await page.evaluate(() => {
  const p = window.__globe.pointOfView()
  const cam = window.__events.focusSteps.find((s) => s.id === 'typhoon').camera
  return { lat: p.lat, lng: p.lng, cam }
})
console.log(
  `    camera at ${pov.lat.toFixed(2)},${pov.lng.toFixed(2)}; the step asked for ` +
    `${pov.cam.lat},${pov.cam.lng}`,
)
await check('the drag wins: the flight is abandoned where the hand took over', () => {
  const off = Math.hypot(pov.lat - pov.cam.lat, pov.lng - pov.cam.lng)
  ok(off > 0.5, `the tween landed anyway (${off.toFixed(3)}° from the step camera)`)
})

/* --------------------------------------------- what a step HIGHLIGHTS ---- */
console.log('\n(g) the children a step names')
await page.evaluate(() => window.__events.dismiss())
await settle(page, 900)
await page.evaluate(() => window.__events.showOnMap('barbarossa'))
await settle(page, 2600)
await page.click('[data-step="kiev"]')
await settle(page, 2400)
const lifted = await stateOf(page)
await shot(page, '10-step-highlights')
console.log(`    highlights ${JSON.stringify(lifted.highlights)}, ${lifted.accented} accented mark(s)`)
await check('the step lifts the children it names, and marks them on the globe', () => {
  eq(lifted.highlights, ['kiev-pocket', 'uman-pocket'], 'highlights')
  for (const id of lifted.highlights) ok(lifted.visible.includes(id), `${id} is not pinned`)
  // the mark may be on a badge rather than on a teardrop — at the zoom an
  // operation is fitted to, a named child is usually inside a cluster
  ok(lifted.accented > 0, 'nothing on the globe is accented')
})
await check('and lets go of them again on the overview', async () => {
  await page.click('[data-step="overview"]')
  await settle(page, 2000)
  const s = await stateOf(page)
  eq(s.highlights, [], 'highlights')
  ok(s.accented === 0, `${s.accented} mark(s) survived the overview`)
})

/* ------------------------------------------------------- map mode -------- */
console.log('\n(h) map mode — the same view, a different look')
await page.evaluate(() => window.__settings.setMode('schematic'))
await settle(page, 2200)
const flat = await stateOf(page)
await shot(page, '11-map-mode')
await check('the presentation swaps and the domain does not', () => {
  ok(flat.mode === 'schematic', `mode is ${flat.mode}`)
  eq(flat.layers, back.layers, 'the ink changed with the look')
  eq(flat.visible, back.visible, 'the pins changed with the look')
  ok(flat.step === null, 'map mode changed which step is open')
})
await check('every pin is drawn flat, and the sky is gone', async () => {
  const look = await page.evaluate(() => ({
    flatPins: document.querySelectorAll('.event-pin--flat').length,
    pins: document.querySelectorAll('.event-pin').length,
    background: window.__globe.backgroundImageUrl(),
    clouds: window.__surface.cloudsShown,
  }))
  ok(look.pins > 0 && look.flatPins === look.pins, `${look.flatPins} of ${look.pins} pins are flat`)
  ok(!look.background, `the starfield is still up: ${look.background}`)
  ok(!look.clouds, 'the cloud deck is still up')
})
await page.evaluate(() => window.__settings.setMode('realistic'))
await settle(page, 2000)
await shot(page, '12-back-to-globe')
await check('and switching back restores the globe', async () => {
  const look = await page.evaluate(() => ({
    mode: window.__settings.mode,
    flatPins: document.querySelectorAll('.event-pin--flat').length,
    background: window.__globe.backgroundImageUrl(),
  }))
  ok(look.mode === 'realistic', `mode is ${look.mode}`)
  ok(look.flatPins === 0, `${look.flatPins} pins are still flat`)
  ok(!!look.background, 'the starfield did not come back')
})

/* ----------------------------------------------------------- phone ------ */
console.log('\n(i) on a phone')
// The desktop page goes first: two software-GL globes in one browser starve
// each other badly enough that the second page's `load` never fires.
await page.close()
const phone = await open(390, 844)
await phone.evaluate(() => window.__setTime(1941))
await settle(phone, 1200)
await phone.evaluate(() => window.__events.showOnMap('barbarossa'))
await settle(phone, 2800)
await shot(phone, '07-phone-overview')
const strip = await phone.$eval('[data-test="step-strip"]', (el) => {
  const r = el.getBoundingClientRect()
  const pill = document.querySelector('[data-test="panel-pill"]')?.getBoundingClientRect()
  return {
    left: r.left,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    overPill: pill ? pill.top - r.bottom : null,
    scrollable: el.querySelector('.steps').scrollWidth > el.querySelector('.steps').clientWidth,
  }
})
console.log(
  `    strip ${Math.round(strip.width)}px wide at x=${Math.round(strip.left)}..${Math.round(strip.right)}` +
    `, ${Math.round(strip.overPill ?? -1)}px above the pill, chips scroll: ${strip.scrollable}`,
)
await check('the strip stays on screen and sits above the pill', () => {
  ok(strip.left >= 0 && strip.right <= 390, `strip runs ${strip.left}..${strip.right}`)
  ok(strip.overPill !== null && strip.overPill >= 0, `overlaps the pill by ${-strip.overPill}px`)
})
await phone.click('[data-step="typhoon"]')
await settle(phone, 2400)
await shot(phone, '08-phone-step-page')
const phoneStep = await stateOf(phone)
await check('a step page opens over the map on a phone too', () => {
  ok(phoneStep.step === 'typhoon', `step is ${phoneStep.step}`)
  ok(phoneStep.page?.includes('Typhoon'), `page heading: ${phoneStep.page}`)
})
await check('the strip is not buried under the open step page', async () => {
  const hit = await phone.evaluate(() => {
    const strip = document.querySelector('[data-test="step-strip"]')
    const r = strip.getBoundingClientRect()
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { covered: !strip.contains(el), tag: el?.className ?? '?' }
  })
  ok(!hit.covered, `the strip is under ${hit.tag}`)
})

await phone.click('[data-test="step-back"]')
await settle(phone, 2000)
await shot(phone, '09-phone-back')
await check('the page’s own back control returns to the whole article', async () => {
  const s = await stateOf(phone)
  ok(s.step === null, `still on ${s.step}`)
  ok(s.page === null, 'the step page is still up')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  - ${f}`)
console.log(`shots in ${shots}`)

await browser.close()
await server.close()
process.exit(failures.length ? 1 : 0)
