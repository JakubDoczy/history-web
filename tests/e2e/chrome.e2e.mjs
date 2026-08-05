/**
 * In-browser check of the two pieces of CHROME that only a layout engine can
 * answer for: the top bar at phone widths, and the search box's keyboard.
 *
 * Both are regressions with a picture behind them:
 *
 *   · the era chip and the year stamp OVERLAPPED below ~360 px — 54 px of it at
 *     320, which reads as "CONTEMP[1990]RARY". `min-width: 0` let the left half
 *     of the bar shrink, but nothing inside it was told to give up width, so
 *     the chip kept its full size and was drawn straight through the year.
 *     The fix is a chip that ellipsises into whatever room is left, and a
 *     wordmark that stands aside on the narrowest phones (components/TopBar.vue).
 *   · the search RESULTS were reachable by mouse only: no roles, no arrow keys,
 *     and Enter hard-wired to the first row. They are now an
 *     `aria-activedescendant` listbox owned by the field (components/SearchBox.vue
 *     and the arithmetic in lib/listbox.ts).
 *
 * Run:  node tests/e2e/chrome.e2e.mjs
 * Env:  CHROME_PATH        Chromium/Chrome executable
 *       SHOT_DIR           where screenshots land
 *       SHOT_TAG           prefix on every file
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? join(here, 'shots')
const tag = process.env.SHOT_TAG ?? 'chrome'
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
const eq = (a, b, what) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

const server = await createServer({ root, server: { port: 0 }, logLevel: 'warn' })
await server.listen()
const base = `http://localhost:${server.httpServer.address().port}`

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
})

const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
await page.goto(base, { timeout: 90_000 })
await page.addStyleTag({
  content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
})
await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
await page.waitForTimeout(1500)

const sessions = new Map()
const shot = async (target, name) => {
  let cdp = sessions.get(target)
  if (!cdp) sessions.set(target, (cdp = await target.context().newCDPSession(target)))
  await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 })
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, `${tag}-${name}.png`), Buffer.from(data, 'base64'))
}

/* ============================================================== the top bar */

/** Where the bar's two competing pieces are, and whether either was clipped. */
const barOf = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        text: el.innerText.trim().replace(/\s+/g, ' '),
      }
    }
    const name = document.querySelector('.era-name.short')
    const shown = name && getComputedStyle(name).display !== 'none' ? name : null
    return {
      w: innerWidth,
      chip: box('.era'),
      stamp: box('.stamp'),
      // an ellipsis is a fine answer; an invisible one (0 px of text) is not
      nameWidth: shown ? Math.round(shown.getBoundingClientRect().width) : null,
      // the bar must also stay inside the window it is drawn in
      barRight: Math.round(document.querySelector('.bar').getBoundingClientRect().right),
    }
  })

/** The worst pairings there are: the longest era name, and the longest year. */
const states = [
  ['contemporary-1990', () => {
    window.__time.setRange({ start: -550, end: 2026 })
    window.__time.setSelection(1945, 2026)
    window.__time.setTime(1990)
  }],
  ['medieval-1941', () => {
    window.__time.setRange({ start: -550, end: 2026 })
    window.__time.setSelection(500, 1945)
    window.__time.setTime(1941)
  }],
  ['deep-time-4500Ma', () => window.__setTime(-4_500_000_000)],
]

/** The gap the two must keep. `--s3`, the bar's own flex gap. */
const MIN_GAP = 12

for (const width of [320, 360, 390, 414, 768]) {
  await page.setViewportSize({ width, height: 844 })
  for (const [name, apply] of states) {
    await page.evaluate(apply)
    await page.waitForTimeout(500)
    const bar = await barOf(page)
    await check(`${width}px / ${name}: the era chip clears the year stamp`, () => {
      ok(bar.chip && bar.stamp, 'the bar is missing a piece')
      ok(
        bar.stamp.left - bar.chip.right >= MIN_GAP,
        `chip ${bar.chip.left}..${bar.chip.right} "${bar.chip.text}" vs stamp at ${bar.stamp.left}: ` +
          `gap ${bar.stamp.left - bar.chip.right}px`,
      )
      ok(bar.barRight <= width, `the bar overflows the window by ${bar.barRight - width}px`)
      ok(bar.nameWidth === null || bar.nameWidth >= 40, `the era name is down to ${bar.nameWidth}px`)
    })
  }
  await shot(page, `topbar-${width}`)
}
await page.setViewportSize({ width: 390, height: 844 })

/* ============================================================ the search box */

/**
 * The panel is removed by a Vue <Transition>, which resolves on a frame — and
 * under swiftshader, with the globe's own loop in front of it, a frame can be
 * a second away. So "gone" is waited for, never assumed.
 */
