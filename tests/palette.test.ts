import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { readFileSync } from 'node:fs'
import {
  applyPalette,
  matchPreset,
  presetById,
  NEUTRAL_PALETTE,
  PALETTE_PRESETS,
  PALETTE_RANGE,
  PALETTE_CUSTOM,
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

describe('presets', () => {
  it('offers enough of them to choose from', () => {
    expect(PALETTE_PRESETS.length).toBeGreaterThanOrEqual(6)
  })

  it('has unique ids and labels', () => {
    expect(new Set(PALETTE_PRESETS.map((p) => p.id)).size).toBe(PALETTE_PRESETS.length)
    expect(new Set(PALETTE_PRESETS.map((p) => p.label)).size).toBe(PALETTE_PRESETS.length)
    expect(PALETTE_PRESETS.every((p) => p.id !== PALETTE_CUSTOM)).toBe(true)
  })

  it('keeps every value inside its slider, on a step the slider can reach', () => {
    for (const p of PALETTE_PRESETS) {
      for (const key of ['saturation', 'grayscale', 'contrast'] as const) {
        const r = PALETTE_RANGE[key]
        expect(p[key]).toBeGreaterThanOrEqual(r.min)
        expect(p[key]).toBeLessThanOrEqual(r.max)
        // a preset the sliders cannot express would show as 'custom' the moment
        // anything else was touched
        expect(Math.abs(Math.round((p[key] - r.min) / r.step) * r.step - (p[key] - r.min))).toBeLessThan(1e-6)
      }
    }
  })

  it('starts from the shipping look, which must be an exact no-op', () => {
    const first = PALETTE_PRESETS[0]
    expect(first.id).toBe('current')
    expect(first.visuals).toBe('enhanced')
    expect({
      saturation: first.saturation,
      grayscale: first.grayscale,
      contrast: first.contrast,
    }).toEqual(NEUTRAL_PALETTE)
  })

  it('is genuinely six different pictures, not six sets of numbers', () => {
    // each preset must move a sample colour somewhere the others do not
    const seen = new Set(
      PALETTE_PRESETS.map((p) =>
        applyPalette(SAMPLES[1], p)
          .map((v) => v.toFixed(4))
          .join() + p.visuals,
      ),
    )
    expect(seen.size).toBe(PALETTE_PRESETS.length)
  })
})

describe('matchPreset', () => {
  it('recognises each preset from its values', () => {
    for (const p of PALETTE_PRESETS) expect(matchPreset(p, p.visuals)).toBe(p.id)
  })

  it('reports custom once a value is nudged', () => {
    const p = PALETTE_PRESETS[1]
    expect(matchPreset({ ...p, saturation: p.saturation + 0.05 }, p.visuals)).toBe(PALETTE_CUSTOM)
  })

  it('reports custom when the base style no longer matches', () => {
    const natural = presetById('natural')!
    expect(natural.visuals).toBe('realistic')
    expect(matchPreset(natural, 'enhanced')).toBe(PALETTE_CUSTOM)
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

  it('starts neutral, on the shipping preset', () => {
    const s = useSettingsStore()
    expect(s.palette).toEqual(NEUTRAL_PALETTE)
    expect(s.palettePreset).toBe('current')
  })

  it('switches the indicator to custom when a slider moves', () => {
    const s = useSettingsStore()
    s.setPalette({ saturation: 1.45 })
    expect(s.palettePreset).toBe(PALETTE_CUSTOM)
    expect(s.palette.saturation).toBe(1.45)
    expect(s.palette.contrast).toBe(1) // and leaves the others alone
  })

  it('lights a preset up again when the sliders land back on it', () => {
    const s = useSettingsStore()
    const vivid = presetById('vivid')!
    s.setPalette({ saturation: vivid.saturation })
    s.setPalette({ contrast: vivid.contrast })
    expect(s.palettePreset).toBe('vivid')
  })

  it('adopts a preset whole, base style included', () => {
    const s = useSettingsStore()
    s.applyPalettePreset('natural')
    expect(s.visuals).toBe('realistic')
    expect(s.palette.saturation).toBe(presetById('natural')!.saturation)
    expect(s.palettePreset).toBe('natural')
  })

  it('ignores an id it does not know rather than clearing the palette', () => {
    const s = useSettingsStore()
    s.applyPalettePreset('vivid')
    s.applyPalettePreset('nonsense')
    expect(s.palettePreset).toBe('vivid')
  })

  it('drops off a preset when the base style is changed underneath it', () => {
    const s = useSettingsStore()
    s.applyPalettePreset('natural') // realistic
    s.setVisuals('enhanced')
    expect(s.palettePreset).toBe(PALETTE_CUSTOM)
  })
})
