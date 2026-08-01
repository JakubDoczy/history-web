/**
 * Integration check for the Wikipedia lead picture in EventPanel.
 *
 * This sandbox has no route to wikipedia.org, so the summary endpoint and the
 * Wikimedia thumbnail are both served by Playwright route mocks from
 * `fixtures/`. What is proved here is everything on our side of the wire: that a
 * real browser running the real component asks the right URL, renders the
 * picture with its caption and attribution, reserves the box, falls back
 * silently on 404 and on transport failure, never doubles up on an event that
 * already has an image, and aborts a stale request when the user moves on.
 *
 * Live-API behaviour (CORS headers, real payload shapes, the widths the
 * thumbnailer actually honours) still needs a run against the real endpoint in a
 * networked browser.
 *
 * Run:  node tests/e2e/wikiImage.e2e.mjs
 * Env:  CHROME_PATH        Chromium/Chrome executable (defaults to the puppeteer cache)
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 */
import { createServer } from 'vite'
import { readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = join(here, 'shots')
mkdirSync(shots, { recursive: true })

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const CHROME =
  process.env.CHROME_PATH ??
  '/home/claude/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome'

const fixture = (name) => readFileSync(join(here, 'fixtures', name))

/* ------------------------------------------------------------ tiny test kit */

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
const eq = (actual, expected, what) => {
  if (actual !== expected)
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const ok = (cond, what) => {
  if (!cond) throw new Error(what)
}

/* ---------------------------------------------------------- server + mocks */

const SUMMARIES = {
  'G%C3%B6bekli_Tepe': 'summary-gobekli-tepe.json',
  Jericho: 'summary-jericho.json',
}
const NOT_FOUND = new Set(['Definitely_Not_A_Page'])
const NETWORK_ERROR = new Set(['Network_Failure_Page'])

const server = await createServer({
  root,
  configFile: join(root, 'vite.config.ts'),
  server: { port: 5199, strictPort: true },
  logLevel: 'warn',
})
await server.listen()
const base = `http://localhost:${server.config.server.port}/history-web/tests/e2e/harness.html`

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 })

let summaryRequests = []
let failedRequests = []
let summaryDelayMs = 0

await context.route('**/api/rest_v1/page/summary/**', async (route) => {
  const title = route.request().url().split('/summary/')[1]
  summaryRequests.push(title)
  if (summaryDelayMs) await new Promise((r) => setTimeout(r, summaryDelayMs))
  try {
    if (NETWORK_ERROR.has(title)) return await route.abort('failed')
    if (NOT_FOUND.has(title) || !SUMMARIES[title])
      return await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ type: 'not_found', title: 'Not found.' }),
      })
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: fixture(SUMMARIES[title]),
    })
  } catch {
    /* the page aborted this request while we were sleeping — that is the point of test 6 */
  }
})

await context.route('**upload.wikimedia.org/**', (route) =>
  route.fulfill({ status: 200, contentType: 'image/png', body: fixture('thumbnail.png') }),
)
await context.route('**/placeholder-own.png', (route) =>
  route.fulfill({ status: 200, contentType: 'image/png', body: fixture('own-image.png') }),
)

const page = await context.newPage()
page.on('requestfailed', (r) => failedRequests.push(r.url()))
const consoleErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => consoleErrors.push(String(e)))

const wikiFigure = page.locator('[data-test="wiki-figure"]')
const anyFigure = page.locator('article figure')

const select = (id) => page.evaluate((v) => window.panelHarness.select(v), id)
const reset = async () => {
  await page.evaluate(() => {
    window.panelHarness.select(undefined)
    window.panelHarness.clearCache()
  })
  summaryRequests = []
  failedRequests = []
}
const settled = async () => {
  await wikiFigure.waitFor({ state: 'visible', timeout: 6000 })
  await page
    .locator('[data-test="wiki-figure"] img')
    .evaluate((img) => (img.complete ? null : new Promise((r) => img.addEventListener('load', r, { once: true }))))
  await page.waitForTimeout(400) // let the fade finish before any screenshot
}

await page.goto(base, { waitUntil: 'networkidle' })

/* ------------------------------------------------------------ 1. happy path */

console.log('\n1. an event with a Wikipedia link renders the picture')
await reset()
await select('gobekli-tepe')
await settled()
await page.screenshot({ path: join(shots, '01-wiki-image.png') })

