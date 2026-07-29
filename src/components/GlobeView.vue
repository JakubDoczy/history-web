<script setup lang="ts">
import { onMounted, onBeforeUnmount, useTemplateRef, watchEffect } from 'vue'
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
import { DetailImagery, visibleSpanDeg, minAltitudeFor, IMAGERY_ERA_FROM } from '../lib/detailImagery'
import { cloudFadeFor } from '../lib/scale'
import { CelestialLayer } from '../lib/celestialLayer'
import { textureBlend } from '../lib/paleo'
import { subsolarLongitude, cityLightsFactor } from '../lib/sun'
import { pinElement } from '../lib/eventPins'
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

const asEvent = (d: object) => d as HistoricalEvent
const asPoly = (d: object) => d as PolyEntry
const closed = (ring: Ring) => [...ring, ring[0]]

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
    // events layer: HTML pins, coloured by the event's primary tag. Area
    // events get the hollow-square pin; their polygon only draws when selected.
    .htmlLat((d) => asEvent(d).lat)
    .htmlLng((d) => asEvent(d).lng)
    .htmlAltitude(0.006)
    .htmlTransitionDuration(0)
    .htmlElement((d) => {
      const e = asEvent(d)
      return pinElement(e, events.selectedId === e.id, () => events.select(e.id))
    })
    .htmlElementVisibilityModifier((el, visible) => {
      el.style.opacity = visible ? '1' : '0'
      el.style.pointerEvents = visible ? 'auto' : 'none'
    })
    // polygons layer: nation borders + the selected event's area
    .polygonGeoJsonGeometry((d) => ({
      type: 'Polygon',
      coordinates: [closed(asPoly(d).ring)] as unknown as number[],
    }))
    .polygonCapColor((d) => {
      const p = asPoly(d)
      if (p.kind === 'area') return tagColor(primaryTag(p.event)) + '38'
      return p.kind === 'full' ? p.nation.color + '50' : 'rgba(0,0,0,0)'
    })
    .polygonSideColor(() => 'rgba(0,0,0,0)')
    .polygonStrokeColor((d) => {
      const p = asPoly(d)
      if (p.kind === 'area') return tagColor(primaryTag(p.event))
      return p.kind === 'full' ? p.nation.color : p.kind === 'max' ? p.nation.color + 'aa' : '#ffffffaa'
    })
    .polygonAltitude((d) => (asPoly(d).kind === 'area' ? 0.012 : asPoly(d).kind === 'full' ? 0.008 : 0.005))
    .polygonLabel((d) => {
      const p = asPoly(d)
      if (p.kind === 'area') return p.event.name
      return p.kind === 'full' ? p.nation.name : `${p.nation.name} (${p.kind} extent in view)`
    })
    .onPolygonClick((d) => {
      const p = asPoly(d)
      if (p.kind === 'area') events.select(p.event.id)
    })
    .polygonsTransitionDuration(300)

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

  const radius = globe.getGlobeRadius()
  const cam = globe.camera()
  if (cam instanceof PerspectiveCamera) view.fov = cam.fov
  celestial = new CelestialLayer(globe.scene(), radius, `${base}textures/moon.jpg`)
  atmosphere = new AtmosphereLayer(globe.scene(), radius)
  detail = new DetailImagery()
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
   * Streaming applies to every era that uses the modern basemap; how *close* the
   * camera may come is what varies by period, since modern features only become
   * legible at high zoom.
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
    detail!.update(pov.lat, pov.lng, pov.altitude, h * dpr, w / h)
    surface!.setDetail(detail!.texture ?? null, detail!.rect, detail!.mix, detail!.lod)
  }

  /** 0 far out, 1 close in — drives detail streaming and retires the sky effects. */
  const closeness = (altitude: number) => {
    const span = visibleSpanDeg(altitude)
    return Math.max(0, Math.min(1, (40 - span) / 30))
  }

  const applyPov = () => {
    const pov = globe!.pointOfView()
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
    view.altitude = pov.altitude
    view.detailStatus = detail!.status
    view.detailSource = detail!.sourceLabel
    view.viewportPx = el.value?.clientHeight ?? 900
    surface!.setFlatLight(near)
    syncDetail(pov)
    // clouds retire well before the ground fills the screen; haze lingers longer
    const cloudy = cloudFadeFor(visibleSpanDeg(pov.altitude))
    surface!.setClouds(
      settings.clouds && cloudy > 0.01,
      (time.currentTime > -12000 ? 1 : 0) * cloudy,
      settings.cloudShadows,
    )
    atmosphere!.visible = settings.atmosphere && near < 0.9
  }

  globe.onZoom(applyPov)

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
    syncDetail(globe!.pointOfView())
    raf = requestAnimationFrame(tick)
  }
  tick()

  stops.push(
    // Fresh datum objects on purpose: globe.gl reuses DOM for identical data,
    // which would leave selection styling stale. <=100 pins, so rebuilding is cheap.
    watchEffect(() => {
      void events.selectedId
      globe!.htmlElementsData(events.visible.map((e) => ({ ...e })))
    }),
    watchEffect(() => globe!.polygonsData([...nations.borders, ...eventAreas()])),
    watchEffect(() => (globe!.controls().autoRotate = settings.autoRotate)),
    watchEffect(() => surface!.setRelief(settings.relief ? 0.7 : 0)),
    watchEffect(() => surface!.setVisuals(settings.visuals === 'enhanced' ? 1 : 0)),
    watchEffect(() => surface!.setEra(textureBlend(PALEO_FRAMES, time.currentTime))),
    watchEffect(() => surface!.setCityLights(cityLightsFactor(time.currentTime))),
    // clouds are anachronistic detail in deep time, and would hide the plate drift
    watchEffect(() => {
      void settings.clouds
      void settings.atmosphere
      void settings.detail
      void time.currentTime
      applyPov()
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
    applyPov() // the scale bar reads viewportPx; without this it is stale until the next zoom
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
.event-pin svg {
  display: block;
  transform: translateY(-50%);
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55));
  transition: opacity var(--fast, 0.15s ease);
}
.event-pin--selected {
  z-index: 2;
}
.event-pin:hover svg {
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55)) brightness(1.15);
}
</style>
