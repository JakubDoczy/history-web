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

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    sunHour: 12, // UTC hour driving the day/night terminator
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
