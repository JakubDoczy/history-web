/**
 * In-browser check of the UI polish round (docs/plan-ui-polish.md, items 1–4).
 *
 * Every one of these is a claim about LAYOUT or about GEOMETRY DRAWN BY WebGL,
 * which is to say: unverifiable without a layout engine and a GPU. What is
 * checked here, in order:
 *
 *   1. the open article is a comfortable measure on a desktop (~420–480 px),
 *      and on a phone it reaches from the timeline up to just under the top bar;
 *   2. the minimised pill is bottom-CENTRE, above the timeline, and says
 *      "Restore" in words;
 *   3. an expanded stack is joined to its members by STRAIGHT leader lines —
 *      measured as the sag of the drawn geometry against the straight chord,
 *      before and after, with the old parabola put back through the live layer;
 *   4. an operation opens with its overview already up, with the count of its
 *      pages advertised. (Item 5 moved that advertisement off the step strip
 *      and onto the rail itself — components/SagaTimeline.vue — so this now
 *      reads the rail. What is being checked is unchanged: arriving on the
 *      overview, and the existence of the pages being visible without a click.)
 *
 * Run:  node tests/e2e/uiPolish.e2e.mjs
 * Env:  CHROME_PATH        Chromium/Chrome executable
 *       SHOT_DIR           where screenshots land (default /tmp/shots41)
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 */
import { createServer } from 'vite'
import { mkdirSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots41'
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

// The app's own leg geometry, loaded through the dev server rather than copied:
// the check below is "the layer draws what LEG_ARC says", and a second copy of
// the numbers here would make it "the layer draws what this file says".
const { LEG_ARC: LEG } = await server.ssrLoadModule('/src/lib/eventClusters.ts')

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
})

const settle = async (page, ms = 1400) => {
  await page.waitForTimeout(ms)
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('.event-pin').length === window.__globe.htmlElementsData().length,
      null,
      { timeout: 15000 },
    )
    .catch(() => console.log('  [warn] pins never caught up with the data'))
}

async function open(width, height, deviceScaleFactor = 2) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor })
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
  await page.goto(base, { timeout: 90_000 })
  // Under swiftshader the document timeline crawls, so a 0.24 s entrance is
  // still on its opening frame seconds later; nothing here is about motion.
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
  // 1941 first: the chunk Barbarossa lives in is fetched for the window that is
  // open, and on a phone the idle prefetch has not got there by itself yet.
  await page.evaluate(() => window.__setTime(1941))
  await page.waitForFunction(() => window.__events.byId('barbarossa'), null, { timeout: 60_000 })
  await settle(page, 2500)
  return page
}

/** CDP screenshots: page.screenshot waits out its own timeout on a WebGL page. */
const sessions = new Map()
const shot = async (target, name) => {
  let cdp = sessions.get(target)
  if (!cdp) sessions.set(target, (cdp = await target.context().newCDPSession(target)))
  await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 })
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'))
}

const rect = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
  }, sel)

/* ============================================================ 1. the window */
console.log('\n(1) the open event window — desktop width')
const pc = await open(1440, 900)
await pc.evaluate(() => window.__events.select('barbarossa'))
await pc.waitForSelector('.panel')
await settle(pc, 600)

// The BEFORE picture, taken by putting the old rule back through a style tag:
// the same page, the same article, the width it shipped with yesterday.
const beforeTag = await pc.addStyleTag({
  content: '.panel { width: min(400px, calc(100vw - 32px)) !important; }',
})
await pc.waitForTimeout(200)
const beforeW = (await rect(pc, '.panel')).w
await shot(pc, 'a1-pc-window-before-400')
await pc.evaluate((el) => el.remove(), beforeTag)
await pc.waitForTimeout(200)
const panel = await rect(pc, '.panel')
await shot(pc, 'a2-pc-window-after')
console.log(`    ${beforeW}px → ${panel.w}px at a 1440px window`)
await check('the article widened into a comfortable measure', () => {
  ok(panel.w >= 420 && panel.w <= 480, `panel is ${panel.w}px wide`)
  ok(panel.w > beforeW, `no wider than before (${panel.w} vs ${beforeW})`)
})
await check('and still clears the top bar and the timeline', async () => {
  const bar = await rect(pc, '.bar')
  const rail = await rect(pc, '.timeline, .rail, [data-test="timeline"]')
  ok(panel.y >= bar.bottom - 6, `panel top ${panel.y} against bar bottom ${bar.bottom}`)
  if (rail) ok(panel.bottom <= rail.y + 1, `panel bottom ${panel.bottom} over rail ${rail.y}`)
})

