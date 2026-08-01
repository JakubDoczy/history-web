/**
 * Integration check for the Wikipedia lead picture in EventPanel.
 *
 * This sandbox has no route to wikipedia.org, so `en.wikipedia.org` and
 * `upload.wikimedia.org` are answered by a real HTTPS origin on loopback,
 * mapped in with Chromium's host resolver — not by Playwright's request
 * interception, which cannot reproduce a redirect (it does not re-intercept
 * one) and short-circuits the CORS machinery this feature depends on.
 *
 * The stand-in answers the *live* contract rather than what the code happens to
 * expect — that distinction is the whole point, because the first version of
 * this feature passed a mock that answered 200 to every URL it was handed and
 * shipped broken:
 *
 *   · the summary endpoint 302s when the article link is a redirect
 *     (`Aqueduct_(Roman)` → `Roman aqueduct`), and the browser has to follow it;
 *   · an article can have no thumbnail at all (`HIV/AIDS`);
 *   · a thumbnail can be a PNG rendering of an SVG;
 *   · upload.wikimedia.org serves the 320 px rendering the summary names, and
 *     is entitled to 404 any other width we ask it to render;
 *   · and the transport can simply fail.
 *
 * Needs `openssl` on PATH once, to mint the loopback certificate.
 *
 * Run:  node tests/e2e/wikiImage.e2e.mjs
 * Env:  CHROME_PATH        Chromium/Chrome executable (defaults to the puppeteer cache)
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 *       SHOT_DIR           where screenshots land (defaults to tests/e2e/shots)
 */
import { createServer } from 'vite'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createServer as createHttps } from 'node:https'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? join(here, 'shots')
mkdirSync(shots, { recursive: true })

// Playwright is CommonJS; imported by file path Node cannot always detect its
// named exports, so fall back to the default (the whole module.exports object).
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
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
  Roman_aqueduct: 'summary-roman-aqueduct.json',
  'HIV%2FAIDS': 'summary-hiv-aids.json',
  United_Nations: 'summary-united-nations.json',
}
/** Article link → the title the endpoint redirects it to, as the live one does. */
const REDIRECTS = { 'Aqueduct_(Roman)': 'Roman_aqueduct' }
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

/* ------------------------------------------------------- the Wikimedia stand-in
 *
 * Playwright's `route.fulfill` cannot serve this alone: a redirect it fulfils is
 * *not* re-intercepted, and a redirect is the one thing that has to be exercised
 * here. So the two Wikimedia hosts are answered by a real HTTPS origin on
 * loopback, mapped in by Chromium's host resolver. Everything the browser does
 * with them is then genuinely its own: the CORS check, the pre-flight decision,
 * following the 302, refusing to follow it when the request was pre-flighted.
 */
const MOCK_PORT = 5443
const certDir = join(tmpdir(), 'history-web-e2e-tls')
const KEY = join(certDir, 'key.pem')
const CERT = join(certDir, 'cert.pem')
if (!existsSync(KEY) || !existsSync(CERT)) {
  mkdirSync(certDir, { recursive: true })
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', KEY, '-out', CERT,
    '-days', '3650', '-nodes', '-subj', '/CN=wikimedia.test',
    '-addext', 'subjectAltName=DNS:en.wikipedia.org,DNS:upload.wikimedia.org',
  ], { stdio: 'ignore' })
}

let summaryRequests = []
let failedRequests = []
let summaryDelayMs = 0
let imageRequests = []
let preflights = []
/**
 * The thumbnailer. `'any'` renders whatever width is asked for; `'only-320'` is
 * the pessimistic real world, where the one rendering the summary named exists
 * and every other width 404s.
 */
let thumbPolicy = 'any'

// `no-store` on everything: otherwise Chromium serves the second run of a URL —
// redirect included — out of its own cache, and a test that is about what goes
// over the wire stops seeing the wire.
const CORS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }

