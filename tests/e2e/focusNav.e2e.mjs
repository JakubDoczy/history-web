/**
 * In-browser check of FOCUS NAVIGATION — the stack of contexts — over the
 * shipped corpus and the real globe.
 *
 * What the product asked for, and what only a browser can answer:
 *
 *   · inside an operation, clicking one of its battles keeps the operation:
 *     the sibling pins stay, the battle's panel opens over them, and it carries
 *     a way back that names the operation;
 *   · closing the battle — by its X, by the back control, or with Escape —
 *     lands back on the operation, not on the default world;
 *   · the reported STUCK STATE resolves: after plan → battle → close → close
 *     there is no panel left in the DOM, no focus, and the ordinary globe;
 *   · picking an era from inside a focus leaves a clean normal view.
 *
 * Two things about this harness are worth knowing before reading a failure.
 *
 * FRAMES. Headless Chrome only produces a frame when something asks for one,
 * and this app parks its renderer when nothing is moving (lib/renderPump.ts) —
 * so requestAnimationFrame fires about once a second here, and Vue's enter and
 * leave transitions, which are driven by it, stall half-finished. Nothing on a
 * real screen behaves that way. So `frame()` below asks the renderer for a
 * frame explicitly, and every wait pumps one between polls.
 *
 * WAITING. Because of that the DOM can be behind the store here. Nothing below
 * waits a fixed number of milliseconds for a render: every step waits for the
 * condition it needs, pumping frames, and a timeout *is* the failure.
 *
 * Run:  node tests/e2e/focusNav.e2e.mjs
 * Env:  CHROME_PATH        Chromium/Chrome executable
 *       SHOT_DIR           where screenshots land
 *       SHOT_TAG           prefix on every file, for before/after pairs
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? join(here, 'shots')
const tag = process.env.SHOT_TAG ?? 'nav'
mkdirSync(shots, { recursive: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const PATIENCE = 60000 // a frame on a software rasteriser is not quick

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
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
})
const page = await browser.newPage({ viewport: { width: 1180, height: 780 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: PATIENCE })
await page.waitForFunction(() => !!window.__events && window.__events.all.length > 100, null, {
  timeout: PATIENCE,
})

/** Everything about the panel and the mode that a picture cannot be diffed on. */
const stateOf = () =>
  page.evaluate(() => {
    const e = window.__events
    const panel = document.querySelector('[data-test="panel-pill"], article.panel')
    return {
      selectedId: e.selectedId,
      focus: e.focus?.itemId,
      stack: [...e.focusStack],
      returnTo: e.focusReturnTo?.name,
      visible: e.visible.map((v) => v.id),
      shape: !panel ? 'none' : panel.matches('article.panel') ? 'article' : 'pill',
      // what the panel actually says, which is the point of all of it
      says: panel ? panel.textContent.replace(/\s+/g, ' ').trim().slice(0, 70) : '',
      back: document.querySelector('[data-test="focus-back"]')?.textContent.replace(/\s+/g, ' ').trim(),
      panels: document.querySelectorAll('[data-test="panel-pill"], article.panel').length,
    }
  })

/**
 * Wait for the screen to catch up with a state, by name, pumping a frame per
 * poll so the transitions it is waiting on can actually run (see FRAMES).
 */
const settleTo = async (what, fn, arg) => {
  const until = Date.now() + PATIENCE
  for (;;) {
    if (await page.evaluate(fn, arg)) return
    if (Date.now() > until) throw new Error(`never settled to ${what}: ${JSON.stringify(await stateOf())}`)
    await frame()
    await page.waitForTimeout(120)
  }
}
/** The panel is `shape` ('pill' | 'article' | 'none'), and it is the only one. */
const settleToPanel = (shape) =>
  settleTo(`a single ${shape}`, (want) => {
    const all = document.querySelectorAll('[data-test="panel-pill"], article.panel')
    if (want === 'none') return all.length === 0
    return (
      all.length === 1 &&
      (want === 'article' ? all[0].matches('article.panel') : all[0].matches('[data-test="panel-pill"]'))
    )
  }, shape)

/**
 * Screenshots go through CDP rather than through `page.screenshot`, which in
 * this harness waits out its own timeout on a WebGL page under swiftshader (it
 * does that on the shipped e2e scripts too, unchanged). This asks the renderer
 * for the frame it has and writes it.
 */
const cdp = await page.context().newCDPSession(page)
/** One frame, rendered and thrown away — the harness's heartbeat. */
const frame = () => cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 })
const shot = async (name) => {
  await frame() // the picture is of the frame after this one
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, `${tag}-${name}.png`), Buffer.from(data, 'base64'))
}
const click = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) throw new Error(`nothing to click at ${s}`)
    el.click()
  }, sel)
