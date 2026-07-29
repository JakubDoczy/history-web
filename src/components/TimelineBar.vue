<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, useTemplateRef } from 'vue'
import { useTimeStore } from '../stores/time'
import { formatYear, toWarp, fromWarp, type Year } from '../lib/time'

const time = useTimeStore()
const el = useTemplateRef('el')
const width = ref(1)

let resizeObs: ResizeObserver
onMounted(() => {
  width.value = el.value!.clientWidth
  resizeObs = new ResizeObserver(() => (width.value = el.value!.clientWidth))
  resizeObs.observe(el.value!)
})
onBeforeUnmount(() => resizeObs.disconnect())

const ws = () => toWarp(time.range.start)
const we = () => toWarp(time.range.end)
const toX = (t: Year) => ((toWarp(t) - ws()) / (we() - ws())) * width.value
const toT = (x: number): Year => fromWarp(ws() + (x / width.value) * (we() - ws()))

/** Ticks uniform in display space, each snapped to a locally-round year. */
const ticks = computed(() => {
  const [a, b] = [toWarp(time.range.start), toWarp(time.range.end)]
  const n = Math.max(2, Math.floor(width.value / 110))
  const out: Year[] = []
  for (let i = 0; i <= n; i++) {
    const u = a + ((b - a) * i) / n
    const local = fromWarp(u + (b - a) / n) - fromWarp(u) // local tick spacing in years
    const step = 10 ** Math.floor(Math.log10(Math.max(1, Math.abs(local))))
    const t = Math.round(fromWarp(u) / step) * step
    if (t !== out[out.length - 1]) out.push(t)
  }
  return out
})

// --- interactions: drag = pan, pinch/wheel = zoom, click = set time ---
const pointers = new Map<number, number>() // pointerId -> x
let dragged = false

const dist = () => {
  const [a, b] = [...pointers.values()]
  return Math.max(1, Math.abs(b - a))
}

function onPointerDown(e: PointerEvent) {
  pointers.set(e.pointerId, e.offsetX)
  dragged = false
  el.value!.setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return
  if (pointers.size === 1) {
    const dx = e.offsetX - pointers.get(e.pointerId)!
    if (Math.abs(dx) > 2) dragged = true
    time.pan(-dx / width.value)
  } else if (pointers.size === 2) {
    dragged = true
    const before = dist()
    pointers.set(e.pointerId, e.offsetX)
    const [a, b] = [...pointers.values()]
    time.zoom(before / dist(), (a + b) / 2 / width.value)
    return
  }
  pointers.set(e.pointerId, e.offsetX)
}

function onPointerUp(e: PointerEvent) {
  pointers.delete(e.pointerId)
  if (!dragged && pointers.size === 0) time.setTime(toT(e.offsetX))
}

function onWheel(e: WheelEvent) {
  time.zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, e.offsetX / width.value)
}
</script>

<template>
  <div
    ref="el"
    class="timeline"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel.prevent="onWheel"
  >
    <div v-for="t in ticks" :key="t" class="tick" :style="{ left: toX(t) + 'px' }">
      <span>{{ formatYear(t) }}</span>
    </div>
    <div class="cursor" :style="{ left: toX(time.currentTime) + 'px' }" />
  </div>
</template>

<style scoped>
.timeline {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 64px;
  background: rgba(10, 15, 25, 0.85);
  border-top: 1px solid #345;
  cursor: grab;
  touch-action: none;
  overflow: hidden;
  user-select: none;
}
.tick {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid #456;
  pointer-events: none;
}
.tick span {
  position: absolute;
  bottom: 6px;
  left: 4px;
  color: #9ab;
  font-size: 11px;
  white-space: nowrap;
}
.cursor {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #f80;
  box-shadow: 0 0 8px #f80;
  pointer-events: none;
}
</style>
