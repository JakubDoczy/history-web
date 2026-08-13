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

/**
 * Wait for the CORPUS to stop growing.
 *
 * Round 57 moved the app's opening window to 1400–1789 (stores/time.ts), so a
 * harness that jumps straight to 1941 asks for a chunk the boot did not load:
 * the items land a beat later and the rail, the pins and the panel all re-render
 * under whatever this file was pressing at the time. That is the app working as
 * designed — chunks follow the window — and the harness's job is to let the
 * jump finish arriving before it starts driving. (Before round 57 the opening
 * window was the whole of history and everything was already in.)
 */
const corpusQuiet = async (page, still = 800, timeout = 20_000) => {
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
      // ROUND 58: landing on an entrance previews it instead of descending, so
      // "what did that press do" is now answered by the panel as well as by the
      // stack (sagas.md rule 15).
      preview: !!document.querySelector('[data-test="step-preview"]'),
      openEvent: !!document.querySelector('[data-test="open-event"]'),
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
await corpusQuiet(page) // the jump loads a chunk now; see above
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
  // ROUND 58: every step of the war is an entrance, and an entrance now opens
  // as a step of THIS saga with a preview of the child in the panel — the
  // focus, and therefore this rail, stay exactly where they were.
  eq(at.stack, ['ww2'], 'focus stack')
  ok(at.step === 'trinity', `the list opened ${at.step}`)
  ok(at.preview && at.openEvent, 'the row opened no preview')
  await page.evaluate(() => window.__events.selectStep())
  await settle(page, 1800)
})
await page.evaluate(() => document.querySelector('[data-test="saga-timeline"]').focus())
await page.click('[data-test="saga-next"]')
await page.click('[data-test="saga-next"]')
await settle(page, 900)
const walked = await railOf(page)
await shot(page, 'a2-next-twice', { x: 0, y: walked.rail.y - 4, width: 1280, height: walked.rail.h + 8 })
await check('next walks THROUGH the entrances, opening each as a preview', () => {
  // Round 58, defect 2. This used to assert that next moved a cursor and left
  // the store alone, which is precisely what made the press after it a silent
  // no-op: the rail's cursor and the store's step were two values and they
  // disagreed from the first entrance onward (tests/e2e/repro58.e2e.mjs).
  // There is one value now, and every press of next writes it.
  const on = walked.stations.filter((s) => s.cursor)
  ok(on.length === 1 && on[0].step === 'barbarossa', `cursor on ${on.map((s) => s.step)}`)
  ok(walked.step === 'barbarossa', `the store is on ${walked.step}, the rail on barbarossa`)
  eq(walked.stack, ['ww2'], 'a press of next descended')
  ok(walked.preview, 'walking onto an entrance opened no preview')
  ok(!walked.prevOn === false, 'prev is dead two steps in')
})
/* AND THE PRESS AFTER THAT MOVES — the defect itself, at the end of the walk
   it was reported on. Two more presses from the second station have to land on
   the fourth, not on the second for a third time. */
await page.click('[data-test="saga-next"]')
await page.click('[data-test="saga-next"]')
await settle(page, 900)
const walkedOn = await railOf(page)
await check('the presses after an entrance keep moving, one distinct step each', () => {
  const ids = walkedOn.stations.map((s) => s.step)
  ok(walkedOn.step === ids[3], `four presses of next reached ${walkedOn.step}, not ${ids[3]}`)
  eq(walkedOn.stack, ['ww2'], 'a press of next descended')
})
await page.click('[data-test="saga-prev"]')
await page.click('[data-test="saga-prev"]')
await settle(page, 900)
await page.click('[data-test="saga-prev"]')
await page.click('[data-test="saga-prev"]')
await settle(page, 900)
const home = await railOf(page)
await check('and prev comes back off the first step onto the overview, then stops', () => {
  ok(home.stations.every((s) => !s.cursor), 'the cursor is still on a station at the overview')
  ok(home.step === null, `still in step ${home.step}`)
  ok(!home.prevOn, 'prev is live at the beginning of the saga — it wrapped')
})

