# Brief: continuing history-web

Paste the block below into Claude Cowork (or Claude Code) to pick this project up.

---

I'm continuing an existing project: **https://github.com/JakubDoczy/history-web**
(live at https://jakubdoczy.github.io/history-web/). Read the repo first —
`README.md` for how to run and deploy, `docs/requirements.md` for what it's meant
to be, `docs/plan-clouds.md` for one sub-project's full history including what
failed and why.

**What it is.** A Vue 3 + TypeScript globe for exploring Earth's history. A
zoomable timeline spans 4.5 billion years to the present using an asinh scale
(linear near today, logarithmic in deep time). The globe surface is a single
custom shader handling paleogeographic era crossfades, day/night with
electrification-aware city lights, clouds with parallax and shadows, terrain
relief, and a streamed high-resolution imagery patch. Events are filtered by
priority, tag and parent hierarchy; nations are time-evolving polygons.

**Work in this order.**

1. **Verify what I cannot.** I built this without a browser, so rendering and
   network behaviour are unverified. Run it, look at it, and fix what is
   actually broken. Highest suspicion, roughly in order:
   - Streamed imagery from EOX Sentinel-2 (`src/lib/detailImagery.ts`) — does it
     load at all? Is the patch correctly placed? Does the colour matching
     (frequency separation against the base map) look right? Settings → Imagery
     reports the live source and metres-per-pixel; use it.
   - Cloud appearance. Three approaches were tried and two abandoned; the
     current one is a satellite mask composited in the surface shader.
   - Close zoom. A clamp was recently found that had silently pinned the minimum
     view at 570 km; confirm the 100 km / 300 km floors now really apply.
   - Mobile layout, especially the settings sheet and timeline gestures.

2. **Review the code.** Look for the same class of bug that dominated this
   project: geometry and lifecycle errors that type-check cleanly and fail
   silently at runtime — wrong axis order, wrong UV convention, stale state,
   duplicated shader declarations, effects that never re-run. Where you fix one,
   add the test that would have caught it.

3. **Improve it.** Reduce the bundle (currently ~2 MB, three.js dominates;
   code-splitting is untouched). Tighten the visual quality. Keep logic in
   `src/lib` as pure functions with tests; keep components thin.

**Conventions to honour.**
- Tests gate deploys — `scripts/deploy.sh` runs them and refuses to publish red.
- Never place an unverified data source ahead of a working one; load the
  reliable one first and upgrade only if the better one arrives.
- Comment the surprises, not the obvious.
- Never commit tokens. Deploy reads `GITHUB_TOKEN` from the environment.

**When to stop.** Once the verified bugs are fixed and the obvious improvements
are made, you will reach a point where the next step is a product decision
rather than an engineering one — because the real remaining gap is *content and
data*, not features: fifteen sample events, three hand-drawn nations, procedural
paleogeography. Do not invent a direction. Write your proposals to
`docs/proposals.md` — each with what it would take, what it would unlock, and
what it would cost — commit that file, and stop there.
