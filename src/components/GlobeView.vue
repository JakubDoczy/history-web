<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, useTemplateRef, watchEffect } from 'vue'
import Globe, { type GlobeInstance } from 'globe.gl'
import { AmbientLight, DirectionalLight, PerspectiveCamera, Vector3 } from 'three'
import { useEventStore } from '../stores/events'
import { useNationStore, type BorderEntry } from '../stores/nations'
import { useTimeStore } from '../stores/time'
import { useSettingsStore } from '../stores/settings'
import { useViewStore } from '../stores/view'
import type { HistoricalEvent } from '../lib/events'
import type { Ring } from '../lib/nations'
import { GlobeSurface } from '../lib/globeSurface'
import { AtmosphereLayer } from '../lib/skyLayer'
import { DetailImagery, visibleSpanDeg, minAltitudeFor, patchPixelCap } from '../lib/detailImagery'
import { cloudFadeFor, cloudSharpenFor } from '../lib/scale'
import { CelestialLayer } from '../lib/celestialLayer'
import { textureBlend } from '../lib/paleo'
import { subsolarLongitude, cityLightsFactor } from '../lib/sun'
import { pinElement, clusterElement, pinStateKey } from '../lib/eventPins'
import {
  clusterEvents,
  clusterSpanBucket,
  fanViewFor,
  layoutPins,
  legStrokeDeg,
  type ClusterLeg,
  type FanView,
  type PinDatum,
} from '../lib/eventClusters'
import { primaryTag, tagColor } from '../lib/tags'
import { PALEO_FRAMES, MODERN_TEXTURE, NIGHT_TEXTURE, RELIEF_TEXTURE, SKY_TEXTURE } from '../data/paleoTextures'

const events = useEventStore()
const nations = useNationStore()
const time = useTimeStore()
const settings = useSettingsStore()
const view = useViewStore()
const el = useTemplateRef('el')

let globe: GlobeInstance | undefined
let surface: GlobeSurface | undefined
let celestial: CelestialLayer | undefined
let atmosphere: AtmosphereLayer | undefined
let detail: DetailImagery | undefined
let resizeObs: ResizeObserver | undefined
let raf = 0
const stops: (() => void)[] = []

type EventAreaEntry = { kind: 'area'; event: HistoricalEvent; ring: Ring }
type PolyEntry = BorderEntry | EventAreaEntry

const asPin = (d: object) => d as PinDatum
const asLeg = (d: object) => d as ClusterLeg
const asPoly = (d: object) => d as PolyEntry

/**
 * Clustering runs off a *quantised* span: zoom fires continuously, and
 * regrouping (which rebuilds every pin element) on each frame would both cost
 * and flicker. See lib/eventClusters.ts.
 */
const clusterSpan = computed(() => clusterSpanBucket(visibleSpanDeg(view.altitude)))
const groups = computed(() => clusterEvents(events.visible, clusterSpan.value))

/** The frame the camera actually shows — what a fan is measured against. */
const liveFan = (): FanView =>
  // CSS pixels, not device pixels: the fan is measured against the pins, and a
  // pin is 24 CSS px wide whatever the display's ratio
  fanViewFor({
    altitude: view.altitude,
    fovDeg: view.fov,
    widthPx: view.viewportWidthPx,
    heightPx: view.viewportPx,
  })
/** Stands in when nothing is fanned; layoutPins never reads it then. */
const NO_FAN: FanView = { degPerPx: 0, heightPx: 1, widthPx: 1 }

const layout = computed(() =>
  layoutPins(groups.value, {
    expandedId: events.expandedClusterId,
    selectedId: events.selectedId,
    // The live view is read *only* while a cluster is open. Vue tracks
    // dependencies per run, so with nothing fanned this computed does not
    // depend on the altitude at all and a zoom cannot invalidate the layout —
    // which is what keeps a plain zoom from rebuilding every pin.
    fan: events.expandedClusterId ? liveFan() : NO_FAN,
  }),
)
const closed = (ring: Ring) => [...ring, ring[0]]

/**
 * Pin identity, held across layouts.
 *
 * The globe's HTML layer joins data by *object identity*: a datum it has seen
 * before keeps its element and is merely repositioned, a new one is built from
 * scratch. Handing it a fresh `{...p}` every time — which is what this used to
 * do — therefore rebuilt every pin element on every layout change, and a zoom
 * changes the layout several times on its way in. Reusing one object per pin
 * state (see pinStateKey) means a zoom that leaves the same events on screen
 * rebuilds nothing; the elements are cached by the same key for the case where
 * the globe does ask again.
 */
