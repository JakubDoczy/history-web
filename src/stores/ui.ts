import { defineStore } from 'pinia'

export const useUiStore = defineStore('ui', {
  state: () => ({ search: false, settings: false }),
  actions: {
    toggle(panel: 'search' | 'settings') {
      const next = !this[panel]
      this.search = this.settings = false
      this[panel] = next
    },
    close() {
      this.search = this.settings = false
    },
  },
})
