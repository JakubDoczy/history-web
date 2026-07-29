<script setup lang="ts">
import { computed } from 'vue'
import { useViewStore } from '../stores/view'
import { kmPerPixel, niceScale, formatDistance } from '../lib/scale'

const view = useViewStore()
const bar = computed(() => niceScale(kmPerPixel(view.altitude, view.fov, view.viewportPx)))
</script>

<template>
  <div class="scale" aria-label="Map scale">
    <span>{{ formatDistance(bar.km) }}</span>
    <div class="rule" :style="{ width: Math.round(bar.px) + 'px' }" />
  </div>
</template>

<style scoped>
.scale {
  position: absolute;
  left: 16px;
  bottom: calc(var(--rail) + 14px);
  display: grid;
  gap: 3px;
  justify-items: start;
  pointer-events: none;
  user-select: none;
}
span {
  font-family: var(--cond);
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--frost);
  text-shadow: 0 1px 3px #000;
}
.rule {
  height: 6px;
  border: 1px solid var(--frost);
  border-top: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
  transition: width 0.18s var(--ease);
}
</style>
