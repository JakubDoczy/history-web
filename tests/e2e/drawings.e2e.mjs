/**
 * DRAWINGS V2, in a browser — the ink, photographed.
 *
 * Every claim round 60 makes about a plan is a claim about pixels: that a
 * frontline reads over parchment and over ocean because it is cased, that an
 * axis of advance is a curve rather than a traverse, that a zone is a wash and
 * not a lid, and that a plain SELECTED event now puts its plan on the ground at
 * all. None of that is reachable from a unit test, so this drives the real app
 * under SwiftShader and photographs it.
 *
 * It shoots the SAME cameras against whatever tree it is run in, so running it
 * once in a worktree at the previous commit and once here produces a matched
 * before/after pair (the pattern tests/e2e/nations.e2e.mjs uses). `SHOT_TAG` is
 * what keeps the two sets apart. The zone/ticks camera has no "before": those
 * kinds did not exist, and the harness says so rather than shooting a blank.
 *
 * Run:  node tests/e2e/drawings.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR (default /tmp/shots60/drawings), SHOT_TAG
 *       (default 'after'), SHOT_ONLY (a regex over camera names),
 *       PLAYWRIGHT_MODULE
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? '/tmp/shots60/drawings'
const tag = process.env.SHOT_TAG ?? 'after'
mkdirSync(shots, { recursive: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const server = await createServer({ root, server: { port: 0 }, logLevel: 'warn' })
await server.listen()
const base = `http://localhost:${server.httpServer.address().port}`

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
})

const sessions = new Map()
const shot = async (page, name) => {
  let cdp = sessions.get(page)
  if (!cdp) sessions.set(page, (cdp = await page.context().newCDPSession(page)))
  await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 })
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = join(shots, `${tag}-${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

/**
 * Wait for the CORPUS to stop growing — the app loads chunks for the window
 * that is open, and a jump to 1941 asks for one the boot did not have.
 */
const corpusQuiet = async (page, still = 800, timeout = 25_000) => {
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
  console.log('  [warn] the corpus never stopped growing')
}

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
  await page.goto(base, { timeout: 90_000 })
  await page.addStyleTag({
    content:
      '*, *::before, *::after { animation: none !important; transition: none !important; }' +
      // The subject is the ground, and on a desktop the article covers a third
      // of it. The panel is not what is being judged here.
      '.panel { display: none !important; }',
  })
  await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
  // THE BAND IS THE PREMISE, and it is stated rather than inherited: a bare
  // `__setTime(1941)` only grows the open band AS FAR AS 1941, so anything
  // later is culled and a 1944 plan is photographed against a map with no pins.
  await page.evaluate(() => {
    window.__time.setRange({ start: -550, end: 2026 })
    window.__time.setSelection(500, 1945)
  })
  await page.evaluate(() => window.__setTime(1941))
  await corpusQuiet(page)
  await page.waitForFunction(() => window.__events.byId('barbarossa'), null, { timeout: 60_000 })
  await page.waitForTimeout(2500)
  return page
}

const setMode = async (page, mode) => {
  await page.evaluate((m) => window.__settings.setMode(m), mode)
  await page.waitForTimeout(1200)
}

const clear = async (page) => {
  await page.evaluate(() => window.__events.dismiss())
  await page.waitForTimeout(600)
}

/** What is actually on the ground, as numbers a picture cannot be diffed on. */
const stateOf = (page) =>
  page.evaluate(() => ({
    focus: window.__events.focus?.itemId ?? null,
    selected: window.__events.selectedId ?? null,
    layers: (window.__events.focusDrawing?.layers ?? []).map((l) => l.type),
    caps: window.__globe.polygonsData().filter((p) => p.kind === 'area').length,
    calls: window.__globe.renderer?.().info?.render?.calls ?? null,
    triangles: window.__globe.renderer?.().info?.render?.triangles ?? null,
  }))

/**
 * A drawing the corpus does not carry yet, put on a selected event for one
 * frame. The zone and the ticks are round 60's new vocabulary and Part 3 is the
 * pass that authors any; this is how they are photographed before then, and it
 * is thrown away with the page.
 */
