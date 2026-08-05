import { defineStore } from 'pinia'
import { defaultPaletteFor, type Palette } from '../lib/palette'
import { DEFAULT_MODE, type RenderMode } from '../lib/present/mode'

export type ToggleKey =
  | 'clouds'
  | 'cloudShadows'
  | 'atmosphere'
  | 'detail'
  | 'scaleBar'
  | 'autoRotate'
  | 'relief'
  | 'showMinorEvents'

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
    /**
     * Show the minor tier: everything absent from data/events/ranking.txt,
     * including the birth and death pins derived from every person. Off by
     * default — the tier exists so the corpus can hold far more than the map
     * can usefully show.
     */
    showMinorEvents: false,
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
    /**
     * HOW THE APP DRAWS ITSELF — the photographic globe, or the drawn map.
     *
     * Experimental, and the one setting here that is not a knob on the existing
     * look: it selects a whole `GlobeStyle` (see lib/present/globe.ts), and the
     * knobs above are then inputs the schematic style mostly ignores. They are
     * deliberately left alone rather than disabled, so switching back restores
     * exactly what the reader had.
     */
    mode: DEFAULT_MODE as RenderMode,
  }),
  actions: {
    toggle(key: ToggleKey) {
      this[key] = !this[key]
    },

    /** Switch the whole look. See `mode`, and lib/present/mode.ts. */
    setMode(mode: RenderMode) {
      this.mode = mode
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
