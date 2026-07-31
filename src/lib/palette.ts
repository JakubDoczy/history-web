import type { VisualStyle } from '../stores/settings'

/**
 * The globe's colour grade: three controls the viewer can move.
 *
 * They are applied to the surface colour *after* the enhanced grade and before
 * lighting, so they work identically in both visual styles: the enhanced curve
 * decides what the map looks like, and these decide what is then done to it.
 * Deliberately the smallest set that can describe a look — how vivid, how
 * monochrome, how punchy — rather than a full colour pipeline.
 *
 * The neutral triple (1, 0, 1) is an exact identity (see `applyPalette`), which
 * is why the stage can sit unconditionally in the shader's hot path.
 */
export interface Palette {
  /** 0 = grey, 1 = untouched, 2 = twice the chroma. */
  saturation: number
  /** 0 = untouched, 1 = fully mixed to luminance. */
  grayscale: number
  /** 0.5..1.5 about mid grey, in perceptual space. 1 = untouched. */
  contrast: number
}

export const NEUTRAL_PALETTE: Palette = { saturation: 1, grayscale: 0, contrast: 1 }

/** Slider bounds, shared by the UI and the tests so they cannot drift. */
export const PALETTE_RANGE = {
  saturation: { min: 0, max: 2, step: 0.05 },
  grayscale: { min: 0, max: 1, step: 0.05 },
  contrast: { min: 0.5, max: 1.5, step: 0.05 },
} as const

/**
 * Encoding gamma the contrast pivot works in.
 *
 * Contrast about mid grey in *linear* light pivots around 0.5 of the linear
 * range, which is a very bright grey — everything interesting on this map is
 * below it, so raising contrast would push the whole land surface toward black.
 * In a perceptual space mid grey is mid grey, and the same operation opens the
 * midtones instead of crushing them. Matches ENHANCED_GRADE.gamma on purpose.
 */
export const PALETTE_GAMMA = 2.2

export type RGB = [number, number, number]

const LUMA: RGB = [0.2126, 0.7152, 0.0722]
const mix = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * TS mirror of the GLSL palette stage: linear RGB in, linear RGB out.
 *
 * Order matters and is the same in both: saturate around the original
 * luminance, then mix toward that same luminance for the grey control, then
 * contrast. Recomputing luminance between the two would make saturation and
 * grayscale interact — pushing chroma up would then survive the grey mix — and
 * "grayscale 1" would no longer be reliably grey.
 */
export function applyPalette(c: RGB, p: Palette): RGB {
  const l = LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2]
  const out: RGB = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const sat = mix(l, c[i], p.saturation)
    const grey = mix(sat, l, p.grayscale)
    // into perceptual space, pivot about mid grey, and back
    const perceptual = Math.pow(Math.max(grey, 0), 1 / PALETTE_GAMMA)
    const pushed = (perceptual - 0.5) * p.contrast + 0.5
    out[i] = Math.pow(Math.max(pushed, 0), PALETTE_GAMMA)
  }
  return out
}

/**
 * The grade the globe ships with in the enhanced style.
 *
 * These are the values that won the preset bench (the "Muted atlas" candidate):
 * colour steps back a little so pins, borders and labels lead, and the slightly
 * soft contrast keeps the terminator band from blocking up. See
 * `defaultPaletteFor` for why the realistic style does not get them.
 */
export const DEFAULT_PALETTE: Palette = { saturation: 0.75, grayscale: 0.1, contrast: 0.95 }

/**
 * The palette a visual style starts from.
 *
 * Enhanced is a deliberately non-photographic look, so it carries the graded
 * default; realistic exists to show physical lighting, and grading it would
 * defeat the point — it starts neutral, which is an exact identity.
 */
export const defaultPaletteFor = (visuals: VisualStyle): Palette =>
  visuals === 'enhanced' ? { ...DEFAULT_PALETTE } : { ...NEUTRAL_PALETTE }
