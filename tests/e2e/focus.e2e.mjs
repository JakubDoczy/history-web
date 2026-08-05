/**
 * In-browser check of focus mode, over the shipped corpus and the real globe.
 *
 * What the product asked for, and what a picture is the only proof of:
 *
 *   · "Show on map" always minimises and enters the mode — a battle plan and a
 *     bare point event alike;
 *   · while the mode is on the globe carries the focused item, its children and
 *     its ink, and NOTHING else — no unrelated pins, no nation borders;
 *   · the pill is small, the expanded article is large and starts near its top;
 *   · Escape puts every one of those back.
 *
 * Run:  node tests/e2e/focus.e2e.mjs
 * Env:  CHROME_PATH        Chromium/Chrome executable
 *       SHOT_DIR           where screenshots land
 *       SHOT_TAG           prefix on every file, for before/after pairs
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 */
import { createServer } from 'vite'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? join(here, 'shots')
const tag = process.env.SHOT_TAG ?? 'now'
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
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

const server = await createServer({ root, server: { port: 0 }, logLevel: 'warn' })
await server.listen()
const base = `http://localhost:${server.httpServer.address().port}`

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
})

/** Everything the map is showing, as numbers a screenshot cannot be diffed on. */
const stateOf = (page) =>
  page.evaluate(() => ({
    focus: window.__events.focus?.itemId,
    minimised: window.__events.panelMinimised,
    visible: window.__events.visible.map((e) => e.id).sort(),
    children: window.__events.focusChildren.map((e) => e.id).sort(),
    // what the polygon layer is actually holding: borders and footprints alike
    polygons: window.__globe.polygonsData().map((p) => p.kind), // 'full' = a nation border, 'area' = an event footprint
    pins: document.querySelectorAll('.event-pin').length,
    // the three inputs the result set is a function of, so a mismatch says which
    scope: window.__view.scope ? { ...window.__view.scope } : null,
    selection: { ...window.__time.selection },
    pov: window.__globe.pointOfView(),
  }))

/**
 * Wait for the globe to have drawn what the store has told it.
 *
 * The pins are CSS2D elements, so they only exist once a frame has rendered —
 * and a frame here is expensive enough (software GL, a 4096×2048 basemap) that
 * the DOM trails the data by two or three seconds. `htmlElementsData` is what
 * the store handed the layer; the elements are what the layer has made of it.
 */
const settle = async (page, ms = 1400) => {
  await page.waitForTimeout(ms)
  await page
    .waitForFunction(
      () => document.querySelectorAll('.event-pin').length === window.__globe.htmlElementsData().length,
      null,
      { timeout: 15000 },
    )
    .catch(() => console.log('  [warn] pins never caught up with the data'))
}

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
  await page.goto(base)
  // Kill the CSS animations for the duration of the run. Under swiftshader the
  // document timeline crawls — a 0.26 s panel entrance was still on its opening
  // frame six seconds later — so every screenshot of a panel came back with the
  // panel at `opacity: 0`. Nothing here is about the animations; they are the
  // one thing a still cannot show anyway, and Vue's <Transition> resolves
  // immediately when it measures no duration.
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
  // the corpus loads in chunks; the map is only comparable once the war years are in
  await page.waitForFunction(() => window.__events.byId('barbarossa'))
  await settle(page, 2500)
  return page
}

/* ------------------------------------------------------------ desktop ---- */
const page = await open(1280, 860)
await page.evaluate(() => window.__setTime(1941))
await settle(page)

console.log('\nbaseline (no focus)')
const clean = await stateOf(page)
console.log(`    visible ${clean.visible.length} pins, polygons ${clean.polygons.length}`)
await page.screenshot({ path: join(shots, `${tag}-00-normal.png`) })

console.log('\n(a) a battle plan')
await page.evaluate(() => window.__events.showOnMap('barbarossa'))
await settle(page, 2600)
const plan = await stateOf(page)
await page.screenshot({ path: join(shots, `${tag}-01-plan-pill.png`) })
// Barbarossa carries steps, so on a desktop it is an OPERATION and lands with
// its overview up rather than folded to the pill (`opensExpanded` in
// stores/events.ts). The pill is still what everything else gets — see (b)
// below, which is a bare point event, and the phone at the foot of this file.
await check('enters focus, on the overview of the operation', () => {
  eq(plan.focus, 'barbarossa', 'focus')
  ok(!plan.minimised, 'the operation folded to the pill on a desktop')
})
await check('the globe carries only the plan and its children', () => {
  eq(plan.visible, ['barbarossa', ...plan.children].sort(), 'visible set')
  ok(plan.children.length > 0, 'no children pinned')
})
await check('no nation borders while the mode is on', () => {
  ok(!plan.polygons.includes('full'), `polygons: ${plan.polygons}`)
})