console.log('\n(b) a step of the war previewed, then opened for real')
await page.click('[data-step="stalingrad"] >> nth=0')
await settle(page, 2600)
const previewed = await railOf(page)
await shot(page, 'b-preview-stalingrad')
const previewText = await page.textContent('[data-test="step-preview"]')
console.log(`    preview: ${previewText?.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
await check('pressing an entrance station PREVIEWS the child, keeping the saga', () => {
  // ROUND 58. This press used to descend on sight: the war left the screen, the
  // rail re-anchored to Stalingrad's own span, and a reader who only wanted to
  // know what the step was had changed what the whole map was about to find out.
  eq(previewed.stack, ['ww2'], 'focus stack')
  ok(previewed.selected === 'ww2', `panel on ${previewed.selected}`)
  ok(previewed.step === 'stalingrad', `the rail is on ${previewed.step}`)
  ok(previewed.stations.length === 11, 'the parent’s rail went')
  ok(previewed.preview && previewed.openEvent, 'no preview, or no way in from it')
  // the child's own summary is what the preview reads, under the step's date
  ok(/1942/.test(previewText ?? ''), `the preview says no date: "${previewText}"`)
})
await page.click('[data-test="open-event"]')
await settle(page, 2600)
const dived = await railOf(page)
await shot(page, 'b-descended-stalingrad')
await check('"Open event" performs the descent the press used to perform on sight', () => {
  eq(dived.stack, ['ww2', 'stalingrad'], 'focus stack')
  ok(dived.selected === 'stalingrad', `panel on ${dived.selected}`)
  // …and Stalingrad carries no steps of its own, so the saga rail stands down
  // and the era rail comes back — which is the same thing it always did, and
  // the reason this descent is worth asking to be made rather than performing
  // on a press that only meant "what is this step".
  ok(!dived.rail && dived.era, 'the saga rail stayed up over an event with no steps')
})

console.log('\n(c) the deep case the report asks for: D-Day')
await page.evaluate(() => window.__events.focusBack())
await settle(page, 1800)
// Two presses since round 58: the station previews, the button descends.
await page.click('[data-step="d-day"] >> nth=0')
await settle(page, 1600)
await page.click('[data-test="open-event"]')
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
await check('D-Day is ruled in days, and every station’s date is reachable', async () => {
  ok(dday.ticks.length >= 4, `a dashed unruled axis: ${dday.ticks.length} tick(s)`)
  for (const t of dday.ticks) ok(/^\d+ [A-Z][a-z]{2}$/.test(t.label), `tick "${t.label}" is not a day`)
  ok(!dday.dashed, 'the axis is still drawn dashed, which means unruled')
  // Most of them say it where they stand. Round 51 took 44 px off the right of
  // the rail for the zoom cluster, and the last station's date was the one
  // label on this rail with three pixels of slack — so what is asserted is the
  // rule the layout actually states (`dated`, lib/present/sagaTimeline.ts): a
  // date is dropped only for want of room, and it is never LOST.
  const said = dday.stations.filter((s) => /\d{4}$/.test(s.label ?? ''))
  ok(said.length >= dday.stations.length - 1, `only ${said.length} of ${dday.stations.length} stations say their date`)
  for (const s of dday.stations) {
    if (/\d{4}$/.test(s.label ?? '')) continue
    // …and where it is dropped it comes back WHOLE the moment the reader asks
    // about that station, which is the promise `dated` makes
    await page.evaluate((id) => window.__events.selectStep(id), s.step)
    await settle(page, 900)
    const asked = (await railOf(page)).stations.find((x) => x.step === s.step)
    ok(/\d{4}$/.test(asked?.label ?? ''), `asked about, ${s.step} still reads "${asked?.label}"`)
    await page.evaluate(() => window.__events.selectStep())
    await settle(page, 900)
  }
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

console.log('\n(e) the keyboard walks the rail; Enter is still what descends')
await page.evaluate(() => document.querySelector('[data-test="saga-timeline"]').focus())
await page.keyboard.press('ArrowRight')
await page.keyboard.press('ArrowRight')
await settle(page, 900)
const keyed = await railOf(page)
await shot(page, 'e-keyboard-two-rights', { x: 0, y: keyed.rail.y - 4, width: 1280, height: keyed.rail.h + 8 })
await check('two ArrowRights open the second step, and change no context', () => {
  // ROUND 58: the arrows are prev/next, so they OPEN what they land on — which
  // for a step of the war is a preview of the child. What they still never do
  // is descend; that is Enter's, and rule 2's surviving half.
  const on = keyed.stations.filter((s) => s.cursor)
  ok(on.length === 1 && on[0].step === 'barbarossa', `cursor on ${on.map((s) => s.step)}`)
  ok(keyed.step === 'barbarossa', `the store is on ${keyed.step}`)
  ok(on[0].named || on[0].label, 'the cursor station does not say its name')
  eq(keyed.stack, ['ww2'], 'an arrow key descended')
  ok(keyed.preview, 'the arrow keys opened no preview on an entrance')
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
await corpusQuiet(phone)
await settle(phone, 2200)
await phone.evaluate(() => window.__events.showOnMap('ww2'))
await settle(phone, 2600)
const small = await railOf(phone)
await shot(phone, 'g-phone-rail')
console.log(
  `    rail ${small.rail.w}x${small.rail.h} at y=${small.rail.y}, track scrolls ${small.scrollW}>${small.clientW}`,
)
/* ROUND 46 CHANGED THIS CHECK, and it is the same claim by the opposite means.
   Until now a phone answered "eleven moments will not fit" by growing the rail
   past the element and SCROLLING it — a second system the desktop did not have,
   and a pan with none of a pan's other half. The rail is exactly as wide as its
   element now, on every screen, and what a phone does instead is ZOOM: one
   window, moved by wheel, pinch, drag and double-tap, with everything re-derived
   from it (docs/design/sagas.md, rule 7). So the assertion that the track
   overflows is gone and its opposite is here; the span is still stretched
   rather than bent, and the reader still reaches the end of the war. */
await check('the phone fits the whole span in its own width — no second system', () => {
  ok(small.stations.length === 11, `${small.stations.length} stations`)
  ok(small.scrollW <= small.clientW + 1, `the rail still scrolls (${small.scrollW} > ${small.clientW})`)
  ok(small.rail.h >= 108, `the phone's rail is ${small.rail.h}px tall, not the taller one`)
  // every mark inside the track, and every lane inside the rail
  for (const s of small.stations) {
    ok(s.lane <= 2, `${s.step} is in lane ${s.lane}`)
    ok(s.h >= 22 && s.w >= 22, `${s.step} is a ${s.w}x${s.h} target`)
  }
})
/* THE RULE A PHONE CAN READ A POSITION OFF (round 47).
   *"D-Day at fit showed a single tick; WWII showed 2 years."* `TICK_PX` is the
   room the ERA rail's 11.5px labels want, and this rail sets its ticks in 10px
   condensed — so a 390px rail divided three ways said almost nothing. There is
   a floor under the rule now (`MIN_TICKS`, lib/present/sagaTimeline.ts) and it
   may only refine as far as the labels themselves allow. Measured here rather
   than only in the unit tests because the thing under test is a claim about
   PIXELS, and the browser is what has them. */
