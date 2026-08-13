/**
 * In-browser check of the ARTICLE READER (components/WikiReader.vue), over the
 * real app and the real globe.
 *
 * WHY A STAND-IN ORIGIN RATHER THAN A LIVE FETCH. This sandbox has no route to
 * wikipedia.org — the outbound proxy answers a couple of rest_v1 routes from a
 * cache and refuses the rest — so the live endpoints CANNOT be exercised here,
 * and saying so is part of the result. What is exercised is everything on this
 * side of the wire: the two Wikimedia hosts are answered by a real HTTPS origin
 * on loopback, mapped in with Chromium's own host resolver (the technique in
 * tests/e2e/wikiImage.e2e.mjs, and for the same reason: Playwright's request
 * interception cannot reproduce a redirect and short-circuits the CORS machinery
 * this feature depends on). The fixtures it serves are representative captures:
 * Parsoid page HTML with the chrome that has to be cut (navbox, edit sections,
 * infobox coordinates, a reference list with its backlinks, a category strip and
 * a script that tries to rename the document), and a PCS mobile-html rendering
 * with its lazy-loaded images, for the fallback.
 *
 * What is checked, in order:
 *   1. the closer link in the article body opens the reader over the globe;
 *   2. it is OUR chrome — our serif, our colours, our sheet — and no Wikipedia
 *      chrome survived the adaptation;
 *   3. pictures load cross-origin from upload.wikimedia.org, scrolled into view;
 *   4. an internal wiki link navigates INSIDE the reader, and back comes back —
 *      to where the reader was on the page, not to the top of it;
 *   5. Escape and the scrim close it, and the panel behind is untouched;
 *   6. a modifier-click is still the browser's, not ours;
 *   7. a phone does NOT get the modal;
 *   8. when the first endpoint fails the chain falls to the next, in the browser;
 *   9. when every endpoint fails the reader apologises and offers the live link.
 *
 * Needs `openssl` on PATH once, to mint the loopback certificate.
 *
 * Run:  node tests/e2e/wikiReader.e2e.mjs
 * Env:  CHROME_PATH        Chromium/Chrome executable
 *       SHOT_DIR           where screenshots land (default /tmp/shots58/wiki)
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
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
const shots = process.env.SHOT_DIR ?? '/tmp/shots58/wiki'
mkdirSync(shots, { recursive: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

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

/* ------------------------------------------------------- the Wikimedia mock */

const ARTICLES = {
  Battle_of_Trafalgar: 'article-trafalgar.html',
  HMS_Victory: 'article-hms-victory.html',
}
/** Served only by mobile-html: the fallback article (rest-html 503s for it). */
const MOBILE_ONLY = { Napoleonic_Wars: 'article-napoleonic-wars.mobile.html' }
/** Every endpoint fails for this one — the apology path. */
const DEAD = new Set(['Battle_of_Austerlitz'])

const MOCK_PORT = 5444
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

/** Every article request the browser made, in order: `<endpoint> <title>`. */
let articleRequests = []
let preflights = []
const CORS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }

/** A summary, generated for whatever title the panel asks about. */
const summaryFor = (title) =>
  JSON.stringify({
    type: 'standard',
    title: title.replace(/_/g, ' '),
    titles: { canonical: title, normalized: title.replace(/_/g, ' ') },
    description: 'A stand-in summary, served by the e2e mock',
    thumbnail: {
      source: `https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/${title}.jpg/320px-${title}.jpg`,
      width: 320,
      height: 213,
    },
    originalimage: {
      source: `https://upload.wikimedia.org/wikipedia/commons/6/6c/${title}.jpg`,
      width: 2000,
      height: 1332,
    },
    content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${title}` } },
    extract: 'Stand-in extract.',
  })

const wikimedia = createHttps({ key: readFileSync(KEY), cert: readFileSync(CERT) }, (req, res) => {
  const host = (req.headers.host ?? '').split(':')[0]
  if (req.method === 'OPTIONS') {
    preflights.push(host + req.url)
    res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': '*' })
    return res.end()
  }

  if (host === 'upload.wikimedia.org') {
    const png = fixture('thumbnail.png')
    res.writeHead(200, { ...CORS, 'content-type': 'image/png', 'content-length': png.length })
    return res.end(png)
  }

  const url = req.url ?? ''
  const send = (status, type, body) => {
    res.writeHead(status, { ...CORS, 'content-type': type })
    res.end(body)
  }

  // 1. summaries — the panel's lead picture (lib/wikiImage.ts), not this feature
  let m = /^\/api\/rest_v1\/page\/summary\/(.+)$/.exec(url)
  if (m) return send(200, 'application/json', summaryFor(decodeURIComponent(m[1])))

  // 2. Parsoid page HTML — the reader's first choice
  m = /^\/api\/rest_v1\/page\/html\/(.+)$/.exec(url)
  if (m) {
    const title = decodeURIComponent(m[1])
    articleRequests.push(`rest-html ${title}`)
    if (ARTICLES[title]) return send(200, 'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/2.8.0"', fixture(ARTICLES[title]))
    // Everything else — the fallback article and the dead one — fails here.
    return send(503, 'text/html', 'service unavailable')
  }

  // 3. mobile-html — the second link of the chain
  m = /^\/api\/rest_v1\/page\/mobile-html\/(.+)$/.exec(url)
  if (m) {
    const title = decodeURIComponent(m[1])
    articleRequests.push(`mobile-html ${title}`)
    if (MOBILE_ONLY[title]) return send(200, 'text/html', fixture(MOBILE_ONLY[title]))
    return send(404, 'text/html', 'not found')
  }

  // 4. the action API — the last link
  if (url.startsWith('/w/api.php')) {
    const title = decodeURIComponent(/[?&]page=([^&]+)/.exec(url)?.[1] ?? '')
    articleRequests.push(`action-parse ${title}`)
    ok(url.includes('origin=*'), 'the action API request must carry a literal origin=*')
    if (DEAD.has(title)) return send(200, 'application/json', JSON.stringify({ error: { code: 'internal_api_error' } }))
    return send(500, 'application/json', '{}')
  }

  send(404, 'text/plain', 'no such route')
})
await new Promise((r) => wikimedia.listen(MOCK_PORT, '127.0.0.1', r))

/* ------------------------------------------------------------- the real app */

const server = await createServer({
  root,
  configFile: join(root, 'vite.config.ts'),
  server: { port: 5198, strictPort: true },
  logLevel: 'warn',
})
await server.listen()
const base = `http://localhost:${server.config.server.port}/history-web/`

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--no-sandbox',
    '--no-proxy-server',
    `--host-resolver-rules=MAP en.wikipedia.org 127.0.0.1:${MOCK_PORT},MAP upload.wikimedia.org 127.0.0.1:${MOCK_PORT}`,
  ],
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  ignoreHTTPSErrors: true,
})

const consoleErrors = []

/** Open the app, put the clock on the Napoleonic years, and wait for the globe. */
async function openApp(page) {
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  // Under swiftshader the document timeline crawls, so a 0.24s entrance is still
  // on its first frame seconds later and every screenshot of a panel comes back
  // transparent. Nothing here is about the animations.
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe, null, { timeout: 60000 })
  await page.evaluate(() => {
    window.__time.setRange({ start: -550, end: 2026 })
    window.__time.setSelection(1700, 1900)
  })
  await page.evaluate(() => window.__setTime(1805))
  await page.waitForFunction(() => window.__events.byId('trafalgar'), null, { timeout: 60000 })
  await page.waitForTimeout(1200)
  return page
}

const page = await context.newPage()
await openApp(page)

const reader = page.locator('[data-test="wiki-reader"]')
const closerLink = page.locator('article .body a[href*="wikipedia.org"]').last()
const select = async (id) => {
  await page.evaluate((v) => window.__events.select(v), id)
  await page.locator('article .body').waitFor({ state: 'visible', timeout: 10000 })
}

/* ------------------------------------------- 1. the closer link opens it */

console.log('\n1. "More at Wikipedia" opens the reader over the globe')
articleRequests = []
await select('trafalgar')
await closerLink.click()
await reader.waitFor({ state: 'visible', timeout: 15000 })
await page.locator('[data-test="wiki-reader-body"] .prose').waitFor({ state: 'visible', timeout: 15000 })
await page.waitForTimeout(500)
await page.screenshot({ path: join(shots, '01-reader-over-globe.png') })

await check('asked Parsoid page HTML first, and needed nothing else', () =>
  eq(articleRequests.join(' | '), 'rest-html Battle_of_Trafalgar', 'article requests'),
)
await check('never triggered a CORS pre-flight', () => eq(preflights.length, 0, 'pre-flights'))