console.log('\n(c) the article, as the operation opened it')
// No toggle: it is already up (see (a)). `mode="out-in"` still applies to the
// fold at the end of this block — under swiftshader those two 240 ms halves
// are not 480 ms.
await page.waitForSelector('.panel')
await settle(page, 1200)
await page.screenshot({ path: join(shots, `${tag}-02-plan-article.png`) })
const box = await page.$eval('.panel', (el) => {
  const r = el.getBoundingClientRect()
  const h2 = el.querySelector('h2').getBoundingClientRect()
  return {
    top: r.top,
    height: r.height,
    width: r.width,
    // the dead band above the title, which is what change (3) is about
    headGap: h2.top - r.top + el.scrollTop,
    pad: getComputedStyle(el).paddingTop,
    scrolled: el.scrollTop,
    bottomClear: window.innerHeight - r.bottom,
  }
})
console.log(
  `    panel ${Math.round(box.width)}x${Math.round(box.height)} at y=${Math.round(box.top)}` +
    `, clear below ${Math.round(box.bottomClear)}px, pad-top ${box.pad}` +
    `, title gap ${Math.round(box.headGap)}px (scrollTop ${Math.round(box.scrolled)})`,
)
await page.evaluate(() => window.__events.toggleFocusExpanded())
await settle(page, 600)

console.log('\n(d) Escape')
await page.keyboard.press('Escape')
await settle(page, 2200)
const after = await stateOf(page)
await page.screenshot({ path: join(shots, `${tag}-04-after-escape.png`) })
await check('leaves the mode', () => {
  ok(after.focus === undefined, `still focused on ${after.focus}`)
  ok(!after.minimised, 'panel is still the pill')
})
await check('borders and unrelated pins come back', () => {
  ok(after.polygons.includes('full'), `polygons: ${after.polygons}`)
  ok(after.visible.length > 3, `only ${after.visible.length} pins after exit`)
})

/* "Exiting restores everything exactly" is a claim about the mode, not about the
   camera, so it is tested with the camera held still: the same frame, the same
   year, the mode switched off and on and off again. Flying back to world view to
   compare against the opening state would test the fly-to instead — and cannot
   be done honestly from a script anyway, since the app recomputes its viewport
   scope from the controls' own change events and a camera set in one assignment
   never emits one. */
console.log('\n    round-trip check, camera held still')
const beforeRoundTrip = await stateOf(page)
await page.evaluate(() => window.__events.enterFocus('barbarossa'))
await settle(page, 900)
const during = await stateOf(page)
await page.evaluate(() => window.__events.exitFocus())
await settle(page, 900)
const afterRoundTrip = await stateOf(page)
await page.screenshot({ path: join(shots, `${tag}-05-restored.png`) })
await check('re-entering the mode empties the map again', () => {
  ok(during.visible.length < beforeRoundTrip.visible.length, 'nothing was culled')
  ok(!during.polygons.includes('full'), 'borders survived')
})
await check('and leaving it puts every pin and every border back, exactly', () => {
  eq(afterRoundTrip.visible, beforeRoundTrip.visible, 'visible set')
  eq(afterRoundTrip.polygons, beforeRoundTrip.polygons, 'polygons')
  eq(afterRoundTrip.pins, beforeRoundTrip.pins, 'rendered pin elements')
})

console.log('\n(b) a plain point event, no geometry, no children')
await page.evaluate(() => window.__events.showOnMap('moon-landing'))
await settle(page, 2600)
const bare = await stateOf(page)
await page.screenshot({ path: join(shots, `${tag}-06-bare-pill.png`) })
await check('a bare point event enters the mode too', () => {
  eq(bare.focus, 'moon-landing', 'focus')
  ok(bare.minimised, 'panel is not the pill')
})
await check('and stands alone on the globe', () => {
  eq(bare.visible, ['moon-landing'], 'visible set')
  ok(!bare.polygons.includes('full'), `polygons: ${bare.polygons}`)
})
await page.close()

/* ------------------------------------------------------------- mobile ---- */
console.log('\nmobile')
const m = await open(390, 780)
await m.evaluate(() => window.__setTime(1941))
await m.evaluate(() => window.__events.showOnMap('barbarossa'))
await settle(m, 2600)
await m.screenshot({ path: join(shots, `${tag}-07-mobile-pill.png`) })
await m.evaluate(() => window.__events.toggleFocusExpanded())
await m.waitForSelector('.panel')
await settle(m, 1200)
await m.screenshot({ path: join(shots, `${tag}-08-mobile-article.png`) })
const mbox = await m.$eval('.panel', (el) => {
  const r = el.getBoundingClientRect()
  return { top: r.top, height: r.height, bottom: window.innerHeight - r.bottom }
})
console.log(`    mobile sheet h=${Math.round(mbox.height)} top=${Math.round(mbox.top)} clear=${Math.round(mbox.bottom)}`)
await m.close()

await browser.close()
await server.close()

console.log(`\n${passed} passed, ${failures.length} failed`)
console.log(`screenshots in ${shots} (${tag}-*)`)
if (failures.length) process.exit(1)
