/**
 * In-browser check of THE SAGA TIMELINE (docs/plan-ui-polish.md, item 5).
 *
 * While a saga is on the map the bottom rail is not a map of time any more: it
 * is that saga's span with its steps as stations. What only a browser can
 * settle, and what this walks:
 *
 *   · World War II focused on a desktop — eleven stations, all of them inside
 *     the rail, none of them narrower than a thumb, and no strip left over;
 *   · pressing an entrance station descends into the child, and the rail
 *     re-anchors to ITS span with a breadcrumb naming the stack;
 *   · pressing the ancestor crumb climbs back out — the ordinary ladder;
 *   · leaving the focus gives the era rail back, holding the year it held;
 *   · a phone gets the same rail with pressable stations;
 *   · and the arrow keys walk the stations without descending, which is what
 *     Enter is for.
 *
 * Run:  node tests/e2e/sagaRail.e2e.mjs
 * Env:  CHROME_PATH, SHOT_DIR, PLAYWRIGHT_MODULE (see saga.e2e.mjs)
 */
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const shots = process.env.SHOT_DIR ?? join(here, 'shots')
const tag = process.env.SHOT_TAG ?? 'saga-rail'
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

const sessions = new Map()
/** See steps.e2e.mjs: page.screenshot times out on a swiftshader globe. */
const shot = async (target, name, clip) => {
  let cdp = sessions.get(target)
  if (!cdp) sessions.set(target, (cdp = await target.context().newCDPSession(target)))
  await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 })
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  })
  writeFileSync(join(shots, `${tag}-${name}.png`), Buffer.from(data, 'base64'))
}

const settle = async (page, ms = 1500) => {
  await page.waitForTimeout(ms)
  await page
    .waitForFunction(
      () => document.querySelectorAll('.event-pin').length === window.__globe.htmlElementsData().length,
      null,
      { timeout: 15000 },
    )
    .catch(() => console.log('  [warn] pins never caught up with the data'))
}

const railOf = (page) =>
  page.evaluate(() => {
    const rail = document.querySelector('[data-test="saga-timeline"]')
    const box = rail?.getBoundingClientRect()
    const stations = [...document.querySelectorAll('[data-test="saga-station"]')].map((b) => {
      const r = b.getBoundingClientRect()
      const label = b.querySelector('.label')
      return {
        step: b.dataset.step,
        entrance: b.dataset.entrance !== undefined,
        on: b.classList.contains('on'),
        cursor: b.classList.contains('cursor'),
        named: b.classList.contains('named'),
        lane: Number(b.dataset.lane),
        // the CENTRE, which is the claim a station makes about when it happened
        cx: Math.round(r.x + r.width / 2),
        x: Math.round(r.x),
        w: Math.round(r.width),
        h: Math.round(r.height),
        label: label?.textContent.replace(/\s+/g, ' ').trim(),
      }
    })
    return {
      rail: box && { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
      era: !!document.querySelector('.rail:not(.saga)'),
      // an unruled axis, drawn dashed: the point-dated saga's rail
      dashed: !!document.querySelector('[data-test="saga-timeline"] .inner.dateless'),
      strip: !!document.querySelector('[data-test="step-strip"]'), // the retired chips
      crumbs: [...document.querySelectorAll('[data-test="saga-crumb"]')].map((c) => c.textContent.trim()),
      span: document.querySelector('[data-test="saga-span"]')?.textContent.trim() ?? null,
      scrollW: document.querySelector('[data-test="saga-timeline"] .track')?.scrollWidth ?? 0,
      clientW: document.querySelector('[data-test="saga-timeline"] .track')?.clientWidth ?? 0,
      // the rule: what a reader reads the dates off
      ticks: [...document.querySelectorAll('[data-test="saga-tick"]')].map((t) => ({
        label: t.textContent.trim(),
        cx: Math.round(t.getBoundingClientRect().x),
      })),
      list: [...document.querySelectorAll('[data-test="saga-list-item"]')].map((r) => ({
        step: r.dataset.step,
        text: r.textContent.replace(/\s+/g, ' ').trim(),
        on: r.classList.contains('on'),
      })),
      prevOn: !document.querySelector('[data-test="saga-prev"]')?.disabled,
      nextOn: !document.querySelector('[data-test="saga-next"]')?.disabled,
      stations,
      stack: [...window.__events.focusStack],
      step: window.__events.stepId ?? null,
      selected: window.__events.selectedId,
      year: window.__time.currentTime,
    }
  })

const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()))
await page.goto(base, { timeout: 90_000 })
await page.addStyleTag({
  content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
})
await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
await page.waitForFunction(() => window.__events.byId('ww2')?.steps)
await page.evaluate(() => window.__setTime(1941))
await settle(page, 2500)
const beforeYear = await page.evaluate(() => window.__time.currentTime)

