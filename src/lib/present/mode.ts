/**
 * PRESENTATION — the seam between what the app knows and what it draws.
 *
 * Everything under lib/present/ is a PURE function from domain values to a
 * *render spec*: a small data object describing what the renderer should put on
 * screen. Nothing here touches a DOM node, a WebGL context, a store or a clock.
 * The renderers (lib/eventPins.ts, lib/drawingLayer.ts, components/GlobeView.vue)
 * consume the specs; the domain (lib/events.ts, lib/steps.ts) never hears about
 * them.
 *
 * The rule that makes it worth having: **the domain says what a thing IS, this
 * says what it LOOKS LIKE, and only the second one is allowed to have opinions.**
 * Before this, a route event's glyph was decided inside the SVG string builder,
 * the day/night terminator was decided by reading `settings.clouds` from the
 * middle of a camera callback, and "which layers does this step show" was
 * decided in a store getter. Each was one small decision in a place no other
 * look could reach.
 *
 * `RenderMode` is what proves the seam is real. A second mode is not a theme —
 * a theme is colours — it is a different answer to "what should a globe of
 * history look like", and the test of the design is whether it can be added
 * without editing a single line of the domain. It can: `schematic` exists
 * entirely inside these four resolvers.
 */

/**
 * How the app draws itself.
 *
 *  · `realistic` — the shipped globe: satellite imagery, relief, a cloud deck,
 *    a day/night terminator, stars behind it.
 *  · `schematic` — MAP MODE, and deliberately minimal: no clouds, no relief, no
 *    night side, no stars, no streamed imagery, a flattened palette. A drawn map
 *    rather than a photograph of a planet. Experimental, and switched on from
 *    Settings → Display.
 *
 * Threaded through every resolver's context rather than read from a store, so
 * every one of them is a pure function of its arguments and a test can ask for
 * both answers side by side.
 */
export type RenderMode = 'realistic' | 'schematic'

export const DEFAULT_MODE: RenderMode = 'realistic'

/** What every resolver needs to know, and the least it could be. */
export interface RenderCtx {
  mode: RenderMode
}
