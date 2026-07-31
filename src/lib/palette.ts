import type { VisualStyle } from '../stores/settings'

/**
 * A temporary grading bench for choosing the final palette.
 *
 * Three controls, applied to the surface colour *after* the enhanced grade and
 * before lighting, so they work identically in both visual styles: the enhanced
 * curve decides what the map looks like, and these decide what is then done to
 * it. They are deliberately the smallest set that can describe a look — how
 * vivid, how monochrome, how punchy — rather than a full colour pipeline; the
 * point is to pick one preset and delete the rest.
 *
 * All three are neutral at their defaults and the neutral triple is an exact
 * identity (see `applyPalette`), so shipping with the lab untouched changes
 * nothing about how the globe renders today.
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

export interface PalettePreset extends Palette {
  id: string
  label: string
  /** Presets may set the base look too — a palette sits on top of one. */
  visuals: VisualStyle
  /** One line, shown under the picker. */
  note: string
}

/**
 * The candidates, chosen by looking at world and Europe-closeup renders of each
 * rather than by picking round numbers (see /tmp/shots5/preset-*.png).
 *
 * They are meant to be distinct at a glance, not to span the space evenly:
 * three of them are variations on "more punch", because that is the axis the
 * globe actually needs a decision on, and the other three exist to show what
 * the alternatives cost.
 */
export const PALETTE_PRESETS: PalettePreset[] = [
  {
    id: 'current',
    label: 'Current',
    ...NEUTRAL_PALETTE,
    visuals: 'enhanced',
    note: 'What ships today — the enhanced grade, untouched.',
  },
  {
    id: 'vivid',
    label: 'Vivid',
    saturation: 1.35,
    grayscale: 0,
    contrast: 1.05,
    visuals: 'enhanced',
    note: 'Chroma-led. Oceans read blue, vegetation green, deserts gold.',
  },
  {
    id: 'natural',
    label: 'Natural',
    saturation: 0.95,
    grayscale: 0,
    contrast: 1.05,
    visuals: 'realistic',
    note: 'Physical lighting with a touch of shape — the photographic option.',
  },
  {
    id: 'crisp',
    label: 'Crisp',
    saturation: 1,
    grayscale: 0.15,
    contrast: 1.3,
    visuals: 'enhanced',
    note: 'Contrast-led, colour pulled back: coastlines and terrain edges snap.',
  },
  {
    id: 'muted',
    label: 'Muted atlas',
    saturation: 0.75,
    grayscale: 0.1,
    contrast: 0.95,
    visuals: 'enhanced',
    note: 'Printed-atlas restraint: colour steps back so pins and borders lead.',
  },
  {
    id: 'ink',
    label: 'Ink',
    saturation: 0.6,
    grayscale: 0.85,
    contrast: 1.2,
    visuals: 'enhanced',
    note: 'Near-monochrome engraving. Every coloured overlay reads at once.',
  },
  {
    id: 'warm',
    label: 'Warm',
    saturation: 1.2,
    grayscale: 0,
    contrast: 0.9,
    visuals: 'enhanced',
    note: 'Softer curve, richer chroma — the map leans to its ochres and golds.',
  },
]

export const PALETTE_CUSTOM = 'custom'

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

/**
 * Which preset a state corresponds to, or 'custom'.
 *
 * Used to move the indicator when a slider moves — and, because it is a lookup
 * rather than a flag, a slider dragged back onto a preset's values lights that
 * preset up again instead of staying stuck on 'custom'.
 */
export function matchPreset(p: Palette, visuals: VisualStyle): string {
  const hit = PALETTE_PRESETS.find(
    (q) =>
      q.visuals === visuals &&
      near(q.saturation, p.saturation) &&
      near(q.grayscale, p.grayscale) &&
      near(q.contrast, p.contrast),
  )
  return hit ? hit.id : PALETTE_CUSTOM
}

export const presetById = (id: string): PalettePreset | undefined =>
  PALETTE_PRESETS.find((p) => p.id === id)