console.log('\n(a) World War II focused — the rail is the saga’s')
await page.evaluate(() => window.__events.showOnMap('ww2'))
await settle(page, 2600)
const war = await railOf(page)
await shot(page, 'a-ww2-desktop')
await shot(page, 'a-ww2-rail-close', { x: 0, y: war.rail.y - 4, width: 1280, height: war.rail.h + 8 })
console.log(
  `    ${war.stations.length} stations, ${war.stations.filter((s) => s.named).length} named at rest, ` +
    `crumbs ${war.crumbs.join(' > ')}, ${war.span}`,
)
await check('the era rail is gone and the saga rail is in its place', () => {
  ok(!war.era, 'the era rail is still mounted')
  ok(war.rail, 'no saga rail')
  ok(!war.strip, 'the step strip is still there, duplicating the rail')
})
await check('all eleven steps are stations, in order, and none has overflowed', () => {
  ok(war.stations.length === 11, `${war.stations.length} stations`)
  ok(war.scrollW <= war.clientW + 1, `the rail scrolls on a desktop (${war.scrollW} > ${war.clientW})`)
  for (const s of war.stations) ok(s.x >= -1 && s.x + s.w <= 1281, `${s.step} runs ${s.x}..${s.x + s.w}`)
  const xs = war.stations.map((s) => s.cx)
  eq(xs, [...xs].sort((a, b) => a - b), 'stations out of time order')
})

/* THE DEFECT, AS A MEASUREMENT.
   The rail used to widen every station to a 44px slab, which spread the last
   four steps of the war — six months of it — across a quarter of the rail. They
   are where they happened now: the axis is ruled in years and the stations line
   up on it. */
await check('the rail is ruled in years, from the war’s own start to its own end', () => {
  // 1940..1945: the round years INSIDE 1 September 1939 – 2 September 1945,
  // which is what the war is dated to since round 45 gave its steps real dates
  eq(war.ticks.map((t) => t.label), ['1940', '1941', '1942', '1943', '1944', '1945'], 'ticks')
  const gaps = war.ticks.slice(1).map((t, i) => t.cx - war.ticks[i].cx)
  for (const g of gaps) ok(Math.abs(g - gaps[0]) <= 2, `uneven year ticks: ${gaps}`)
})
await check('the last four steps stand in the last months, not over a quarter of the rail', () => {
  const at = (id) => war.stations.find((s) => s.step === id).cx
  const tick = (y) => war.ticks.find((t) => t.label === y).cx
  const pile = ['ve-day', 'trinity', 'hiroshima', 'vj-day'].map(at)
  ok(pile[3] - pile[0] < 0.1 * war.rail.w, `the end of the war spans ${pile[3] - pile[0]}px`)
  // …and each one lands on its own DATE, which is the round-45 fix: VJ Day is
  // 15 August 1945, past the 1945 gridline, and D-Day is June 1944 rather than
  // the late 1943 the authored proportions used to put it at
  ok(at('vj-day') > tick('1945'), `VJ Day is ${at('vj-day')}, 1945 is ${tick('1945')}`)
  ok(at('d-day') > tick('1944') && at('d-day') < tick('1945'), `D-Day sits at ${at('d-day')}`)
  // eight months of 1945 is about an eighth of a year-ruled rail's year
  const year = tick('1945') - tick('1944')
  ok(Math.abs(at('vj-day') - tick('1945') - 0.62 * year) < 0.05 * year, 'VJ Day is not mid-August')
})
await check('a crowded mark drops to the next lane rather than moving off its date', () => {
  const lanes = war.stations.map((s) => s.lane)
  ok(Math.max(...lanes) >= 1, 'nothing hung below the axis on an eleven-step war')
  ok(Math.max(...lanes) <= 2, `${Math.max(...lanes) + 1} lanes — the rail is not that tall`)
  // …and the names that fit carry their dates: the round-45 report was "there
  // are no dates", and a rule two rows up is not an answer to "when is this one"
  const dated = war.stations.filter((s) => /\d{4}$/.test(s.label ?? ''))
  ok(dated.length >= 4, `only ${dated.length} stations of the war say when they are`)
  for (const lane of new Set(lanes)) {
    const row = war.stations.filter((s) => s.lane === lane).map((s) => s.cx)
    for (let i = 1; i < row.length; i++)
      ok(row[i] - row[i - 1] >= 19, `two marks ${row[i] - row[i - 1]}px apart in lane ${lane}`)
  }
})
await check('every station advertises the descent, since every step of the war is one', () => {
  ok(war.stations.every((s) => s.entrance), 'a station is not marked as an entrance')
  ok(war.crumbs.length === 1 && /World War II/.test(war.crumbs[0]), `crumbs: ${war.crumbs}`)
})

