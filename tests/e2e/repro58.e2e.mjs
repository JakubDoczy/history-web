/**
 * ROUND 58, DEFECT 2 — "Next step arrow button sometimes doesn't work (I think
 * it works the first time and then stops working for another step)."
 *
 * THE CAMERA THAT CONVICTS IT. A press of next is a pure state transition, so
 * the only thing a browser can add is the sequence the reader actually
 * performed — and the sequence is the whole of the report: it is not that next
 * never works, it is that it works, and then stops, and the press after that
 * looks dead. What this file does is press it nine times on a real saga and
 * write down, per press, the three things the walk is a function of:
 *
 *   · the CURSOR   — the rail's own idea of where the walk is (`.station.cursor`)
 *   · the STEP     — the store's idea of it (`window.__events.stepId`)
 *   · the STACK    — whether the press descended
 *
 * The saga is `ww1`, whose steps run `p p p E E p p p p` (three pages, two
 * entrances, four pages): the first shape in the corpus where a page step is
 * followed by an entrance, which is exactly the shape the desync needs.
 *
 * Round 58's expectation, and what this asserts: N presses open N DISTINCT
 * places, every one of them a step of the saga, with the stack never growing —
 * traversal through an entrance is a preview, not a descent (sagas.md rule 10).
 *
 * Run:  node tests/e2e/repro58.e2e.mjs
 * Env:  SHOT_DIR (default /tmp/shots58/rail), SHOT_TAG (default 'repro58'),
 *       PLAYWRIGHT_MODULE, CHROME_PATH
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots58/rail'
const tag = process.env.SHOT_TAG ?? 'repro58'
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
const shot = async (page, name, clip) => {
  let cdp = sessions.get(page)
  if (!cdp) sessions.set(page, (cdp = await page.context().newCDPSession(page)))
  await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 })
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  })
  writeFileSync(join(shots, `${tag}-${name}.png`), Buffer.from(data, 'base64'))
}

/** Everything the walk is a function of, read off the live page. */
const stateOf = (page) =>
  page.evaluate(() => {
    const cursor = document.querySelector('[data-test="saga-station"].cursor')
    const track = document.querySelector('[data-test="saga-timeline"] .track')
    return {
      cursor: cursor?.dataset.step ?? null,
      step: window.__events.stepId ?? null,
      stack: [...window.__events.focusStack],
      selected: window.__events.selectedId ?? null,
      win: track?.dataset.window ?? null,
      preview: !!document.querySelector('[data-test="step-preview"]'),
      steps: (window.__events.byId('ww1')?.steps ?? []).map((s) => (s.child ? 'E' : 'p')).join(''),
    }
  })

const corpusQuiet = async (page, still = 800, timeout = 20_000) => {
  const t0 = Date.now()
  let last = -1
  let since = Date.now()
  while (Date.now() - t0 < timeout) {
    const n = await page.evaluate(() => window.__events.all.length)
    if (n !== last) {
      last = n
      since = Date.now()
    } else if (Date.now() - since >= still) return
    await page.waitForTimeout(150)
  }
}

const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })
page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
await page.goto(base, { timeout: 90_000 })
await page.addStyleTag({
  content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
})
await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
await page.waitForFunction(() => window.__events.byId('ww1')?.steps)
await page.evaluate(() => window.__setTime(1916))
await corpusQuiet(page)
await page.waitForTimeout(1200)

console.log('\n(1) the Great War, on the rail — nine presses of next')
await page.evaluate(() => window.__events.showOnMap('ww1'))
await page.waitForTimeout(1600)
const start = await stateOf(page)
console.log(`    ww1 steps: ${start.steps}  (p = a page of this saga, E = an entrance)`)
console.log(`    press 0   cursor=${start.cursor}  step=${start.step}  stack=[${start.stack}]`)

const seq = []
for (let i = 1; i <= 9; i++) {
  await page.click('[data-test="saga-next"]')
  await page.waitForTimeout(320)
  const s = await stateOf(page)
  seq.push(s)
  console.log(
    `    press ${i}   cursor=${s.cursor}  step=${s.step}  stack=[${s.stack}]` +
      `  preview=${s.preview}  win=${s.win}`,
  )
}
await shot(page, 'next-sequence')

await check('nine presses of next open nine distinct places', () => {
  const places = seq.map((s) => s.step)
  const dead = places.map((p, i) => (i && p === places[i - 1] ? i + 1 : 0)).filter(Boolean)
  ok(dead.length === 0, `press ${dead.join(', ')} landed where the press before it did (${places.join(' → ')})`)
  ok(new Set(places).size === 9, `only ${new Set(places).size} distinct steps in ${places.join(' → ')}`)
})
await check('the cursor and the open step never disagree about where the walk is', () => {
  const off = seq.map((s, i) => (s.cursor === s.step ? null : `press ${i + 1}: cursor=${s.cursor} step=${s.step}`)).filter(Boolean)
  ok(off.length === 0, off.join('; '))
})
await check('walking through an entrance previews it rather than descending', () => {
  ok(seq.every((s) => s.stack.length === 1 && s.stack[0] === 'ww1'), `the stack grew: ${seq.map((s) => s.stack.join('>')).join(' | ')}`)
  ok(seq.some((s) => s.preview), 'no press of next ever landed on a step preview')
})

