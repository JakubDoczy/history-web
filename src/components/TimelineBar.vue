<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, useTemplateRef } from 'vue'
import { useTimeStore } from '../stores/time'
import { formatYear, toWarp, fromWarp, type Year } from '../lib/time'
import { bandsFor } from '../lib/eras'

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
  const [a, b] = [ws(), we()]
  const n = Math.max(2, Math.floor(width.value / 110))
  const out: Year[] = []
  for (let i = 0; i <= n; i++) {
    const u = a + ((b - a) * i) / n
    const local = fromWarp(u + (b - a) / n) - fromWarp(u)
    const step = 10 ** Math.floor(Math.log10(Math.max(1, Math.abs(local))))
    const t = Math.round(fromWarp(u) / step) * step
    if (t !== out[out.length - 1]) out.push(t)
  }
  return out
})

/** Era strata clipped to the visible window. */
const strata = computed(() =>
  bandsFor(time.range.start, time.range.end).map((e) => {
    const x0 = Math.max(0, toX(e.start))
    const x1 = Math.min(width.value, toX(e.end))
    return { ...e, x: x0, w: Math.max(0, x1 - x0) }
  }),
)

// --- interactions: drag = pan, pinch/wheel = zoom, click = set time ---
const pointers = new Map<number, number>()
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
    class="rail"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel.prevent="onWheel"
  >
    <!-- strata: the geological/historical column, laid horizontal -->
    <div class="strata">
      <div
        v-for="s in strata"
        :key="s.name"
        class="band"
        :style="{ left: s.x + 'px', width: s.w + 'px', background: s.color }"
      >
        <span v-if="s.w > 64">{{ s.name }}</span>
      </div>
    </div>

    <div class="ruler">
      <div v-for="t in ticks" :key="t" class="tick" :style="{ left: toX(t) + 'px' }">
        <span>{{ formatYear(t) }}</span>
      </div>
    </div>

    <div class="cursor" :style="{ left: toX(time.currentTime) + 'px' }">
      <span class="flag">{{ formatYear(time.currentTime) }}</span>
    </div>
  </div>
</template>

<style scoped>
.rail {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: var(--rail);
  background: linear-gradient(180deg, rgba(6, 10, 18, 0.55), rgba(6, 10, 18, 0.96) 42%);
  border-top: 1px solid var(--line);
  cursor: grab;
  touch-action: none;
  overflow: hidden;
  user-select: none;
}
.rail:active { cursor: grabbing; }

.strata {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 20px;
}
.band {
  position: absolute;
  top: 0;
  height: 100%;
  display: grid;
  place-items: center;
  border-right: 1px solid rgba(6, 10, 18, 0.55);
  opacity: 0.82;
  overflow: hidden;
}
.band span {
  font-family: var(--cond);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.88);
  white-space: nowrap;
}

.ruler { position: absolute; top: 20px; bottom: 0; left: 0; right: 0; }
.tick {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--line-soft);
  pointer-events: none;
}
.tick span {
  position: absolute;
  top: 6px;
  left: 6px;
  font-family: var(--cond);
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--muted);
  white-space: nowrap;
}

.cursor {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--ember);
  box-shadow: 0 0 10px rgba(226, 101, 62, 0.7);
  pointer-events: none;
}
.flag {
  position: absolute;
  bottom: 8px;
  left: 6px;
  font-family: var(--cond);
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--void);
  background: var(--ember);
  padding: 1px 6px;
  border-radius: 3px;
  white-space: nowrap;
}
</style>