/* --------------------------------- the dual system's other half ---------- */
console.log('\n(a2) prev, next, and the list of every step')
await page.click('[data-test="saga-list-toggle"]')
await page.waitForSelector('[data-test="saga-list"]')
const listed = await railOf(page)
await shot(page, 'a2-step-list-open')
console.log(`    ${listed.list.length} rows: ${listed.list.slice(0, 3).map((r) => r.text).join(' | ')} …`)
await check('the list names the overview and every step, by name and by date', () => {
  eq(listed.list.map((r) => r.step), ['overview', ...listed.stations.map((s) => s.step)], 'rows')
  ok(listed.list[0].on, 'the overview is not marked as where the reader is')
  ok(/1939 – 1945/.test(listed.list[0].text), `overview row: "${listed.list[0].text}"`)
  // every row carries a date, at the resolution the axis is ruled in
  for (const r of listed.list.slice(1)) ok(/19\d\d/.test(r.text), `no date on "${r.text}"`)
})
await check('a row of the list reaches a station the rail packs into ten pixels', async () => {
  // Trinity is one of the four moments in the last 7% of the war: on the rail
  // its mark is a few pixels from its neighbours', and this is how it is opened
  await page.click('[data-test="saga-list-item"][data-step="trinity"]')
  await settle(page, 2400)
  const at = await railOf(page)
  eq(at.stack, ['ww2', 'trinity'], 'focus stack') // every step of the war is an entrance
  await page.evaluate(() => window.__events.focusBack())
  await settle(page, 1800)
})
await page.evaluate(() => document.querySelector('[data-test="saga-timeline"]').focus())
await page.click('[data-test="saga-next"]')
await page.click('[data-test="saga-next"]')
await settle(page, 900)
const walked = await railOf(page)
await shot(page, 'a2-next-twice', { x: 0, y: walked.rail.y - 4, width: 1280, height: walked.rail.h + 8 })
await check('next walks the stations without descending through the entrances', () => {
  const on = walked.stations.filter((s) => s.cursor)
  ok(on.length === 1 && on[0].step === 'barbarossa', `cursor on ${on.map((s) => s.step)}`)
  eq(walked.stack, ['ww2'], 'a press of next descended')
  ok(!walked.prevOn === false, 'prev is dead two steps in')
})
await page.click('[data-test="saga-prev"]')
await page.click('[data-test="saga-prev"]')
await settle(page, 900)
const home = await railOf(page)
await check('and prev comes back off the first step onto the overview, then stops', () => {
  ok(home.stations.every((s) => !s.cursor), 'the cursor is still on a station at the overview')
  ok(home.step === null, `still in step ${home.step}`)
  ok(!home.prevOn, 'prev is live at the beginning of the saga — it wrapped')
})

console.log('\n(b) a step of the war highlighted, then the descent')
await page.click('[data-step="stalingrad"] >> nth=0')
await settle(page, 2600)
const dived = await railOf(page)
await shot(page, 'b-descended-stalingrad')
await check('pressing an entrance station descends into the child', () => {
  eq(dived.stack, ['ww2', 'stalingrad'], 'focus stack')
  ok(dived.selected === 'stalingrad', `panel on ${dived.selected}`)
})

