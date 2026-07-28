<script setup lang="ts">
import { useEventStore } from '../stores/events'
import { useNationStore } from '../stores/nations'

const events = useEventStore()
const nations = useNationStore()
const active = (t: string) => events.filter.tags?.includes(t)
</script>

<template>
  <div class="filters">
    <button
      v-for="t in events.allTags"
      :key="t"
      :class="{ active: active(t) }"
      @click="events.toggleTag(t)"
    >{{ t }}</button>
    <button :class="{ active: nations.showExtremes }" @click="nations.toggleExtremes()">borders ±</button>
    <button v-if="events.filter.parent" class="active" @click="events.setParentFilter()">
      family: {{ events.byId(events.filter.parent)?.name }} ✕
    </button>
  </div>
</template>

<style scoped>
.filters {
  position: absolute;
  top: 1rem;
  left: 1rem;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 45vw;
}
button {
  background: rgba(10, 15, 25, 0.85);
  border: 1px solid #345;
  border-radius: 12px;
  color: #9ab;
  padding: 2px 10px;
  font-size: 0.8rem;
  cursor: pointer;
}
button.active { color: #fff; border-color: #f80; background: rgba(80, 40, 0, 0.6); }
</style>