const state = await page.evaluate(() => {
  const fig = document.querySelector('[data-test="wiki-figure"]')
  const img = fig.querySelector('img')
  const a = fig.querySelector('figcaption a')
  return {
    src: img.getAttribute('src'),
    widthAttr: Number(img.getAttribute('width')),
    heightAttr: Number(img.getAttribute('height')),
    loading: img.getAttribute('loading'),
    naturalWidth: img.naturalWidth,
    renderedHeight: Math.round(img.getBoundingClientRect().height),
    renderedWidth: Math.round(img.getBoundingClientRect().width),
    opacity: getComputedStyle(fig).opacity,
    caption: fig.querySelector('figcaption').textContent.trim(),
    href: a.getAttribute('href'),
    linkText: a.textContent.trim(),
    rel: a.getAttribute('rel'),
    target: a.getAttribute('target'),
    figures: document.querySelectorAll('article figure').length,
    // DOCUMENT_POSITION_FOLLOWING (4): the body comes after the figure
    figureBeforeBody: Boolean(
      fig.compareDocumentPosition(document.querySelector('article .body')) & 4,
    ),
  }
})

await check('asks the summary endpoint once, with the encoded title', () => {
  eq(summaryRequests.length, 1, 'summary requests')
  eq(summaryRequests[0], 'G%C3%B6bekli_Tepe', 'requested title')
})
await check('upgrades the 320px thumbnail to the panel width', () => {
  const m = /\/(\d+)px-/.exec(state.src)
  ok(m, `no NNNpx- segment in ${state.src}`)
  ok(Number(m[1]) > 320, `expected an upgrade above 320px, got ${m[1]}px`)
  ok(Number(m[1]) <= 4288, 'must not exceed the original width')
})
await check('the picture actually loaded', () => ok(state.naturalWidth > 0, 'naturalWidth is 0'))
await check('intrinsic size is on the element, so the box is reserved', () => {
  ok(state.widthAttr > 0 && state.heightAttr > 0, 'missing width/height attributes')
  const ratio = state.heightAttr / state.widthAttr
  ok(Math.abs(ratio - 213 / 320) < 0.01, `aspect ratio ${ratio} does not match the thumbnail`)
})
await check('renders at the thumbnail ratio, not squashed by the height hint', () => {
  const ratio = state.renderedHeight / state.renderedWidth
  ok(Math.abs(ratio - 213 / 320) < 0.05, `rendered ${state.renderedWidth}x${state.renderedHeight}`)
})
await check('sits above the article body', () => eq(state.figureBeforeBody, true, 'figure precedes .body'))
await check('is lazily loaded', () => eq(state.loading, 'lazy', 'loading attribute'))
await check('faded in to full opacity', () => eq(state.opacity, '1', 'figure opacity'))
await check('captions with the API description', () =>
  ok(
    state.caption.includes('Neolithic archaeological site in southeastern Anatolia'),
    `caption was ${JSON.stringify(state.caption)}`,
  ),
)
await check('attributes to Wikipedia with a safe external link', () => {
  eq(state.linkText, 'Wikipedia', 'attribution link text')
  eq(state.href, 'https://en.wikipedia.org/wiki/G%C3%B6bekli_Tepe', 'attribution href')
  ok((state.rel ?? '').includes('noopener'), 'link is missing rel=noopener')
  eq(state.target, '_blank', 'link target')
})
await check('renders exactly one figure', () => eq(state.figures, 1, 'figure count'))

/* ----------------------------------------------------------------- 2. a 404 */

console.log('\n2. a 404 from the API leaves the panel as it was')
await reset()
await select('missing')
await page.waitForTimeout(600)
await page.screenshot({ path: join(shots, '02-fallback-404.png') })
await check('asked, and got nothing', () => eq(summaryRequests.length, 1, 'summary requests'))
await check('renders no figure', async () => eq(await anyFigure.count(), 0, 'figure count'))
await check('still renders the article body', async () =>
  ok((await page.locator('article .body').innerText()).length > 10, 'body missing'),
)

/* --------------------------------------------------- 3. a transport failure */

console.log('\n3. a network failure leaves the panel as it was')
await reset()
await select('offline')
await page.waitForTimeout(600)
await page.screenshot({ path: join(shots, '03-fallback-network-error.png') })
await check('renders no figure after a failed request', async () => eq(await anyFigure.count(), 0, 'figure count'))
await check('the failure was a real transport failure', () =>
  ok(failedRequests.some((u) => u.includes('Network_Failure_Page')), 'no requestfailed recorded'),
)
await check('no uncaught error reached the console', () => {
  const real = consoleErrors.filter((e) => !/Failed to load resource|net::ERR/.test(e))
  eq(real.length, 0, `console errors: ${JSON.stringify(real)}`)
})

