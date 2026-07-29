import { defineStore } from 'pinia'

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    sunHour: 12, // UTC hour driving the day/night terminator
    clouds: true,
    atmosphere: true,
    detail: true,
    scaleBar: true,
  }),
  actions: {
    toggle(key: 'clouds' | 'atmosphere' | 'detail' | 'scaleBar') {
      this[key] = !this[key]
    },
  },
})