const open = await page.evaluate(() => {
  const dialog = document.querySelector('[data-test="wiki-reader"]')
  const prose = document.querySelector('[data-test="wiki-reader-body"] .prose')
  const head = document.querySelector('[data-test="wiki-reader-title"]')
  const foot = document.querySelector('[data-test="wiki-reader-attribution"]')
  const box = dialog.getBoundingClientRect()
  return {
    title: head.textContent.trim(),
    proseFont: getComputedStyle(prose).fontFamily,
    proseColor: getComputedStyle(prose).color,
    headFont: getComputedStyle(head).fontFamily,
    footText: foot.textContent.replace(/\s+/g, ' ').trim(),
    footHrefs: [...foot.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    externalHref: document.querySelector('[data-test="wiki-reader-external"]').getAttribute('href'),
    role: dialog.getAttribute('role'),
    modal: dialog.getAttribute('aria-modal'),
    focusInside: dialog.contains(document.activeElement),
    box: { x: box.x, y: box.y, w: box.width, h: box.height },
    win: { w: innerWidth, h: innerHeight },
    // what the scrim is doing: the globe under the middle of the screen must
    // not be reachable by a pointer
    hitTopLeft: document.elementFromPoint(12, 12)?.getAttribute('data-test') ?? '',
    hitCentre: dialog.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2)),
    html: document.querySelector('[data-test="wiki-reader-body"]').innerHTML,
    docTitle: document.title,
    panel: {
      selected: window.__events.selectedId,
      minimised: window.__events.panelMinimised,
      heading: document.querySelector('article h2')?.textContent.trim(),
    },
  }
})

await check('names the article in the header', () => eq(open.title, 'Battle of Trafalgar', 'header title'))
await check('is centred and takes most of the screen', () => {
  ok(Math.abs(open.box.x + open.box.w / 2 - open.win.w / 2) < 2, `not horizontally centred: ${JSON.stringify(open.box)}`)
  ok(Math.abs(open.box.y + open.box.h / 2 - open.win.h / 2) < 2, 'not vertically centred')
  ok(open.box.h / open.win.h > 0.8, `height is ${(open.box.h / open.win.h).toFixed(2)} of the window`)
  ok(open.box.w >= 900 && open.box.w <= 920, `width is ${open.box.w}px, expected min(920px, 86vw)`)
})
await check('sets the article in the app’s serif, in the app’s ink', () => {
  ok(/IBM Plex Serif/.test(open.proseFont), `prose font is ${open.proseFont}`)
  eq(open.proseColor, 'rgb(219, 228, 241)', 'prose colour')
})
await check('and the chrome in the app’s sans', () => ok(/IBM Plex Sans/.test(open.headFont), `header font is ${open.headFont}`))
await check('is a modal dialog that took focus', () => {
  eq(open.role, 'dialog', 'role')
  eq(open.modal, 'true', 'aria-modal')
  eq(open.focusInside, true, 'focus is not inside the dialog')
})
await check('makes the globe inert: the scrim takes every pointer event', () => {
  eq(open.hitTopLeft, 'wiki-reader-scrim', 'what is under the top-left corner')
  eq(open.hitCentre, true, 'the centre of the screen is not the reader')
})
await check('carries the licence, with both links, as Settings does', () => {
  ok(/From Wikipedia — CC BY-SA 4\.0/.test(open.footText), `footer said ${JSON.stringify(open.footText)}`)
  ok(open.footHrefs.includes('https://en.wikipedia.org/wiki/Battle_of_Trafalgar'), 'no article link in the footer')
  ok(open.footHrefs.includes('https://creativecommons.org/licenses/by-sa/4.0/'), 'no licence link in the footer')
})
await check('offers the live page from its header', () =>
  eq(open.externalHref, 'https://en.wikipedia.org/wiki/Battle_of_Trafalgar', 'external link href'),
)
await check('leaves the panel behind it exactly as it was', () => {
  eq(open.panel.selected, 'trafalgar', 'selected event')
  eq(open.panel.minimised, false, 'panel minimised')
  eq(open.panel.heading, 'Battle of Trafalgar', 'panel heading')
})

/* -------------------------------------------------- 2. the adaptation held */