const wikimedia = createHttps({ key: readFileSync(KEY), cert: readFileSync(CERT) }, async (req, res) => {
  const host = (req.headers.host ?? '').split(':')[0]

  // A correct pre-flight answer, so that when a pre-flighted request fails it
  // can only be for the reason this test is about: the redirect behind it.
  if (req.method === 'OPTIONS') {
    preflights.push(host + req.url)
    res.writeHead(204, {
      ...CORS,
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '0',
    })
    return res.end()
  }

  if (host === 'upload.wikimedia.org') {
    imageRequests.push(`https://${host}${req.url}`)
    if (thumbPolicy === 'only-320' && !req.url.includes('/320px-')) {
      res.writeHead(404, { ...CORS, 'content-type': 'text/html' })
      return res.end('Error creating thumbnail: source too small')
    }
    const png = fixture('thumbnail.png')
    res.writeHead(200, { ...CORS, 'content-type': 'image/png', 'content-length': png.length })
    return res.end(png)
  }

  const match = /^\/api\/rest_v1\/page\/summary\/(.+)$/.exec(req.url)
  if (!match) {
    res.writeHead(404, CORS)
    return res.end('{}')
  }
  const title = match[1]
  summaryRequests.push(title)
  if (summaryDelayMs) await new Promise((r) => setTimeout(r, summaryDelayMs))
  if (req.destroyed || res.destroyed) return // the page moved on: test 6

  if (NETWORK_ERROR.has(title)) return req.destroy() // the transport gives up
  if (REDIRECTS[title]) {
    // 302, exactly as the live endpoint answers for a redirect article.
    res.writeHead(302, {
      ...CORS,
      location: `https://en.wikipedia.org/api/rest_v1/page/summary/${REDIRECTS[title]}`,
    })
    return res.end()
  }
  if (NOT_FOUND.has(title) || !SUMMARIES[title]) {
    res.writeHead(404, { ...CORS, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ type: 'not_found', title: 'Not found.' }))
  }
  const body = fixture(SUMMARIES[title])
  res.writeHead(200, {
    ...CORS,
    // the live profile parameter and all
    'content-type':
      'application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/Summary/1.5.0"',
    'content-length': body.length,
  })
  res.end(body)
})
await new Promise((r) => wikimedia.listen(MOCK_PORT, '127.0.0.1', r))

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--no-sandbox',
    // the sandbox exports a proxy; these two hosts must not go through it
    '--no-proxy-server',
    `--host-resolver-rules=MAP en.wikipedia.org 127.0.0.1:${MOCK_PORT},MAP upload.wikimedia.org 127.0.0.1:${MOCK_PORT}`,
  ],
})
const context = await browser.newContext({
  viewport: { width: 900, height: 900 },
  deviceScaleFactor: 1,
  ignoreHTTPSErrors: true, // the stand-in origin is self-signed
})

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
  imageRequests = []
  preflights = []
  thumbPolicy = 'any'
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
  ok(own.src.endsWith('own-image.png'), `image src was ${own.src}`)
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

/* --------------------------------------------------- 9. a redirect article */

console.log('\n9. the endpoint 302s a redirect article, and the picture still arrives')
await reset()
await select('redirected')
await settled()
await page.screenshot({ path: join(shots, '07-redirect-302.png') })
const red = await page.evaluate(() => {
  const fig = document.querySelector('[data-test="wiki-figure"]')
  return {
    src: fig.querySelector('img').getAttribute('src'),
    natural: fig.querySelector('img').naturalWidth,
    caption: fig.querySelector('figcaption').textContent.trim(),
    href: fig.querySelector('figcaption a').getAttribute('href'),
  }
})
await check('followed the redirect to the target article', () => {
  eq(summaryRequests.length, 2, 'summary requests')
  eq(summaryRequests[0], 'Aqueduct_(Roman)', 'first request')
  eq(summaryRequests[1], 'Roman_aqueduct', 'redirected request')
})
await check('renders the target article picture', () => {
  ok(red.src.includes('Pont_du_Gard'), `src was ${red.src}`)
  ok(red.natural > 0, 'the picture did not load')
})
await check('attributes to the article the redirect landed on', () =>
  eq(red.href, 'https://en.wikipedia.org/wiki/Roman_aqueduct', 'attribution href'),
)
await check('captions from the target summary', () =>
  ok(red.caption.includes('Water-supply structures'), `caption was ${red.caption}`),
)

/* ------------------------------------------------- 10. an article with none */

console.log('\n10. an article with no lead image renders no figure and no error')
await reset()
await select('no-picture')
await page.waitForTimeout(600)
await page.screenshot({ path: join(shots, '08-no-thumbnail.png') })
await check('asked, with the slash in the title encoded', () => {
  eq(summaryRequests.length, 1, 'summary requests')
  eq(summaryRequests[0], 'HIV%2FAIDS', 'requested title')
})
await check('renders no figure', async () => eq(await anyFigure.count(), 0, 'figure count'))
await check('asks upload.wikimedia.org for nothing', () => eq(imageRequests.length, 0, 'image requests'))
await check('still renders the article body', async () =>
  ok((await page.locator('article .body').innerText()).length > 10, 'body missing'),
)

/* ------------------------------------------------------ 11. an SVG lead image */

