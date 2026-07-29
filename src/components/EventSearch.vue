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
    <input v-model="query" type="search" placeholder="Search events…" aria-label="Search events" />
    <ul v-if="matches.length">
      <li v-for="e in matches" :key="e.id" @click="pick(e.id)">
        <span class="name">{{ e.name }}</span>
        <small class="tnum">{{ formatYear(e.start) }}</small>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.search {
  position: absolute;
  top: calc(3rem + var(--safe-t));
  left: 50%;
  transform: translateX(-50%);
  width: min(300px, 70vw);
  z-index: 6;
}
input {
  width: 100%;
  box-sizing: border-box;
  background: rgba(6, 10, 18, 0.75);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  color: var(--frost);
  padding: 9px 13px;
  font-size: 14px;
  outline: none;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  transition:
    border-color var(--fast),
    box-shadow var(--fast),
    background-color var(--fast);
}
input::placeholder {
  color: var(--muted);
}
input:hover {
  border-color: #2b3d58;
}
input:focus {
  border-color: var(--brass-line);
  background: rgba(6, 10, 18, 0.92);
  box-shadow: 0 0 0 3px var(--brass-soft);
}
ul {
  list-style: none;
  margin: 6px 0 0;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--lift);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  overflow: hidden;
}
li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s3);
  padding: 8px 10px;
  border-radius: 7px;
  color: var(--frost);
  font-size: var(--t-md);
  cursor: pointer;
  transition:
    background-color var(--fast),
    color var(--fast);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
li:hover {
  background: var(--brass-soft);
  color: #fff;
}
li:active {
  background: rgba(227, 167, 88, 0.2);
}
small {
  color: var(--brass);
  font-family: var(--cond);
  font-size: var(--t-xs);
  white-space: nowrap;
  flex: none;
}

@media (max-width: 640px) {
  input {
    font-size: 16px;
  }
  li {
    min-height: 40px;
  }
}
</style>
