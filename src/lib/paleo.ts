import type { Year } from './time'

export interface TextureKeyframe {
  time: Year
  url: string
}

/** Crossfade state: render `from`, overlay `to` at opacity `f` (0 → pure from). */
export interface TextureBlend {
  from: string
  to: string
  f: number
}

/**
 * Blend between the two texture keyframes surrounding t.
 * Clamps to the first frame in deep past and holds the last frame from its
 * time onward — with the last frame at ~10 ka, the recent past never morphs.
 */
export function textureBlend(frames: TextureKeyframe[], t: Year): TextureBlend {
  const first = frames[0]
  const last = frames[frames.length - 1]
  if (t <= first.time) return { from: first.url, to: first.url, f: 0 }
  if (t >= last.time) return { from: last.url, to: last.url, f: 0 }
  const i = frames.findIndex((k, idx) => t >= k.time && t < frames[idx + 1].time)
  const a = frames[i]
  const b = frames[i + 1]
  // A zero-length interval is reachable without anyone noticing: the frame list
  // is two lists concatenated (the generated ones, then the pinned modern map),
  // so a generator change can put two frames on the same year. Dividing by that
  // gap yields NaN, and mix() with a NaN factor renders the globe black.
  const dt = b.time - a.time
  return { from: a.url, to: b.url, f: dt > 0 ? (t - a.time) / dt : 0 }
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

const MODERN_CREDIT = 'Imagery: NASA GIBS / Worldview'

/**
 * The imagery credit line: whatever the streamed layer requires while one is
 * shown, otherwise whichever basemap the globe is actually drawing.
 */
export function imageryCredit(frames: TextureKeyframe[], t: Year, streamed: string): string {
  if (streamed) return streamed
  return modernShare(frames, t) < 1 ? PALEO_CREDIT : MODERN_CREDIT
}
