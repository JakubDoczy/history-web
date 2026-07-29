<script setup lang="ts">
import { computed, ref, onMounted, useTemplateRef } from 'vue'
import { useEventStore } from '../stores/events'
import { useTimeStore } from '../stores/time'
import { useUiStore } from '../stores/ui'
import { formatYear } from '../lib/time'

const events = useEventStore()
const time = useTimeStore()
const ui = useUiStore()
const query = ref('')
const input = useTemplateRef<HTMLInputElement>('input')
const results = computed(() => events.search(query.value))

onMounted(() => input.value?.focus())

function pick(id: string) {
  const e = events.byId(id)!
  if (e.start < time.range.start || e.start > time.range.end) {
    const pad = Math.max(50, Math.abs(e.start) * 0.05)
    time.range = { start: e.start - pad, end: e.start + pad }
  }
  time.setTime(e.start)
  events.select(id)
  query.value = ''
  ui.close()
}
</script>

<template>
  <div class="sheet wrap">
    <input
      ref="input"
      v-model="query"
      placeholder="Search events"
      @keydown.escape="ui.close()"
      @keydown.enter="results[0] && pick(results[0].id)"
    />
    <ul v-if="results.length">
      <li v-for="e in results" :key="e.id" @mousedown.prevent="pick(e.id)">
        <span>{{ e.name }}</span>
        <span class="year">{{ formatYear(e.start) }}</span>
      </li>
    </ul>
    <p v-else-if="query.trim()" class="empty">No events match. Try a name or a tag like “war”.</p>
  </div>
</template>

<style scoped>
.wrap {
  position: absolute;
  top: 60px;
  right: 16px;
  width: min(320px, calc(100vw - 32px));
  padding: 8px;
  z-index: 6;
}
input {
  width: 100%;
  box-sizing: border-box;
  background: rgba(6, 10, 18, 0.7);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--frost);
  padding: 8px 12px;
  font-size: 14px;
}
input::placeholder { color: var(--muted); }
ul { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 2px; }
li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13.5px;
}
li:hover { background: rgba(227, 167, 88, 0.12); }
.year { color: var(--brass); font-family: var(--cond); font-size: 11px; white-space: nowrap; }
.empty { margin: 8px 10px 4px; font-size: 12.5px; color: var(--muted); }
@media (max-width: 640px) {
  .wrap { left: 16px; right: 16px; width: auto; }
}
</style>
