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
    aria-label="Timeline — drag to pan, scroll or pinch to zoom"
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
        :title="s.name"
        :style="{ left: s.x + 'px', width: s.w + 'px', background: s.color }"
      >
        <!-- only label a band wide enough for the whole word; a clipped era name is worse than none -->
        <span v-if="s.w > s.name.length * 7 + 14">{{ s.name }}</span>
      </div>
    </div>

    <div class="ruler">
      <div v-for="t in ticks" :key="t" class="tick" :style="{ left: toX(t) + 'px' }">
        <span class="tnum">{{ formatYear(t) }}</span>
      </div>
    </div>

    <div
      class="cursor"
      :class="{ flip: toX(time.currentTime) > width - 84 }"
      :style="{ left: toX(time.currentTime) + 'px' }"
    >
      <span class="knob" />
      <span class="flag tnum">{{ formatYear(time.currentTime) }}</span>
    </div>
  </div>
</template>

<style scoped>
.rail {
  --band-h: 22px;
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: calc(var(--rail) + var(--safe-b));
  padding-bottom: var(--safe-b);
  box-sizing: border-box;
  background: linear-gradient(180deg, rgba(6, 10, 18, 0.55), rgba(6, 10, 18, 0.97) 42%);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-top: 1px solid var(--line);
  cursor: grab;
  touch-action: none;
  overflow: hidden;
  user-select: none;
  z-index: var(--z-timeline);
}
.rail:active {
  cursor: grabbing;
}

.strata {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--band-h);
  /* a hairline of shadow under the strip separates it from the ruler */
  box-shadow: 0 1px 0 rgba(6, 10, 18, 0.9);
}
.band {
  position: absolute;
  top: 0;
  height: 100%;
  display: grid;
  place-items: center;
  border-right: 1px solid rgba(6, 10, 18, 0.5);
  overflow: hidden;
}
/* darken the foot of each band so the label always has something to sit on */
.band::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(0, 0, 0, 0.28));
}
.band span {
  position: relative;
  font-family: var(--cond);
  font-size: var(--t-micro);
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.75);
  white-space: nowrap;
  padding: 0 6px;
}

.ruler {
  position: absolute;
  top: var(--band-h);
  bottom: var(--safe-b);
  left: 0;
  right: 0;
}
.tick {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--line-soft);
  pointer-events: none;
}
/* a stronger stub at the top of each gridline reads as a real ruler */
.tick::before {
  content: '';
  position: absolute;
  top: 0;
  left: -1px;
  width: 1px;
  height: 8px;
  background: var(--line);
}
.tick span {
  position: absolute;
  top: 5px;
  left: 7px;
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.06em;
  color: var(--frost-dim);
  white-space: nowrap;
}

.cursor {
  position: absolute;
  top: 0;
  bottom: var(--safe-b);
  width: 1px;
  background: var(--ember);
  box-shadow: 0 0 10px rgba(226, 101, 62, 0.7);
  pointer-events: none;
}
.knob {
  position: absolute;
  top: -1px;
  left: -3px;
  width: 7px;
  height: 7px;
  background: var(--ember);
  border-radius: 0 0 4px 4px;
}
.flag {
  position: absolute;
  bottom: 9px;
  left: 6px;
  font-family: var(--cond);
  font-size: var(--t-xs);
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--void);
  background: var(--ember);
  padding: 2px 7px;
  border-radius: 4px;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(226, 101, 62, 0.35);
}
/* near the right edge the label would be clipped, so hang it on the other side */
.cursor.flip .flag {
  left: auto;
  right: 6px;
}
</style>
