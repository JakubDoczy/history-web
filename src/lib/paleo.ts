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
