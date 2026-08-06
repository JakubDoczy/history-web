# UI polish round — plan of record

Six user-requested changes, in priority order. Items 1–4 are this round;
5–6 are outlined and scheduled next. Architect session owns this file.

## 1. Event window sizing

- **PC**: the open event window is too slim — widen it (target ~440–480 px
  at typical desktop widths; keep it proportional, not fixed).
- **Mobile**: the open event window should be taller — its top edge sits
  just below the top bar (HISTORY / search / settings), rather than the
  current lower start. Respect safe-area insets.

## 2. Minimised window prominence (PC)

The minimised event pill is easy to lose. Move it to bottom-centre (above
the timeline bar) and/or make it visually unmistakable as a minimised
window: it should read as "your event is parked here, click to restore".
Keep the mobile placement as-is unless it inherits the same benefit for
free.

## 3. Stack expansion geometry

Expanding a stacked-pin cluster currently flings children on parabolic
arcs from the centre ("fireworks"). Replace with simple straight leader
lines from the stack centre to each expanded pin — calm, legible,
no arc easing. Keep the relative-spread behaviour that was tuned earlier.

## 4. Operations: overview first, details discoverable

For steps-bearing period events ("operations" — wars, campaigns, other
long events): on PC the open window shows the overview page immediately
(no extra click), and the existence of per-step detail is visibly
advertised (affordance on the step strip / a "details" cue), instead of
being discoverable only by accident.

## 5. Step timeline replaces the main timeline — shipped, then corrected

While a saga is shown on the map the bottom timeline swaps to that saga's
own rail: its steps as stations, current step highlighted, click-through
advancing the map drawing and the window page. The era rail returns on
exit. One component owns "which timeline is mounted"
(components/BottomRail.vue), driven by the focus store.

**The correction (round 44).** The first cut relaxed every station's
target to a 44 px slab and clamped the mark into it. That inverted the
priority — legibility bought with the truth — and the reader said so:
*"it's not a proper timeline since I don't see time and it's spaced
uniformly, not according to when it happened."* The contract now:

- **A TRUE AXIS.** A station is drawn at its own moment in the saga's
  span and nowhere else; no relaxation, ever. Above the stations is a
  rule in the era rail's own idiom (gridline, stub, label beside it),
  ruled in the finest unit the span and the width allow — years for the
  war, months for a saga that ran a dated year, days below that. A
  point-dated saga (Barbarossa: 1941) has no extent to divide, so its
  axis is dashed and unruled and its stations stand in the proportion
  they were authored in.
- **CROWDING COSTS LANES, NOT POSITIONS.** A mark with no room beside its
  neighbour drops to the next lane down and keeps a stem back to the
  axis. Three lanes; past that the marks share one and overlap, which is
  an honest picture of four moments in eleven pixels.
- **A DUAL SYSTEM.** The rail is the picture; beside it, at the rail's
  edge, is the index: prev, next, and a list of every step by name and
  date (with the overview at the top of it). The arrow keys are the same
  action as prev/next. Both walk `[overview, …steps]` and stop at the
  ends rather than wrapping. A press opens a step that is a page of this
  saga; a step that is an ENTRANCE into another item is only moved to,
  and Enter or a click descends — walking into a child on an arrow key
  would take the rail off the screen.

## 5b. A saga's own call to action, and the map-first step (round 44)

- **"Show steps on map"** (EventPanel.vue) is the prominent action on a
  saga's article — filled brass, its own row, the step count on it —
  because *"show on map right now is also to just center on the
  location"* and a plan of eleven moments could not be told from a pin.
  The generic **Show on map** stays where it was, secondary, in the date
  line; a saga with an area keeps both. The pin's hover says
  "Saga · 11 steps" (`pinTitle`).
  The label was **"Walk the steps"** in rounds 44–46. It named the
  sequence and hid the place: the same imperative voice, but "walk"
  could as easily have meant walking through the article, and the one
  thing the button had to say was that eleven moments get DRAWN ON THE
  GLOBE. The new label is the generic one plus the word that makes it a
  saga's, which is exactly the relation between the two controls
  (round 47).
- **On a phone a step shows the MAP.** Selecting a step — by station, by
  list row or by prev/next — leaves the panel as the pill, names the step
  on it, and does not open the text sheet: the drawing is the point and
  the sheet was covering it. Desktop is unchanged. The rule is a variant
  of the existing viewport rule (`stepOpensExpanded` beside
  `opensExpanded`, stores/events.ts), not a new flag.

## 5c. Pin glyph metrics (round 44)