/* ====================================================== 2. the parked pill */
console.log('\n(2) the minimised window on a desktop')
await pc.evaluate(() => window.__events.showOnMap('vostok-1'))
await settle(pc, 1200)
// vostok-1 may not exist in the corpus; fall back to any pinned event.
const pillState = await pc.evaluate(() => ({
  minimised: window.__events.panelMinimised,
  focus: window.__events.focus?.itemId,
}))
if (!pillState.focus) {
  await pc.evaluate(() => window.__events.showOnMap(window.__events.visible[0].id))
  await settle(pc, 1200)
}
// …and it may have landed on a SAGA, which opens on its overview rather than as
// a pill (`opensExpanded`) — this section is about the pill's geometry, so fold
// it down. Without this the whole file stopped here whenever `vostok-1` was not
// in the loaded chunks, which is how it stood before item 5 touched it.
if (!(await pc.evaluate(() => window.__events.panelMinimised))) {
  await pc.evaluate(() => window.__events.toggleFocusExpanded())
  await settle(pc, 800)
}
// The panel's own fold is a Vue <Transition mode="out-in">, and under
// swiftshader the two animation frames it waits for can take seconds — the
// store is minimised long before the pill is in the DOM. Waiting for the
// element rather than reading it on the next line is the difference between
// this file measuring the pill and this file throwing at it.
await pc.waitForSelector('[data-test="panel-pill"]', { timeout: 20_000 })
const pill = await rect(pc, '[data-test="panel-pill"]')
const railRect = await rect(pc, 'footer, .timeline, .rail')
await shot(pc, 'c-pc-minimised-pill-bottom-centre')
console.log(
  `    pill ${Math.round(pill.w)}x${Math.round(pill.h)} centred at ` +
    `${Math.round(pill.x + pill.w / 2)} of 1440, bottom ${Math.round(pill.bottom)} of 900`,
)
await check('the pill is bottom-centre, above the timeline', () => {
  const off = Math.abs(pill.x + pill.w / 2 - 720)
  ok(off < 2, `pill centre is ${off}px off the screen's axis`)
  ok(pill.bottom < 900 && pill.bottom > 700, `pill bottom at ${pill.bottom}`)
})
await check('it says what it is, in a word', async () => {
  const label = await pc.textContent('[data-test="pill-restore"]')
  ok(/restore/i.test(label ?? ''), `restore control reads "${label}"`)
})
await check('and it is still compact — a bar, not a second panel', () => {
  ok(pill.h <= 44, `pill is ${pill.h}px tall`)
  ok(pill.w <= 500, `pill is ${pill.w}px wide`)
})

/* ================================================= 3. the expanded stack -- */
console.log('\n(3) an expanded stack — straight leader lines')
await pc.evaluate(() => window.__events.dismiss())
await settle(pc, 800)
// The densest badge on screen, and the camera brought down onto it so the fan
// is drawn at the scale the complaint was about.
const target = await pc.evaluate(() => {
  const data = window.__globe.htmlElementsData()
  const best = data
    .filter((d) => d.kind === 'cluster')
    .sort((a, b) => b.members.length - a.members.length)[0]
  return best && { id: best.id, lat: best.lat, lng: best.lng, n: best.members.length }
})
console.log(`    densest stack: ${target?.id} with ${target?.n} members`)
ok(target, 'no cluster on the globe to expand')
/**
 * As close as the stack survives.
 *
 * Close is where the complaint lived — a fixed 25 km apex over a leg a few
 * kilometres long is a near-vertical lob, and a handful of them from one point
 * is what "fireworks" meant — but the clustering radius is a fraction of the
 * visible span, so past some zoom the stack simply is not a stack any more.
 * Walk in until the badge stops being there, and use the last altitude that
 * still had one.
 */
