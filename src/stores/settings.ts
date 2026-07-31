import { defineStore } from 'pinia'
import {
  NEUTRAL_PALETTE,
  PALETTE_PRESETS,
  matchPreset,
  presetById,
  type Palette,
} from '../lib/palette'

export type ToggleKey =
  | 'clouds'
  | 'cloudShadows'
  | 'atmosphere'
  | 'detail'
  | 'scaleBar'
  | 'autoRotate'
  | 'relief'

export type VisualStyle = 'enhanced' | 'realistic'

/** Bounds of the "events on globe" slider; the UI and the store share them. */
export const MAX_EVENTS = { min: 10, max: 100, step: 10, default: 30 } as const

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    sunHour: 12, // UTC hour driving the day/night terminator
    /**
     * How many events the globe may show at once. Kept low by default: past
     * about thirty pins the map stops reading as a map, and clustering only
     * hides so much.
     */
    maxEvents: MAX_EVENTS.default as number,
    /** 'enhanced' brightens the day side and lifts the night side; 'realistic' keeps physical lighting. */
    visuals: 'enhanced' as VisualStyle,
    /**
     * Experimental colour grading, applied after the enhanced curve. Neutral by
     * default, and the neutral triple is an exact identity — see lib/palette.ts
     * — so this ships switched off in every sense but the UI.
     */
    palette: { ...NEUTRAL_PALETTE } as Palette,
    /** Which preset the current palette corresponds to, or 'custom'. */
    palettePreset: PALETTE_PRESETS[0].id,
    clouds: true,
    cloudShadows: true,
    atmosphere: true,
    detail: true,
    scaleBar: true,
    autoRotate: false,
    relief: true,
  }),
  actions: {
    toggle(key: ToggleKey) {
      this[key] = !this[key]
    },
    setVisuals(style: VisualStyle) {
      this.visuals = style
      // a preset can carry a base style, so changing the base can move the
      // indicator off it — the picker must not claim a preset it is not on
      this.palettePreset = matchPreset(this.palette, this.visuals)
    },

    /** Move one palette control; the preset indicator follows the values. */
    setPalette(patch: Partial<Palette>) {
      this.palette = { ...this.palette, ...patch }
      this.palettePreset = matchPreset(this.palette, this.visuals)
    },

    /** Adopt a preset whole: its three values and the base style it sits on. */
    applyPalettePreset(id: string) {
      const preset = presetById(id)
      if (!preset) return
      this.palette = {
        saturation: preset.saturation,
        grayscale: preset.grayscale,
        contrast: preset.contrast,
      }
      this.visuals = preset.visuals
      this.palettePreset = preset.id
    },
  },
})