await check('the fitted rule shows the war’s years, not two of six', () => {
  const labels = small.ticks.map((t) => t.label)
  ok(labels.length >= 5, `only ${labels.length} ticks at fit on a phone: ${labels.join(' ')}`)
  eq(labels, ['1940', '1941', '1942', '1943', '1944', '1945'], 'the fitted phone rule')
  // …and every one of them still has its own room: no two labels overlap
  const gaps = small.ticks.slice(1).map((t, i) => t.cx - small.ticks[i].cx)
  for (const g of gaps) ok(g > 40, `ticks ${g}px apart — closer than a label is wide`)
})
await shot(phone, 'b-ww2-fit-390', { x: 0, y: small.rail.y - 4, width: 390, height: small.rail.h + 8 })

/* …and the gesture that replaced the scroll, on the device that needed it.
   Two fingers, because that is what a phone has: the pinch is the era rail's
   own idiom (TimelineBar.vue) and lands in the same pure window math the unit
   tests cover (tests/sagaTimeline.test.ts). What only a browser can settle is
   that it is WIRED — that the rule refines and the marks move apart. */
let phoneHead
const winOf = () =>
  phone.evaluate(() => document.querySelector('[data-test="saga-timeline"] .track').dataset.window)
await check('a pinch on the rail zooms the window, and the rule refines with it', async () => {
  ok((await winOf()) === '0.0000,1.0000', `the rail did not open fitted: ${await winOf()}`)
  const box = await phone.evaluate(() => {
    const r = document.querySelector('[data-test="saga-timeline"] .track').getBoundingClientRect()
    return { x: r.x, y: r.y + r.height / 2, w: r.width }
  })
  // a pinch OUT (fingers apart) is a zoom IN, held at the point between them
  for (let i = 0; i < 6; i++) {
    await phone.evaluate(
      ([x, y, w, step]) => {
        const el = document.querySelector('[data-test="saga-timeline"] .track')
        const fire = (type, pts) =>
          pts.forEach((p, i) =>
            el.dispatchEvent(
              new PointerEvent(type, {
                pointerId: i + 1,
                clientX: p,
                clientY: y,
                bubbles: true,
                pointerType: 'touch',
              }),
            ),
          )
        const mid = x + w * 0.8
        fire('pointerdown', [mid - 40, mid + 40])
        fire('pointermove', [mid - 40 * step, mid + 40 * step])
        fire('pointerup', [mid - 40 * step, mid + 40 * step])
      },
      [box.x, box.y, box.w, 1.6],
    )
    await phone.waitForTimeout(60)
  }
  const [u0, u1] = (await winOf()).split(',').map(Number)
  ok(u1 - u0 < 0.35, `the pinch did not zoom: window is ${u1 - u0} of the span`)
  const zoomed = await railOf(phone)
  ok(
    zoomed.ticks.length > 1 && !/^\d{4}$/.test(zoomed.ticks[1].label),
    `the rule is still in years: ${zoomed.ticks.map((t) => t.label).join(' ')}`,
  )
  await shot(phone, 'g2-phone-pinched')
  // …and the cluster at the rail's right edge puts the whole saga back (round
  // 51: three controls, [−] [+] [fit], where one magnifier used to be)
  await phone.tap('[data-test="saga-zoom-fit"]')
  await phone.waitForFunction(
    () => document.querySelector('[data-test="saga-timeline"] .track').dataset.window === '0.0000,1.0000',
    null,
    { timeout: 15000 },
  )
})
/* ---------------------------------------------------------------- round 47
   THE PINCH, WITH REAL TOUCHES.

   The check above dispatches `PointerEvent`s at the element, which proves the
   arithmetic is wired and proves nothing about the browser: a constructed event
   is delivered wherever it is aimed, and `touch-action` — the property that
   decides whether a pinch is the page's or the rail's — is never consulted at
   all. So the rail passed that check while a real phone answered a pinch by
   magnifying the whole document.

   These drive `Input.dispatchTouchEvent` through CDP: real touch points, hit
   tested by the compositor, subject to touch-action like a thumb. What they
   found: the rail is 116px tall on a phone and the top 26 of them are the
   breadcrumb and the ‹/Steps/› row, and `touch-action: none` sat on the
   TRACK alone — so a pinch that caught the head row was the browser's, and it
   took the visual viewport from scale 1 to scale 5. The era rail has always
   carried the line on its root (TimelineBar.vue) and that is why it pinches. */
