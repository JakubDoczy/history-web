<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEventStore } from '../stores/events'
import { useTimeStore } from '../stores/time'
import { formatYear } from '../lib/time'

const events = useEventStore()
const time = useTimeStore()
const query = ref('')

const matches = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (q.length < 2) return []
  return events.all
    .filter((e) => e.name.toLowerCase().includes(q))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 8)
})

function pick(id: string) {
  const e = events.byId(id)!
  events.select(id)
  time.focusTime(e.start)
  query.value = ''
}
</script>

<template>
  <div class="search">
    <input v-model="query" type="search" placeholder="Search events…" />
    <ul v-if="matches.length">
      <li v-for="e in matches" :key="e.id" @click="pick(e.id)">
        <span>{{ e.name }}</span>
        <small>{{ formatYear(e.start) }}</small>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.search {
  position: absolute;
  top: 3rem;
  left: 50%;
  transform: translateX(-50%);
  width: min(300px, 70vw);
}
input {
  width: 100%;
  box-sizing: border-box;
  background: rgba(10, 15, 25, 0.85);
  border: 1px solid #345;
  border-radius: 12px;
  color: #dde;
  padding: 5px 12px;
  font-size: 0.9rem;
  outline: none;
}
input:focus {
  border-color: #f80;
}
ul {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  background: rgba(10, 15, 25, 0.95);
  border: 1px solid #345;
  border-radius: 8px;
  overflow: hidden;
}
li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  color: #dde;
  cursor: pointer;
}
li:hover {
  background: #234;
}
small {
  color: #f80;
  white-space: nowrap;
}
</style>