let clicked = false
for (const altitude of [0.1, 0.16, 0.24, 0.35]) {
  await pc.evaluate(
    ({ lat, lng, altitude }) => window.__globe.pointOfView({ lat, lng, altitude }, 0),
    { ...target, altitude },
  )
  await settle(pc, 2200)
  // Click the badge nearest the middle of the screen — the one we just flew to.
  clicked = await pc.evaluate(() => {
    const els = [...document.querySelectorAll('.event-pin--cluster')]
    const mid = { x: innerWidth / 2, y: innerHeight / 2 }
    const near = els
      .map((el) => {
        const r = el.getBoundingClientRect()
        return { el, d: Math.hypot(r.x + r.width / 2 - mid.x, r.y + r.height / 2 - mid.y) }
      })
      .filter((c) => c.d < Math.min(innerWidth, innerHeight) / 3)
      .sort((a, b) => a.d - b.d)[0]
    if (!near) return false
    near.el.click()
    return true
  })
  await settle(pc, 1200)
  const legs = await pc.evaluate(
    () => window.__events.expandedClusterId && window.__globe.arcsData().length,
  )
  console.log(`    altitude ${altitude}: ${legs || 0} legs`)
  if (clicked && legs) break
}
ok(clicked, 'no cluster badge on screen after the flight')

/**
 * The sag of every drawn leg, in globe radii: how far the middle of the drawn
 * geometry departs from the straight chord between its two ends. A leader line
 * has none; a parabola has a lot. Read off the actual three.js geometry the
 * arcs layer built, which is the only place the answer lives.
 */
const sagOf = () =>
  pc.evaluate(() => {
    const out = []
    window.__globe.scene().traverse((o) => {
      if (!o.geometry?.attributes?.position || !o.material?.uniforms?.dashSize) return
      const p = o.geometry.attributes.position
      const at = (i) => [p.getX(i), p.getY(i), p.getZ(i)]
      const a = at(0)
      const b = at(p.count - 1)
      const m = at(Math.floor(p.count / 2))
      // distance from the midpoint of the drawn curve to the straight chord
      const ab = a.map((v, i) => b[i] - v)
      const am = a.map((v, i) => m[i] - v)
      const len = Math.hypot(...ab) || 1e-9
      const t = ab.reduce((s, v, i) => s + v * am[i], 0) / (len * len)
      const foot = a.map((v, i) => v + ab[i] * t)
      const sag = Math.hypot(...foot.map((v, i) => m[i] - v))
      out.push({ sag: sag / 100, chord: len / 100 }) // globe radius is 100 units
    })
    return out
  })

/**
 * The render loop PARKS when nothing in the app is dirty (lib/renderPump.ts),
 * and poking the arc layer from a console is not something the app knows about
 * — so without a nudge to the camera the two pictures below are the same frame
 * twice, however different the geometry behind them is. A thousandth of a
 * degree of pan is enough to wake it and far too little to move the fan.
 */
const wake = async () => {
  await pc.evaluate(() => {
    const p = window.__globe.pointOfView()
    window.__globe.pointOfView({ ...p, lng: p.lng + 0.001 }, 0)
  })
  await pc.waitForTimeout(900)
}

const after = await sagOf()
await wake()
await shot(pc, 'd1-pc-expanded-stack-straight')
// …and the old geometry, put back through the live layer for the comparison.
await pc.evaluate(() => {
  window.__globe.arcStartAltitude(0).arcEndAltitude(0).arcAltitude(0.004)
})
const before = await sagOf()
await wake()
await shot(pc, 'd2-pc-expanded-stack-old-arcs')
/**
 * The same pair again, from an OBLIQUE angle.
 *
 * Straight down on the fan, a leg that lobs 25 km toward the camera projects as
 * a slightly shortened radial line: the numbers above tell the two shapes
 * apart, a top-down picture barely can. Off to one side the hop is side-on, and
 * the difference is what the eye sees rather than what the geometry says.
 */