/* --------------------------------------------- 4. event that already has one */

console.log('\n4. an event with its own image is left alone')
await reset()
await select('has-image')
await page.waitForTimeout(600)
await page.screenshot({ path: join(shots, '04-own-image-no-double.png') })
const own = await page.evaluate(() => ({
  figures: document.querySelectorAll('article figure').length,
  wiki: document.querySelectorAll('[data-test="wiki-figure"]').length,
  src: document.querySelector('article figure img')?.getAttribute('src'),
}))
await check('renders exactly one figure', () => eq(own.figures, 1, 'figure count'))
await check('and it is the dataset one', () => {
  eq(own.wiki, 0, 'wiki figure count')
  eq(own.src, '/placeholder-own.png', 'image src')
})
await check('never asks Wikipedia for it', () => eq(summaryRequests.length, 0, 'summary requests'))

/* -------------------------------------------------------- 5. no link at all */

console.log('\n5. an event with no Wikipedia link asks for nothing')
await reset()
await select('no-link')
await page.waitForTimeout(400)
await check('no request', () => eq(summaryRequests.length, 0, 'summary requests'))
await check('no figure', async () => eq(await anyFigure.count(), 0, 'figure count'))

/* ------------------------------------------------------- 6. stale navigation */

console.log('\n6. rapid event → event navigation aborts the stale request')
await reset()
summaryDelayMs = 900
await select('gobekli-tepe')
await page.waitForTimeout(100)
await select('jericho') // the user moved on before the first answer arrived
summaryDelayMs = 0
await settled()
await page.screenshot({ path: join(shots, '05-after-rapid-navigation.png') })
const after = await page.evaluate(() => ({
  heading: document.querySelector('article h2').textContent.trim(),
  src: document.querySelector('[data-test="wiki-figure"] img').getAttribute('src'),
  caption: document.querySelector('[data-test="wiki-figure"] figcaption').textContent.trim(),
  figures: document.querySelectorAll('article figure').length,
}))
await check('the panel shows the event the user landed on', () => eq(after.heading, 'Walls of Jericho', 'heading'))
await check('and its picture, not the abandoned one', () => {
  ok(after.src.includes('Jericho.jpg'), `src was ${after.src}`)
  ok(after.caption.includes('City in the West Bank'), `caption was ${after.caption}`)
  eq(after.figures, 1, 'figure count')
})
await check('the abandoned request was aborted in flight', () =>
  ok(
    failedRequests.some((u) => u.includes('G%C3%B6bekli_Tepe')),
    `no aborted request recorded; failures: ${JSON.stringify(failedRequests)}`,
  ),
)

/* ------------------------------------------------------------ 7. the cache */

console.log('\n7. the session cache serves a revisit without a second request')
const before = summaryRequests.length
await select('gobekli-tepe')
await settled()
await select('jericho')
await settled()
await select('gobekli-tepe')
await settled()
await check('revisiting costs at most one request per article', () => {
  const added = summaryRequests.slice(before)
  ok(added.length <= 2, `expected ≤2 further requests, got ${added.length}: ${JSON.stringify(added)}`)
})
await check('the picture survives the round trip', async () => eq(await wikiFigure.count(), 1, 'figure count'))

/* -------------------------------------------------------- 8. reduced motion */

console.log('\n8. reduced motion: the picture appears without a fade')
const rm = await context.newPage()
await rm.emulateMedia({ reducedMotion: 'reduce' })
await rm.goto(base + '?event=gobekli-tepe', { waitUntil: 'networkidle' })
await rm.locator('[data-test="wiki-figure"]').waitFor({ state: 'visible', timeout: 6000 })
await rm.waitForTimeout(300)
const rmState = await rm.evaluate(() => {
  const fig = document.querySelector('[data-test="wiki-figure"]')
  return { transition: getComputedStyle(fig).transitionDuration, opacity: getComputedStyle(fig).opacity }
})
await rm.screenshot({ path: join(shots, '06-reduced-motion.png') })
await check('no transition runs', () => eq(rmState.transition, '0s', 'transition duration'))
await check('and the picture is fully visible', () => eq(rmState.opacity, '1', 'opacity'))
await rm.close()

/* ------------------------------------------------------------------ wrap up */

await browser.close()
await server.close()

console.log(`\nscreenshots: ${shots}`)
console.log(`${passed} checks passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
