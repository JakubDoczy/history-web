import { defineStore } from 'pinia'
import type { ViewportScope } from '../lib/viewport'

/** Camera state the UI needs (scale bar, zoom-dependent chrome). */
export const useViewStore = defineStore('view', {
  state: () => ({
    altitude: 2.5,
    fov: 50,
    /** Viewport height in CSS px (the axis the camera's fov measures). */
    viewportPx: 900,
    /** Viewport width in CSS px — needed wherever the *short* side matters. */
    viewportWidthPx: 900,
    /**
     * The circle of ground the camera can see, or `undefined` at world view —
     * where there is nothing to scope to and the event query is the global one
     * it has always been (see lib/viewport.ts).
     *
     * Quantised before it lands here, and written only when the quantised value
     * actually changes: the event query, the clustering and every pin element
     * hang off it, so a value that moved with the camera would rebuild the pin
     * layer on every frame of a pan. `GlobeView.applyPov` is the only writer.
     */
    scope: undefined as ViewportScope | undefined,
    detailStatus: 'idle' as 'idle' | 'loading' | 'ready' | 'unavailable',
    detailSource: '—',
    detailAttribution: '',
    detailGroundRes: 0,
  }),
})