const oblique = async (name) => {
  await pc.evaluate(() => {
    const p = window.__globe.pointOfView()
    window.__globe.pointOfView({ ...p, lat: p.lat + 1.15 }, 0)
  })
  await pc.waitForTimeout(1200)
  await shot(pc, name)
  await pc.evaluate(() => {
    const p = window.__globe.pointOfView()
    window.__globe.pointOfView({ ...p, lat: p.lat - 1.15 }, 0)
  })
  await pc.waitForTimeout(900)
}
await oblique('d3-pc-expanded-stack-old-arcs-oblique')
await pc.evaluate(
  (leg) =>
    window.__globe
      .arcStartAltitude(leg.startAltitude)
      .arcEndAltitude(leg.endAltitude)
      .arcAltitude(leg.altitude),
  LEG,
)
await pc.waitForTimeout(400)
await oblique('d4-pc-expanded-stack-straight-oblique')

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)
const ratio = (rows) => mean(rows.map((r) => r.sag / Math.max(r.chord, 1e-9)))
console.log(
  `    ${after.length} legs drawn; sag/chord now ${ratio(after).toFixed(4)}, ` +
    `with the old parabola ${ratio(before).toFixed(4)}`,
)
await check('the legs are straight lines from the stack to each pin', () => {
  ok(after.length > 1, `only ${after.length} legs were drawn`)
  ok(ratio(after) < 0.02, `legs still sag ${(ratio(after) * 100).toFixed(1)}% of their length`)
})
await check('…where the old ones arced far out of their own line', () => {
  ok(ratio(before) > 5 * ratio(after), `old sag ${ratio(before)} vs new ${ratio(after)}`)
})

/* ============================================== 4. an operation on the PC - */
console.log('\n(4) an operation opens on its overview')
await pc.evaluate(() => window.__events.dismiss())
await settle(pc, 800)
await pc.evaluate(() => window.__events.showOnMap('barbarossa'))
await settle(pc, 2200)
const op = await pc.evaluate(() => ({
  minimised: window.__events.panelMinimised,
  step: window.__events.stepId ?? null,
  steps: window.__events.focusSteps.length,
  count: document.querySelector('[data-test="saga-span"]')?.textContent?.trim() ?? null,
  chips: [...document.querySelectorAll('[data-test="saga-station"]')].map((b) => ({
    text: b.querySelector('.label')?.textContent.trim() ?? '',
    numbered: !!b.querySelector('.num')?.textContent.trim(),
    named: b.classList.contains('named'),
  })),
  article: !!document.querySelector('.panel'),
}))
await shot(pc, 'e-pc-operation-overview-and-rail')
console.log(`    ${op.steps} steps, the rail says "${op.count}", article up: ${op.article}`)
await check('the overview is up on arrival, with no second click', () => {
  ok(op.minimised === false, 'the panel folded to the pill')
  ok(op.article, 'no article on screen')
  ok(op.step === null, `landed on step ${op.step}`)
})
await check('the rail advertises the pages that exist', () => {
  // Item 5 moved the advertisement from a strip of chips over the map to the
  // rail itself: the count rides in the rail's span readout, and every step is
  // a numbered station wearing its own name.
  ok(op.count.endsWith(`${op.steps} steps`), `the rail reads "${op.count}" for ${op.steps} steps`)
  ok(op.chips.length === op.steps, `${op.chips.length} stations for ${op.steps} steps`)
  ok(op.chips.every((c) => c.numbered), 'a station carries no number')
  ok(op.chips.every((c) => c.named && c.text), 'a five-station rail is hiding a name')
})