const cdpFor = async (target) => {
  let s = sessions.get(target)
  if (!s) sessions.set(target, (s = await target.context().newCDPSession(target)))
  return s
}
const touchOn = async (target, type, pts) =>
  (await cdpFor(target)).send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1, radiusX: 14, radiusY: 14, force: 1 })),
  })
/** Two fingers, moving apart, at the given heights. Returns the visual viewport
 *  scale afterwards — 1 means the browser did NOT take the gesture. */
async function realPinch(y1, y2, { steps = 8, by = 14 } = {}) {
  await (await cdpFor(phone)).send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
  const [x1, x2] = [120, 270]
  await touchOn(phone, 'touchStart', [{ x: x1, y: y1 }, { x: x2, y: y2 }])
  for (let i = 1; i <= steps; i++) {
    await touchOn(phone, 'touchMove', [{ x: x1 - i * by, y: y1 }, { x: x2 + i * by, y: y2 }])
    await phone.waitForTimeout(20)
  }
  await touchOn(phone, 'touchEnd', [])
  await phone.waitForTimeout(150)
  return phone.evaluate(() => visualViewport.scale)
}
const fitAgain = async () => {
  await (await cdpFor(phone)).send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
  await phone.evaluate(() => {
    const b = document.querySelector('[data-test="saga-zoom-fit"]')
    if (b && !b.disabled) b.click()
  })
  await phone.waitForTimeout(400)
}

