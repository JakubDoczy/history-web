/**
 * ROUND 64 — "when you open an event from an operation step, you should not
 * show it minimised."
 *
 * The sequence, exactly as the reader performs it: walk a saga to an ENTRANCE
 * step (sagas.md rule 15), read the preview, press its brass "Open event". The
 * button is a request to READ a whole event — and what the reader got was the
 * pill: `openEntrance` descends through `showOnMap`, whose `enterFocus` folds
 * the panel for everything that is not itself a saga on a desktop
 * (`opensExpanded`). So the one press in the app whose label promises an
 * article delivered a two-word bar over the map.
 *
 * The two shapes it happens in, both walked here:
 *   · DESKTOP, entrance child that is NOT a saga (ww1 → verdun): pill.
 *   · PHONE, any entrance child (ww1 → somme, which IS a saga): pill, because
 *     `opensExpanded` also answers no below SIDE_BY_SIDE_MIN_PX.
 *
 * After the fix the article must be up in both, and everything around the
 * descent must hold: the stack is [ww1, child], the way back returns to the
 * saga, and "Show on map" elsewhere still minimises.
 *
 * Run:  node tests/e2e/repro64.e2e.mjs
 * Env:  SHOT_DIR (default /tmp/shots64/ui), SHOT_TAG (default 'repro64'),
 *       PLAYWRIGHT_MODULE, CHROME_PATH
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots64/ui'
const tag = process.env.SHOT_TAG ?? 'repro64'
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
  args: [
    '--no-proxy-server',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
  ],
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

/** Everything the complaint is about, read off the live page. */
const panelOf = (page) =>
  page.evaluate(() => ({
    stack: [...window.__events.focusStack],
    selected: window.__events.selectedId ?? null,
    step: window.__events.stepId ?? null,
    minimised: window.__events.panelMinimised,
    pill: !!document.querySelector('[data-test="panel-pill"]'),
    article: !!document.querySelector('article.panel'),
    // the article's own body text, so "expanded" means READABLE, not merely mounted
    bodyPx: (() => {
      const b = document.querySelector('article.panel .body')
      if (!b) return 0
      const r = b.getBoundingClientRect()
      return Math.round(r.height)
    })(),
  }))

async function openFromEntrance(page, sagaId, entranceId) {
  await page.evaluate((id) => window.__events.showOnMap(id), sagaId)
  await page.waitForTimeout(1400)
  await page.evaluate((id) => window.__events.selectStep(id), entranceId)
  await page.waitForTimeout(900)
  const preview = await panelOf(page)
  // On a phone the preview waits on the pill (round 58) — the reader taps the
  // pill's "Open" first, and so does the harness. The complaint is about the
  // press AFTER that: the brass button itself.
  if (preview.minimised) {
    await page.click('[data-test="pill-restore"]')
    await page.waitForTimeout(500)
  }
  await page.waitForSelector('[data-test="open-event"]', { timeout: 5000 })
  await page.click('[data-test="open-event"]')
  await page.waitForTimeout(1600)
  const after = await panelOf(page)
  return { preview, after }
}

async function boot(viewport, extra = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, ...extra })
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
  await page.goto(base, { timeout: 90_000 })
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
  await page.waitForFunction(() => window.__events.byId('ww1')?.steps)
  await page.evaluate(() => window.__setTime(1916))
  await corpusQuiet(page)
  await page.waitForTimeout(1000)
  return page
}

