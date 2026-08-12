/**
 * ROUND 57 — the range lock, in a browser: the two windows, apart.
 *
 * Round 56 shipped the lock and coupled two things that are not the same
 * thing: a press on the rail moved the year and the band (right), and also
 * flew the VISIBLE window to frame the band (wrong). The reader: *"now the
 * whole timeline shifts constantly when you click — don't do that. If possible
 * (visible timeline is large enough), just shift selected range."*
 *
 * So this file's centre of gravity moved. The rule that makes the band is
 * unchanged and still unit-tested (tests/rangeLock.test.ts); what needs a
 * layout engine is the other half — that a PRESS ON THE RAIL, at a pixel,
 * leaves the rail's own drawing alone.
 *
 * What is checked, in order:
 *
 *   a. THE DEFAULT the app opens on: the rail showing 1400–1789 exactly, the
 *      cursor on 1453 (the fall of Constantinople), the band the locked rule
 *      gives that year — 1433.9–1548.5 today;
 *   b. THE NO-SHIFT PROOF: three successive locked clicks inside that view,
 *      with the window equal to the byte and the ruler's own markup — every
 *      tick, every label, every pixel position — identical across all three;
 *   c. a click near the edge, where the band would poke out: the view slides,
 *      minimally, keeping its width exactly, and does not recentre;
 *   d. a click that no slide could contain: the view widens, and only then;
 *   e. the reader's own numbers near the present (1 back, 5 forward), and the
 *      rule at 1 Ma, each on a rail already at that scale;
 *   f. a handle dragged, then a click → the reader's own proportion, kept,
 *      in the reader's own view;
 *   g. the padlock unlocked → the old behaviour, exactly;
 *   h. the button itself: both states, aria-pressed, the tooltip on hover and
 *      on keyboard focus, and the double-press that restores the defaults.
 *
 * Run:  node tests/e2e/rangeLock.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots57/timeline), PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots57/timeline'
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

// The rail's own display warp and the lock's own rule, loaded through the dev
// server rather than restated here: the press below has to land on the pixel
// the APP puts a year on, and a second copy of asinh in this file would only
// ever agree with itself.
const { toWarp, MAX_TIME } = await server.ssrLoadModule('/src/lib/time.ts')
const { lockedWindow } = await server.ssrLoadModule('/src/lib/rangeLock.ts')
const { SLIDE_MARGIN } = await server.ssrLoadModule('/src/lib/selection.ts')

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
 * THE RULER, as markup.
 *
 * The no-shift claim is about what the reader sees, and what they see of the
 * visible window is the ruler: a tick per locally-round year, each at a pixel
 * the rail computed from the window. So the proof is this string being equal
 * across clicks — every label and every `left:` in it, to the byte. A window
 * that moved by a hundredth of a year would move a tick by a fraction of a
 * pixel and show up here; a tolerance on two numbers would not.
 */
const ruler = () => page.evaluate(() => document.querySelector('.rail .ruler').innerHTML)

const setWindow = (start, end) =>
  page.evaluate(([a, b]) => window.__time.setRange({ start: a, end: b }), [start, end])

/**
 * Press the rail at the PIXEL a year falls on — the real gesture, through the
 * real hit-testing. The mapping is the rail's own (`toWarp`), imported from the
 * app through the dev server rather than restated here, so this cannot pass by
 * agreeing with a second copy of the arithmetic.
 */
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
const warp = (s) => toWarp(s.end) - toWarp(s.start)
const same = (a, b) => a.start === b.start && a.end === b.end

/* ============================================== a. the view the app opens on */
console.log('\n(a) the default, on load')
const home = await state()
console.log(
  `    window ${home.range.start}–${home.range.end}  year ${home.year}` +
    `  band ${home.selection.start}–${home.selection.end} (${span(home.selection).toFixed(1)} yr)`,
)
await railShot('a-default-load')
await shot('a-default-load-full')