console.log('\n(c) the deep case the report asks for: D-Day')
await page.evaluate(() => window.__events.focusBack())
await settle(page, 1800)
await page.click('[data-step="d-day"] >> nth=0')
await settle(page, 2600)
const dday = await railOf(page)
await shot(page, 'c-d-day-rail')
await shot(page, 'c-d-day-rail-close', { x: 0, y: dday.rail.y - 4, width: 1280, height: dday.rail.h + 8 })
console.log(`    crumbs ${dday.crumbs.join(' ▸ ')}, stations ${dday.stations.map((s) => s.step).join(' ')}`)
await check('the rail re-anchors to the child’s own span and steps', () => {
  eq(dday.stations.map((s) => s.step), ['six-june', 'beachhead', 'cherbourg', 'breakout'], 'stations')
  ok(dday.stations.every((s) => !s.entrance), 'D-Day’s own steps read as entrances')
  // …all but the assault, which opens the day before the beachhead step and is
  // 22 px from it on a 1280 px rail: its name is on its tap, its hover and the
  // list, which is what the dual system is for
  ok(dday.stations.filter((s) => s.named).length >= 3, 'a four-station rail is hiding two names')
})
/* THE ROUND-45 DEFECT, as a measurement. Normandy was dated to the point 1944,
   so the rail drew a dashed unruled axis with its four stations standing in the
   proportion someone typed them in — "it looks random and without dates". The
   steps carry their real dates now (6 June to 25 July 1944) and the day ladder
   from round 44 finally has data to draw. */
await check('D-Day is ruled in days, and every station says its own date', () => {
  ok(dday.ticks.length >= 4, `a dashed unruled axis: ${dday.ticks.length} tick(s)`)
  for (const t of dday.ticks) ok(/^\d+ [A-Z][a-z]{2}$/.test(t.label), `tick "${t.label}" is not a day`)
  ok(!dday.dashed, 'the axis is still drawn dashed, which means unruled')
  for (const s of dday.stations)
    ok(/\d{4}$/.test(s.label ?? ''), `station ${s.step} reads "${s.label}" — no date`)
  // …and 6 June is the first thing on it, where the rule says June is
  const six = dday.stations.find((s) => s.step === 'six-june')
  ok(/6 Jun 1944/.test(six.label), `the assault reads "${six.label}"`)
})
await check('the breadcrumb names the stack', () => {
  eq(dday.crumbs, ['World War II', 'D-Day landings'], 'crumbs')
})

console.log('\n(d) a station selects its step; the crumb climbs back out')
await page.click('[data-step="cherbourg"] >> nth=0')
await settle(page, 1800)
const stepped = await railOf(page)
await shot(page, 'd-step-selected')
await check('a page station opens the step — the map, the page and the cursor', () => {
  ok(stepped.step === 'cherbourg', `step is ${stepped.step}`)
  ok(stepped.stations.find((s) => s.step === 'cherbourg').on, 'the open step is not highlighted')
  ok(stepped.crumbs.length === 2, 'the crumbs changed under a step')
})
await page.click('[data-crumb="ww2"]')
await settle(page, 2400)
const back = await railOf(page)
await shot(page, 'd-crumb-back-to-ww2')
await check('the ancestor crumb pops the focus back to it', () => {
  eq(back.stack, ['ww2'], 'focus stack')
  ok(back.step === null, `came back into step ${back.step}`)
  ok(back.stations.length === 11, `${back.stations.length} stations`)
  eq(back.crumbs, ['World War II'], 'crumbs')
})

console.log('\n(e) the keyboard walks the rail; Enter is what descends')
await page.evaluate(() => document.querySelector('[data-test="saga-timeline"]').focus())
await page.keyboard.press('ArrowRight')
await page.keyboard.press('ArrowRight')
await settle(page, 900)
const keyed = await railOf(page)
await shot(page, 'e-keyboard-two-rights', { x: 0, y: keyed.rail.y - 4, width: 1280, height: keyed.rail.h + 8 })
await check('two ArrowRights move the cursor and nothing else', () => {
  const on = keyed.stations.filter((s) => s.cursor)
  ok(on.length === 1 && on[0].step === 'barbarossa', `cursor on ${on.map((s) => s.step)}`)
  ok(on[0].named || on[0].label, 'the cursor station does not say its name')
  eq(keyed.stack, ['ww2'], 'an arrow key descended')
})
await page.keyboard.press('Enter')
await settle(page, 2600)
const entered = await railOf(page)
await shot(page, 'e-keyboard-enter-descends')
await check('Enter descends on an entrance', () => {
  eq(entered.stack, ['ww2', 'barbarossa'], 'focus stack')
})

