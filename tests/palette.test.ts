import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { readFileSync } from 'node:fs'
import {
  applyPalette,
  NEUTRAL_PALETTE,
  DEFAULT_PALETTE,
  PALETTE_RANGE,
  PALETTE_GAMMA,
  type RGB,
} from '../src/lib/palette'
import { useSettingsStore } from '../src/stores/settings'

const luma = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
/** Linear value of perceptual mid grey — the pivot the contrast control turns on. */
const MID_GREY = Math.pow(0.5, PALETTE_GAMMA)

const SAMPLES: RGB[] = [
  [0.012, 0.018, 0.009], // central European land, measured off the basemap
  [0.16, 0.13, 0.07], // Sahara
  [0.002, 0.004, 0.012], // deep ocean
  [0.7, 0.72, 0.75], // ice
]

describe('applyPalette', () => {
  it('is an exact identity at the neutral triple', () => {
    for (const c of SAMPLES) {
      const out = applyPalette(c, NEUTRAL_PALETTE)
      for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(c[i], 12)
    }
  })

  it('collapses to grey at saturation 0', () => {
    for (const c of SAMPLES) {
      const out = applyPalette(c, { ...NEUTRAL_PALETTE, saturation: 0 })
      expect(out[0]).toBeCloseTo(out[1], 12)
      expect(out[1]).toBeCloseTo(out[2], 12)
      expect(out[0]).toBeCloseTo(luma(c), 10)
    }
  })

  it('collapses to grey at grayscale 1, whatever saturation says', () => {
    for (const saturation of [0, 1, 2]) {
      const out = applyPalette(SAMPLES[1], { saturation, grayscale: 1, contrast: 1 })
      expect(out[0]).toBeCloseTo(out[1], 12)
      expect(out[1]).toBeCloseTo(out[2], 12)
    }
  })

  it('pushes chroma away from luminance as saturation rises', () => {
    const c = SAMPLES[1]
    const spread = (p: RGB) => Math.max(...p) - Math.min(...p)
    expect(spread(applyPalette(c, { ...NEUTRAL_PALETTE, saturation: 1.5 }))).toBeGreaterThan(
      spread(c),
    )
    expect(spread(applyPalette(c, { ...NEUTRAL_PALETTE, saturation: 0.5 }))).toBeLessThan(spread(c))
  })

  it('pivots contrast on mid grey, which is therefore a fixed point', () => {
    for (const contrast of [0.5, 0.8, 1.2, 1.5]) {
      const out = applyPalette([MID_GREY, MID_GREY, MID_GREY], { ...NEUTRAL_PALETTE, contrast })
      expect(out[0]).toBeCloseTo(MID_GREY, 10)
    }
  })

  it('opens midtones rather than crushing shadows, which is why the pivot is perceptual', () => {
    // The palette runs on the *graded* albedo, where European land has been
    // lifted to roughly 0.2 linear — 0.49 perceptual, i.e. all but on the
    // pivot. A pivot in linear light instead sits at 0.5 linear, above almost
    // everything on this map, so the same 1.25x contrast would cut that land by
    // a third and take genuinely dark ground straight to black.
    const graded: RGB = [0.19, 0.21, 0.16]
    const out = applyPalette(graded, { ...NEUTRAL_PALETTE, contrast: 1.25 })
    const linearPivot = (v: number) => (v - 0.5) * 1.25 + 0.5
    expect(out[1]).toBeGreaterThan(graded[1] * 0.9)
    expect(linearPivot(graded[1])).toBeLessThan(graded[1] * 0.7)

    // and the darkest thing on the map survives as something, rather than as 0
    const abyss = SAMPLES[2]
    expect(applyPalette(abyss, { ...NEUTRAL_PALETTE, contrast: 1.25 })[2]).toBeGreaterThan(0)
    expect(linearPivot(abyss[2])).toBeLessThan(0)
  })

  it('is monotonic in contrast above the pivot and below it', () => {
    const bright: RGB = [0.5, 0.5, 0.5]
    const dark: RGB = [0.02, 0.02, 0.02]
    const at = (c: RGB, contrast: number) => applyPalette(c, { ...NEUTRAL_PALETTE, contrast })[0]
    expect(at(bright, 1.3)).toBeGreaterThan(at(bright, 1))
    expect(at(bright, 1)).toBeGreaterThan(at(bright, 0.7))
    expect(at(dark, 1.3)).toBeLessThan(at(dark, 1))
    expect(at(dark, 1)).toBeLessThan(at(dark, 0.7))
  })

  it('never returns a negative channel, however hard it is pushed', () => {
    for (const c of SAMPLES) {
      for (const saturation of [0, 2]) {
        for (const contrast of [0.5, 1.5]) {
          for (const grayscale of [0, 1]) {
            for (const v of applyPalette(c, { saturation, grayscale, contrast })) {
              expect(v).toBeGreaterThanOrEqual(0)
              expect(Number.isFinite(v)).toBe(true)
            }
          }
        }
      }
    }
  })
})