await check('opens on 1400–1789, exactly', () => {
  ok(home.range.start === 1400 && home.range.end === 1789, `the rail shows ${home.range.start}–${home.range.end}`)
})
await check('opens with the cursor on the fall of Constantinople', () => {
  ok(home.year === 1453, `the cursor is on ${home.year}`)
})
await check('opens with the band the locked rule gives 1453', () => {
  const want = lockedWindow(1453)
  ok(same(home.selection, want), `the band is ${JSON.stringify(home.selection)}, not ${JSON.stringify(want)}`)
  // …which, while the clock says 2026, is these numbers
  if (MAX_TIME === 2026)
    ok(
      home.selection.start === 1433.9 && home.selection.end === 1548.5,
      `in 2026 the band should be 1433.9–1548.5, not ${home.selection.start}–${home.selection.end}`,
    )
})
await check('the default is a year, not an event: nothing is selected or focused', () => {
  ok(home.lock.on === true, 'the lock is off by default')
})
await check('the rail draws the band and the cursor inside the window', async () => {
  const drawn = await page.evaluate(() => {
    const rail = document.querySelector('.rail').getBoundingClientRect()
    const sel = document.querySelector('.sel').getBoundingClientRect()
    const cur = document.querySelector('.cursor').getBoundingClientRect()
    return {
      band: [sel.left - rail.left, sel.right - rail.left],
      cursor: cur.left - rail.left,
      width: rail.width,
      flag: document.querySelector('.cursor .flag').textContent.trim(),
    }
  })
  ok(drawn.band[0] > 0 && drawn.band[1] < drawn.width, `the band is drawn at ${drawn.band}`)
  ok(drawn.cursor > drawn.band[0] && drawn.cursor < drawn.band[1], 'the cursor is outside its band')
  ok(drawn.flag === '1453', `the cursor flag reads "${drawn.flag}"`)
})

/* ======================================= b. three clicks that move no ticks */
console.log('\n(b) three successive locked clicks inside the view')
const before = await state()
const rulerBefore = await ruler()
// Each year is well clear of the band the click before it left behind: a
// selection handle owns 40 px of rail around its edge and swallows a press that
// lands on it (which is the drag gesture, and is not this one).
const seen = []
for (const [i, year] of [1450, 1650, 1500].entries()) {
  const s = await pressYear(year)
  seen.push({ ...s, asked: year, ruler: await ruler() })
  await railShot(`b${i + 1}-locked-click-${year}`)
  console.log(
    `    click ${year} → year ${s.year.toFixed(1)}  band ${s.selection.start.toFixed(1)}–${s.selection.end.toFixed(1)}` +
      `  window ${s.range.start}–${s.range.end}`,
  )
}
await check('the window does not move — strictly, not nearly', () => {
  for (const s of seen)
    ok(
      s.range.start === before.range.start && s.range.end === before.range.end,
      `the window went to ${s.range.start}–${s.range.end}, from ${before.range.start}–${before.range.end}`,
    )
})
await check('and the ruler is identical across all three, to the byte', () => {
  for (const [i, s] of seen.entries())
    ok(s.ruler === rulerBefore, `the ruler changed on click ${i + 1}`)
  // the check is worth nothing if the ruler is empty or trivial
  ok(/tnum/.test(rulerBefore) && rulerBefore.length > 200, 'the ruler markup looks empty')
})
await check('the band DID move, every time — this is not a test of nothing', () => {
  for (const [i, s] of seen.entries()) {
    ok(Math.abs(s.year - s.asked) < 3, `click ${i + 1} asked for ${s.asked} and got ${s.year}`)
    ok(!same(s.selection, before.selection), `click ${i + 1} left the band where it was`)
    const want = lockedWindow(s.year)
    ok(
      Math.abs(s.selection.start - want.start) < 0.5 && Math.abs(s.selection.end - want.end) < 0.5,
      `click ${i + 1} gave ${s.selection.start}–${s.selection.end}, the rule says ${want.start}–${want.end}`,
    )
  }
})