console.log('\n(f) leaving: the era rail comes back holding the year it held')
await page.evaluate(() => {
  window.__events.focusBack()
  window.__events.focusBack()
  window.__events.close()
})
await settle(page, 2400)
const out = await railOf(page)
await shot(page, 'f-era-rail-restored')
await check('the era rail is back, with the timeline where the reader left it', () => {
  ok(out.era, 'no era rail after the focus ended')
  ok(!out.rail, 'the saga rail outlived the focus')
  // 1941, or a date inside it: walking a saga moves the CURSOR to the step's
  // own moment, and since round 45 that moment is 22 June 1941 rather than the
  // bare year. What must not have moved is the window (checked next).
  ok(Math.abs(out.year - beforeYear) < 1e-6 || Math.floor(out.year) === 1941,
    `the cursor moved to ${out.year}`)
})
await check('the selected year is inside the restored window', () =>
  page.evaluate(() => {
    const { selection, currentTime, range } = window.__time
    if (currentTime < range.start || currentTime > range.end) throw new Error('cursor outside the window')
    if (selection.start > selection.end) throw new Error('selection inverted')
    return true
  }),
)

/* ------------------------------------------------------------------- mobile */

console.log('\n(g) a phone: the same rail, still pressable')
// The desktop page goes first: two software-GL globes in one browser starve
// each other badly enough that the second page's `load` never fires (see
// steps.e2e.mjs, which learnt this the same way).
await page.close()
const phone = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})
await phone.goto(base, { timeout: 90_000 })
await phone.addStyleTag({
  content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
})
await phone.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
await phone.waitForFunction(() => window.__events.byId('ww2')?.steps)
await phone.evaluate(() => window.__setTime(1941))
await settle(phone, 2200)
await phone.evaluate(() => window.__events.showOnMap('ww2'))
await settle(phone, 2600)
const small = await railOf(phone)
await shot(phone, 'g-phone-rail')
console.log(
  `    rail ${small.rail.w}x${small.rail.h} at y=${small.rail.y}, track scrolls ${small.scrollW}>${small.clientW}`,
)
await check('the phone stretches the span rather than bending it', () => {
  ok(small.stations.length === 11, `${small.stations.length} stations`)
  ok(small.scrollW > small.clientW, 'eleven stations fitted a 390px phone without scrolling?')
  ok(small.rail.h >= 44, `the rail is ${small.rail.h}px tall`)
  // every mark inside the track, and every lane inside the rail
  for (const s of small.stations) {
    ok(s.lane <= 2, `${s.step} is in lane ${s.lane}`)
    ok(s.h >= 22 && s.w >= 22, `${s.step} is a ${s.w}x${s.h} target`)
  }
})
await check('and the plain way through is on the phone too: prev, the list, next', async () => {
  const nav = await phone.evaluate(() => ({
    prev: !!document.querySelector('[data-test="saga-prev"]'),
    next: !!document.querySelector('[data-test="saga-next"]'),
    list: !!document.querySelector('[data-test="saga-list-toggle"]'),
  }))
  ok(nav.prev && nav.next && nav.list, `nav cluster: ${JSON.stringify(nav)}`)
})
await check('the pill still clears the rail (the mobile sheet’s --bar-clear is untouched)', async () => {
  const gap = await phone.evaluate(() => {
    const pill = document.querySelector('[data-test="panel-pill"]')?.getBoundingClientRect()
    const rail = document.querySelector('[data-test="saga-timeline"]').getBoundingClientRect()
    return pill ? rail.top - pill.bottom : null
  })
  ok(gap === null || gap >= 0, `the pill overlaps the rail by ${-gap}px`)
})
await phone.tap('[data-step="d-day"] >> nth=0')
await settle(phone, 2600)
const tapped = await railOf(phone)
await shot(phone, 'g-phone-descended')
await check('a tap descends, and the breadcrumb truncates rather than pushing the rail', () => {
  eq(tapped.stack, ['ww2', 'd-day'], 'focus stack')
  eq(tapped.crumbs, ['World War II', 'D-Day landings'], 'crumbs')
  ok(tapped.rail.w <= 390, `the rail is ${tapped.rail.w}px wide on a 390px phone`)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  - ${f}`)
console.log(`shots in ${shots}`)
await browser.close()
await server.close()
process.exit(failures.length ? 1 : 0)
