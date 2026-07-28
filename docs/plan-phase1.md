# Phase 1 Plan — Globe + Timeline Shell

Status: draft v0.1 · 2026-07-28
Decision: **three.js via globe.gl** (wraps three-globe; lighter than Cesium, good fit for
stylized "Earth in space", data layers via simple JS API).

## Goal

A running app with a rotatable Earth in space and a zoomable/pannable timeline.
Timeline and globe share one time state. No historical data yet — the deliverable is
the interaction shell everything else plugs into.

## 1. Architecture

```
src/
├── stores/time.ts          # Pinia: currentTime, visibleRange (single source of truth)
├── components/
│   ├── GlobeView.vue       # wraps globe.gl (imperative lib → one thin Vue wrapper)
│   └── TimelineBar.vue     # custom zoomable timeline (SVG or canvas)
├── views/HomeView.vue      # layout: globe fills screen, timeline docked at bottom
└── lib/time.ts             # time model helpers + formatting
```

Principles:
- globe.gl is imperative and owns its canvas — keep it isolated inside `GlobeView`;
  the rest of the app talks only to the Pinia store.
- Timeline is custom-built (no off-the-shelf widget handles 4.5 By → decades zoom).

## 2. Time Model

- Time = single `number`: **astronomical year** (2026 = 2026, 1 BCE = 0, deep time
  = large negatives, e.g. Pangaea ≈ -250_000_000). Fractions = sub-year precision.
- Store state: `currentTime` (cursor) + `visibleRange {start, end}` (timeline window).
- Formatting helper renders adaptively: `250 Ma`, `3000 BCE`, `1969`, `Jul 1969`.
- Zoom is multiplicative on the range (feels uniform whether spanning eons or years);
  hybrid/log display scale deferred to Phase 5.

## 3. Tasks

| # | Task | Notes |
|---|------|-------|
| 1.1 | Install deps: `globe.gl`, `three`, `pinia` | pin versions |
| 1.2 | `lib/time.ts` — time type, clamp, format | pure functions, unit-testable |
| 1.3 | `stores/time.ts` — Pinia store | actions: `setTime`, `zoom(factor, focus)`, `pan(delta)` |
| 1.4 | `GlobeView.vue` — globe.gl init/resize/dispose | night-sky background, modern Earth texture, auto-rotate until first interaction |
| 1.5 | `TimelineBar.vue` — render ticks + cursor | adaptive tick density from visibleRange |
| 1.6 | Timeline interactions | drag = pan, wheel/pinch = zoom at pointer, click = set currentTime |
| 1.7 | Layout in `HomeView` + time readout | globe 100%, timeline overlay bottom |
| 1.8 | Polish: resize handling, mobile touch check | |

## 4. Milestones

- **M1** (1.1–1.4): globe renders and rotates in the app.
- **M2** (1.5–1.6): timeline zooms from full Earth history down to a single year.
- **M3** (1.7–1.8): integrated shell; moving the cursor updates a visible time readout.

## 5. Explicitly Deferred

- Globe reacting to time (paleo textures) → Phase 5.
- Any events/overlays → Phases 2 & 4.
- Hybrid timeline scale for deep time → Phase 5 (linear window + multiplicative zoom is fine until then).