console.log('\n11. an SVG lead image renders through its PNG thumbnail')
await reset()
await select('svg-lead')
await settled()
await page.screenshot({ path: join(shots, '09-svg-thumbnail.png') })
const svg = await page.evaluate(() => {
  const img = document.querySelector('[data-test="wiki-figure"] img')
  return { src: img.getAttribute('src'), natural: img.naturalWidth }
})
await check('renders the PNG rendering, not the .svg file', () => {
  ok(svg.src.endsWith('.svg.png'), `src was ${svg.src}`)
  ok(svg.natural > 0, 'the picture did not load')
})
await check('never asks for more than the SVG declares', () => {
  const m = /\/(\d+)px-/.exec(svg.src)
  ok(m, `no NNNpx- segment in ${svg.src}`)
  ok(Number(m[1]) <= 1200, `asked for ${m[1]}px of a 1200px original`)
})

/* ------------------------------------- 12. the thumbnailer refuses our width */

console.log('\n12. a 404 on the re-rendered width falls back to the promised one')
await reset()
thumbPolicy = 'only-320'
// A fresh document: this article's wider rendering is already in the first
// page's memory cache, and a cached bitmap would never reach the thumbnailer.
const fallbackPage = await context.newPage()
await fallbackPage.goto(base + '?event=redirected', { waitUntil: 'networkidle' })
await fallbackPage.locator('[data-test="wiki-figure"]').waitFor({ state: 'visible', timeout: 8000 })
await fallbackPage.waitForTimeout(600)
await fallbackPage.screenshot({ path: join(shots, '10-thumb-404-fallback.png') })
const fell = await fallbackPage.evaluate(() => {
  const img = document.querySelector('[data-test="wiki-figure"] img')
  return { src: img.getAttribute('src'), natural: img.naturalWidth }
})
await check('tried the wider rendering first', () =>
  ok(
    imageRequests.some((u) => !u.includes('/320px-')),
    `image requests: ${JSON.stringify(imageRequests)}`,
  ),
)
await check('then used the width the summary actually promised', () => {
  ok(fell.src.includes('/320px-'), `src was ${fell.src}`)
  ok(fell.natural > 0, 'the picture did not load')
})
await check('the figure is on screen, not hidden by the failure', async () =>
  eq(await fallbackPage.locator('[data-test="wiki-figure"]').count(), 1, 'figure count'),
)
await fallbackPage.close()

/* ---------------------------------- 13. a network failure is not remembered */

console.log('\n13. a failed request is retried on the next open, not cached as "no picture"')
await reset()
await select('offline')
await page.waitForTimeout(500)
// Chromium re-tries an idempotent GET once when the connection is dropped, so
// what matters is that the *second open* produced traffic at all.
const firstTry = summaryRequests.filter((t) => t === 'Network_Failure_Page').length
await select('gobekli-tepe')
await settled()
await select('offline')
await page.waitForTimeout(500)
const afterSecond = summaryRequests.filter((t) => t === 'Network_Failure_Page').length
await check('the first attempt reached the network and failed', () => ok(firstTry >= 1, 'no request made'))
await check('and the second open asked again rather than replaying a cached "no"', () =>
  ok(afterSecond > firstTry, `asked ${firstTry} times, then ${afterSecond}`),
)

/* ------------------------------------- 14. why the request carries no headers */

console.log('\n14. the app never triggers a CORS pre-flight')
await reset()
await select('redirected')
await settled()
const appPreflights = preflights.length
await check('the app asks for a redirect article without a single OPTIONS', () =>
  eq(appPreflights, 0, 'pre-flights caused by the app'),
)

// What one request header would cost, measured rather than assumed. On this
// Chromium a pre-flighted request does follow the redirect — by pre-flighting
// again at the target: two extra round trips per article, on browsers new
// enough to have the fix at all. Wikimedia's own docs still warn that older
// ones fail the request outright.
await reset()
const cors = await page.evaluate(async () => {
  const url = 'https://en.wikipedia.org/api/rest_v1/page/summary/Aqueduct_(Roman)'
  const attempt = async (init) => {
    try {
      const r = await fetch(url, { mode: 'cors', credentials: 'omit', redirect: 'follow', ...init })
      return { status: r.status, url: r.url }
    } catch (e) {
      return { error: String(e) }
    }
  }
  const bare = await attempt({})
  const bareCost = 'measured below'
  const withHeader = await attempt({ headers: { 'api-user-agent': 'history-web' } })
  return { bare, bareCost, withHeader }
})
await check('a bare GET follows the 302 to the target article', () => {
  eq(cors.bare.status, 200, 'status')
  ok(cors.bare.url.endsWith('/Roman_aqueduct'), `landed on ${cors.bare.url}`)
})
await check('one custom header adds a pre-flight on both sides of the redirect', () =>
  ok(preflights.length >= 2, `expected ≥2 OPTIONS, saw ${preflights.length}: ${JSON.stringify(preflights)}`),
)

/* ------------------------------------------------------------------ wrap up */

await browser.close()
await server.close()
wikimedia.close()

console.log(`\nscreenshots: ${shots}`)
console.log(`${passed} checks passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