The crossed swords reached 6.4 units of the pin's 24×32 box, which is
past the saga ring's inner edge at 6.6 and near the head's rim: *"the
crossed swords icon is a bit too large inside the pin so you only see
parts of the swords."* The registry now holds glyph **geometry** rather
than path strings, so the ink a mark covers is measurable (`glyphReach`),
and every entry is authored inside one budget (`GLYPH_R`) that a unit
test enforces. Verified by close crop at 1x, not magnified.

## 5d. The four regressions the phone found (round 45)

Reported off a real device, all four reproduced before they were fixed
(tests/e2e/repro45.e2e.mjs, shots in /tmp/shots45).

- **The pill's restore control was broken on a phone.** `.pill-restore`
  keeps `display: flex` from the desktop rule, where it carries the word
  "Restore"; the phone rule hides the word and pins the button back to a
  38 px square, and a flex box ignores the `justify-items` half of
  `place-items`. The chevron sat flush against the left edge of its own
  brass ring with 22 px of empty frame beside it. It is centred now,
  stated in the base rule so no override can lose it again.
- **The rails had no dates on them.** Two causes, one symptom. The steps
  of all three sagas were authored as PROPORTIONS of the span, so D-Day
  stood between 1943 and 1944 on the war's rail, and Barbarossa and
  Normandy — both dated to a single year — had no rule at all: a dashed
  axis and four unlabelled marks *"at random"*. Every step in the corpus
  now carries its real date, the two campaigns carry their real spans
  (22 June – 5 December 1941; 6 June – 25 July 1944), and every station
  carries its own date beside its name. The month and day tick ladder
  from round 44 draws for the first time.
- **"Show on map" left the step.** `enterFocus` cleared `stepId`
  unconditionally, which is right for a new context and wrong for the one
  it is already in. See rule 6 in docs/design/sagas.md.

## 5e. The rail zooms, the rule refines, the icons stop being type (round 46)

Three reports off the same phone, and one of them for the second time.

- **The rail is zoomable, and the phone's horizontal scroll is gone.**
  *"The timeline of operations should be zoomable."* It has a visible
  window now, with the era rail's own gestures on it — wheel and pinch
  about the point under the cursor, drag to pan, double-tap for one step
  in — and everything the rail draws is re-derived from that window
  rather than scaled with it: positions, bands, lanes, label room and
  the rule. The 44px-per-station scrolling fallback a phone used to get
  is **deleted**: one system, on every screen. Clamped at the padded
  span going out and at ~three days going in (where the tick ladder
  stops refining); the window is the rail's own state and a descent
  opens fitted. Prev/next/list pan their target into view when it is
  outside the window. See docs/design/sagas.md rule 7.
  · e2e: `sagaRail.e2e.mjs` (g) — the assertion that the phone's track
  overflows is inverted, with the reasoning written where it was.

- **Ticks refine with the space.** *"The timeline, if it's short enough,
  should show months or even days — all based on how much space you have
  for ticks."* This is the round-44 ladder fed the VISIBLE span instead
  of the whole one, so the same war rules in years, its 1944 in months
  and D-Day's June in days with no mode and no threshold. Two defects
  fell out of being able to zoom far enough to see them: month ticks
  were spaced a uniform twelfth of a year (30.44 days) and so drifted
  off the calendar — "Jan 1944" twice, no February — and the head's span
  readout followed the live rule, so a war that began in 1939 read
  "1 Sep – 2 Sep 1945" when zoomed into June. Months are calendar months
  now; the saga's own dates are asked of the span (`spanUnit`), never of
  the window. Rule 8.

- **The phone's rail is taller, and the open step is on top.** `--rail`
  goes 84 → 116px on a phone *while a saga is up* — the token every
  clearance is derived from, so the pill, the mobile sheet and the scale
  bar all move with it — and the lanes take the pixels. In a pile-up the
  step the reader is on is drawn above every other lane's marks and
  labels, keeps its whole label, and is lifted with a dark ring and a
  shadow. Rule 9.

- **The chevron, third time: stop asking a layout where the middle is.**
  The pill's restore control was reported off-centre AGAIN, after round
  45 measured `dx = 0.00` at three widths and three pixel ratios. Both
  earlier fixes argued with the button's layout (`place-items`, then
  `justify-content`); what they never removed was the *dependence* on
  one. Icons are geometry now: a symmetric viewBox whose centre is the
  shape's centre, placed by translation off the container's centre, with
  `padding: 0` (the UA's own `1px 6px` was still live and left a 26px
  desktop button a 12px content box for a 14px glyph) and `font-size: 0`
  so no strut can exist. The text arrows next door (`←`, `▸`) — real
  font glyphs, resolved per device — are SVG paths now too. Verified by
  the rendered PATH's bounding box, and with the button's layout
  deliberately degraded to `display: block`. Rule 10; the rule itself is
  in styles/tokens.css.

