<script setup lang="ts">
import { computed } from 'vue'
import { useViewStore } from '../stores/view'
import { kmPerPixel, niceScale, formatDistance } from '../lib/scale'

const view = useViewStore()
const bar = computed(() => niceScale(kmPerPixel(view.altitude, view.fov, view.viewportPx)))
</script>

<template>
  <div class="scale" aria-label="Map scale">
    <span class="tnum">{{ formatDistance(bar.km) }}</span>
    <div class="rule" :style="{ width: Math.round(bar.px) + 'px' }" />
  </div>
</template>

<style scoped>
.scale {
  position: absolute;
  left: calc(var(--s4) + var(--safe-l));
  bottom: calc(var(--rail-clear) + var(--s3));
  display: grid;
  gap: 3px;
  justify-items: start;
  pointer-events: none;
  user-select: none;
  z-index: var(--z-scalebar);
}
span {
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.08em;
  color: var(--frost);
  text-shadow:
    0 1px 4px rgba(0, 0, 0, 0.9),
    0 0 2px rgba(0, 0, 0, 0.9);
}
.rule {
  height: 6px;
  border: 1px solid var(--frost);
  border-top: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
  filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.9));
  transition: width var(--slow);
}
</style>