/* ============================================ c. the least move: a slide */
console.log('\n(c) a click near the edge, where the band pokes out')
const slidFrom = await state()
const slid = await pressYear(1770)
console.log(
  `    click 1770 → band ${slid.selection.start.toFixed(1)}–${slid.selection.end.toFixed(1)}` +
    `  window ${slidFrom.range.start}–${slidFrom.range.end} → ${slid.range.start.toFixed(1)}–${slid.range.end.toFixed(1)}`,
)
await railShot('c-edge-slide')
await check('the view slides rather than staying put', () => {
  ok(slid.range.start > slidFrom.range.start, 'the window did not slide right')
  ok(slid.selection.end <= slid.range.end, 'the band is still off the rail')
})
await check('it keeps its width exactly: a slide, not a reframe', () => {
  ok(
    Math.abs(warp(slid.range) / warp(slidFrom.range) - 1) < 1e-9,
    `the window went from ${warp(slidFrom.range)} to ${warp(slid.range)} warp units`,
  )
})
await check('and it slides no further than the margin it owes', () => {
  const air = toWarp(slid.range.end) - toWarp(slid.selection.end)
  ok(
    Math.abs(air / (warp(slid.range) * SLIDE_MARGIN) - 1) < 1e-6,
    `there is ${air} of air past the band, not ${warp(slid.range) * SLIDE_MARGIN}`,
  )
  // not a recentre: the band is hard against the leading edge, not in the middle
  const lead = toWarp(slid.selection.start) - toWarp(slid.range.start)
  ok(lead > air, 'the band came back centred — that is the fit, not a slide')
})

/* ================================== d. the widening, and only when needed */
console.log('\n(d) a click no slide could contain')
await setWindow(1500, 1520)
const tight = await state()
const widened = await pressYear(1510)
console.log(
  `    window 1500–1520 → ${widened.range.start.toFixed(1)}–${widened.range.end.toFixed(1)}` +
    ` for a band of ${span(widened.selection).toFixed(1)} yr`,
)
await railShot('d-widened')
await check('the view widens, to exactly the band plus its two margins', () => {
  ok(warp(widened.range) > warp(tight.range), 'the window did not widen')
  const want = warp(widened.selection) / (1 - 2 * SLIDE_MARGIN)
  ok(Math.abs(warp(widened.range) / want - 1) < 1e-6, `the window is ${warp(widened.range)}, wanted ${want}`)
})

/* ============================== e. the rule itself, on a rail at its scale */
console.log('\n(e) the reader’s own numbers, and the rule at 1 Ma')
await setWindow(1900, 2026)
const nearFrom = await state()
const near = await pressYear(2000)
console.log(
  `    year ${near.year.toFixed(1)}  band ${near.selection.start.toFixed(1)}–${near.selection.end.toFixed(1)}` +
    ` (${span(near.selection).toFixed(2)} yr)  window ${near.range.start}–${near.range.end}`,
)
await railShot('e1-locked-click-2000')
await check('a click near the present gives 1 year back and 5 forward', () => {
  ok(Math.abs(span(near.selection) - 6) < 0.01, `the band is ${span(near.selection)} years wide`)
  ok(Math.abs(near.year - near.selection.start - 1) < 0.05, 'not 1 year behind the cursor')
  ok(Math.abs(near.selection.end - near.year - 5) < 0.05, 'not 5 years in front of it')
})
await check('…on a rail that did not move for it', () => {
  ok(same(near.range, nearFrom.range), `the window went to ${near.range.start}–${near.range.end}`)
})

await setWindow(-1.3e6, -0.7e6)
const deepFrom = await state()
const ma = await pressYear(-1e6)
console.log(
  `    year ${ma.year.toExponential(3)}  band ${span(ma.selection).toExponential(3)} yr` +
    `  ×${(span(ma.selection) / span(near.selection)).toExponential(2)} the present's`,
)
await railShot('e2-locked-click-1Ma')
await check('a click at 1 Ma opens a band tens of thousands of times wider', () => {
  ok(span(ma.selection) / span(near.selection) > 20_000, 'the deep band is not vast')
  ok(Math.abs(span(ma.selection) / (0.2 * (MAX_TIME + 1e6)) - 1) < 0.01, 'k is not 0.2 here')
  ok(ma.year >= ma.selection.start && ma.year <= ma.selection.end, 'the year is outside its band')
})
await check('…and the deep rail holds still too', () => {
  ok(same(ma.range, deepFrom.range), `the window went to ${ma.range.start}–${ma.range.end}`)
})