const TEST_INK = {
  layers: [
    { type: 'zone', ring: [[30.2, 50.9], [32.6, 51.4], [33.8, 50.2], [32.4, 49.2], [30.5, 49.6]], label: 'Kiev pocket' },
    { type: 'frontline', paths: [[[28.5, 52.8], [30.0, 51.6], [31.4, 50.4], [32.2, 49.0], [33.4, 47.6]]], ticks: 'left', width: 2.6 },
    { type: 'thrust', path: [[27.0, 53.4], [29.4, 52.4], [31.2, 51.2], [32.6, 50.6]], width: 0.3 },
  ],
}

const page = await open(1280, 860)

const CAMERAS = [
  // BARBAROSSA: two fronts and three army groups, which is the whole of what
  // casing and smoothing were done for. The plan's own frame, on both grounds.
  { name: 'a-barbarossa-map', mode: 'schematic', focus: 'barbarossa' },
  { name: 'b-barbarossa-realistic', mode: 'realistic', focus: 'barbarossa' },
  // D-DAY: five short thrusts at close zoom, where a casing has the least room
  // and an arrowhead on the wrong tangent is most visible.
  { name: 'c-dday-map', mode: 'schematic', focus: 'd-day', year: 1944 },
  { name: 'd-dday-realistic', mode: 'realistic', focus: 'd-day', year: 1944 },
  // PART 2: the same plan reached by SELECTING the event — no focus mode, no
  // steps, no rail. Blank ground before this round.
  { name: 'e-selected-map', mode: 'schematic', select: 'barbarossa' },
  { name: 'f-selected-realistic', mode: 'realistic', select: 'barbarossa' },
  // THE NEW KINDS, injected for one frame (see TEST_INK).
  { name: 'g-zone-map', mode: 'schematic', select: 'barbarossa', ink: TEST_INK, view: [50.6, 31.2, 0.16] },
  { name: 'h-zone-realistic', mode: 'realistic', select: 'barbarossa', ink: TEST_INK, view: [50.6, 31.2, 0.16] },
]

const only = process.env.SHOT_ONLY ? new RegExp(process.env.SHOT_ONLY) : undefined
const results = []
for (const cam of CAMERAS) {
  if (only && !only.test(cam.name)) continue
  console.log(`\n${cam.name}`)
  await clear(page)
  await setMode(page, cam.mode)
  // The cursor is a camera's own premise: `dismiss` clears the selection but not
  // the year, and a frame photographed at the year the *previous* camera left
  // behind draws the previous camera's polities under this one's ink.
  await page.evaluate((y) => window.__setTime(y), cam.year ?? 1941)
  await page.waitForTimeout(500)
  const restore = await page.evaluate(
    ([id, ink]) => {
      if (!ink) return null
      const e = window.__events.byId(id)
      const was = e.drawing
      e.drawing = ink
      return was ? 'held' : null
    },
    [cam.focus ?? cam.select, cam.ink ?? null],
  )
  if (cam.focus) {
    await page.evaluate((id) => window.__events.showOnMap(id), cam.focus)
  } else {
    await page.evaluate(
      ([id, view]) => {
        window.__events.select(id)
        const t = view
          ? { lat: view[0], lng: view[1], altitude: view[2] }
          : window.__events.mapTarget(id)
        if (t) window.__globe.pointOfView(t, 0)
      },
      [cam.select, cam.view ?? null],
    )
  }
  await page.waitForTimeout(5000)
  await page.evaluate(() => window.__wake?.(600))
  await page.waitForTimeout(1200)
  const state = await stateOf(page)
  const file = await shot(page, cam.name)
  console.log(`      ${file}`)
  console.log(
    `      focus ${state.focus}  selected ${state.selected}  layers [${state.layers.join(', ')}]  ` +
      `caps ${state.caps}  draws ${state.calls}  tris ${state.triangles}`,
  )
  results.push({ ...cam, ink: !!cam.ink, ...state, restored: restore })
}

writeFileSync(join(shots, `${tag}-summary.json`), JSON.stringify(results, null, 2))
console.log(`\nwrote ${results.length} frames to ${shots} as "${tag}-*"`)

await browser.close()
await server.close()