await fitAgain()
await check('a REAL two-finger pinch on the track zooms the rail, not the page', async () => {
  const boxes = await phone.evaluate(() => {
    const nav = document.querySelector('[data-test="saga-timeline"]')
    const g = (e) => {
      const r = e.getBoundingClientRect()
      return { y: r.y, h: r.height }
    }
    return { track: g(nav.querySelector('.track')), head: g(nav.querySelector('.head')) }
  })
  const before = await winOf()
  const scale = await realPinch(boxes.track.y + boxes.track.h / 2, boxes.track.y + boxes.track.h / 2)
  const after = await winOf()
  ok(after !== before, `real touches did not move the window (${before} -> ${after})`)
  const [u0, u1] = after.split(',').map(Number)
  ok(u1 - u0 < 0.9, `the pinch barely zoomed: window is ${(u1 - u0).toFixed(3)} of the span`)
  ok(scale === 1, `the browser took the gesture and zoomed the page to ${scale}x`)
  phoneHead = boxes.head
})
await fitAgain()
await check('…and a pinch that lands on the rail’s HEAD never zooms the page', async () => {
  // THE DEFECT, AS A MEASUREMENT. Before `touch-action: none` moved to the
  // rail's root this returned 5: the reader's pinch magnified the document and
  // left them in a zoomed page with the rail untouched.
  const scale = await realPinch(phoneHead.y + phoneHead.h / 2, phoneHead.y + phoneHead.h / 2)
  ok(scale === 1, `a pinch on the breadcrumb row zoomed the page to ${scale}x`)
})
await fitAgain()
await check('the index still scrolls under the rail’s blanket touch-action', async () => {
  // `touch-action: none` on the root is what makes the pinch the rail's; the
  // two scrollers inside it have to have their own axis given back, or a
  // phone's flick through eleven steps does nothing at all.
  await phone.evaluate(() => document.querySelector('[data-test="saga-list-toggle"]').click())
  await phone.waitForSelector('[data-test="saga-list"]', { timeout: 10_000 })
  const axes = await phone.evaluate(() => {
    const nav = document.querySelector('[data-test="saga-timeline"]')
    const list = document.querySelector('[data-test="saga-list"]')
    return {
      rail: getComputedStyle(nav).touchAction,
      track: getComputedStyle(nav.querySelector('.track')).touchAction,
      crumbs: getComputedStyle(nav.querySelector('.crumbs')).touchAction,
      list: list && getComputedStyle(list).touchAction,
    }
  })
  eq(axes.rail, 'none', 'the rail root')
  eq(axes.track, 'none', 'the track')
  eq(axes.crumbs, 'pan-x', 'the breadcrumb scroller')
  eq(axes.list, 'pan-y', 'the step index')
  await phone.evaluate(() =>
    document.querySelector('[data-test="saga-list-toggle"]').click(),
  )
})
await fitAgain()

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
/* A TAP ON AN ENTRANCE, ON A PHONE (round 58). The tap previews, exactly as a
   press does on a desktop — and the phone is where the preview earns its keep
   twice over, because on a phone a descent replaces the whole screen. What is
   different here is only where the preview WAITS: the map wins on a phone
   (`stepOpensExpanded`), so the pill carries it and its own control opens it. */