// The honest limit, stated as a check rather than as a comment: on the
// whole-of-time rail the rule's band is a third of a percent of the window, and
// `clampSelection` will not let a band be narrower than 2% of it — two handles
// that close together cannot be told apart. So the band lands at that floor.
await setWindow(-4.5e9, 2026)
const wholeFrom = await state()
const whole = await pressYear(-1e6)
await railShot('e3-whole-of-time-click')
await check('on the whole-of-time rail the band takes the minimum grabbable width', () => {
  ok(same(whole.range, wholeFrom.range), 'the whole-of-time view moved')
  const frac = warp(whole.selection) / warp(whole.range)
  ok(Math.abs(frac - 0.02) < 1e-6, `the band is ${frac} of the rail, not the 2% floor`)
  ok(span(whole.selection) > 0.2 * (MAX_TIME + 1e6), 'the floor did not widen the band')
  ok(whole.year >= whole.selection.start && whole.year <= whole.selection.end, 'the year is outside its band')
})

/* ============================================= f. the drag wins, and teaches */
console.log('\n(f) a dragged handle, then a click')
await setWindow(-2e6, 0)
await pressYear(-1e6)
// The band is a fifth of the depth and the view is the reader's, so there is
// room to take a handle out — which is itself round 57's doing: under the old
// fit the band filled its window and this test had to wheel-zoom first.
const teachFrom = await state()
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
await railShot('f1-handle-dragged')
const after = await pressYear(taught.selection.start + span(taught.selection) * 0.4)
console.log(
  `    next click: band ${span(after.selection).toExponential(3)} yr, cursor at ` +
    `${(((after.year - after.selection.start) / span(after.selection)) * 100).toFixed(1)}% of it`,
)
await railShot('f2-click-after-drag')
await check('the drag wins: the band is the one the reader dragged', () => {
  ok(
    span(taught.selection) > span(teachFrom.selection) * 1.5,
    `the band is ${span(taught.selection)} yr, was ${span(teachFrom.selection)}`,
  )
  ok(taught.lock.scale > 0.25, `the lock learnt k=${taught.lock.scale}, barely more than the default`)
})
await check('the drag teaches: the next click keeps the reader’s proportions', () => {
  const k = span(after.selection) / (MAX_TIME - after.year)
  ok(Math.abs(k / taught.lock.scale - 1) < 0.05, `next click used k=${k}, not ${taught.lock.scale}`)
  const split = (after.year - after.selection.start) / span(after.selection)
  ok(Math.abs(split - taught.lock.split) < 0.05, `next click split ${split}, not ${taught.lock.split}`)
})

/* ========================================================= g. unlocked = old */
console.log('\n(g) unlocked — the behaviour that shipped')
const tipText = await page.evaluate(() => document.querySelector('#range-lock-tip').textContent.trim())
await page.click('[data-test="range-lock"]')
await page.waitForTimeout(60)
const offTip = await page.evaluate(() => ({
  pressed: document.querySelector('[data-test="range-lock"]').getAttribute('aria-pressed'),
  tip: document.querySelector('#range-lock-tip').textContent.trim(),
}))
// a window and a band with room either side, restated so the assertions below
// have something exact to be about
await page.evaluate(() => {
  window.__time.setRange({ start: -550, end: 2026 })
  window.__time.setSelection(500, 1945)
  window.__time.setTime(1500)
})
const plainBefore = await state()
const inside = await pressYear(1200)
const outside = await pressYear(-200)
console.log(
  `    window ${plainBefore.range.start}–${plainBefore.range.end} → ${inside.range.start}–${inside.range.end};` +
    ` band ${outside.selection.start.toFixed(0)}–${outside.selection.end.toFixed(0)}`,
)
await railShot('g-unlocked-click-1200')
await check('unlocked, a click inside the band moves the year and NOTHING else', () => {
  ok(same(inside.range, plainBefore.range), 'the window moved')
  ok(Math.abs(inside.year - 1200) < 8, `the cursor is at ${inside.year}`)
  ok(inside.selection.start === 500 && inside.selection.end === 1945, 'the band moved')
})
await check('unlocked, a click outside it opens the near edge exactly, and no further', () => {
  ok(same(outside.range, plainBefore.range), 'the window moved')
  ok(outside.selection.end === 1945, 'the far edge of the band moved')
  ok(Math.abs(outside.selection.start - outside.year) < 0.001, 'the near edge is not exactly on the cursor')
})
await check('the button says which state it is in, in words and in ARIA', () => {
  ok(offTip.pressed === 'false', `aria-pressed is ${offTip.pressed}`)
  ok(/only the year moves/.test(offTip.tip), `the unlocked tooltip reads "${offTip.tip}"`)
  ok(/follows the year/.test(tipText), `the locked tooltip reads "${tipText}"`)
})