## 5f. Which build is this, and is it still the one being served? (round 47)

*"I keep seeing the old build on my phone."* gh-pages was verifiably
serving the current bundle — the hash was checked — and the device was
verifiably showing symptoms one or two rounds old. Both were true.
GitHub Pages hands out `index.html` with a ten-minute `max-age`, a
mobile browser keeps its own copy well past that, and an SPA tab on a
home screen is never reloaded at all. The cost was not only a stale
screen: a reader reporting a fixed bug and a reader reporting a live one
wrote the same sentence, and nothing in the product could tell them
apart.

- **One identity, emitted twice.** `vite.config.ts` stamps the git short
  hash and an ISO build time INTO the bundle (`__BUILD_ID__` /
  `__BUILD_AT__`) and beside it into `dist/version.json`. The first
  cannot be stale — it is the same bytes as the code it describes. The
  second is 60 bytes, so it can be re-fetched cheaply. Both are also
  served in dev, so the mechanism is one code path in both modes.
- **The settings footer prints it** — "build a1b2c3d · 2026-08-06",
  selectable, quiet, at the foot of the panel. "Which build are you on?"
  is a thing to read out now, not a thing to deduce.
- **The toast asks; it never acts.** On load, on the tab becoming
  visible, and on a five-minute timer while it is visible, the app
  fetches `version.json?ts=<now>` with `cache: 'no-store'` (the query
  gets past every cache the header does not). Two stamps that DIFFER —
  not "are newer": a rollback is a deploy too — put up a small dark
  notice above the rail: "New version · Reload · ✕". It never reloads by
  itself, and once dismissed it does not come back for that build.
  Anything that is not a clean payload (a 404 that serves index.html, a
  captive portal, an outage) is not news and is answered with silence.
- **No service worker, no PWA machinery.** Those control what a browser
  caches; the problem here is one document and one long-lived tab, and a
  service worker would add a second, longer-lived cache with an update
  problem of its own — the shape of this bug, not its cure.
- **`deploy.sh` prints the stamp** it just published, read out of
  `dist/version.json` rather than recomputed, twice (top and bottom of
  the run) and with the exact footer string a device should be showing.
  A session log and a phone can now be compared.

## 5g. The rule a phone can read, and the pinch it can make (round 47)

- **The tick floor.** *"D-Day at fit showed a single tick; WWII showed 2
  years."* `TICK_PX = 110` is the room the ERA rail's 11.5px labels
  want; the saga rail sets its ticks in 10px condensed, where the widest
  label a rule can produce measures 53px. Two statements now: the calm
  rule (unchanged, and what a desktop lives on) and `MIN_TICKS = 5`, a
  floor that refines the spacing until a rule has divisions in it — as
  far as the labels themselves allow and no further (`tickRoom`,
  measured in the browser). A 390px phone goes from 1 tick to 5 on
  D-Day and from 2 to 6 on the war; a 1280px desktop is untouched.
  docs/design/sagas.md, rule 11.
- **The pinch that was the browser's.** `touch-action: none` sat on the
  saga rail's `.track` and not on its 26px header, so a pinch that
  caught the breadcrumb row zoomed the PAGE to 5x and left the rail
  alone. Found with real Touch events through CDP — the existing
  synthetic `PointerEvent` check could not have found it, because a
  constructed event is delivered where it is aimed and `touch-action` is
  never consulted. Fixed by mirroring the era rail's recipe (the line on
  the root), plus the two scrollers' axes given back, a WebKit
  `gesturestart` refusal, and pointer capture from the second finger.
  docs/design/sagas.md, rule 12.
- **"Show steps on map"** replaces "Walk the steps" — see 5b.

## 6. Map mode: first-class toggle + drawn cartography (next round)

- A visible side toggle (icon) switches globe/map rendering mode; no
  longer buried in settings. The experimental Map/RenderMode plumbing
  (present/ resolvers, `RenderMode = 'realistic' | 'schematic'`) is the
  extension point.
- The schematic mode should look like a *drawn* map — vintage
  hand-drawn atlas feel, not satellite, not overly modern. Direction to
  evaluate: shader-side treatment of existing data (paper-grain base,
  ink coastlines from the nations/coastline geometry, hypsometric tints
  or muted parchment palette, stippled ocean) versus sourcing a
  Natural Earth–derived vector layer. Constraints: offline-friendly
  (no third-party tile service), era-aware (paleo frames still work or
  degrade gracefully), and consistent with pins/drawings ink.