describe('the shader mirrors the TypeScript', () => {
  const glsl = readFileSync('src/lib/globeSurface.ts', 'utf8')

  it('grades with the same gamma the TS pivot assumes', () => {
    // the GLSL interpolates the shared constant rather than restating it, which
    // is the only way the two can be checked to agree without running WebGL
    expect(glsl).toContain('f(1 / PALETTE_GAMMA)')
    expect(glsl).toContain('f(PALETTE_GAMMA)')
    expect(PALETTE_GAMMA).toBe(2.2)
  })

  it('applies the palette outside the enhanced-mode mix, so both styles get it', () => {
    const palette = glsl.indexOf('uPalette.x')
    const boostMix = glsl.indexOf('albedo = mix(albedo, target, uBoost);')
    expect(boostMix).toBeGreaterThan(-1)
    expect(palette).toBeGreaterThan(boostMix) // after the grade, and unconditional
  })
})

describe('settings store palette', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('starts on the enhanced default, not neutral', () => {
    const s = useSettingsStore()
    expect(s.visuals).toBe('enhanced')
    expect(s.palette).toEqual(DEFAULT_PALETTE)
  })

  it('moves one control and leaves the others alone', () => {
    const s = useSettingsStore()
    s.setPalette({ saturation: 1.45 })
    expect(s.palette.saturation).toBe(1.45)
    expect(s.palette.contrast).toBe(DEFAULT_PALETTE.contrast)
  })

  it('resets to the current style default', () => {
    const s = useSettingsStore()
    s.setPalette({ saturation: 1.45, grayscale: 0.5 })
    s.resetPalette()
    expect(s.palette).toEqual(DEFAULT_PALETTE)
  })

  it('neutralises the palette when the style goes realistic', () => {
    const s = useSettingsStore()
    s.setVisuals('realistic')
    expect(s.palette).toEqual(NEUTRAL_PALETTE)
    s.resetPalette()
    expect(s.palette).toEqual(NEUTRAL_PALETTE) // reset follows the style too
  })

  it('re-applies the default when the style goes back to enhanced', () => {
    const s = useSettingsStore()
    s.setVisuals('realistic')
    s.setVisuals('enhanced')
    expect(s.palette).toEqual(DEFAULT_PALETTE)
  })

  it('lets slider edits stand until the next style switch, then discards them', () => {
    const s = useSettingsStore()
    s.setPalette({ contrast: 1.4 })
    expect(s.palette.contrast).toBe(1.4)
    s.setVisuals('enhanced') // even switching to the style already showing
    expect(s.palette).toEqual(DEFAULT_PALETTE)
  })

  it('keeps the default inside the sliders, on a step they can reach', () => {
    for (const key of ['saturation', 'grayscale', 'contrast'] as const) {
      const r = PALETTE_RANGE[key]
      expect(DEFAULT_PALETTE[key]).toBeGreaterThanOrEqual(r.min)
      expect(DEFAULT_PALETTE[key]).toBeLessThanOrEqual(r.max)
      const off = DEFAULT_PALETTE[key] - r.min
      expect(Math.abs(Math.round(off / r.step) * r.step - off)).toBeLessThan(1e-6)
    }
  })

  it('is a real grade, not a disguised no-op', () => {
    expect(applyPalette(SAMPLES[1], DEFAULT_PALETTE)).not.toEqual(
      applyPalette(SAMPLES[1], NEUTRAL_PALETTE),
    )
  })
})