const waitForSel = (sel) => settleTo(sel, (s) => !!document.querySelector(s), sel)
const hasPin = (name) =>
  page.evaluate(
    (n) => [...document.querySelectorAll('.event-pin')].some((x) => x.title.includes(n)),
    name,
  )
/**
 * Click the pin for a named event, fanning a cluster out first if it is inside
 * one.
 *
 * Barbarossa has eight parts now — the five headline ones plus Brest, Uman and
 * Tallinn — and at the zoom the plan is framed at, two of them fall inside a
 * cluster badge rather than standing as their own teardrop (see
 * lib/eventClusters.ts). That is the app's ordinary answer to crowded pins and
 * a reader gets past it in one tap, so the harness does what the reader does
 * rather than reaching into the store: the point of this script is that the
 * parts are REACHABLE, and a part behind a badge that will not open is exactly
 * the failure worth catching.
 */
const clickPin = async (name) => {
  await settleTo(
    `a pin or a cluster for ${name}`,
    (n) =>
      [...document.querySelectorAll('.event-pin')].some(
        (x) => x.title.includes(n) || /events here/.test(x.title),
      ),
    name,
  )
  for (let i = 0; i < 6 && !(await hasPin(name)); i++) {
    await page.evaluate((k) => {
      const badges = [...document.querySelectorAll('.event-pin')].filter((x) =>
        /events here/.test(x.title),
      )
      badges[k % Math.max(1, badges.length)]?.click()
    }, i)
    await page.waitForTimeout(500)
  }
  await settleTo(`a pin for ${name}`, (n) =>
    [...document.querySelectorAll('.event-pin')].some((x) => x.title.includes(n)), name)
  await page.evaluate((n) => {
    ;[...document.querySelectorAll('.event-pin')].find((x) => x.title.includes(n)).click()
  }, name)
}

console.log('\n(a) an operation on the map')
await page.evaluate(() => window.__events.showOnMap('barbarossa'))
// An OPERATION — a steps-bearing event — opens with its overview up on a
// desktop rather than folded to the pill (`opensExpanded` in stores/events.ts).
// Everything below is about the ladder in and out of it, which is unchanged;
// only the shape the ladder starts in is.
await settleToPanel('article')
await settleTo('the plan drawn', () => document.querySelectorAll('.event-pin').length > 2)
await shot('01-operation')
let s = await stateOf()
await check('the operation is the context, on its overview', () => {
  ok(s.focus === 'barbarossa', `focus is ${s.focus}`)
  ok(s.shape === 'article', `panel is ${s.shape}`)
  ok(!s.back, 'a way back was offered from the context itself')
  ok(s.visible.includes('kiev-pocket'), `battles are not pinned: ${s.visible}`)
})

console.log('\n(b) a battle inside it')
await clickPin('Kiev')
await settleTo('the battle in the panel', () =>
  /Kiev/.test(document.querySelector('[data-test="panel-pill"], article.panel')?.textContent ?? ''))
await shot('02-battle-inside')
s = await stateOf()
await check('the battle opens without losing the operation', () => {
  ok(s.focus === 'barbarossa', `focus is now ${s.focus}`)
  ok(s.selectedId === 'kiev-pocket', `selection is ${s.selectedId}`)
  ok(s.visible.includes('minsk-pocket'), `sibling battles left the globe: ${s.visible}`)
  ok(s.panels === 1, `${s.panels} panels on screen`)
})
await check('and says how to get back, by name', () => {
  ok(/Operation Barbarossa/.test(s.back ?? ''), `back control reads "${s.back}"`)
})

console.log('\n(c) the way back')
await click('[data-test="focus-back"]')
await settleTo('the operation in the panel', () =>
  !document.querySelector('[data-test="focus-back"]'))
await shot('03-back-at-operation')
s = await stateOf()
await check('lands on the operation, still in the mode', () => {
  ok(s.focus === 'barbarossa', `focus is ${s.focus}`)
  ok(s.selectedId === 'barbarossa', `selection is ${s.selectedId}`)
  ok(s.shape === 'pill', `panel is ${s.shape}`)
  ok(/Barbarossa/.test(s.says), `pill reads "${s.says}"`)
})

console.log('\n(d) closing the battle with its own X')
await clickPin('Kiev')
await waitForSel('[data-test="focus-back"]')
await click('[data-test="pill-close"], [data-test="panel-close"]')
await settleTo('the operation in the panel', () =>
  !document.querySelector('[data-test="focus-back"]'))
s = await stateOf()
await check('the X on a battle also lands on the operation', () => {
  ok(s.focus === 'barbarossa', `focus is ${s.focus}`)
  ok(s.selectedId === 'barbarossa', `selection is ${s.selectedId}`)
  ok(s.visible.includes('kiev-pocket'), 'the plan stopped showing its battles')
})

