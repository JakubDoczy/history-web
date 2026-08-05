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

## 5. Step timeline replaces the main timeline (next round)

While an operation is shown on the map, the bottom timeline swaps to a
linear step timeline for that operation: steps as clickable stations in
order, current step highlighted, click-through advances the map drawing
and the window page. Era/main timeline returns on exit. This is a
structural change to TimelineBar/StepStrip interplay — design before
code: one component owning "which timeline is mounted", driven by the
focus store, no v-if soup.

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
