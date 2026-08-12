/**
 * ROUND 56 — the range lock, in a browser.
 *
 * The store's half is unit-tested (tests/rangeLock.test.ts, tests/time.test.ts);
 * what needs a layout engine is the other half — that a PRESS ON THE RAIL, at a
 * pixel, is what runs the rule; that the padlock is on the rail, says both of
 * its states and can be reached from the keyboard; and that the windows the
 * rule produces are the ones a reader would want, which is a question about
 * what the rail draws and therefore about a picture.
 *
 * What is checked, in order:
 *
 *   a. locked click near the present → a window of 1 year back and 5 forward;
 *   b. locked click at 1 Ma → a window a hundred thousand times wider, with
 *      the geological strip on it (and the same click at 2.5 Ga, where the
 *      years are large negatives);
 *   c. a handle dragged, then a click → the reader's own proportion, kept;
 *   d. the padlock unlocked → the old behaviour, exactly: the cursor moves and
 *      the window stays;
 *   e. the button itself: both states, aria-pressed, the tooltip on hover and
 *      on keyboard focus, and the double-press that restores the defaults.
 *
 * Run:  node tests/e2e/rangeLock.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots56), PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots56'
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

// The rail's own display warp, loaded through the dev server rather than
// restated here: the press below has to land on the pixel the APP puts a year
// on, and a second copy of asinh in this file would only ever agree with itself.
const { toWarp } = await server.ssrLoadModule('/src/lib/time.ts')

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
})

const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
await page.goto(base, { timeout: 90_000 })
// The fit is a 320 ms tween and none of this is about motion; under swiftshader
// the document timeline crawls, so a tween would still be in flight minutes on.
await page.addStyleTag({
  content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
})
await page.emulateMedia({ reducedMotion: 'reduce' }) // …and the store asks this too
await page.waitForFunction(() => window.__time && document.querySelector('.rail'))
// The rail measures itself with a ResizeObserver and the globe is still coming
// up behind it; a press before the first observation maps the pixel through a
// 1px-wide rail. Nothing here is about the boot, so wait it out.
await page.waitForTimeout(1500)

/** CDP screenshots: page.screenshot waits out its own timeout on a WebGL page. */
const cdp = await page.context().newCDPSession(page)
const shot = async (name, clip) => {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 2 } } : {}),
  })
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'))
}
const railRect = () =>
  page.evaluate(() => {
    const r = document.querySelector('.rail').getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
const railShot = async (name) => shot(name, { ...(await railRect()) })

const state = () =>
  page.evaluate(() => ({
    year: window.__time.currentTime,
    selection: { ...window.__time.selection },
    range: { ...window.__time.range },
    lock: {
      on: window.__time.rangeLock,
      scale: window.__time.lockScale,
      split: window.__time.lockSplit,
    },
  }))

/**
 * Press the rail at the PIXEL a year falls on — the real gesture, through the
 * real hit-testing. The mapping is the rail's own (`toWarp`), imported from the
 * app through the dev server rather than restated here, so this cannot pass by
 * agreeing with a second copy of the arithmetic.
 */
const setWindow = (start, end) => page.evaluate(([a, b]) => window.__time.setRange({ start: a, end: b }), [start, end])
const pressYear = async (year) => {
  const r = await railRect()
  const { start, end } = (await state()).range
  const u = (toWarp(year) - toWarp(start)) / (toWarp(end) - toWarp(start))
  // low in the rail: the top strip is the era bands, and a press on the fine
  // lane is an era pick rather than a scrub (which is its own rule)
  const at = { x: r.x + u * r.width, y: r.y + r.height - 10, u }
  ok(at.u > 0.01 && at.u < 0.99, `${year} is not on the rail (u=${at.u.toFixed(3)})`)
  await page.mouse.click(at.x, at.y)
  await page.waitForTimeout(120)
  return state()
}

const span = (s) => s.end - s.start

/* =================================================== a. a click at the present */
console.log('\n(a) locked click near the present')
await setWindow(-550, 2026)
const near = await pressYear(2000)
console.log(
  `    year ${near.year.toFixed(1)}  band ${near.selection.start.toFixed(1)}–${near.selection.end.toFixed(1)}` +
    ` (${span(near.selection).toFixed(2)} yr)  window ${span(near.range).toFixed(2)} yr`,
)
await railShot('a-locked-click-2000')

await check('the lock is ON without anyone turning it on', () => {
  ok(near.lock.on === true, 'the lock is off by default')
})
await check('a click near the present gives 1 year back and 5 forward', () => {
  ok(Math.abs(span(near.selection) - 6) < 0.01, `the band is ${span(near.selection)} years wide`)
  ok(Math.abs(near.year - near.selection.start - 1) < 0.05, 'not 1 year behind the cursor')
  ok(Math.abs(near.selection.end - near.year - 5) < 0.05, 'not 5 years in front of it')
})
await check('the window came with it, framing the band', () => {
  ok(near.range.start < near.selection.start, 'the window does not contain the band')
  ok(near.range.end > near.selection.end, 'the window does not contain the band')
  ok(span(near.range) < 9, `the window is ${span(near.range)} years wide, not ~6.6`)
})

/* ======================================================== b. deep time clicks */
console.log('\n(b) locked click at 1 Ma, and at 2.5 Ga')
await setWindow(-4.5e9, 2026)
const ma = await pressYear(-1e6)
console.log(
  `    year ${ma.year.toExponential(3)}  band ${span(ma.selection).toExponential(3)} yr` +
    `  ×${(span(ma.selection) / span(near.selection)).toExponential(2)} the present's`,
)
await railShot('b-locked-click-1Ma')
await check('a click at 1 Ma opens a window tens of thousands of times wider', () => {
  ok(span(ma.selection) / span(near.selection) > 20_000, 'the deep window is not vast')
  ok(Math.abs(span(ma.selection) / (0.2 * 1_002_026) - 1) < 0.01, `k is not 0.2 here`)
  ok(ma.year >= ma.selection.start && ma.year <= ma.selection.end, 'the year is outside its band')
})
await check('the rail is showing the Quaternary, not the whole of geology', () => {
  ok(span(ma.range) < 3e5, `the window is ${span(ma.range)} years wide`)
})

await setWindow(-4.5e9, 2026)
const ga = await pressYear(-2.5e9)
console.log(
  `    year ${ga.year.toExponential(3)}  band ${ga.selection.start.toExponential(3)} – ${ga.selection.end.toExponential(3)}`,
)
await railShot('b2-locked-click-2500Ma')
await check('deep time, where the years are large negatives, works the same', () => {
  ok(ga.selection.start < ga.year && ga.selection.end > ga.year, 'the year is outside its band')
  ok(ga.selection.start < ga.selection.end, 'the band came back reversed')
  ok(Math.abs(span(ga.selection) / (0.2 * 2.5e9) - 1) < 0.01, 'k is not 0.2 at 2.5 Ga')
})

/* ============================================= c. the drag wins, and teaches */
console.log('\n(c) a dragged handle, then a click')
await setWindow(-4.5e9, 2026)
await pressYear(-1e6)
// Zoom out first, with the rail's own wheel gesture: a locked click leaves the
// band filling its window, so there is nowhere to drag a handle TO until the
// reader makes room. (An honest cost of fitting the window to the band.)
const mid = await railRect()
await page.mouse.move(mid.x + mid.width / 2, mid.y + mid.height - 10)
for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 120)
await page.waitForTimeout(150)
await railShot('c0-zoomed-out-to-make-room')
const dragged = await page.evaluate(() => {
  const rail = document.querySelector('.rail').getBoundingClientRect()
  const h = document.querySelector('.handle.end').getBoundingClientRect()
  const y = rail.y + rail.height - 10
  return { from: { x: h.x + h.width / 2, y }, to: { x: rail.right - 8, y } }
})
await page.mouse.move(dragged.from.x, dragged.from.y)
await page.mouse.down()
await page.mouse.move(dragged.to.x, dragged.to.y, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(150)
const taught = await state()
console.log(
  `    band dragged to ${span(taught.selection).toExponential(3)} yr;` +
    ` taught k=${taught.lock.scale.toFixed(3)} split=${taught.lock.split.toFixed(3)}`,
)
await railShot('c1-handle-dragged')
const after = await pressYear(taught.selection.start + span(taught.selection) * 0.4)
console.log(
  `    next click: band ${span(after.selection).toExponential(3)} yr, cursor at ` +
    `${(((after.year - after.selection.start) / span(after.selection)) * 100).toFixed(1)}% of it`,
)
await railShot('c2-click-after-drag')
await check('the drag wins: the band is the one the reader dragged', () => {
  ok(span(taught.selection) > span(ma.selection) * 1.5, `the band is ${span(taught.selection)} yr, was ${span(ma.selection)}`)
  ok(taught.lock.scale > 0.25, `the lock learnt k=${taught.lock.scale}, barely more than the default`)
})
await check('the drag teaches: the next click keeps the reader\u2019s proportions', () => {
  const k = span(after.selection) / (2026 - after.year)
  ok(Math.abs(k / taught.lock.scale - 1) < 0.02, `next click used k=${k}, not ${taught.lock.scale}`)
  const split = (after.year - after.selection.start) / span(after.selection)
  ok(Math.abs(split - taught.lock.split) < 0.02, `next click split ${split}, not ${taught.lock.split}`)
})

/* ========================================================= d. unlocked = old */
console.log('\n(d) unlocked — the behaviour that shipped')
const tipText = await page.evaluate(() => document.querySelector('#range-lock-tip').textContent.trim())
await page.click('[data-test="range-lock"]')
await page.waitForTimeout(60)
const offTip = await page.evaluate(() => ({
  pressed: document.querySelector('[data-test="range-lock"]').getAttribute('aria-pressed'),
  tip: document.querySelector('#range-lock-tip').textContent.trim(),
}))
// the state the app opens on, restated so the assertion has something exact
// to be about: the home window, the home band, the cursor inside it
await page.evaluate(() => {
  window.__time.setRange({ start: -550, end: 2026 })
  window.__time.setSelection(500, 1945)
  window.__time.setTime(1500)
})
const before = await state()
const inside = await pressYear(1200)
const outside = await pressYear(-200)
console.log(
  `    window ${before.range.start}\u2013${before.range.end} \u2192 ${inside.range.start}\u2013${inside.range.end};` +
    ` band ${outside.selection.start.toFixed(0)}\u2013${outside.selection.end.toFixed(0)}`,
)
await railShot('d-unlocked-click-1200')
await check('unlocked, a click inside the band moves the year and NOTHING else', () => {
  ok(inside.range.start === before.range.start && inside.range.end === before.range.end, 'the window moved')
  ok(Math.abs(inside.year - 1200) < 8, `the cursor is at ${inside.year}`)
  ok(inside.selection.start === 500 && inside.selection.end === 1945, 'the band moved')
})
await check('unlocked, a click outside it opens the near edge exactly, and no further', () => {
  ok(outside.range.start === before.range.start && outside.range.end === before.range.end, 'the window moved')
  ok(outside.selection.end === 1945, 'the far edge of the band moved')
  ok(Math.abs(outside.selection.start - outside.year) < 0.001, 'the near edge is not exactly on the cursor')
})
await check('the button says which state it is in, in words and in ARIA', () => {
  ok(offTip.pressed === 'false', `aria-pressed is ${offTip.pressed}`)
  ok(/only the year moves/.test(offTip.tip), `the unlocked tooltip reads "${offTip.tip}"`)
  ok(/follows the year/.test(tipText), `the locked tooltip reads "${tipText}"`)
})

/* ============================================================= e. the button */
console.log('\n(e) the padlock')
const btn = await page.evaluate(() => {
  const b = document.querySelector('[data-test="range-lock"]')
  const r = b.getBoundingClientRect()
  const rail = document.querySelector('.rail').getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, insideRail: r.top >= rail.top && r.bottom <= rail.bottom, right: rail.right - r.right }
})
console.log(`    ${btn.w}x${btn.h} at ${btn.right.toFixed(0)}px from the rail's right edge`)
await shot('e1-unlocked-button', { x: btn.x - 240, y: btn.y - 6, width: 280, height: 120 })
await page.hover('[data-test="range-lock"]')
await page.waitForTimeout(80)
const hovered = await page.evaluate(() => {
  const t = document.querySelector('#range-lock-tip')
  const r = t.getBoundingClientRect()
  const rail = document.querySelector('.rail').getBoundingClientRect()
  return { opacity: +getComputedStyle(t).opacity, clipped: r.bottom > rail.bottom + 0.5 || r.left < rail.left }
})
await shot('e2-tooltip-unlocked', { x: btn.x - 240, y: btn.y - 6, width: 280, height: 120 })
await page.click('[data-test="range-lock"]') // back on
await page.waitForTimeout(80)
await shot('e3-tooltip-locked', { x: btn.x - 240, y: btn.y - 6, width: 280, height: 120 })
const on = await page.evaluate(() => {
  const b = document.querySelector('[data-test="range-lock"]')
  return {
    pressed: b.getAttribute('aria-pressed'),
    brass: getComputedStyle(b.querySelector('svg')).color,
    shackle: [...b.querySelectorAll('path')].map((p) => p.getAttribute('d'))[0],
    tip: document.querySelector('#range-lock-tip').textContent.trim(),
  }
})
await check('the padlock is on the rail, and closes when it is locked', () => {
  ok(btn.insideRail, 'the button is not inside the rail')
  ok(btn.w >= 26 && btn.h >= 26, `the button is ${btn.w}x${btn.h}`)
  ok(on.pressed === 'true', 'aria-pressed did not come back on')
  ok(/V11$/.test(on.shackle), `the shackle path is "${on.shackle}" — not closed onto the body`)
  ok(on.brass === 'rgb(227, 167, 88)', `the locked glyph is ${on.brass}, not brass`)
})
await check('the tooltip shows on hover and stays inside the rail', () => {
  ok(hovered.opacity > 0.9, `the tooltip is at opacity ${hovered.opacity}`)
  ok(!hovered.clipped, 'the tooltip is clipped by the rail')
})
await check('…and on keyboard focus, which is the reason it is not a title', async () => {
  const focused = await page.evaluate(() => {
    const b = document.querySelector('[data-test="range-lock"]')
    b.blur()
    b.focus({ focusVisible: true })
    return { opacity: +getComputedStyle(document.querySelector('#range-lock-tip')).opacity }
  })
  ok(focused.opacity > 0.9, `focused tooltip is at opacity ${focused.opacity}`)
})
await shot('e4-focus-ring', { x: btn.x - 240, y: btn.y - 8, width: 280, height: 120 })

// the reset: a double press is two toggles (a no-op) plus the defaults back
const reset = await page.evaluate(() => ({ before: window.__time.lockIsDefault }))
await page.dblclick('[data-test="range-lock"]')
await page.waitForTimeout(80)
const afterReset = await state()
await check('a double press restores the shipped proportions, and stays locked', () => {
  ok(reset.before === false, 'the lock was already on its defaults, so this proves nothing')
  ok(afterReset.lock.on === true, 'the double press left it unlocked')
  ok(Math.abs(afterReset.lock.scale - 0.2) < 1e-9, `k is ${afterReset.lock.scale}`)
  ok(Math.abs(afterReset.lock.split - 1 / 6) < 1e-9, `the split is ${afterReset.lock.split}`)
})

/* ------------------------------------------------------------------ phone */
console.log('\n(f) a phone')
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })
await phone.goto(base, { timeout: 90_000 })
await phone.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' })
await phone.waitForFunction(() => window.__time && document.querySelector('.rail'))
await phone.waitForTimeout(400)
const small = await phone.evaluate(() => {
  const b = document.querySelector('[data-test="range-lock"]').getBoundingClientRect()
  const rail = document.querySelector('.rail').getBoundingClientRect()
  return { w: b.width, h: b.height, insideRail: b.bottom <= rail.bottom, y: rail.y, railH: rail.height }
})
const pcdp = await phone.context().newCDPSession(phone)
const pshot = async (name, clip) => {
  const { data } = await pcdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 3 } } : {}) })
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'))
}
await pshot('f-phone-rail', { x: 0, y: small.y, width: 390, height: small.railH })
console.log(`    button ${small.w}x${small.h} in a ${small.railH}px rail`)
await check('the phone gets a thumb-sized padlock inside its rail', () => {
  ok(small.w >= 30 && small.h >= 30, `the button is ${small.w}x${small.h} on a phone`)
  ok(small.insideRail, 'the button hangs out of the rail')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  · ${f}`)
console.log(`shots in ${shots}`)
await browser.close()
await server.close()
process.exit(failures.length ? 1 : 0)
