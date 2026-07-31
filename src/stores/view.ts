import { defineStore } from 'pinia'

/** Camera state the UI needs (scale bar, zoom-dependent chrome). */
export const useViewStore = defineStore('view', {
  state: () => ({
    altitude: 2.5,
    fov: 50,
    /** Viewport height in CSS px (the axis the camera's fov measures). */
    viewportPx: 900,
    /** Viewport width in CSS px — needed wherever the *short* side matters. */
    viewportWidthPx: 900,
    detailStatus: 'idle' as 'idle' | 'loading' | 'ready' | 'unavailable',
    detailSource: '—',
    detailAttribution: '',
    detailGroundRes: 0,
  }),
})
