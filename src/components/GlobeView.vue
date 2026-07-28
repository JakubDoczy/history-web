<script setup lang="ts">
import { onMounted, onBeforeUnmount, useTemplateRef, watchEffect } from 'vue'
import Globe, { type GlobeInstance } from 'globe.gl'
import { useEventStore } from '../stores/events'
import type { HistoricalEvent } from '../lib/events'

const events = useEventStore()
const el = useTemplateRef('el')
let globe: GlobeInstance | undefined
let resizeObs: ResizeObserver | undefined
let stopSync: (() => void) | undefined

onMounted(() => {
  const dom = el.value!
  globe = new Globe(dom)
    .globeImageUrl('//unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
    .bumpImageUrl('//unpkg.com/three-globe/example/img/earth-topology.png')
    .backgroundImageUrl('//unpkg.com/three-globe/example/img/night-sky.png')
    .width(dom.clientWidth)
    .height(dom.clientHeight)
    .pointAltitude(0.02)
    .pointRadius((e) => 0.3 + ((e as HistoricalEvent).priority / 100) * 0.7)
    .pointColor((e) => (events.selectedId === (e as HistoricalEvent).id ? '#ff0' : '#f80'))
    .pointLabel((e) => (e as HistoricalEvent).name)
    .onPointClick((e) => events.select((e as HistoricalEvent).id))

  globe.controls().autoRotate = true
  globe.controls().autoRotateSpeed = 0.5
  dom.addEventListener('pointerdown', () => (globe!.controls().autoRotate = false), { once: true })

  stopSync = watchEffect(() => globe!.pointsData([...events.visible]))

  resizeObs = new ResizeObserver(() => globe?.width(dom.clientWidth).height(dom.clientHeight))
  resizeObs.observe(dom)
})

onBeforeUnmount(() => {
  stopSync?.()
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