console.log('\n(e) Escape unwinds the same ladder')
await clickPin('Kiev')
await waitForSel('[data-test="focus-back"]')
await page.keyboard.press('Escape')
await settleTo('the operation in the panel', () =>
  !document.querySelector('[data-test="focus-back"]'))
const afterOne = await stateOf()
await page.keyboard.press('Escape')
await settleToPanel('article')
const afterTwo = await stateOf()
await shot('04-escape-ladder')
await check('one rung at a time: the battle, then the mode', () => {
  ok(afterOne.focus === 'barbarossa', `first Escape left focus ${afterOne.focus}`)
  ok(afterOne.selectedId === 'barbarossa', `first Escape selected ${afterOne.selectedId}`)
  ok(afterTwo.focus === undefined, `second Escape left focus ${afterTwo.focus}`)
  ok(afterTwo.selectedId === 'barbarossa', 'Escape closed the article it should have kept')
})

console.log('\n(f) the reported stuck state: plan, battle, close, close')
errors.length = 0
await page.evaluate(() => window.__events.dismiss())
await settleToPanel('none')
await page.evaluate(() => window.__events.select('barbarossa'))
await waitForSel('[data-test="show-on-map"]')
await click('[data-test="show-on-map"]')
await clickPin('Kiev')
await waitForSel('[data-test="focus-back"]')
await click('[data-test="pill-close"], [data-test="panel-close"]') // closes the battle
await settleTo('the operation in the panel', () =>
  !document.querySelector('[data-test="focus-back"]'))
await click('[data-test="pill-close"], [data-test="panel-close"]') // closes the operation
await settleToPanel('none')
await shot('05-stuck-state-resolved')
s = await stateOf()
await check('resolves to the ordinary map, with nothing welded on screen', () => {
  ok(s.focus === undefined, `still focused on ${s.focus}`)
  ok(s.selectedId === undefined, `still selected: ${s.selectedId}`)
  ok(s.panels === 0, `${s.panels} stale panel(s) left in the DOM: "${s.says}"`)
  ok(s.visible.length > 3, `globe still filtered down to ${s.visible.length} pins`)
  ok(errors.length === 0, `errors thrown: ${errors.join('; ')}`)
})

/* The same ladder again, with every transition fired inside one tick — which is
   what a reader clicking faster than the 0.24 s fold does, and what used to weld
   a stale panel into the DOM with nothing on screen answering to the store. */
console.log('\n    …and again, with the whole sequence in one tick')
errors.length = 0
await page.evaluate(() => {
  const e = window.__events
  e.select('barbarossa')
  e.showOnMap('barbarossa')
  e.select('kiev-pocket')
  e.close()
  e.close()
})
await settleToPanel('none')
s = await stateOf()
await check('no panel survives a burst of transitions', () => {
  ok(s.panels === 0, `${s.panels} stale panel(s): "${s.says}"`)
  ok(s.focus === undefined && s.selectedId === undefined, `state: ${JSON.stringify(s.stack)}`)
  ok(errors.length === 0, `errors thrown: ${errors.join('; ')}`)
})

console.log('\n(g) an era picked from deep inside a focus')
await page.evaluate(() => window.__events.showOnMap('barbarossa'))
await settleToPanel('article')
await clickPin('Kiev')
await waitForSel('[data-test="focus-back"]')
// the battle's own article, over the plan: selecting a part expands it
await waitForSel('[data-test="show-on-map"]')
await click('[data-test="show-on-map"]') // push: the battle becomes the context
await settleToPanel('pill')
const deep = await stateOf()
await shot('06-deep-in-stack')
await check('the battle is a context of its own, over the operation', () => {
  ok(deep.stack.length === 2, `stack is ${JSON.stringify(deep.stack)}`)
  ok(deep.focus === 'kiev-pocket', `focus is ${deep.focus}`)
})
// the era picker, as a user works it: open the chip, choose an era
await click('.era-picker .era')
await waitForSel('.era-picker .menu')
await page.evaluate(() => {
  const opt = [...document.querySelectorAll('.era-picker .opt')].find((o) =>
    /classical/i.test(o.textContent),
  )
  if (!opt) throw new Error('no Classical option in the era menu')
  opt.click()
})
await settleToPanel('none')
await settleTo('the classical world', () => window.__events.visible.length > 3)
await shot('07-era-clean')
s = await stateOf()
await check('lands on a clean normal view', () => {
  ok(s.focus === undefined, `still focused on ${s.focus}`)
  ok(s.stack.length === 0, `stack survived: ${JSON.stringify(s.stack)}`)
  ok(s.selectedId === undefined, `still selected: ${s.selectedId}`)
  ok(s.panels === 0, `${s.panels} panel(s) still on screen: "${s.says}"`)
  ok(s.visible.length > 3, `globe still filtered down to ${s.visible.length} pins`)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  · ${f}`)
console.log(`shots in ${shots}`)

await browser.close()
await server.close()
process.exit(failures.length ? 1 : 0)