console.log('\n(2) the preview, and the button that opens it for real')
// walk to the first entrance and look at what the panel says
await page.evaluate(() => window.__events.selectStep())
await page.waitForTimeout(300)
const entrance = await page.evaluate(() => {
  const st = window.__events.byId('ww1').steps.find((s) => s.child)
  return st.id
})
await page.evaluate((id) => window.__events.selectStep(id), entrance)
await page.waitForTimeout(1200)
const prev = await page.evaluate(() => {
  const box = document.querySelector('[data-test="step-preview"]')
  return {
    shown: !!box,
    text: box?.textContent.replace(/\s+/g, ' ').trim() ?? null,
    open: !!document.querySelector('[data-test="open-event"]'),
    rail: !!document.querySelector('[data-test="saga-timeline"]'),
    stack: [...window.__events.focusStack],
    step: window.__events.stepId ?? null,
  }
})
console.log(`    preview: ${prev.text?.slice(0, 140)}`)
await shot(page, 'entrance-preview')
await check('an entrance previews as a step, with the parent rail still under it', () => {
  ok(prev.shown, 'no step preview in the panel')
  ok(prev.open, 'no "Open event" button on the preview')
  ok(prev.rail, 'the parent’s rail went')
  ok(prev.stack.length === 1, `the stack is ${prev.stack.join('>')}`)
  ok(prev.step === entrance, `the rail is on ${prev.step}, not on the entrance`)
})

await page.click('[data-test="open-event"]')
await page.waitForTimeout(1800)
const opened = await page.evaluate(() => ({
  stack: [...window.__events.focusStack],
  selected: window.__events.selectedId,
  step: window.__events.stepId ?? null,
}))
console.log(`    after Open event: stack=[${opened.stack}] selected=${opened.selected}`)
await shot(page, 'after-open-event')
await check('"Open event" performs the descent the entrance used to perform on sight', () => {
  ok(opened.stack.length === 2, `stack ${opened.stack.join('>')}`)
  ok(opened.selected === opened.stack[1], `panel on ${opened.selected}`)
  ok(opened.step === null, `landed in step ${opened.step} rather than on the child’s overview`)
})

/* ============================================================ item 1 ======
 * THE DESKTOP RAIL: bigger, and the walk in the middle.
 *
 * Two measurements and two pictures. The measurements are the ones that can go
 * wrong quietly: whether the enlarged controls fit the box they are in, and
 * whether the 6 px the zoom cluster's gutter took cost a station its name —
 * the strip is measured against the rail's label floor and round 51 recorded
 * that the last station of Barbarossa's five had 58 px against a floor of 56.
 * ========================================================================= */
console.log('\n(3) the desktop rail at its new size, with the walk centred')
const measure = (page) =>
  page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), cx: Math.round(b.x + b.width / 2) }
    }
    return {
      vw: innerWidth,
      rail: r('[data-test="saga-timeline"]'),
      head: r('[data-test="saga-timeline"] .head'),
      prev: r('[data-test="saga-prev"]'),
      steps: r('[data-test="saga-list-toggle"]'),
      next: r('[data-test="saga-next"]'),
      zoomOut: r('[data-test="saga-zoom-out"]'),
      zoomFit: r('[data-test="saga-zoom-fit"]'),
      named: [...document.querySelectorAll('[data-test="saga-station"]')].filter((s) =>
        s.classList.contains('named'),
      ).length,
      stations: document.querySelectorAll('[data-test="saga-station"]').length,
    }
  })

