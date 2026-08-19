import type { Year } from './time'

export interface TextureKeyframe {
  time: Year
  url: string
  /**
   * The frame's coastline signed-distance field, when its timeline morphs.
   *
   * Only the DRAWN timeline carries one: map mode's transition between two
   * reconstructions is a thresholded mix of the two frames' SDFs — a single
   * coastline that moves — where a plain crossfade of two drawn plates is a
   * double exposure of two inked coastlines. The photographic timeline keeps
   * the crossfade (haze on a photograph reads as weather, not as a defect) and
   * simply has no `sdf`, which is also what switches the shader path off.
   */
  sdf?: string
}

/** Crossfade state: render `from`, overlay `to` at opacity `f` (0 → pure from). */
export interface TextureBlend {
  from: string
  to: string
  f: number
}

/**
 * Which two keyframes surround t, by index, and how far between them it sits.
 * Clamps to the first frame in deep past and holds the last frame from its
 * time onward — with the last frame at ~10 ka, the recent past never morphs.
 */
function span(frames: TextureKeyframe[], t: Year): { a: number; b: number; f: number } {
  const last = frames.length - 1
  if (t <= frames[0].time) return { a: 0, b: 0, f: 0 }
  if (t >= frames[last].time) return { a: last, b: last, f: 0 }
  // findIndex cannot fail on sorted frames; the clamp is for data that is not
  const i = Math.max(0, frames.findIndex((k, idx) => t >= k.time && t < frames[idx + 1].time))
  // A zero-length interval is reachable without anyone noticing: the frame list
  // is two lists concatenated (the generated ones, then the pinned modern map),
  // so a generator change can put two frames on the same year. Dividing by that
  // gap yields NaN, and mix() with a NaN factor renders the globe black.
  const dt = frames[i + 1].time - frames[i].time
  return { a: i, b: i + 1, f: dt > 0 ? (t - frames[i].time) / dt : 0 }
}

/** Crossfade state at t; see `span`. */
export function textureBlend(frames: TextureKeyframe[], t: Year): TextureBlend {
  const { a, b, f } = span(frames, t)
  return { from: frames[a].url, to: frames[b].url, f }
}

/**
 * How many keyframes either side of the blend pair stay resident.
 *
 * Every deep-time frame is a 4096x2048 sRGB texture — 32 MB on the GPU with its
 * mip chain, and there are 40 of them. Loading them and never letting one go
 * (which is what a plain URL cache does) reaches 336 MB after a scrub across a
 * couple of eras, on top of everything else the globe holds; the browser starts
 * evicting the whole context long before the user runs out of timeline.
 *
 * Two either side is the smallest window that still absorbs the two things
 * people actually do: nudging the cursor back and forth across a frame
 * boundary, and dragging the timeline a frame or two per event. Anything the
 * window drops costs one decode to get back, and `EraPlan.prefetch` is what
 * keeps a steady scrub ahead of that decode.
 */
export const ERA_WINDOW = 2

/**
 * What the surface should show, hold, and warm next.
 *
 * `keep` is a retention list, not a load list: the two frames being blended
 * plus `radius` on each side. `prefetch` is the one frame worth *starting* now
 * — the next one in the direction the cursor is moving — so that a steady
 * scrub crosses each boundary with the next map already decoded instead of
 * stalling on it.
 */
export interface EraPlan extends TextureBlend {
  /** URLs that must stay resident. Everything else may be disposed. */
  keep: string[]
  /** The next frame in the direction of travel, or null at either end. */
  prefetch: string | null
}

export function eraPlan(
  frames: TextureKeyframe[],
  t: Year,
  prevT?: Year,
  radius = ERA_WINDOW,
): EraPlan {
  const { a, b, f } = span(frames, t)
  const last = frames.length - 1
  const keep: string[] = []
  for (let i = Math.max(0, a - radius); i <= Math.min(last, b + radius); i++) {
    if (!keep.includes(frames[i].url)) keep.push(frames[i].url)
  }
  // Forward by default: an unknown direction is the first frame after load, and
  // the timeline's own home position is inside recorded history, so "toward the
  // present" is the better guess. A dead-still cursor keeps the last direction's
  // guess rather than dropping the lookahead, which costs one already-resident
  // frame's worth of nothing.
  const back = prevT !== undefined && t < prevT
  const next = back ? a - 1 : b + 1
  return {
    from: frames[a].url,
    to: frames[b].url,
    f,
    keep,
    prefetch: next >= 0 && next <= last ? frames[next].url : null,
  }
}

/**
 * How much of the *last* frame — the real modern basemap — the blend is showing.
 *
 * The globe's relief map is the modern height field, so lighting a Pangaean
 * coastline with it puts the Andes in the middle of Panthalassa. Deep-time
 * frames carry their own hillshade, baked from the reconstruction's own
 * elevations, and fade the shader's relief out by this factor instead.
 */
export function modernShare(frames: TextureKeyframe[], t: Year): number {
  const modern = frames[frames.length - 1].url
  const { from, to, f } = textureBlend(frames, t)
  return (from === modern ? 1 - f : 0) + (to === modern ? f : 0)
}

/** Credit for the deep-time frames; see scripts/gen_paleo_v4.py for the source. */
export const PALEO_CREDIT =
  'Paleogeography: PALEOMAP PaleoDEMs — Scotese & Wright (2018), CC BY 4.0'

export const MODERN_CREDIT = 'Imagery: NASA GIBS / Worldview'

/**
 * The imagery credit line: whatever the streamed layer requires while one is
 * shown, otherwise whichever basemap the globe is actually drawing.
 *
 * `modern` is a parameter because the last keyframe is not always a photograph.
 * Map mode runs the same frame list with the modern one swapped for the drawn
 * world (data/paleoTextures.ts), and crediting NASA for a map drawn on the
 * device from Natural Earth vectors would be wrong twice over — the deep-time
 * frames it shares with the photographic globe still credit PALEOMAP, because
 * those really are the same reconstructions, printed differently.
 */
export function imageryCredit(
  frames: TextureKeyframe[],
  t: Year,
  streamed: string,
  modern = MODERN_CREDIT,
): string {
  if (streamed) return streamed
  return modernShare(frames, t) < 1 ? PALEO_CREDIT : modern
}
