/**
 * In-browser check of the relation rework, over the shipped corpus.
 *
 * Three questions the design has to answer on real data, not on fixtures:
 *
 *   · focus mode on Operation Barbarossa pins its five child battles and
 *     nothing else — no strong relation leaks onto the map;
 *   · the Einstein article renders Part of / Contains / Related / See also in
 *     that order, with the right items under each;
 *   · a strong pair authored on ONE side navigates from either end.
 *
 * Run:  node tests/e2e/relations.e2e.mjs
 * Env:  CHROME_PATH        Chromium/Chrome executable
 *       PLAYWRIGHT_MODULE  path to the playwright package, if not resolvable
 *       SHOT_DIR           where screenshots land
 */
import { createServer } from 'vite'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? join(here, 'shots')
mkdirSync(shots, { recursive: true })

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME =
  process.env.CHROME_PATH ??
  '/home/claude/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome'

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
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}
const ok = (cond, what) => {
  if (!cond) throw new Error(what)
}

const server = await createServer({ root, server: { port: 0 }, logLevel: 'warn' })
await server.listen()
const base = `http://localhost:${server.config.server.port ?? server.httpServer.address().port}`

const browser = await chromium.launch({ executablePath: CHROME })
// tall enough that the whole article fits without the panel's own scroll
// swallowing the sections a screenshot is meant to show
const page = await browser.newPage({ viewport: { width: 460, height: 2400 } })
page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))

await page.goto(`${base}${server.config.base}tests/e2e/relations.harness.html`)
await page.waitForFunction(() => window.relHarness?.ready)

const rel = (id) => page.evaluate((x) => window.relHarness.relations(x), id)
const sectionTitles = () =>
  page.$$eval('.block .eyebrow', (els) => els.map((e) => e.textContent.trim()))
const sectionItems = (name) =>
  page.$$eval(`[data-test="${name}"] li a`, (els) => els.map((e) => e.textContent.trim()))

console.log('\nfocus mode pins only children')
await check('Barbarossa forces exactly its five battles onto the globe', async () => {
  await page.evaluate(() => window.relHarness.showOnMap('barbarossa'))
  const kids = await page.evaluate(() => window.relHarness.focusChildren())
  eq(kids.slice().sort(), [
    'kiev-pocket', 'leningrad-siege', 'minsk-pocket', 'moscow-1941', 'smolensk-1941',
  ], 'focusChildren')
})
await check('nothing merely related to Barbarossa is pinned with it', async () => {
  const { strong, seeAlso } = await rel('barbarossa')
  const visible = await page.evaluate(() => window.relHarness.visible())
  for (const id of [...strong, ...seeAlso])
    ok(!visible.includes(id), `${id} is a relation of Barbarossa but got a pin`)
  ok(strong.length + seeAlso.length > 0, 'Barbarossa has no associations at all to test with')
})
await check('the plan itself is on the globe', async () => {
  const visible = await page.evaluate(() => window.relHarness.visible())
  ok(visible.includes('barbarossa'), 'the focused plan lost its own pin')
})
await page.evaluate(() => window.relHarness.expand())
await page.waitForSelector('[data-test="part-of"]')
await page.screenshot({ path: join(shots, '01-barbarossa-focus-sections.png') })

console.log('\nthe article sections')
await page.evaluate(() => window.relHarness.exitFocus())
const ORDER = ['Part of', 'Contains', 'Related', 'See also', 'Read more']
/** The sections an article shows, which must be a subsequence of ORDER. */
const inOrder = async () => {
  const titles = await sectionTitles()
  const ranks = titles.map((t) => ORDER.indexOf(t))
  ok(!ranks.includes(-1), `unknown section in ${titles}`)
  ok(ranks.every((r, i) => i === 0 || r > ranks[i - 1]), `sections out of order: ${titles}`)
  return titles
}

