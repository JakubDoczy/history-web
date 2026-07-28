<script setup lang="ts">
import { onMounted, onBeforeUnmount, useTemplateRef, watchEffect } from 'vue'
import Globe, { type GlobeInstance } from 'globe.gl'
import { useEventStore } from '../stores/events'
import { useNationStore, type BorderEntry } from '../stores/nations'
import { useTimeStore } from '../stores/time'
import type { HistoricalEvent } from '../lib/events'
import { PaleoLayer } from '../lib/paleoLayer'
import { textureBlend } from '../lib/paleo'
import { PALEO_FRAMES, MODERN_TEXTURE } from '../data/paleoTextures'

const events = useEventStore()
const time = useTimeStore()
const nations = useNationStore()
const el = useTemplateRef('el')
let globe: GlobeInstance | undefined
let paleo: PaleoLayer | undefined
let resizeObs: ResizeObserver | undefined
const stops: (() => void)[] = []

const asEvent = (d: object) => d as HistoricalEvent
const asBorder = (d: object) => d as BorderEntry
const closed = (ring: [number, number][]) => [...ring, ring[0]]

onMounted(() => {
  const dom = el.value!
  globe = new Globe(dom)
    .globeImageUrl('//unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
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
    // nations layer: semi-transparent caps so overlaps blend visibly
    // three-globe's GeoJsonGeometry type declares coordinates as number[], which is
    // narrower than real GeoJSON — cast at this boundary only.
    .polygonGeoJsonGeometry((d) => ({
      type: 'Polygon',
      coordinates: [closed(asBorder(d).ring)] as unknown as number[],
    }))
    .polygonCapColor((d) => (asBorder(d).kind === 'full' ? asBorder(d).nation.color + '50' : 'rgba(0,0,0,0)'))
    .polygonSideColor(() => 'rgba(0,0,0,0)')
    .polygonStrokeColor((d) => {
      const b = asBorder(d)
      return b.kind === 'full' ? b.nation.color : b.kind === 'max' ? b.nation.color + 'aa' : '#ffffffaa'
    })
    .polygonAltitude((d) => (asBorder(d).kind === 'full' ? 0.008 : 0.005))
    .polygonLabel((d) => {
      const b = asBorder(d)
      return b.kind === 'full' ? b.nation.name : `${b.nation.name} (${b.kind} extent in view)`
    })
    .polygonsTransitionDuration(300)

  globe.controls().autoRotate = true
  globe.controls().autoRotateSpeed = 0.5
  dom.addEventListener('pointerdown', () => (globe!.controls().autoRotate = false), { once: true })

  paleo = new PaleoLayer(globe.scene(), globe.getGlobeRadius(), MODERN_TEXTURE)

  stops.push(
    watchEffect(() => globe!.pointsData([...events.visible])),
    watchEffect(() => globe!.polygonsData([...nations.borders])),
    watchEffect(() => paleo!.setBlend(textureBlend(PALEO_FRAMES, time.currentTime))),
  )

  resizeObs = new ResizeObserver(() => globe?.width(dom.clientWidth).height(dom.clientHeight))
  resizeObs.observe(dom)
})

onBeforeUnmount(() => {
  stops.forEach((s) => s())
  paleo?.dispose()
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