type KeyedPin = PinDatum & { key: string }
const pinData = new Map<string, KeyedPin>()
const pinEls = new Map<string, HTMLElement>()

const stablePins = (pins: PinDatum[], selectedId?: string): KeyedPin[] => {
  const live = new Set<string>()
  const out = pins.map((p) => {
    const key = pinStateKey(p, selectedId)
    live.add(key)
    const held = pinData.get(key)
    if (held) {
      // Same pin, new layout: copy the fresh datum's fields onto the object the
      // layer already knows, so it moves that one instead of building another.
      // Everything is copied, not just the position — a datum that keeps its
      // identity must not keep stale fields (`fanned` went stale when a member
      // left its cluster, and the next reader of it would have been wrong).
      Object.assign(held as PinDatum, p)
      return held
    }
    const fresh = { ...p, key } as KeyedPin
    pinData.set(key, fresh)
    return fresh
  })
  for (const key of [...pinData.keys()])
    if (!live.has(key)) {
      pinData.delete(key)
      pinEls.delete(key)
    }
  return out
}

const legData = new Map<string, ClusterLeg>()
const stableLegs = (legs: ClusterLeg[]): ClusterLeg[] => {
  const live = new Set(legs.map((l) => l.id))
  for (const id of [...legData.keys()]) if (!live.has(id)) legData.delete(id)
  return legs.map((l) => {
    const held = legData.get(l.id)
    if (!held) {
      legData.set(l.id, { ...l })
      return legData.get(l.id)!
    }
    held.endLat = l.endLat
    held.endLng = l.endLng
    held.startLat = l.startLat
    held.startLng = l.startLng
    return held
  })
}

// Only the selected event's area draws as a polygon: overlapping region fills
// used to smother the planet. Unselected area events are pins like the rest.
const eventAreas = (): EventAreaEntry[] =>
  events.visible
    .filter((e) => e.area && e.id === events.selectedId)
    .map((e) => ({ kind: 'area', event: e, ring: e.area! }))