await page.evaluate(() => window.__events.dismiss())
await page.waitForTimeout(600)
await page.evaluate(() => window.__events.showOnMap('ww1'))
await page.waitForTimeout(1600)
const pc = await measure(page)
console.log(
  `    rail ${pc.rail.h}px, head ${pc.head.h}px; prev ${pc.prev.w}x${pc.prev.h}, ` +
    `Steps ${pc.steps.w}x${pc.steps.h}, next ${pc.next.w}x${pc.next.h}, ` +
    `zoom ${pc.zoomOut.w}x${pc.zoomOut.h}; ${pc.named}/${pc.stations} names at rest`,
)
console.log(`    walk centred at ${Math.round((pc.prev.x + pc.next.x + pc.next.w) / 2)} of ${pc.vw}`)
await shot(page, 'pc-rail', { x: 0, y: pc.rail.y - 4, width: 1280, height: pc.rail.h + 8 })
await shot(page, 'pc-rail-full')
await check('the rail and its controls grew, and the walk is centred on the rail', () => {
  ok(pc.rail.h >= 116, `the rail is ${pc.rail.h}px tall`)
  for (const [name, b] of [['prev', pc.prev], ['next', pc.next], ['Steps', pc.steps]])
    ok(b.h >= 32, `${name} is ${b.w}x${b.h} — under a pointer's target`)
  ok(pc.zoomOut.h >= 32, `a zoom button is ${pc.zoomOut.w}x${pc.zoomOut.h}`)
  const centre = (pc.prev.x + pc.next.x + pc.next.w) / 2
  ok(Math.abs(centre - pc.vw / 2) <= 2, `the walk's centre is ${Math.round(centre)} of ${pc.vw}`)
  // …and it is a cluster, not three buttons scattered: prev, Steps and next in
  // that order with small gaps
  ok(pc.prev.x < pc.steps.x && pc.steps.x < pc.next.x, 'the walk is out of order')
  ok(pc.next.x - (pc.steps.x + pc.steps.w) <= 8, 'the walk came apart')
})
await check('the zoom column still fits inside the rail it is pinned to', () => {
  ok(pc.zoomOut.y >= pc.rail.y, `the zoom column starts ${pc.rail.y - pc.zoomOut.y}px above the rail`)
  ok(
    pc.zoomFit.y + pc.zoomFit.h <= pc.rail.y + pc.rail.h + 1,
    `the zoom column overruns the rail's foot by ${pc.zoomFit.y + pc.zoomFit.h - pc.rail.y - pc.rail.h}px`,
  )
})

/* THE GUTTER'S COST, at the width round 51 measured it at. Barbarossa's five
   stations on a 1440px rail were the tightest case in the corpus: the last of
   them had 58px of label room against a floor of 56. The cluster is 6px wider
   now, so this asks the rail rather than assuming. */
const wide = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
await wide.goto(base, { timeout: 90_000 })
await wide.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' })
await wide.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
await wide.waitForFunction(() => window.__events.byId('barbarossa')?.steps)
await wide.evaluate(() => window.__setTime(1941))
await corpusQuiet(wide)
await wide.evaluate(() => window.__events.showOnMap('barbarossa'))
await wide.waitForTimeout(1800)
const barb = await measure(wide)
console.log(`    1440: Barbarossa ${barb.named}/${barb.stations} names at rest, rail ${barb.rail.h}px`)
await shot(wide, 'pc-1440-barbarossa', { x: 0, y: barb.rail.y - 4, width: 1440, height: barb.rail.h + 8 })
await check('the wider zoom gutter costs no station its name at 1440', () => {
  ok(barb.named === barb.stations, `${barb.stations - barb.named} of ${barb.stations} names dropped`)
})
await wide.close()

console.log('\n(4) a phone, unchanged where it was meant to be')
const phone = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})
await phone.goto(base, { timeout: 90_000 })
await phone.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' })
await phone.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
await phone.waitForFunction(() => window.__events.byId('ww1')?.steps)
await phone.evaluate(() => window.__setTime(1916))
await corpusQuiet(phone)
await phone.evaluate(() => window.__events.showOnMap('ww1'))
await phone.waitForTimeout(1800)
const ph = await measure(phone)
console.log(`    phone rail ${ph.rail.w}x${ph.rail.h}, head ${ph.head.h}px, prev ${ph.prev.w}x${ph.prev.h}`)
await shot(phone, 'phone-rail', { x: 0, y: ph.rail.y - 4, width: 390, height: ph.rail.h + 8 })
await check('the phone keeps the rail it was given in round 46', () => {
  ok(ph.rail.h === 116, `the phone's saga rail is ${ph.rail.h}px, not 116`)
  // 24 of content plus the 1px rule under it, which the box measures
  ok(ph.head.h === 25, `the phone's head row is ${ph.head.h}px, not 24 + its rule`)
  ok(ph.zoomOut.w === 34, `the phone's zoom button is ${ph.zoomOut.w}px, not 34`)
  ok(ph.prev.h === 22, `the phone's prev is ${ph.prev.w}x${ph.prev.h}, not the round-46 22px`)
  // …and the walk is still IN THE FLOW of the head row, beside the breadcrumb,
  // rather than centred. Centring is a desktop rule (min-width: 641px): a
  // phone's head row is 24px of crumb and controls with nothing to spare, and
  // there is no middle of it to put anything in.
  ok(
    Math.abs((ph.prev.x + ph.next.x + ph.next.w) / 2 - ph.vw / 2) > 20,
    'the phone’s walk was centred — a desktop rule leaked past its query',
  )
})
await phone.close()

console.log(`\n${passed} ok, ${failures.length} failed`)
for (const f of failures) console.log(`  · ${f}`)
console.log(`shots in ${shots}`)
await browser.close()
await server.close()
process.exit(failures.length ? 1 : 0)
