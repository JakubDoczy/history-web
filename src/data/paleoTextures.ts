import type { TextureKeyframe } from '../lib/paleo'

export const MODERN_TEXTURE = '//unpkg.com/three-globe/example/img/earth-blue-marble.jpg'

/**
 * Globe texture timeline. Placeholder era maps for now — to refine, replace the
 * files in public/textures/paleo/ (equirectangular) or add more keyframes here
 * (e.g. real PALEOMAP/Scotese rasters). The last keyframe at ~10 ka pins the
 * modern map: nothing morphs within the most recent 10,000 years.
 */
const base = import.meta.env.BASE_URL // app may be served from a sub-path (GitHub Pages)

export const PALEO_FRAMES: TextureKeyframe[] = [
  { time: -250e6, url: `${base}textures/paleo/250ma.jpg` },
  { time: -150e6, url: `${base}textures/paleo/150ma.jpg` },
  { time: -65e6, url: `${base}textures/paleo/65ma.jpg` },
  { time: -20e6, url: `${base}textures/paleo/20ma.jpg` },
  { time: -10_000, url: MODERN_TEXTURE },
]

export const NIGHT_TEXTURE = '//unpkg.com/three-globe/example/img/earth-night.jpg'