onMounted(() => {
  const dom = el.value!
  const base = import.meta.env.BASE_URL

  globe = new Globe(dom)
    .backgroundImageUrl(SKY_TEXTURE)
    .width(dom.clientWidth)
    .height(dom.clientHeight)
    // events layer: HTML pins, coloured by the event's primary tag. Area events
    // get the footprint pin; their polygon only draws when selected. Co-located
    // events arrive here already collapsed into cluster badges.
    .htmlLat((d) => asPin(d).lat)
    .htmlLng((d) => asPin(d).lng)
    .htmlAltitude(0.006)
    .htmlTransitionDuration(0)
    .htmlElement((d) => {
      const p = asPin(d)
      const key = (d as KeyedPin).key ?? pinStateKey(p, events.selectedId)
      const held = pinEls.get(key)
      if (held) return held
      const el =
        p.kind === 'cluster'
          ? clusterElement(p.members, () =>
              // the live span, not the quantised one: it is compared against
              // the live span on the next zoom
              events.expandCluster(p.id, visibleSpanDeg(view.altitude)),
            )
          : pinElement(p.event, events.selectedId === p.event.id, () => events.select(p.event.id))
      pinEls.set(key, el)
      return el
    })
    .htmlElementVisibilityModifier((el, visible) => {
      el.style.opacity = visible ? '1' : '0'
      el.style.pointerEvents = visible ? 'auto' : 'none'
    })
    // arcs layer: the legs of an expanded cluster, anchor out to each member,
    // so a fanned pin still reads as belonging to the spot it came from
    .arcStartLat((d) => asLeg(d).startLat)
    .arcStartLng((d) => asLeg(d).startLng)
    .arcEndLat((d) => asLeg(d).endLat)
    .arcEndLng((d) => asLeg(d).endLng)
    .arcColor((d: object) => {
      const c = tagColor(primaryTag(asLeg(d).event))
      return [c + '10', c + 'cc'] // fades in from the anchor so the badge stays clean
    })
    .arcAltitude(0.004)
    // the legs are measured on screen like the fan they belong to; the layer is
    // only ever re-digested while a fan is open, which is when this changes
    .arcStroke(() => legStrokeDeg(liveFan()))
    .arcsTransitionDuration(180)
    // polygons layer: nation borders + the selected event's area
    .polygonGeoJsonGeometry((d) => ({
      type: 'Polygon',
      coordinates: [closed(asPoly(d).ring)] as unknown as number[],
    }))
    // Borders read as a drawn line, not a wash of colour. The cap is fully
    // transparent on purpose: caps are lit Lambert meshes, so on the night side
    // of the terminator even a 13% tint renders as a dark sheet that blots out
    // the map (strokes are unlit lines and stay crisp everywhere). The
    // invisible cap still catches hover/click for the label.
    .polygonCapColor((d) => {
      const p = asPoly(d)
      if (p.kind === 'area') return tagColor(primaryTag(p.event)) + '38'
      return 'rgba(0,0,0,0)'
    })
    .polygonSideColor(() => 'rgba(0,0,0,0)')
    .polygonStrokeColor((d) => {
      const p = asPoly(d)
      if (p.kind === 'area') return tagColor(primaryTag(p.event))
      return p.nation.color
    })
    // Borders sit almost on the surface, and always under the event pins (0.006).
    .polygonAltitude((d) => (asPoly(d).kind === 'area' ? 0.012 : 0.004))
    .polygonLabel((d) => {
      const p = asPoly(d)
      return p.kind === 'area' ? p.event.name : p.label
    })
    .onPolygonClick((d) => {
      const p = asPoly(d)
      if (p.kind === 'area') events.select(p.event.id)
    })
    .polygonsTransitionDuration(300)
    // clicking bare globe dismisses an open cluster
    .onGlobeClick(() => events.collapseClusters())

  // one material for the planet: era textures, day/night, city lights, clouds
  surface = new GlobeSurface(
    {
      day: MODERN_TEXTURE,
      night: NIGHT_TEXTURE,
      relief: RELIEF_TEXTURE,
      clouds: `${base}textures/clouds.jpg`,
    },
    globe.renderer(),
  )
  globe.globeMaterial(surface.material)
  // No whole-globe network upgrade: the bundled basemap is already 4096×2048,
  // the same layer and size GIBS would return. Sharper close-up detail comes
  // from the streamed Sentinel-2 patch instead.

  globe.controls().autoRotateSpeed = 0.5
  // dev-only handles so a browser console (or a screenshot script) can drive the
  // camera to an exact point of view and inspect what the streamer is doing;
  // never exist in a production build
  if (import.meta.env.DEV) {
    const w = window as unknown as { __globe?: GlobeInstance; __detail?: DetailImagery }
    w.__globe = globe
  }

  // CSS2DRenderer stamps a depth-sorted z-index (0..100) on every pin, and its
  // container carries no z-index of its own — so those values used to compete
  // in the root stacking context and paint pins over the panels. Naming the
  // container gives it a z-index from the app's scale (tokens.css), which turns
  // it into a stacking context and traps the 0..100 inside. It is the only
  // class-less div globe.gl puts in the scene container.
  dom.querySelector('.scene-container > div:not([class])')?.classList.add('globe-css2d')

  const radius = globe.getGlobeRadius()
  const cam = globe.camera()
  if (cam instanceof PerspectiveCamera) view.fov = cam.fov
  celestial = new CelestialLayer(globe.scene(), radius, `${base}textures/moon.jpg`)
  atmosphere = new AtmosphereLayer(globe.scene(), radius)
  // A patch at the 4096 ceiling is a 33 MB texture upload, and the composite is
  // re-uploaded whenever the view moves — so what the device can afford, not
  // what GL permits, is the right ceiling. See patchPixelCap.
  detail = new DetailImagery({
    maxPx: patchPixelCap({
      maxTextureSize: globe.renderer().capabilities.maxTextureSize,
      devicePixelRatio: window.devicePixelRatio,
      deviceMemoryGb: (navigator as { deviceMemory?: number }).deviceMemory,
    }),
  })
  if (import.meta.env.DEV) {
    ;(window as unknown as { __detail?: DetailImagery }).__detail = detail
  }
  // the patch only reaches the shader if the loader tells us it arrived
  detail.onReady = () => {
    // a load can resolve after imagery was switched off or the time scrubbed
    // into deep time; adopting it then would flash a patch nobody asked for
    if (!detailAllowed()) return
    view.detailStatus = detail!.status
    view.detailSource = detail!.sourceLabel
    view.detailAttribution = detail!.attribution
    view.detailGroundRes = detail!.groundRes
    surface!.setDetail(detail!.texture ?? null, detail!.rect, detail!.mix, detail!.lod)
  }

  /**
   * Streaming applies to every era that uses the modern basemap — coastline,
   * river, ice and desert are no less true in 1500 than today. Deep time is the
   * one exclusion: those eras draw a paleo map, and a Sentinel-2 patch of the
   * modern Atlantic over a Pangaean coastline would be nonsense.
   *
   * How *close* the camera may come is what varies by period instead; see
   * minAltitudeFor.
   */
  const detailAllowed = () => settings.detail && time.currentTime > -12000

  /**
   * The only place detail streaming is driven. It was previously called from
   * both the zoom handler and the frame loop with different arguments, so the
   * two computed different rectangles and fought over which one to load.
   */
  const syncDetail = (pov: { lat: number; lng: number; altitude: number }) => {
    if (!detailAllowed()) {
      surface!.setDetail(null, detail!.rect, 0)
      return
    }
    // device pixels, not CSS pixels: the globe renders at the device ratio
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const w = el.value?.clientWidth ?? 900
    const h = el.value?.clientHeight ?? 900
    // the camera's own fov, so the patch is cut to the frame rather than to the
    // horizon — close in those differ by more than an order of magnitude
    detail!.update(pov.lat, pov.lng, pov.altitude, h * dpr, w / h, view.fov)
    surface!.setDetail(detail!.texture ?? null, detail!.rect, detail!.mix, detail!.lod)
  }

  /** 0 far out, 1 close in — drives detail streaming and retires the sky effects. */
  const closeness = (altitude: number) => {
    const span = visibleSpanDeg(altitude)
    return Math.max(0, Math.min(1, (40 - span) / 30))
  }

  type Pov = { lat: number; lng: number; altitude: number }
  /** Has the camera moved enough for any of the work below to differ? */
  const povMoved = (a: Pov | undefined, b: Pov) =>
    !a ||
    Math.abs(a.altitude - b.altitude) > Math.max(b.altitude, 1e-6) * 1e-3 ||
    Math.abs(a.lat - b.lat) > 1e-4 ||
    Math.abs(a.lng - b.lng) > 1e-4

  let lastPov: Pov | undefined
  let lastSync: Pov | undefined

  const applyPov = (force = false) => {
    const pov = globe!.pointOfView()
    // OrbitControls fires a change event per wheel notch and per pointer move,
    // several times a frame during a zoom, and everything below — a projection
    // matrix, store writes that wake Vue, a detail-streaming pass — is only a
    // function of where the camera is. Doing it once per distinct pov is the
    // whole difference between a throttled zoom and an interactive one.
    if (!force && !povMoved(lastPov, pov)) return
    lastPov = { ...pov }
    // how close the camera may come depends on whether modern imagery is allowed
    globe!.controls().minDistance = radius * (1 + minAltitudeFor(time.currentTime, settings.detail))
    // globe.gl pins near at 0.05, which is what limits how close the camera may
    // come. Tracking it to the camera's own height keeps depth precision good
    // while allowing a far closer approach.
    if (cam instanceof PerspectiveCamera) {
      const wanted = Math.max(0.004, radius * pov.altitude * 0.35)
      if (Math.abs(cam.near - wanted) > wanted * 0.2) {
        cam.near = wanted
        cam.updateProjectionMatrix()
      }
    }
    const near = closeness(pov.altitude)
    const span = visibleSpanDeg(pov.altitude)
    view.altitude = pov.altitude
    events.noteSpan(span)
    view.detailStatus = detail!.status
    view.detailSource = detail!.sourceLabel
    view.viewportPx = el.value?.clientHeight ?? 900
    view.viewportWidthPx = el.value?.clientWidth ?? 900
    surface!.setFlatLight(near)
    lastSync = { ...pov }
    syncDetail(pov)
    // clouds retire well before the ground fills the screen; haze lingers longer
    const cloudy = cloudFadeFor(span)
    surface!.setCloudSharpen(cloudy > 0.01 ? cloudSharpenFor(span) : 0)
    surface!.setClouds(
      settings.clouds && cloudy > 0.01,
      (time.currentTime > -12000 ? 1 : 0) * cloudy,
      settings.cloudShadows,
    )
    atmosphere!.visible = settings.atmosphere && near < 0.9
  }

  // One pass per frame at most: the camera can only be in one place per frame,
  // so a change event that arrives after another has already been scheduled has
  // nothing new to say.
  let povRaf = 0
  const scheduleApplyPov = () => {
    if (povRaf) return
    povRaf = requestAnimationFrame(() => {
      povRaf = 0
      applyPov()
    })
  }
  globe.onZoom(scheduleApplyPov)

  const coords = (lat: number, lng: number, alt: number) => globe!.getCoords(lat, lng, alt)
  const sunDir = () => {
    const { x, y, z } = coords(0, subsolarLongitude(settings.sunHour), 1)
    return new Vector3(x, y, z).normalize()
  }
  const dirLight = globe.lights().find((l): l is DirectionalLight => l instanceof DirectionalLight)
  const ambient = globe.lights().find((l): l is AmbientLight => l instanceof AmbientLight)
  if (ambient) ambient.intensity = Math.min(ambient.intensity, 0.7)

  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const t0 = performance.now()
  const tick = () => {
    if (!still) surface!.setCloudDrift((performance.now() - t0) / 1000)
    // streaming is a function of where the camera is, so a still camera has
    // nothing to re-derive; the settle timer inside DetailImagery is already
    // armed and lands the sharp patch on its own
    const pov = globe!.pointOfView()
    if (povMoved(lastSync, pov)) {
      lastSync = { ...pov }
      syncDetail(pov)
    }
    raf = requestAnimationFrame(tick)
  }
  tick()

  stops.push(
    watchEffect(() => {
      // selection is part of a pin's identity, so it must be a dependency here
      // even though the layout object may be unchanged
      globe!.htmlElementsData(stablePins(layout.value.pins, events.selectedId))
    }),
    // Legs get stable identity for the same reason pins do: while a fan is open
    // a zoom relays it every frame, and a fresh object would restart the arc's
    // transition each time instead of moving the arc it already has.
    watchEffect(() => globe!.arcsData(stableLegs(layout.value.legs))),
    watchEffect(() => globe!.polygonsData([...nations.borders, ...eventAreas()])),
    watchEffect(() => (globe!.controls().autoRotate = settings.autoRotate)),
    watchEffect(() => surface!.setRelief(settings.relief ? 0.7 : 0)),
    watchEffect(() => surface!.setVisuals(settings.visuals === 'enhanced' ? 1 : 0)),
    watchEffect(() => surface!.setPalette(settings.palette)),
    watchEffect(() => surface!.setEra(textureBlend(PALEO_FRAMES, time.currentTime))),
    watchEffect(() => surface!.setCityLights(cityLightsFactor(time.currentTime))),
    // clouds are anachronistic detail in deep time, and would hide the plate drift
    watchEffect(() => {
      void settings.clouds
      void settings.atmosphere
      void settings.detail
      void time.currentTime
      applyPov(true) // a settings change, not a camera move: run it regardless
    }),
    watchEffect(() => {
      const dir = sunDir()
      surface!.setSun(dir)
      atmosphere!.setSunDirection(dir)
      dirLight?.position.copy(dir.clone().multiplyScalar(radius * 4))
      celestial!.setHour(settings.sunHour, coords)
    }),
  )

  resizeObs = new ResizeObserver(() => {
    globe?.width(dom.clientWidth).height(dom.clientHeight)
    applyPov(true) // the scale bar reads viewportPx; without this it is stale until the next zoom
  })
  resizeObs.observe(dom)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  stops.forEach((s) => s())
  surface?.dispose()
  detail?.dispose()
  celestial?.dispose()
  atmosphere?.dispose()
  resizeObs?.disconnect()
  globe?._destructor()
})
</script>

