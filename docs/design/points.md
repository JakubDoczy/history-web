# Points — named places as context (round 68)

The ask, verbatim: *"Create another thing - points. It's not events and the
limits do not apply and you only should show max 10 (limit changable in
options) but the points can be fortresses, geographical points (volcano),
cities and more and they have like important eras and for every major era,
they have different priority / they might not exist. Use custom icons for them
(so city has city icon and fortress has fortress icon)."*

## The contract

A **point** is a named place — a city, a fortress, a volcano, a mountain, a
strait, a site — drawn as a small ink mark under the event pins. It is *not*
an event and shares nothing with the event pipeline: no top-N event budget, no
clustering, no tag filters, no tiers. Its own rule is the era table it
carries.

### Data (`src/data/points.json`, shipped in-bundle)

```jsonc
{
  "id": "constantinople",
  "name": "Istanbul",                 // fallback name
  "kind": "city",                     // 'city'|'fortress'|'volcano'|'mountain'|'strait'|'site' — extensible
  "pos": [28.9784, 41.0082],          // [lng, lat], GeoJSON order
  "note": "one line for the chip",    // optional
  "eras": [
    { "from": -660, "to": 330,  "priority": 4, "name": "Byzantion" },
    { "from": 330,  "to": 1453, "priority": 1, "name": "Constantinople" },
    { "from": 1930,             "priority": 2, "name": "Istanbul" }
  ]
}
```

- A point **exists only inside its era entries**. Gaps are real: Samarkand has
  none from 1220 (Mongols) to 1370 (Timur); Masada ends at 73 and never comes
  back. Windows are half-open `[from, to)`; `to` omitted runs to the present.
  Years are astronomical (1 BCE = 0), like the rest of the app.
- `priority` is per era, 1 = top, 5 = merely exists. Vesuvius is priority 5
  forever except 79–120; Verdun is a background fort except 1914–1919.
- A per-era `name` is how renames are said (Byzantion → Constantinople →
  Istanbul, Tenochtitlan → Mexico City); absent, the point's name stands.
- Overlapping entries are authoring drift, not a feature; the resolver takes
  the best-priority match so drift degrades gracefully (`eraAt`).
- The file is parsed through a validator (`parsePoints`) that drops malformed
  entries, and `tests/points.test.ts` holds the shipped file to the schema.
- In-bundle rather than fetched: ~16 kB of source, two orders of magnitude
  under the smallest event chunk.

**Starter dataset: 52 points** — 22 cities, 10 fortresses, 4 volcanoes,
3 mountains, 4 straits, 9 sites — spread from Göbekli Tepe (-9500) to the
present, Easter Island to Kyoto. Entries are honest and sparse (name, kind,
eras, one-line note); the content agent expands later.

### Resolution (`src/lib/points.ts`, `resolvePointsAt`)

At year **Y** (the cursor, `time.currentTime` — *not* the selection band; a
point is *there* in the year the globe is drawn for, and the band can be
centuries wide):

1. candidates = points with an era containing Y;
2. sort by that era's priority, **ties broken by id** — a total order, so a
   scrub across a quiet century produces the identical array and nothing
   flickers;
3. show the top **N**.

N defaults to 10, is a slider in **Settings → Points** (0–25, step 1; 0 hides
the layer), lives in the settings store as `maxPoints` beside `maxEvents`, and
is clamped on the way into the slice (`clampShown`) so a bad write cannot
blow up. Like every setting in this app it does not persist across reloads —
by design.

### Rendering (`src/lib/pointsLayer.ts` + the delimited section in GlobeView)

- **CSS2D markers**, but *not* the globe's HTML layer (that belongs to the
  pins and their clustering): raw `CSS2DObject`s in a group of their own,
  rendered by the same CSS2DRenderer into the same `.globe-css2d` container
  the drawing labels use, so they live inside the same stacking context.
- **Always under the event pins.** CSS2DRenderer stamps a depth-sorted inline
  z-index on every element; the stylesheet forces `.map-point { z-index: 0
  !important }`, so a pin or a badge always paints over a point sharing its
  spot. A marker is also *centred* on its coordinate rather than tip-anchored,
  so it sits under a co-located pin's head instead of fighting it.
- **Icons per kind**, drawn as inline SVG line art in a 16×16 box (registry
  `POINT_ICONS` in lib/points.ts): city = circled dot, fortress = crenellated
  bastion, volcano = notched triangle, mountain = plain triangle, strait = two
  facing chevrons, site = lozenge. Unknown kinds fall back to the lozenge.
  Every path is stroked twice — casing under ink — the same halo idea as the
  map text; the ink is muted (`POINT_INK`), light on the photograph, the
  map's own pen on paper (map mode gets `map-point--flat`, no modelled light).
- **Labels** (the era-resolved name, small condensed map text) appear once the
  framed span is ≤ `POINT_LABEL_MAX_SPAN_DEG` (55° — about a continent in
  frame); at world view ten labels over the pins is clutter. A hovered point
  shows its label at any zoom, and the title tooltip carries name + kind.
- **Occlusion** is the layer's own: CSS2DRenderer culls the frustum but not
  the far side of the planet, so `sync(camera)` hides markers past the horizon
  ring (visible iff `n̂·ĉ > R/d`, with a small slack against limb flicker),
  wired to the controls' change event.
- **Clicking a point** opens the **point chip** (`components/PointChip.vue`),
  not the event panel: icon, era-resolved name, "Kind · from – to", the
  one-line note, a close button. It sits above the timeline rail. The chip
  resolves against the *visible* set, so scrubbing the year out of the
  point's era (or out of the top N) takes chip and marker down together.
  Clicking the same point again closes it.

### Store (`src/stores/points.ts`)

`visible` = `resolvePointsAt(POINTS, time.currentTime, settings.maxPoints)` —
recomputed per cursor/setting change, ~50 candidates, nothing. `selectedId` +
`selected` drive the chip. Dev hook: `window.__points` (DEV builds only).

## As-built notes / honest limits

- Points do not avoid event pins spatially; the z-rule and the size/anchor
  difference are the whole collision story. At default N=10 on a whole globe
  it reads fine; N=25 zoomed out can put a point under a busy cluster, where
  it is (correctly) painted under.
- Label overlap between two *points* is not resolved (no decluttering); the
  55° threshold and the ≤25 cap keep it rare. Hover always disambiguates.
- The set is driven by the cursor year alone. Scrubbing *within* one era
  changes nothing; crossing a boundary swaps markers with no transition
  animation.
- `priority` is 1–5 by convention (validated ≥1, integers); the resolver
  accepts any integer ≥1.
- Dataset years are conventional round numbers, deliberately not
  falsely precise; a handful of "always existed" naturals use -9999 (the
  Neolithic edge of the sub-age table) rather than deep time, except Lascaux
  (-15000), so deep-time frames are not littered with modern names.