console.log('\n(1) desktop: Open event on the Verdun entrance (child is not a saga)')
const page = await boot({ width: 1280, height: 860 })
const desk = await openFromEntrance(page, 'ww1', 'verdun')
console.log(
  `    preview: step=${desk.preview.step} minimised=${desk.preview.minimised}` +
    `\n    after Open event: stack=[${desk.after.stack}] selected=${desk.after.selected}` +
    ` minimised=${desk.after.minimised} pill=${desk.after.pill} article=${desk.after.article} bodyPx=${desk.after.bodyPx}`,
)
await shot(page, 'desktop-after-open-event')
await check('the preview itself is up on a desktop (round 58, unchanged)', () => {
  ok(desk.preview.step === 'verdun', `standing on ${desk.preview.step}`)
  ok(!desk.preview.minimised, 'the preview was behind the pill')
})
await check('"Open event" arrives EXPANDED: an article, not a pill', () => {
  ok(desk.after.stack.join('>') === 'ww1>verdun', `stack ${desk.after.stack.join('>')}`)
  ok(desk.after.selected === 'verdun', `panel on ${desk.after.selected}`)
  ok(!desk.after.minimised, 'the opened child arrived minimised — the complaint, verbatim')
  ok(desk.after.article && !desk.after.pill, 'no article in the DOM after Open event')
  ok(desk.after.bodyPx > 60, `the article's body is ${desk.after.bodyPx}px tall — not readable`)
})
await check('the way back still returns to the saga', () => {
  return page
    .evaluate(() => {
      window.__events.focusBack()
      return {
        stack: [...window.__events.focusStack],
        selected: window.__events.selectedId ?? null,
      }
    })
    .then((s) => {
      ok(s.stack.join('>') === 'ww1', `stack ${s.stack.join('>')}`)
      ok(s.selected === 'ww1', `panel on ${s.selected}`)
    })
})
await check('"Show on map" elsewhere still minimises to the pill', async () => {
  await page.evaluate(() => window.__events.dismiss())
  await page.waitForTimeout(400)
  await page.evaluate(() => window.__events.showOnMap('verdun'))
  await page.waitForTimeout(1000)
  const s = await panelOf(page)
  ok(s.minimised && s.pill, 'Show on map on a plain event no longer folds to the pill')
})
await page.close()

console.log('\n(2) phone: Open event on the Somme entrance (child IS a saga)')
const phone = await boot(
  { width: 390, height: 844 },
  { deviceScaleFactor: 2, isMobile: true, hasTouch: true },
)
const mob = await openFromEntrance(phone, 'ww1', 'somme')
console.log(
  `    preview: step=${mob.preview.step} minimised=${mob.preview.minimised}` +
    `\n    after Open event: stack=[${mob.after.stack}] selected=${mob.after.selected}` +
    ` minimised=${mob.after.minimised} pill=${mob.after.pill} article=${mob.after.article} bodyPx=${mob.after.bodyPx}`,
)
await shot(phone, 'phone-after-open-event')
await check('on a phone the preview waits on the pill (round 58, unchanged)…', () => {
  ok(mob.preview.step === 'somme', `standing on ${mob.preview.step}`)
  ok(mob.preview.minimised, 'the phone preview should be behind the pill — the map wins a landing')
})
await check('…but "Open event" was ASKED for, and arrives readable on a phone too', () => {
  ok(mob.after.stack.join('>') === 'ww1>somme', `stack ${mob.after.stack.join('>')}`)
  ok(!mob.after.minimised, 'the opened child arrived minimised on the phone')
  ok(mob.after.article && !mob.after.pill, 'no article in the DOM after Open event')
  ok(mob.after.bodyPx > 60, `the article's body is ${mob.after.bodyPx}px tall — not readable`)
})
// The mobile sheet must still clear the top bar and stand on the rail — the
// height rules in EventPanel.vue's 640px query. Measured, not assumed.
await check('the phone sheet respects the mobile height rules', async () => {
  const m = await phone.evaluate(() => {
    const p = document.querySelector('article.panel')
    if (!p) return null
    const r = p.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight }
  })
  ok(m, 'no article to measure')
  ok(m.top >= 40, `the sheet reaches ${m.top}px from the top — over the top bar`)
  ok(m.bottom <= m.vh, `the sheet overruns the viewport (${m.bottom} of ${m.vh})`)
})
await phone.close()

console.log(`\n${passed} ok, ${failures.length} failed`)
for (const f of failures) console.log(`  · ${f}`)
console.log(`shots in ${shots}`)
await browser.close()
await server.close()
process.exit(failures.length ? 1 : 0)