/* ------------------------- 5b. the saga's call to action, renamed (round 47) */
console.log('\n(5b) a saga’s own action says where the steps go')
await pc.evaluate(() => window.__events.dismiss())
await pc.evaluate(() => window.__events.select('ww2'))
await pc.waitForSelector('[data-test="saga-cta"]')
await settle(pc, 600)
const ctaBox = await rect(pc, '[data-test="saga-cta"]')
const cta = await pc.evaluate(() => {
  const b = document.querySelector('[data-test="saga-cta"]')
  const cs = getComputedStyle(b)
  return {
    label: b.querySelector('.saga-cta-label').textContent.trim(),
    count: b.querySelector('.saga-cta-count').textContent.trim(),
    title: b.title,
    filled: cs.backgroundImage !== 'none' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
    generic: document.querySelector('[data-test="show-on-map"]')?.textContent.trim(),
  }
})
await shot(pc, 'g-saga-cta-renamed')
console.log(`    "${cta.label}" · ${cta.count} — beside the generic "${cta.generic}"`)
await check('the CTA is "Show steps on map", with the step count still on it', () => {
  ok(cta.label === 'Show steps on map', `the CTA reads "${cta.label}"`)
  ok(!/walk/i.test(cta.label + cta.title), `"Walk" survives somewhere: ${cta.label} / ${cta.title}`)
  ok(cta.count === '11', `the count reads "${cta.count}"`)
  ok(cta.generic === 'Show on map', `the generic action reads "${cta.generic}"`)
})
await check('…and it keeps its brass prominence over the generic action', () => {
  ok(cta.filled, 'the CTA is no longer filled')
  ok(ctaBox.w > 300, `the CTA is only ${Math.round(ctaBox.w)}px wide — it lost its own row`)
})

/* --------------------------------- 6. which build is this? (round 47) ------ */
console.log('\n(6) the settings footer names the build')
await pc.evaluate(() => window.__events.dismiss())
await pc.click('[aria-label="Settings"]')
await pc.waitForSelector('[data-test="build-stamp"]')
const stamp = await pc.evaluate(() => ({
  text: document.querySelector('[data-test="build-stamp"]').textContent.trim(),
  served: null,
}))
stamp.served = await pc.evaluate(async () => (await (await fetch('version.json')).json()))
await shot(pc, 'h-settings-build-stamp')
console.log(`    footer: "${stamp.text}"  ·  served: ${JSON.stringify(stamp.served)}`)
await check('the footer says which build the tab is running', () => {
  ok(/^build \S+ · \d{4}-\d{2}-\d{2}$/.test(stamp.text), `footer reads "${stamp.text}"`)
})
/* THE WHOLE POINT OF THE PAIR: the string compiled into the bundle and the
   string sitting beside index.html are the same string on a fresh load. When
   they stop being the same, the tab is stale — which is the only thing the
   toast below ever fires on. */
await check('…and it agrees with the version.json the server is serving', () => {
  ok(stamp.text.includes(stamp.served.id), `${stamp.text} vs ${stamp.served.id}`)
  ok(stamp.text.endsWith(stamp.served.at.slice(0, 10)), `${stamp.text} vs ${stamp.served.at}`)
})

/* ========================================================= the phone ==== */
// The desktop page goes first and is closed here: two software-GL globes in
// one browser starve each other badly enough that the second page never
// finishes loading (the shipped steps.e2e.mjs says the same).
await pc.close()

/* --------------------------------------------------------- 1b. the phone -- */
console.log('\n(1b) the open event window on a phone')
const phone = await open(390, 844, 3)
await phone.evaluate(() => window.__events.select('barbarossa'))
await phone.waitForSelector('.panel')
await settle(phone, 800)
const sheet = await rect(phone, '.panel')
const phoneBar = await rect(phone, '.bar')
await shot(phone, 'b-mobile-window-390x844')
console.log(
  `    sheet ${Math.round(sheet.h)}px tall, top at ${Math.round(sheet.y)}, ` +
    `bar ends at ${Math.round(phoneBar.bottom)}, viewport 844`,
)
await check('the sheet starts just below the top bar', () => {
  ok(sheet.y >= phoneBar.bottom - 8, `sheet top ${sheet.y} is under the bar (${phoneBar.bottom})`)
  ok(sheet.y <= phoneBar.bottom + 24, `sheet starts ${sheet.y - phoneBar.bottom}px below the bar`)
})
await check('and is far taller than the old 62dvh peephole', () => {
  ok(sheet.h > 0.62 * 844, `sheet is ${Math.round(sheet.h)}px, 62dvh is ${Math.round(0.62 * 844)}`)
})

