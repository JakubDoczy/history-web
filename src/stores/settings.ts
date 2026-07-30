import { defineStore } from 'pinia'

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
    },
  },
})
