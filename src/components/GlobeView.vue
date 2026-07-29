<script setup lang="ts">
import { onMounted, onBeforeUnmount, useTemplateRef, watchEffect } from 'vue'
import Globe, { type GlobeInstance } from 'globe.gl'
import { AmbientLight, DirectionalLight, Vector3 } from 'three'
import { useEventStore } from '../stores/events'
import { useNationStore, type BorderEntry } from '../stores/nations'
import { useTimeStore } from '../stores/time'
import { useSettingsStore } from '../stores/settings'
import type { HistoricalEvent } from '../lib/events'
import type { Ring } from '../lib/nations'
import { PaleoLayer } from '../lib/paleoLayer'
import { DayNightLayer } from '../lib/dayNightLayer'
import { CelestialLayer } from '../lib/celestialLayer'
import { CloudLayer, AtmosphereLayer } from '../lib/skyLayer'
import { textureBlend } from '../lib/paleo'
import { subsolarLongitude, cityLightsFactor } from '../lib/sun'
import { PALEO_FRAMES, MODERN_TEXTURE, NIGHT_TEXTURE } from '../data/paleoTextures'

const events = useEventStore()
const nations = useNationStore()
const time = useTimeStore()
const settings = useSettingsStore()
const el = useTemplateRef('el')

let globe: GlobeInstance | undefined
let paleo: PaleoLayer | undefined
let dayNight: DayNightLayer | undefined
let celestial: CelestialLayer | undefined
let clouds: CloudLayer | undefined
let atmosphere: AtmosphereLayer | undefined
let raf = 0
let resizeObs: ResizeObserver | undefined
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
  globe = new Globe(dom)
    .globeImageUrl(MODERN_TEXTURE)
    .bumpImageUrl('//unpkg.com/three-globe/example/img/earth-topology.png')
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

  globe.controls().autoRotate = true
  globe.controls().autoRotateSpeed = 0.5
  dom.addEventListener('pointerdown', () => (globe!.controls().autoRotate = false), { once: true })

  const radius = globe.getGlobeRadius()
  const base = import.meta.env.BASE_URL
  dayNight = new DayNightLayer(globe.scene(), radius, MODERN_TEXTURE, NIGHT_TEXTURE)
  paleo = new PaleoLayer(globe.scene(), radius, MODERN_TEXTURE)
  celestial = new CelestialLayer(globe.scene(), radius, `${base}textures/moon.jpg`)
  clouds = new CloudLayer(
    globe.scene(),
    radius,
    `${base}textures/clouds.png`,
    `${base}textures/clouds_bump.jpg`,
    `${base}textures/cirrus.png`,
  )
  atmosphere = new AtmosphereLayer(globe.scene(), radius)

  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const t0 = performance.now()
  const tick = () => {
    if (!still) clouds!.drift((performance.now() - t0) / 1000)
    raf = requestAnimationFrame(tick)
  }
  tick()

  const coords = (lat: number, lng: number, alt: number) => globe!.getCoords(lat, lng, alt)
  const sunDir = () => {
    const { x, y, z } = coords(0, subsolarLongitude(settings.sunHour), 1)
    return new Vector3(x, y, z).normalize()
  }
  const dirLight = globe.lights().find((l): l is DirectionalLight => l instanceof DirectionalLight)
  const ambient = globe.lights().find((l): l is AmbientLight => l instanceof AmbientLight)
  if (ambient) ambient.intensity = Math.min(ambient.intensity, 0.7) // let the night side be night

  stops.push(
    watchEffect(() => globe!.pointsData(events.visible.filter((e) => !e.area))),
    watchEffect(() => globe!.polygonsData([...nations.borders, ...eventAreas()])),
    watchEffect(() => paleo!.setBlend(textureBlend(PALEO_FRAMES, time.currentTime))),
    watchEffect(() => dayNight!.setCityLights(cityLightsFactor(time.currentTime))),
    watchEffect(() => {
      const dir = sunDir()
      dayNight!.setSunDirection(dir)
      dirLight?.position.copy(dir.clone().multiplyScalar(radius * 4)) // paleo eras lit by the same sun
      celestial!.setHour(settings.sunHour, coords)
      atmosphere!.setSunDirection(dir)
    }),
    watchEffect(() => (clouds!.visible = settings.clouds)),
    watchEffect(() => (atmosphere!.visible = settings.atmosphere)),
  )

  resizeObs = new ResizeObserver(() => globe?.width(dom.clientWidth).height(dom.clientHeight))
  resizeObs.observe(dom)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  stops.forEach((s) => s())
  clouds?.dispose()
  atmosphere?.dispose()
  paleo?.dispose()
  dayNight?.dispose()
  celestial?.dispose()
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
