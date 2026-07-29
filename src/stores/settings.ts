import { defineStore } from 'pinia'

export type ToggleKey =
  | 'clouds'
  | 'cloudShadows'
  | 'atmosphere'
  | 'detail'
  | 'scaleBar'
  | 'autoRotate'
  | 'relief'

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    sunHour: 12, // UTC hour driving the day/night terminator
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
  },
})