/* -------------------------------------------- 4b. the phone still folds -- */
console.log('\n(4b) the same operation on a phone still opens as a pill')
await phone.evaluate(() => window.__events.showOnMap('barbarossa'))
await settle(phone, 2000)
const opPhone = await phone.evaluate(() => ({
  minimised: window.__events.panelMinimised,
  strip: !!document.querySelector('[data-test="saga-timeline"]'),
}))
await shot(phone, 'f-mobile-operation-pill')
await check('a phone keeps the map uncovered and the strip reachable', () => {
  ok(opPhone.minimised, 'the article covered the plan on a phone')
  ok(opPhone.strip, 'no saga rail on the phone')
})

/* --------------------------------- 7. the update toast (round 47) ---------- */
// its own page again, and the phone's globe has to let go of the GPU first
await phone.close()
console.log('\n(7) a tab running an old build is told so, once, and asked')
/* The stale-tab case, staged the only way a browser can stage it: the bundle is
   what it is, so the SERVER's answer is what changes under it. That is exactly
   the shape of the real failure — the tab is fine, the origin moved on. */
const stale = await open(1440, 900)
await check('a fresh tab whose build matches the server is left alone', async () => {
  await stale.waitForTimeout(1200)
  ok(
    !(await stale.$('[data-test="update-toast"]')),
    'the toast appeared on a tab that is already current',
  )
})
await stale.route('**/version.json*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ id: 'deadbee', at: '2026-08-07T09:00:00Z' }),
  }),
)
await check('coming back to a backgrounded tab finds the new build and offers a reload', async () => {
  // past MIN_GAP_MS, so the visibility check is not debounced away — the guard
  // that keeps flicking between apps down to one request
  await stale.waitForTimeout(10_500)
  await stale.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await stale.waitForSelector('[data-test="update-toast"]', { timeout: 15_000 })
  const t = await stale.evaluate(() => {
    const el = document.querySelector('[data-test="update-toast"]')
    const r = el.getBoundingClientRect()
    return {
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      action: el.querySelector('[data-test="update-reload"]').textContent.trim(),
      dismissible: !!el.querySelector('[data-test="update-dismiss"]'),
      bottom: innerHeight - r.bottom,
      clearsRail: r.bottom <= document.querySelector('.rail').getBoundingClientRect().top,
    }
  })
  await shot(stale, 'i-update-toast')
  console.log(`    "${t.text}" — ${Math.round(t.bottom)}px off the bottom`)
  ok(/new version/i.test(t.text), `the toast reads "${t.text}"`)
  ok(t.action === 'Reload', `the action reads "${t.action}"`)
  ok(t.dismissible, 'the toast cannot be dismissed')
  ok(t.clearsRail, 'the toast sits over the timeline instead of above it')
})
await check('…and it is gone for good once dismissed — it asks once per build', async () => {
  await stale.click('[data-test="update-dismiss"]')
  // detached rather than a fixed wait: under swiftshader the document timeline
  // crawls, so Vue's leave transition takes about a second to resolve
  await stale.waitForSelector('[data-test="update-toast"]', { state: 'detached', timeout: 15_000 })
  await stale.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await stale.waitForTimeout(1500)
  ok(!(await stale.$('[data-test="update-toast"]')), 'the dismissed toast came back')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  - ${f}`)
console.log(`screenshots in ${shots}`)
await browser.close()
await server.close()
process.exit(failures.length ? 1 : 0)
