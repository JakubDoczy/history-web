# History Web — User Requirements (First Pass)

Status: draft v0.1 · 2026-07-28

## 1. Vision

An interactive 3D Earth shown in space, letting the user travel through the planet's entire
history — from deep geological time (e.g. Pangaea) to the present. A zoomable timeline drives
what is displayed: continents drift, and as the user zooms into more recent and narrower time
ranges, human-history overlays (nations, borders) and events appear on the globe.

## 2. Core Concepts

### 2.1 Globe
- 3D Earth rendered in space; user can rotate, zoom, and pan.
- Surface appearance changes with the selected time (paleogeography for deep time,
  modern topography for recent history).

### 2.2 Timeline
- Single master timeline controlling globe state, overlays, and events.
- Continuously zoomable: from billions/hundreds of millions of years down to
  decades, years, possibly days for recent history.
- Level-of-detail principle: what is shown depends on both the zoom level and the
  current time position.

### 2.3 Overlays (nations & regions)
- Overlays appear only at appropriate time ranges (nations exist only in human history).
- An overlay evolves over time: its geometry is a function of time, not a static shape.
- Border representations per nation:
  - **Full borders** — exact borders at a given point in time.
  - **Max outline** — the greatest historical extent within the visible timeline window.
  - **Min outline** — the smallest extent within the visible window.
- Overlays may **overlap** (disputed territories, empires, simultaneous claims);
  rendering must handle overlap gracefully (transparency, hatching, z-order — TBD).

### 2.4 Events
- Target scale: **tens of thousands** of events.
- Each event has a **priority**; when too many events fit the current view,
  only the highest-priority ones are displayed (simple heuristic for now, bias is
  explicitly out of scope in this pass).
- Event location is either a **point** (e.g. a battle) or an **area** (e.g. a plague).
- Events are linked:
  - **Parent events** — hierarchy (e.g. "Battle of Stalingrad" → parent "WWII").
  - **Tags** — categories such as *science*, *war*, *politics*, *culture*, …
- **Filtering**: user can restrict the visible events to specific tags and/or
  descendants of a parent event; filters combine with the priority-based culling.

### 2.5 Event detail window
- Wikipedia-style rich content: formatted text, pictures, sections.
- Internal links between events (hyperlink-like navigation event → event) and
  external links (e.g. to Wikipedia).

## 3. Functional Requirements (summary)

| ID | Requirement |
|----|-------------|
| F1 | Render interactive 3D Earth in space |
| F2 | Earth surface reflects selected time (continental drift → modern) |
| F3 | Zoomable, pannable master timeline |
| F4 | Time-dependent nation overlays with full/max/min borders |
| F5 | Overlapping overlays rendered legibly |
| F6 | Display events as points or areas on the globe |
| F7 | Priority-based culling when events exceed display capacity |
| F8 | Event relations: parent hierarchy + tags |
| F9 | Filtering by tags and by parent event |
| F10 | Rich-text detail window with images and event-to-event links |

## 4. Non-Functional Requirements

- **Performance**: smooth interaction with tens of thousands of events in the dataset;
  spatial + temporal indexing and LOD culling are mandatory, not optional.
- **Data-driven**: events, overlays, and tags come from data files/API, not code.
- **Incremental**: the app must be useful with partial data (few events, few overlays).
- **Out of scope for now**: priority bias/fairness, editing UI, multi-user features.

## 5. Open Questions

1. Globe engine: CesiumJS (geo-native, heavy) vs three.js/globe.gl (lighter, more manual)?
2. Data formats: GeoJSON + custom temporal extension? Where do paleo-maps come from
   (e.g. GPlates reconstructions)?
3. Timeline scale: linear vs logarithmic vs hybrid for deep time?
4. Overlay data model: keyframed polygons with interpolation, or discrete snapshots?
5. Backend now or static files first?

## 6. Top-Level Plan

Phased, each phase produces something usable:

1. **Phase 0 — Skeleton** *(done)*: Vue 3 + TS project structure.
2. **Phase 1 — Globe + timeline shell**: render a modern Earth globe, add a basic
   zoomable timeline UI wired to app state. No data yet.
3. **Phase 2 — Event MVP**: define event data model (id, time, location point/area,
   priority, tags, parent), load from static JSON, display points on the globe,
   priority culling, simple detail window.
4. **Phase 3 — Filtering & relations**: tag/parent filtering UI, event-to-event links,
   rich-text detail content.
5. **Phase 4 — Overlays**: nation polygons with time evolution, full/max/min borders,
   overlap rendering.
6. **Phase 5 — Deep time**: paleogeographic globe textures/reconstructions,
   hybrid timeline scaling.
7. **Phase 6 — Scale**: indexing, tiling/streaming of event data toward the
   tens-of-thousands target; backend if needed.

Suggested next step: **Phase 1**, starting with the globe engine decision (open question 1).