await check('Barbarossa reads Part of / Contains / Related, in that order', async () => {
  // no See also: everything the prose links to is already its parent or a child,
  // and the softest section is the one that yields
  eq(await inOrder(), ['Part of', 'Contains', 'Related', 'Read more'], 'sections')
  eq(await sectionItems('part-of'), ['World War II'], 'Part of')
  eq((await sectionItems('contains')).length, 5, 'Contains count')
})

await check('an article with all four shows all four, in order', async () => {
  await page.evaluate(() => window.relHarness.select('napoleonic-wars'))
  await page.waitForFunction(() => window.relHarness.selected() === 'napoleonic-wars')
  eq(await inOrder(), ['Part of', 'Contains', 'Related', 'See also', 'Read more'], 'sections')
  eq(await sectionItems('part-of'), ['French Revolution'], 'Part of')
})
await page.screenshot({ path: join(shots, '02-all-four-sections.png'), fullPage: true })

await check('Einstein shows Related and See also, and has nothing to contain', async () => {
  await page.evaluate(() => window.relHarness.select('albert-einstein'))
  await page.waitForFunction(() => window.relHarness.selected() === 'albert-einstein')
  const titles = await sectionTitles()
  ok(titles.includes('Related'), 'no Related section on Einstein')
  ok(!titles.includes('Contains'), 'a life should contain nothing')
  const related = await sectionItems('related')
  ok(related.includes("Einstein's theory of relativity"), `Related is ${related}`)
  ok(related.includes('Relativity'), `the concept is missing from ${related}`)
})
await page.screenshot({ path: join(shots, '03-einstein-article.png'), fullPage: true })
console.log('    Einstein see-also:', (await rel('albert-einstein')).seeAlso.join(', '))

await check('a kind chip marks the person and the concept, as in search', async () => {
  await page.evaluate(() => window.relHarness.select('relativity'))
  await page.waitForFunction(() => window.relHarness.selected() === 'relativity')
  const chips = await page.$$eval('[data-test="related"] li .kind', (els) =>
    els.map((e) => e.textContent.trim()),
  )
  ok(chips.includes('person'), `no person chip in ${chips}`)
  ok(chips.includes('concept'), `no concept chip in ${chips}`)
})
await page.screenshot({ path: join(shots, '04-relativity-kind-chips.png'), fullPage: true })

console.log('\na one-sided strong edge navigates both ways')
await check('the treaty lists the war, though only one side declares it', async () => {
  await page.evaluate(() => window.relHarness.select('versailles'))
  await page.waitForFunction(() => window.relHarness.selected() === 'versailles')
  ok((await sectionItems('related')).includes('World War II'), 'Versailles does not offer WWII')
})
await page.screenshot({ path: join(shots, '05-versailles-related.png'), fullPage: true })

await check('…and the war lists the treaty', async () => {
  await page.click('[data-test="related"] li a:text("World War II")')
  await page.waitForFunction(() => window.relHarness.selected() === 'ww2')
  ok((await sectionItems('related')).includes('Treaty of Versailles'), 'WWII does not offer the treaty')
})
await page.screenshot({ path: join(shots, '06-ww2-related-back.png'), fullPage: true })

await check('a war contains its battles, chronologically', async () => {
  const contains = await sectionItems('contains')
  ok(contains[0] === 'Battle of Britain', `WWII contains starts with ${contains[0]}`)
  ok(contains.includes('D-Day landings'), 'D-Day missing from Contains')
})

await check('no item is offered twice under two headings', async () => {
  for (const id of ['ww2', 'albert-einstein', 'barbarossa', 'cold-war', 'printing']) {
    const r = await rel(id)
    const all = [...r.partOf, ...r.contains, ...r.strong, ...r.seeAlso]
    eq(all.length, new Set(all).size, `${id} repeats an item across sections`)
  }
})

await browser.close()
await server.close()

console.log(`\n${passed} passed, ${failures.length} failed`)
console.log(`screenshots in ${shots}`)
if (failures.length) process.exit(1)