console.log('\n2. the article is ours: no Wikipedia chrome leaked')
await check('kept the prose, the headings, the list and the table', () => {
  for (const kept of ['Twenty-seven British ships', '<h2>Background</h2>', '<li>', '<table>', 'Ships of the line engaged'])
    ok(open.html.includes(kept), `missing ${kept}`)
})
await check('dropped every class, style and data attribute', () => {
  for (const gone of ['class="mw', 'class="infobox', 'style="', 'data-mw', 'typeof=', 'about=']) {
    // (the reader's own markup carries no classes inside the body either)
    ok(!open.html.includes(gone), `leaked ${gone}`)
  }
})
await check('dropped the navbox, the categories, the print footer and the edit links', () => {
  for (const gone of ['navbox', 'Waterloo', 'Categories', 'Retrieved from', 'action=edit', 'edit</a>'])
    ok(!open.html.includes(gone), `leaked ${gone}`)
})
await check('dropped the reference apparatus and its backlinks', () => {
  for (const gone of ['[1]', 'cite_note', 'cite_ref', 'Adkins, Roy']) ok(!open.html.includes(gone), `leaked ${gone}`)
})
await check('dropped the infobox coordinates — on a map app of all things', () => {
  for (const gone of ['36°15', '36.25°N', 'geo-dec']) ok(!open.html.includes(gone), `leaked ${gone}`)
})
await check('ran none of the article’s script', () => {
  ok(!open.html.includes('<script'), 'a script element survived')
  ok(open.docTitle !== 'HIJACKED', 'the fixture’s script ran and renamed the document')
})
await check('sends links out of the encyclopaedia to a new tab, safely', () => {
  ok(open.html.includes('href="https://www.rmg.co.uk/national-maritime-museum"'), 'the external link is gone')
  ok(open.html.includes('rel="noopener noreferrer"'), 'external links are not rel-protected')
})
await check('keeps wiki links inside the reader', () => ok(open.html.includes('data-wiki-title="HMS_Victory"'), 'no internal link marked'))

/* ------------------------------------------------- 3. pictures, scrolled to */

console.log('\n3. the pictures load cross-origin, in a scrolled section')
await page.evaluate(() => {
  const box = document.querySelector('[data-test="wiki-reader-body"]')
  box.scrollTop = box.scrollHeight * 0.45
})
await page.waitForTimeout(900)
await page.screenshot({ path: join(shots, '02-reader-scrolled-images.png') })
const pics = await page.evaluate(() => {
  const box = document.querySelector('[data-test="wiki-reader-body"]')
  return {
    scrolled: box.scrollTop > 0,
    imgs: [...box.querySelectorAll('img')].map((i) => ({
      src: i.getAttribute('src'),
      natural: i.naturalWidth,
      loading: i.getAttribute('loading'),
      rendered: Math.round(i.getBoundingClientRect().width),
    })),
    captions: [...box.querySelectorAll('figcaption')].map((f) => f.textContent.trim().slice(0, 40)),
  }
})
await check('the reader scrolls inside itself', () => eq(pics.scrolled, true, 'scrollTop'))
await check('every picture is an upload.wikimedia.org one, lazily loaded', () => {
  ok(pics.imgs.length >= 2, `expected 2 pictures, got ${pics.imgs.length}`)
  for (const i of pics.imgs) {
    ok(i.src.startsWith('https://upload.wikimedia.org/'), `unexpected src ${i.src}`)
    eq(i.loading, 'lazy', 'loading attribute')
  }
})
await check('and at least one of them actually decoded', () =>
  ok(pics.imgs.some((i) => i.natural > 0), `no picture loaded: ${JSON.stringify(pics.imgs)}`),
)
await check('captions survived as captions', () =>
  ok(pics.captions.some((c) => c.startsWith('J. M. W. Turner')), `captions: ${JSON.stringify(pics.captions)}`),
)

/* --------------------------------------- 4. internal navigation, and back */

