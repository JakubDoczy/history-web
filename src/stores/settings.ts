import { defineStore } from 'pinia'
import { defaultPaletteFor, type Palette } from '../lib/palette'

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
     * Colour grading, applied after the enhanced curve, in both styles.
     * Defaults to whatever the current visual style starts from — see
     * `setVisuals` for what happens when the style changes under it.
     */
    palette: defaultPaletteFor('enhanced') as Palette,
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
    /**
     * Change the base look, and reset the palette to that style's default.
     *
     * The chosen rule, spelled out because it is a judgement call rather than
     * an obvious one: the graded default belongs to the enhanced style, so
     * switching *to* enhanced applies it and switching to realistic returns the
     * triple to neutral. Slider moves override that until the next style
     * switch — a style switch is always a clean slate. The alternative,
     * remembering per-style edits, means the same button does different things
     * depending on history, which is worse to explain than the odd lost tweak.
     */
    setVisuals(style: VisualStyle) {
      this.visuals = style
      this.palette = defaultPaletteFor(style)
    },

    /** Move one palette control. Overrides the style default until it changes. */
    setPalette(patch: Partial<Palette>) {
      this.palette = { ...this.palette, ...patch }
    },

    /** Back to the current style's default triple. */
    resetPalette() {
      this.palette = defaultPaletteFor(this.visuals)
    },
  },
})
