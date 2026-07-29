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
import { CelestialLayer } from '../lib/celestialLayer'
import { textureBlend } from '../lib/paleo'
import { subsolarLongitude, cityLightsFactor } from '../lib/sun'
import { PALEO_FRAMES, MODERN_TEXTURE, NIGHT_TEXTURE, HIRES_MODERN } from '../data/paleoTextures'

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

const eventAreas = (): EventAreaEntry[] =>
  events.visible.filter((e) => e.area).map((e) => ({ kind: 'area', event: e, ring: e.area! }))

onMounted(() => {
  const dom = el.value!
  const base = import.meta.env.BASE_URL

  globe = new Globe(dom)
    .backgroundImageUrl('//unpkg.com/three-globe/example/img/night-sky.png')
    .width(dom.clientWidth)
    .height(dom.clientHeight)
    // events layer
    .pointAltitude(0.02)
    .pointRadius((d) => 0.3 + (asEvent(d).priority / 100) * 0.7)
    .pointColor((d) => (events.selectedId === asEvent(d).id ? '#ff0' : '#f80'))
    .pointLabel((d) => asEvent(d).name)
    .onPointClick((d) => events.select(asEvent(d).id))
    // polygons layer: nation borders + event areas
    .polygonGeoJsonGeometry((d) => ({
      type: 'Polygon',
      coordinates: [closed(asPoly(d).ring)] as unknown as number[],
    }))
    .polygonCapColor((d) => {
      const p = asPoly(d)
      if (p.kind === 'area') return events.selectedId === p.event.id ? '#ffff0060' : '#ff880040'
      return p.kind === 'full' ? p.nation.color + '50' : 'rgba(0,0,0,0)'
    })
    .polygonSideColor(() => 'rgba(0,0,0,0)')
    .polygonStrokeColor((d) => {
      const p = asPoly(d)
      if (p.kind === 'area') return events.selectedId === p.event.id ? '#ff0' : '#f80'
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
      relief: '//unpkg.com/three-globe/example/img/earth-topology.png',
      clouds: `${base}textures/clouds.jpg`,
    },
    globe.renderer(),
  )
  globe.globeMaterial(surface.material)
  surface.upgrade(MODERN_TEXTURE, HIRES_MODERN) // sharper basemap if NASA is reachable

  globe.controls().autoRotate = true
  globe.controls().autoRotateSpeed = 0.5
  dom.addEventListener('pointerdown', () => (globe!.controls().autoRotate = false), { once: true })

  const cam = globe.camera()
  if (cam instanceof PerspectiveCamera) view.fov = cam.fov
  const radius = globe.getGlobeRadius()
  celestial = new CelestialLayer(globe.scene(), radius, `${base}textures/moon.jpg`)
  atmosphere = new AtmosphereLayer(globe.scene(), radius)
  detail = new DetailImagery()
  // the patch only reaches the shader if the loader tells us it arrived
  detail.onReady = () => {
    view.detailStatus = detail!.status
    view.detailSource = detail!.sourceLabel
    surface!.setDetail(detail!.texture ?? null, detail!.rect, detail!.mix)
  }

  /** Detail imagery is modern, so it is only offered within the satellite era. */
  const detailAllowed = () => settings.detail && time.currentTime >= IMAGERY_ERA_FROM

  /** 0 far out, 1 close in — drives detail streaming and retires the sky effects. */
  const closeness = (altitude: number) => {
    const span = visibleSpanDeg(altitude)
    return Math.max(0, Math.min(1, (40 - span) / 30))
  }

  const applyPov = () => {
    const pov = globe!.pointOfView()
    // how close the camera may come depends on whether modern imagery is allowed
    globe!.controls().minDistance = radius * (1 + minAltitudeFor(time.currentTime, settings.detail))
    const near = closeness(pov.altitude)
    view.altitude = pov.altitude
    view.viewportPx = el.value?.clientHeight ?? 900
    surface!.setFlatLight(near)
    if (detailAllowed()) {
      detail!.update(pov.lat, pov.lng, pov.altitude, view.viewportPx)
      surface!.setDetail(detail!.texture ?? null, detail!.rect, detail!.mix)
    } else {
      surface!.setDetail(null, detail!.rect, 0)
    }
    // clouds and haze read as wrong once the view is a few hundred km across
    surface!.setClouds(settings.clouds && near < 0.95, (time.currentTime > -12000 ? 1 : 0) * (1 - near))
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
    if (settings.detail && time.currentTime > -12000) {
      const pov = globe!.pointOfView()
      detail!.update(pov.lat, pov.lng, pov.altitude)
      surface!.setDetail(detail!.texture ?? null, detail!.rect, detail!.mix)
    } else {
      surface!.setDetail(null, detail!.rect, 0)
    }
    raf = requestAnimationFrame(tick)
  }
  tick()

  stops.push(
    watchEffect(() => globe!.pointsData(events.visible.filter((e) => !e.area))),
    watchEffect(() => globe!.polygonsData([...nations.borders, ...eventAreas()])),
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

  resizeObs = new ResizeObserver(() => globe?.width(dom.clientWidth).height(dom.clientHeight))
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