console.log('\n4. an internal link navigates inside the reader, and back comes back')
// Bring the link the click will use into view FIRST, and read the offset after
// that: a click on a link above the fold scrolls the box to reach it, which is
// the reader's real position at the moment of the click and therefore the one
// the back control has to restore.
await page.evaluate(() => {
  const box = document.querySelector('[data-test="wiki-reader-body"]')
  const links = [...box.querySelectorAll('a[data-wiki-title="HMS_Victory"]')]
  links[links.length - 1].scrollIntoView({ block: 'center' })
})
await page.waitForTimeout(300)
const scrollBefore = await page.evaluate(() => document.querySelector('[data-test="wiki-reader-body"]').scrollTop)
articleRequests = []
await page.locator('[data-test="wiki-reader-body"] a[data-wiki-title="HMS_Victory"]').last().click()
await page.waitForFunction(
  () => document.querySelector('[data-test="wiki-reader-title"]').textContent.trim() === 'HMS Victory',
  null,
  { timeout: 15000 },
)
await page.waitForTimeout(400)
await page.screenshot({ path: join(shots, '03-reader-followed-link.png') })
const inner = await page.evaluate(() => ({
  title: document.querySelector('[data-test="wiki-reader-title"]').textContent.trim(),
  back: !!document.querySelector('[data-test="wiki-reader-back"]'),
  scroll: document.querySelector('[data-test="wiki-reader-body"]').scrollTop,
  external: document.querySelector('[data-test="wiki-reader-external"]').getAttribute('href'),
  html: document.querySelector('[data-test="wiki-reader-body"]').innerHTML,
  stillOpen: !!document.querySelector('[data-test="wiki-reader"]'),
  selected: window.__events.selectedId,
}))
await check('the reader is now on the linked article', () => {
  eq(inner.title, 'HMS Victory', 'header title')
  ok(inner.html.includes('oldest commissioned warship'), 'the linked article did not render')
  eq(inner.stillOpen, true, 'the reader closed instead of navigating')
})
await check('it fetched the new article, and only it', () => eq(articleRequests.join(' | '), 'rest-html HMS_Victory', 'article requests'))
await check('the header, the external link and the licence follow the page', () =>
  eq(inner.external, 'https://en.wikipedia.org/wiki/HMS_Victory', 'external link href'),
)
await check('a followed link starts at the top of the new article', () => eq(inner.scroll, 0, 'scrollTop'))
await check('a back control appeared', () => eq(inner.back, true, 'back control'))
await check('the app underneath did not navigate anywhere', () => eq(inner.selected, 'trafalgar', 'selected event'))

articleRequests = []
await page.locator('[data-test="wiki-reader-back"]').click()
await page.waitForFunction(
  () => document.querySelector('[data-test="wiki-reader-title"]').textContent.trim() === 'Battle of Trafalgar',
  null,
  { timeout: 15000 },
)
await page.waitForTimeout(2000) // the restore keeps trying while pictures land
const back = await page.evaluate(() => {
  const box = document.querySelector('[data-test="wiki-reader-body"]')
  return {
    title: document.querySelector('[data-test="wiki-reader-title"]').textContent.trim(),
    scroll: box.scrollTop,
    room: box.scrollHeight - box.clientHeight,
    back: !!document.querySelector('[data-test="wiki-reader-back"]'),
  }
})
await check('back returns to the article it came from', () => eq(back.title, 'Battle of Trafalgar', 'header title'))
await check('…without asking the network again — the session cache answers', () =>
  eq(articleRequests.length, 0, `requests on the way back: ${JSON.stringify(articleRequests)}`),
)
await check('…and lands where the reader was, not at the top', () =>
  ok(
    Math.abs(back.scroll - scrollBefore) < 40,
    `was at ${scrollBefore}, came back to ${back.scroll} (the page can scroll ${back.room})`,
  ),
)
await check('and the back control is gone at the bottom of the stack', () => eq(back.back, false, 'back control'))

/* ----------------------------------------------- 5. the keyboard, and close */

console.log('\n5. Tab stays inside, Escape closes, and the panel is untouched')
const trapped = await page.evaluate(async () => {
  const dialog = document.querySelector('[data-test="wiki-reader"]')
  const focusable = [...dialog.querySelectorAll('a[href], button')]
  focusable[focusable.length - 1]?.focus()
  return { count: focusable.length, insideAfterFocus: dialog.contains(document.activeElement) }
})
for (let i = 0; i < 4; i++) await page.keyboard.press('Tab')
const afterTabs = await page.evaluate(() =>
  document.querySelector('[data-test="wiki-reader"]').contains(document.activeElement),
)
await check('the dialog has its own focusable controls', () => ok(trapped.count >= 3, `only ${trapped.count} controls`))
await check('Tab never leaves the dialog', () => eq(afterTabs, true, 'focus escaped the dialog'))