<template>
  <div ref="el" class="globe" />
</template>

<style scoped>
.globe {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
</style>

<style>
/* Pins are created imperatively by the globe's HTML layer, so unscoped.
   CSS2DRenderer centres the wrapper on the coordinate; shifting the SVG up by
   half its height puts the pin's tip on the spot instead. */
/* the globe's HTML pin layer, pinned below every panel — see tokens.css */
.globe-css2d {
  z-index: var(--z-globe-overlay);
}

.event-pin svg {
  display: block;
  /* --pin-shift lifts the artwork so the pin's *tip* (not the box centre) lands
     on the coordinate; area pins carry extra box below the tip, cluster badges
     are centred and set it to 0. */
  transform: translateY(var(--pin-shift, -50%));
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55));
  transition: opacity var(--fast, 0.15s ease);
}
.event-pin--selected {
  z-index: 2;
}
.event-pin:hover svg {
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55)) brightness(1.15);
}
/* the footprint breathes, so an area pin is legible as one even while still */
.event-pin--area .pin-footprint {
  transform-box: fill-box;
  transform-origin: center;
  animation: pin-footprint 2.6s var(--ease, ease) infinite;
}
@keyframes pin-footprint {
  0%,
  100% {
    transform: scale(0.86);
    opacity: 0.75;
  }
  50% {
    transform: scale(1.06);
    opacity: 1;
  }
}
.event-pin--cluster svg {
  filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.6));
}
</style>
