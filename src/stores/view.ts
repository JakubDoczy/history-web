import { defineStore } from 'pinia'

/** Camera state the UI needs (scale bar, zoom-dependent chrome). */
export const useViewStore = defineStore('view', {
  state: () => ({
    altitude: 2.5,
    fov: 50,
    viewportPx: 900,
    detailStatus: 'idle' as 'idle' | 'loading' | 'ready' | 'unavailable',
    detailSource: '—',
  }),
})