const beforeClose = await page.evaluate(() => ({
  selected: window.__events.selectedId,
  minimised: window.__events.panelMinimised,
  focus: window.__events.focus?.itemId ?? null,
}))
await page.keyboard.press('Escape')
await reader.waitFor({ state: 'detached', timeout: 8000 })
const afterEscape = await page.evaluate(() => ({
  reader: document.querySelectorAll('[data-test="wiki-reader"]').length,
  selected: window.__events.selectedId,
  minimised: window.__events.panelMinimised,
  focus: window.__events.focus?.itemId ?? null,
  heading: document.querySelector('article h2')?.textContent.trim(),
  // the press must not have reached HomeView's own Escape ladder
  focusAfter: document.activeElement?.tagName,
}))
await check('Escape closes the reader', () => eq(afterEscape.reader, 0, 'readers on screen'))
await check('…and only the reader: the panel, the selection and the mode are as they were', () => {
  eq(afterEscape.selected, beforeClose.selected, 'selected event')
  eq(afterEscape.minimised, beforeClose.minimised, 'panel minimised')
  eq(afterEscape.focus, beforeClose.focus, 'focus mode')
  eq(afterEscape.heading, 'Battle of Trafalgar', 'panel heading')
})

// …and the scrim does the same job as the X.
await closerLink.click()
await reader.waitFor({ state: 'visible', timeout: 15000 })
await page.mouse.click(20, 20)
await reader.waitFor({ state: 'detached', timeout: 8000 })
await check('a click on the scrim closes it too', async () => eq(await reader.count(), 0, 'readers on screen'))
await check('and the article behind it is still open', async () =>
  eq(await page.locator('article .body').count(), 1, 'panel body'),
)

/* --------------------------------------------- 6. the browser's own gestures */

console.log('\n6. a modifier click still belongs to the browser')
await closerLink.click({ modifiers: ['Control'] })
await page.waitForTimeout(700)
await check('ctrl-click does not open the reader', async () => eq(await reader.count(), 0, 'readers on screen'))
const strip = page.locator('[data-test="read-more-link"]').first()
await check('the "Read more" strip carries a real Wikipedia href', async () =>
  ok((await strip.getAttribute('href')).includes('en.wikipedia.org/wiki/'), 'strip link href'),
)
await strip.click()
await reader.waitFor({ state: 'visible', timeout: 15000 })
await check('…and a plain click on it opens the reader', async () => eq(await reader.count(), 1, 'readers on screen'))
await page.keyboard.press('Escape')
await reader.waitFor({ state: 'detached', timeout: 8000 })

/* ------------------------------------------------ 7. the fallback, in a browser */

