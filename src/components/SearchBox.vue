<script setup lang="ts">
import { ref, computed } from 'vue'
import { useEventStore } from '../stores/events'
import { useTimeStore } from '../stores/time'
import { formatYear } from '../lib/time'

const events = useEventStore()
const time = useTimeStore()
const query = ref('')
const open = ref(false)
const results = computed(() => events.search(query.value))

function pick(id: string) {
  const e = events.byId(id)!
  // widen the window if the target lies outside it, then center and select
  if (e.start < time.range.start || e.start > time.range.end) {
    const pad = Math.max(50, Math.abs(e.start) * 0.05)
    time.range = { start: e.start - pad, end: e.start + pad }
  }
  time.setTime(e.start)
  events.select(id)
  query.value = ''
  open.value = false
}
</script>

<template>
  <div class="search">
    <input
      v-model="query"
      placeholder="Search events…"
      @focus="open = true"
      @keydown.escape="query = ''; open = false"
      @keydown.enter="results[0] && pick(results[0].id)"
    />
    <ul v-if="open && results.length" class="results">
      <li v-for="e in results" :key="e.id" @mousedown.prevent="pick(e.id)">
        <span class="name">{{ e.name }}</span>
        <span class="year">{{ formatYear(e.start) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.search {
  position: absolute;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  width: min(320px, 70vw);
  z-index: 5;
}
input {
  width: 100%;
  box-sizing: border-box;
  background: rgba(10, 15, 25, 0.9);
  border: 1px solid #345;
  border-radius: 16px;
  color: #dde;
  padding: 6px 14px;
  font-size: 0.9rem;
}
input::placeholder { color: #789; }
.results {
  list-style: none;
  margin: 4px 0 0;
  padding: 4px;
  background: rgba(10, 15, 25, 0.95);
  border: 1px solid #345;
  border-radius: 10px;
}
li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
}
li:hover { background: #234; }
.name { color: #dde; }
.year { color: #f80; font-size: 0.8rem; white-space: nowrap; }
</style>
