<script setup lang="ts">
import { computed } from 'vue'
import { usePointsStore } from '../stores/points'
import { kindLabel, pointIconSvg } from '../lib/points'
import { formatYear } from '../lib/time'

/**
 * THE POINT CHIP — what clicking a point on the globe opens.
 *
 * Deliberately NOT the event panel: a point carries a name, a kind and an era
 * window, and a panel with tabs around three facts would be furniture. One
 * line of identity, one line of context, a close button. It sits just above
 * the timeline rail, where a glance from the globe lands anyway, and it
 * follows the marker's own life: scrubbing the year out of the point's era
 * takes the marker off the globe and the chip goes with it (see `selected` in
 * stores/points.ts).
 */
const points = usePointsStore()

/** The chip's icon, in the panel's own brass rather than the map's ink. */
const icon = computed(() =>
  points.selected ? pointIconSvg(points.selected.kind, 'var(--brass)', 'transparent', 18) : '',
)

const eraLine = computed(() => {
  const p = points.selected
  if (!p) return ''
  const span = `${formatYear(p.from)} – ${p.to === undefined ? 'present' : formatYear(p.to)}`
  return `${kindLabel(p.kind)} · ${span}`
})
</script>

<template>
  <Transition name="pop">
    <div v-if="points.selected" class="sheet chip" data-test="point-chip">
      <span class="icon" aria-hidden="true" v-html="icon" />
      <div class="text">
        <strong>{{ points.selected.name }}</strong>
        <span class="meta tnum">{{ eraLine }}</span>
        <span v-if="points.selected.note" class="note">{{ points.selected.note }}</span>
      </div>
      <button class="close" aria-label="Dismiss" @click="points.dismiss()">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.chip {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--rail-clear) + var(--s3) + var(--safe-b, 0px));
  z-index: var(--z-timeline);
  display: flex;
  align-items: flex-start;
  gap: var(--s3);
  padding: var(--s2) var(--s3);
  max-width: min(420px, calc(100vw - 2 * var(--s4)));
}
.icon {
  display: grid;
  place-items: center;
  flex: none;
  margin-top: 2px;
}
.text {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.text strong {
  font-size: var(--t-md);
  color: var(--frost);
  font-weight: 600;
  line-height: 1.3;
}
.meta {
  font-family: var(--cond);
  font-size: var(--t-sm);
  letter-spacing: 0.05em;
  color: var(--brass);
}
.note {
  font-size: var(--t-sm);
  color: var(--muted);
  line-height: 1.4;
}
.close {
  display: grid;
  place-items: center;
  flex: none;
  background: none;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--muted);
  width: 24px;
  height: 24px;
  cursor: pointer;
  transition:
    border-color var(--fast),
    color var(--fast);
}
.close:hover {
  border-color: var(--brass-line);
  color: var(--brass);
}
@media (max-width: 640px) {
  .chip {
    max-width: calc(100vw - 2 * var(--s3));
  }
  .close {
    width: 36px;
    height: 36px;
  }
}
</style>