console.log('\n7. when Parsoid HTML fails, the chain falls to mobile-html')
articleRequests = []
await select('napoleonic-wars')
await page.locator('article .body a[href*="wikipedia.org"]').last().click()
await reader.waitFor({ state: 'visible', timeout: 15000 })
await page.locator('[data-test="wiki-reader-body"] .prose').waitFor({ state: 'visible', timeout: 15000 })
await page.waitForTimeout(600)
await page.screenshot({ path: join(shots, '04-reader-fallback-mobile-html.png') })
const fell = await page.evaluate(() => {
  const box = document.querySelector('[data-test="wiki-reader-body"]')
  return {
    html: box.innerHTML,
    imgs: [...box.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src'), natural: i.naturalWidth })),
    title: document.querySelector('[data-test="wiki-reader-title"]').textContent.trim(),
  }
})
await check('tried rest-html, then mobile-html, and stopped there', () =>
  eq(articleRequests.join(' | '), 'rest-html Napoleonic_Wars | mobile-html Napoleonic_Wars', 'article requests'),
)
await check('rendered the PCS article', () => {
  eq(fell.title, 'Napoleonic Wars', 'header title')
  ok(fell.html.includes('fluctuating array of European coalitions'), 'the article did not render')
})
await check('stripped PCS’s own chrome — edit pencils, footer container, class names', () => {
  for (const gone of ['pcs-', 'edit</a>', 'Read more on Wikipedia', 'action=edit'])
    ok(!fell.html.includes(gone), `leaked ${gone}`)
})
await check('promoted the lazy data-src placeholder to a real picture', () => {
  ok(fell.imgs.length >= 1, 'no picture at all')
  ok(fell.imgs[0].src.includes('Napoleon_at_Wagram'), `src was ${fell.imgs[0].src}`)
  ok(!fell.imgs[0].src.startsWith('data:'), 'the placeholder GIF is still the src')
  ok(fell.imgs[0].natural > 0, 'the picture did not decode')
})
await page.keyboard.press('Escape')
await reader.waitFor({ state: 'detached', timeout: 8000 })

/* -------------------------------------------------------- 8. the apology path */

console.log('\n8. when every endpoint fails, the reader apologises and links out')
articleRequests = []
await select('austerlitz')
await page.locator('article .body a[href*="wikipedia.org"]').last().click()
await page.locator('[data-test="wiki-reader-error"]').waitFor({ state: 'visible', timeout: 20000 })
await page.waitForTimeout(400)
await page.screenshot({ path: join(shots, '05-reader-failure.png') })
const dead = await page.evaluate(() => {
  const err = document.querySelector('[data-test="wiki-reader-error"]')
  return {
    text: err.textContent.replace(/\s+/g, ' ').trim(),
    href: err.querySelector('a').getAttribute('href'),
    target: err.querySelector('a').getAttribute('target'),
    open: !!document.querySelector('[data-test="wiki-reader"]'),
    foot: !!document.querySelector('[data-test="wiki-reader-attribution"]'),
  }
})
await check('every link of the chain was tried, in order', () =>
  eq(
    articleRequests.join(' | '),
    'rest-html Battle_of_Austerlitz | mobile-html Battle_of_Austerlitz | action-parse Battle_of_Austerlitz',
    'article requests',
  ),
)
await check('the reader stays up and says so in one sentence', () => {
  eq(dead.open, true, 'the reader vanished')
  ok(/could not be loaded/.test(dead.text), `apology said ${JSON.stringify(dead.text)}`)
})
await check('…and hands over the link that always works', () => {
  eq(dead.href, 'https://en.wikipedia.org/wiki/Battle_of_Austerlitz', 'external link href')
  eq(dead.target, '_blank', 'link target')
})
await check('the licence is still under it', () => eq(dead.foot, true, 'attribution footer'))
await page.keyboard.press('Escape')
await reader.waitFor({ state: 'detached', timeout: 8000 })

await check('nothing uncaught reached the console', () => {
  const real = consoleErrors.filter((e) => !/Failed to load resource|net::ERR|WebGL|SwiftShader/.test(e))
  eq(real.length, 0, `console errors: ${JSON.stringify(real)}`)
})

/* ------------------------------------------------------------- 9. the phone */

console.log('\n9. a phone gets the link it always had, not a cramped modal')
const phone = await context.newPage()
await phone.setViewportSize({ width: 390, height: 844 })
await openApp(phone)
await phone.evaluate(() => window.__events.select('trafalgar'))
await phone.locator('article .body').waitFor({ state: 'visible', timeout: 15000 })
await phone.screenshot({ path: join(shots, '06-phone-panel-before.png') })
const phoneLink = phone.locator('article .body a[href*="wikipedia.org"]').last()
const phoneHref = await phoneLink.getAttribute('href')
// target="_blank": the click opens a tab rather than navigating this one, and
// that tab is exactly what a phone should get.
const popup = context.waitForEvent('page', { timeout: 5000 }).catch(() => null)
await phoneLink.click()
await phone.waitForTimeout(900)
const opened = await popup
const onPhone = await phone.evaluate(() => ({
  reader: document.querySelectorAll('[data-test="wiki-reader"]').length,
  layer: document.querySelectorAll('[data-test="wiki-reader-layer"]').length,
  panel: !!document.querySelector('article .body'),
}))
await phone.screenshot({ path: join(shots, '07-phone-unchanged.png') })
await check('no modal, no scrim, nothing new on the phone', () => {
  eq(onPhone.reader, 0, 'readers on screen')
  eq(onPhone.layer, 0, 'reader layers on screen')
  eq(onPhone.panel, true, 'the panel is gone')
})
await check('the closer link is still a link to Wikipedia', () =>
  ok(phoneHref.includes('en.wikipedia.org/wiki/Battle_of_Trafalgar'), `href was ${phoneHref}`),
)
await check('and it went to the site', () => ok(!!opened, 'no new tab opened'))
await opened?.close()
await phone.close()

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