/* ============================================================= h. the button */
console.log('\n(h) the padlock')
const btn = await page.evaluate(() => {
  const b = document.querySelector('[data-test="range-lock"]')
  const r = b.getBoundingClientRect()
  const rail = document.querySelector('.rail').getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, insideRail: r.top >= rail.top && r.bottom <= rail.bottom, right: rail.right - r.right }
})
console.log(`    ${btn.w}x${btn.h} at ${btn.right.toFixed(0)}px from the rail's right edge`)
await shot('h1-unlocked-button', { x: btn.x - 240, y: btn.y - 6, width: 280, height: 120 })
await page.hover('[data-test="range-lock"]')
await page.waitForTimeout(80)
const hovered = await page.evaluate(() => {
  const t = document.querySelector('#range-lock-tip')
  const r = t.getBoundingClientRect()
  const rail = document.querySelector('.rail').getBoundingClientRect()
  return { opacity: +getComputedStyle(t).opacity, clipped: r.bottom > rail.bottom + 0.5 || r.left < rail.left }
})
await shot('h2-tooltip-unlocked', { x: btn.x - 240, y: btn.y - 6, width: 280, height: 120 })
await page.click('[data-test="range-lock"]') // back on
await page.waitForTimeout(80)
await shot('h3-tooltip-locked', { x: btn.x - 240, y: btn.y - 6, width: 280, height: 120 })
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
await shot('h4-focus-ring', { x: btn.x - 240, y: btn.y - 8, width: 280, height: 120 })

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
console.log('\n(i) a phone')
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })
await phone.goto(base, { timeout: 90_000 })
await phone.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' })
await phone.waitForFunction(() => window.__time && document.querySelector('.rail'))
await phone.waitForTimeout(400)
const small = await phone.evaluate(() => {
  const b = document.querySelector('[data-test="range-lock"]').getBoundingClientRect()
  const rail = document.querySelector('.rail').getBoundingClientRect()
  return {
    w: b.width,
    h: b.height,
    insideRail: b.bottom <= rail.bottom,
    y: rail.y,
    railH: rail.height,
    range: { ...window.__time.range },
    year: window.__time.currentTime,
  }
})
const pcdp = await phone.context().newCDPSession(phone)
const pshot = async (name, clip) => {
  const { data } = await pcdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 3 } } : {}) })
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'))
}
await pshot('i-phone-rail', { x: 0, y: small.y, width: 390, height: small.railH })
console.log(`    button ${small.w}x${small.h} in a ${small.railH}px rail`)
await check('the phone gets a thumb-sized padlock inside its rail', () => {
  ok(small.w >= 30 && small.h >= 30, `the button is ${small.w}x${small.h} on a phone`)
  ok(small.insideRail, 'the button hangs out of the rail')
})
await check('the phone opens on the same default view', () => {
  ok(small.range.start === 1400 && small.range.end === 1789, `the phone rail shows ${small.range.start}–${small.range.end}`)
  ok(small.year === 1453, `the phone cursor is on ${small.year}`)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  · ${f}`)
console.log(`shots in ${shots}`)
await browser.close()
await server.close()
process.exit(failures.length ? 1 : 0)