const searchGone = () =>
  page.waitForSelector('input[type=search]', { state: 'detached', timeout: 20_000 })

/** Close the search if it is open, then open it fresh and ask a question.
 *  Fresh, because the highlighted row is state, and one check must not inherit
 *  where the last one left it. */
const openSearch = async (q) => {
  await page.evaluate(() => window.__events.dismiss())
  if (await page.$('input[type=search]')) {
    await page.click('[aria-label="Search events"]') // the button is a toggle
    await searchGone()
  }
  await page.click('[aria-label="Search events"]')
  await page.waitForSelector('input[type=search]')
  await page.fill('input[type=search]', q)
  await page.waitForTimeout(400)
}

/** What a screen reader and a keyboard can see of the results. */
const listOf = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll('#search-results [role="option"]')]
    const input = document.querySelector('input[type=search]')
    return {
      rows: rows.map((r) => ({
        id: r.id,
        name: r.querySelector('.name').textContent.trim(),
        selected: r.getAttribute('aria-selected') === 'true',
        marked: r.classList.contains('active'),
      })),
      listRole: document.querySelector('#search-results')?.getAttribute('role'),
      listName: document.querySelector('#search-results')?.getAttribute('aria-label'),
      role: input.getAttribute('role'),
      expanded: input.getAttribute('aria-expanded'),
      controls: input.getAttribute('aria-controls'),
      activeId: input.getAttribute('aria-activedescendant'),
      focused: document.activeElement === input,
      // nothing in the list is a tab stop: the field owns the listbox, so Tab
      // leaves the search rather than walking 40 results one press at a time
      tabbable: rows.filter((r) => r.tabIndex >= 0).length,
    }
  })

await openSearch('germ theory')
await shot(page, 'search-open')
await check('the results are a listbox the field owns and names', async () => {
  const l = await listOf(page)
  eq([l.listRole, l.role, l.controls], ['listbox', 'combobox', 'search-results'], 'roles')
  ok(l.listName, 'the listbox has no accessible name')
  ok(l.expanded === 'true', 'the field does not say the list is open')
  ok(l.rows.length >= 2, `only ${l.rows.length} rows`)
  ok(l.tabbable === 0, `${l.tabbable} rows are tab stops`)
  ok(l.focused, 'focus is not in the field')
  eq(l.activeId, l.rows[0].id, 'the first row is not the highlighted one')
  ok(l.rows[0].selected && l.rows[0].marked, 'the highlight is not marked')
})

await check('the arrows walk the list, and the field keeps the caret', async () => {
  await page.keyboard.press('ArrowDown')
  let l = await listOf(page)
  eq(l.activeId, l.rows[1].id, 'ArrowDown did not move the highlight')
  ok(l.rows[1].selected && !l.rows[0].selected, 'two rows are selected at once')
  ok(l.focused, 'ArrowDown took focus out of the field')

  await page.keyboard.press('ArrowUp')
  l = await listOf(page)
  eq(l.activeId, l.rows[0].id, 'ArrowUp did not come back')

  // and the ends wrap, so neither key ever goes dead
  await page.keyboard.press('ArrowUp')
  l = await listOf(page)
  eq(l.activeId, l.rows[l.rows.length - 1].id, 'ArrowUp off the top did not wrap')
})

await check('Enter opens the row the arrows left highlighted', async () => {
  await openSearch('germ theory')
  const l = await listOf(page)
  await page.keyboard.press('ArrowDown') // the CONCEPT, not the event
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  const picked = await page.evaluate(() => window.__events.selectedId)
  eq(picked, 'germ-theory-of-disease', `opened ${picked}`)
  ok(l.rows[1].name === 'Germ theory of disease', `the second row was "${l.rows[1].name}"`)
  await searchGone().catch(() => {
    throw new Error('the search stayed open over the article it opened')
  })
})

await check('a new query takes the highlight back to the best match', async () => {
  await openSearch('germ')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.type('input[type=search]', ' theory')
  await page.waitForTimeout(400)
  const l = await listOf(page)
  eq(l.activeId, l.rows[0].id, 'the highlight survived a query it does not belong to')
})

await check('Escape still closes, and the two germ-theory rows read apart', async () => {
  await openSearch('germ theory')
  const l = await listOf(page)
  const names = l.rows.map((r) => r.name)
  ok(new Set(names).size === names.length, `duplicate rows: ${names.join(' | ')}`)
  await page.keyboard.press('Escape')
  await searchGone().catch(() => {
    throw new Error('Escape did not close the search')
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  - ${f}`)
console.log(`shots in ${shots}`)

await browser.close()
await server.close()
process.exit(failures.length ? 1 : 0)