await phone.tap('[data-step="d-day"] >> nth=0')
await settle(phone, 2200)
const tappedPreview = await phone.evaluate(() => ({
  stack: [...window.__events.focusStack],
  step: window.__events.stepId ?? null,
  pill: !!document.querySelector('[data-test="panel-pill"]'),
  preview: !!document.querySelector('[data-test="step-preview"]'),
  expand: document.querySelector('[data-test="pill-restore"]')?.textContent.trim() ?? null,
}))
await shot(phone, 'g-phone-preview-pill')
await check('a tap previews the entrance, with the map still in front on a phone', () => {
  eq(tappedPreview.stack, ['ww2'], 'focus stack')
  ok(tappedPreview.step === 'd-day', `the rail is on ${tappedPreview.step}`)
  ok(tappedPreview.pill, 'a phone opened the article over the map it was asked to show')
  ok(!tappedPreview.preview, 'the preview is up over the map rather than waiting on the pill')
})
await phone.tap('[data-test="pill-expand"]')
await settle(phone, 1400)
await shot(phone, 'g-phone-preview-open')
await check('the pill’s expand opens the PREVIEW, and its label says so', async () => {
  const up = await phone.evaluate(() => ({
    preview: !!document.querySelector('[data-test="step-preview"]'),
    open: !!document.querySelector('[data-test="open-event"]'),
  }))
  ok(up.preview && up.open, 'the pill opened something that was not the preview')
  // "Restore" was retired in round 58: it claimed to put back a window the
  // reader never put down. See `expandLabel` in EventPanel.vue.
  ok(/^open$/i.test(tappedPreview.expand ?? ''), `the pill's control reads "${tappedPreview.expand}"`)
})
await phone.tap('[data-test="open-event"]')
await settle(phone, 2600)
const tapped = await railOf(phone)
await shot(phone, 'g-phone-descended')
await check('and Open event descends, with the breadcrumb truncating rather than pushing the rail', () => {
  eq(tapped.stack, ['ww2', 'd-day'], 'focus stack')
  eq(tapped.crumbs, ['World War II', 'D-Day landings'], 'crumbs')
  ok(tapped.rail.w <= 390, `the rail is ${tapped.rail.w}px wide on a 390px phone`)
})
await shot(phone, 'a-dday-fit-390', { x: 0, y: tapped.rail.y - 4, width: 390, height: tapped.rail.h + 8 })
/* THE SHORTEST SAGA IN THE CORPUS, at the width that showed it worst. Seven
   weeks fitted on a 390px rail used to draw ONE tick — a lone "Jul", which is
   not a rule and cannot be read a position off. The floor takes it to a 10-day
   ladder rung, and every mark on it is a real date. */
await check('D-Day’s seven weeks are ruled in dated days on a phone, not one lonely month', () => {
  const labels = tapped.ticks.map((t) => t.label)
  ok(labels.length >= 5, `only ${labels.length} tick(s) at fit: ${labels.join(' ')}`)
  for (const l of labels) ok(/^\d+ [A-Z][a-z]{2}$/.test(l), `"${l}" is not a dated day tick`)
  const gaps = tapped.ticks.slice(1).map((t, i) => t.cx - tapped.ticks[i].cx)
  for (const g of gaps) ok(g > 55, `ticks ${g}px apart — closer than "17 Jun" is wide`)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  - ${f}`)
console.log(`shots in ${shots}`)
await browser.close()
await server.close()
process.exit(failures.length ? 1 : 0)
