import type { TextureKeyframe } from '../lib/paleo'
import frames from './paleoFrames.json'

const base = import.meta.env.BASE_URL // app may be served from a sub-path (GitHub Pages)

// Base maps are bundled (public/textures/base) so first paint never depends on
// a third-party CDN; sharper sources may still upgrade them after load.
export const MODERN_TEXTURE = `${base}textures/base/earth-blue-marble.jpg`
export const NIGHT_TEXTURE = `${base}textures/base/earth-night.jpg`
export const RELIEF_TEXTURE = `${base}textures/base/earth-topology.png`
export const SKY_TEXTURE = `${base}textures/base/night-sky.png`

/**
 * Globe texture timeline: 38 frames rendered by scripts/gen_paleo_v4.py from the
 * PALEOMAP PaleoDEMs (Scotese & Wright 2018, CC BY 4.0), then the real modern
 * map pinned from ~10 ka so nothing morphs within the most recent 10,000 years.
 * Every frame time is one of the reconstruction's own ages — nothing here is
 * interpolated geography, only crossfaded between two real reconstructions.
 *
 * The last generated frame is the 0 Ma reconstruction, placed at 50 ka: it is
 * the same geography as the modern map in this project's palette, so the handover
 * to real imagery changes only the styling and never the coastline.
 */
export const PALEO_FRAMES: TextureKeyframe[] = [
  ...frames.map((f) => ({ time: f.time, url: `${base}textures/paleo/${f.file}` })),
  { time: -10_000, url: MODERN_TEXTURE },
]
