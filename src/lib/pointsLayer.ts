import { Group, Vector3, type Camera, type Object3D } from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { POINT_INK, kindLabel, pointIconSvg, type ResolvedPoint } from './points'
import type { RenderMode } from './present/mode'

/**
 * POINTS LAYER — the DOM half of lib/points.ts.
 *
 * CSS2D markers, like the event pins — but NOT the globe's HTML layer, which
 * belongs to the pins and their clustering. These are raw `CSS2DObject`s in a
 * group of their own, rendered by the same CSS2DRenderer into the same
 * `.globe-css2d` container (the drawing labels already live there this way),
 * so they inherit its stacking context and cannot reach a panel.
 *
 * Below the pins on purpose. CSS2DRenderer stamps a depth-sorted inline
 * z-index on every element; the stylesheet forces `.map-point` to 0 with
 * `!important` (see GlobeView.vue), so a point never paints over an event pin
 * — points are context, events are content. For the same reason a marker is
 * CENTRED on its coordinate rather than tip-anchored above it like a teardrop:
 * a point and a pin on the same spot stack head-over-dot instead of head-over-
 * head.
 *
 * Occlusion is this layer's own to do: CSS2DRenderer culls the frustum but not
 * the far side of the planet, and — unlike a drawing's labels, which only show
 * when the camera has been flown to them — points cover the whole globe. A
 * point is visible when its surface normal faces the camera past the horizon
 * ring: with the camera at distance d from the centre of a unit sphere, a
 * point at angle θ from the camera axis is in sight iff cos θ > 1/d. `sync`
 * re-answers that per marker; the caller wires it to the camera's own change
 * event (~50 dot products, nothing).
 */

export interface PointsLayerOptions {
  mode: RenderMode
  onSelect: (id: string) => void
}

/** World position for a lat/lng at an altitude, in the globe's own frame. */
export type CoordsFn = (lat: number, lng: number, altitude: number) => { x: number; y: number; z: number }

/** Just off the ground — under the pins' 0.006, matching their z-order story. */
const POINT_ALT = 0.005

/** Hysteresis on the horizon test, so a marker on the limb does not flicker. */
const HORIZON_SLACK = 0.015

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

interface Marker {
  obj: CSS2DObject
  el: HTMLElement
  /** Unit surface normal, for the horizon test. */
  normal: Vector3
  shown: boolean
}

export class PointsLayer {
  private group = new Group()
  private markers: Marker[] = []
  /** What is on the globe now, so an unchanged set rebuilds nothing. */
  private currentKey = ''
  private labels = false
  private camPos = new Vector3()

  constructor(
    parent: Object3D,
    private coords: CoordsFn,
  ) {
    parent.add(this.group)
  }

  /**
   * Put this set of points on the globe. Rebuilds only when the rendered
   * content actually differs (ids, era names, kinds or mode) — a scrub that
   * resolves to the same ten markers touches no DOM. Returns whether anything
   * changed, so the caller knows to buy a frame.
   */
  set(points: readonly ResolvedPoint[], opts: PointsLayerOptions): boolean {
    const key = `${opts.mode}|${points.map((p) => `${p.id}:${p.name}:${p.kind}`).join('|')}`
    if (key === this.currentKey) return false
    this.currentKey = key
    this.clear()
    const { ink, casing } = POINT_INK[opts.mode]
    for (const p of points) {
      const el = document.createElement('div')
      el.className =
        `map-point map-point--${p.kind}` +
        (opts.mode === 'schematic' ? ' map-point--flat' : '') +
        (this.labels ? ' map-point--labelled' : '')
      el.dataset.pointId = p.id
      el.innerHTML =
        pointIconSvg(p.kind, ink, casing) +
        `<span class="map-point__label">${escapeHtml(p.name)}</span>`
      el.title = `${p.name} — ${kindLabel(p.kind)}`
      el.style.pointerEvents = 'auto'
      el.style.cursor = 'pointer'
      // same wiring as the pins: a click on a point is not a click on the globe
      el.addEventListener('pointerdown', (ev) => ev.stopPropagation())
      el.addEventListener('click', (ev) => {
        ev.stopPropagation()
        opts.onSelect(p.id)
      })
      const obj = new CSS2DObject(el)
      const { x, y, z } = this.coords(p.lat, p.lng, POINT_ALT)
      obj.position.set(x, y, z)
      this.group.add(obj)
      this.markers.push({ obj, el, normal: new Vector3(x, y, z).normalize(), shown: true })
    }
    return true
  }

  /**
   * Hide markers on the far side of the planet. Cheap and idempotent; returns
   * whether any marker changed state.
   */
  sync(camera: Camera): boolean {
    if (!this.markers.length) return false
    camera.getWorldPosition(this.camPos)
    const d = this.camPos.length()
    const r = this.globeRadius()
    if (d <= r) return false // inside the sphere: keep whatever state there is
    const limit = r / d + HORIZON_SLACK
    const camUnit = this.camPos.clone().divideScalar(d)
    let changed = false
    for (const m of this.markers) {
      const shown = m.normal.dot(camUnit) > limit
      if (shown !== m.shown) {
        m.shown = shown
        m.obj.visible = shown
        changed = true
      }
    }
    return changed
  }

  /**
   * The planet's radius in scene units, read off the markers themselves: their
   * anchors sit at (1 + POINT_ALT) · R from the centre by construction, so no
   * second copy of R has to be threaded in and kept honest.
   */
  private globeRadius(): number {
    const m = this.markers[0]
    return m ? m.obj.position.length() / (1 + POINT_ALT) : 1
  }

  /**
   * Whether labels ride along. A question of zoom, answered by the caller
   * (see POINT_LABEL_MAX_SPAN_DEG); hover shows a label at any zoom via CSS.
   */
  setLabels(on: boolean): boolean {
    if (on === this.labels) return false
    this.labels = on
    for (const m of this.markers) m.el.classList.toggle('map-point--labelled', on)
    return true
  }

  private clear() {
    for (const m of this.markers) {
      this.group.remove(m.obj)
      m.el.remove()
    }
    this.markers = []
  }

  dispose() {
    this.clear()
    this.group.parent?.remove(this.group)
  }
}
