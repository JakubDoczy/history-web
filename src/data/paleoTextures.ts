import type { TextureKeyframe } from '../lib/paleo'
import frames from './paleoFrames.json'

const base = import.meta.env.BASE_URL // app may be served from a sub-path (GitHub Pages)

// Base maps are bundled (public/textures/base) so first paint never depends on
// a third-party CDN; sharper sources may still upgrade them after load.
//
// WebP for the three colour maps. The app's floor is WebGL2 (the globe material
// is GLSL3 and will not compile without it), and every browser that has WebGL2
// has had a WebP decoder for longer — so there is no fallback to keep, and no
// <picture> dance to do. Measured against the JPEGs they replaced: the day map
// 1,462 kB → 778 kB at 40.3 dB PSNR, the night map 715 kB → 358 kB at 43.3 dB,
// and the starfield 904 kB → 146 kB *losslessly* (it is 165 unique colours of
// mostly-black, which is the case lossy WebP is worst at and lossless is best
// at — a q85 encode of it came out at 907 kB, larger than the PNG).
//
// NOTE: MODERN_TEXTURE is also preloaded by hand in index.html. Change one and
// change the other, or the preload silently fetches a file nothing uses.
export const MODERN_TEXTURE = `${base}textures/base/earth-blue-marble.webp`
export const NIGHT_TEXTURE = `${base}textures/base/earth-night.webp`
// The relief map stays a PNG: it is a height field, not a picture. The shader
// differences it into a normal, so quantisation error that is invisible in a
// colour map becomes visible terrain, and lossless WebP saved only 23%.
export const RELIEF_TEXTURE = `${base}textures/base/earth-topology.png`
export const SKY_TEXTURE = `${base}textures/base/night-sky.webp`

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

/**
 * The drawn world: the same 4096x2048 equirectangular grid, rendered at build
 * time from the same vector data and the same rasterizer the drawn tiles come
 * from (scripts/render-drawn-world.mjs). It is the pyramid's level 3 exactly —
 * 4096 px across 360 degrees is 512 * 2^3 — which is what keeps the shader's
 * sharp/blurred ratio self-consistent: a drawn tile's reduced tap and this
 * texture are the same drawing at the same density.
 */
export const DRAWN_TEXTURE = `${base}textures/map/drawn-world.webp`

/**
 * …and the era timeline it stands in.
 *
 * The SAME reconstruction ages, printed for paper: every deep-time frame has a
 * drawn twin (`pd*.webp`, rendered by the same script from the same DEMs in
 * the drawn map's own palette — see `render_drawn` in scripts/gen_paleo_v4.py),
 * and the modern frame is the drawn world itself. It used to be the
 * photographic frames re-graded by the shader's paper duotone (`uPaperMix`),
 * which collapsed sea and land into one khaki: a photograph's land is midtone
 * and its ocean is dark, so ink-by-luminance printed both within a few steps
 * of each other. The duotone still exists, but only as the paper FLOOR for a
 * frame held over from the other mode's timeline (see `applyPaper` in
 * lib/globeSurface.ts). Derived from the same frames.json rather than rebuilt,
 * so a change to the frame list cannot reach one mode and miss the other.
 */
export const DRAWN_FRAMES: TextureKeyframe[] = [
  ...frames.map((f) => ({ time: f.time, url: `${base}textures/paleo/${f.drawn}` })),
  { time: -10_000, url: DRAWN_TEXTURE },
]

/** The base-texture timeline a mode reads. See `GlobeStyle.base`. */
export const framesFor = (base: 'modern' | 'drawn'): TextureKeyframe[] =>
  base === 'drawn' ? DRAWN_FRAMES : PALEO_FRAMES
