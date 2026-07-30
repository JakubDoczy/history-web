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
    <div class="field">
      <svg
        class="glyph"
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.6-3.6" />
      </svg>
      <input
        ref="input"
        v-model="query"
        type="search"
        placeholder="Search events"
        aria-label="Search events"
        @keydown.escape="ui.close()"
        @keydown.enter="results[0] && pick(results[0].id)"
      />
    </div>

    <ul v-if="results.length" class="scroll-y">
      <li
        v-for="(e, i) in results"
        :key="e.id"
        :class="{ first: i === 0 }"
        @mousedown.prevent="pick(e.id)"
      >
        <span class="name">{{ e.name }}</span>
        <span class="year tnum">{{ formatYear(e.start) }}</span>
      </li>
    </ul>
    <p v-else-if="query.trim()" class="empty">No events match. Try a name or a tag like “war”.</p>
    <p v-else class="empty">Type to find an event — then Enter to jump there.</p>
  </div>
</template>

<style scoped>
.wrap {
  position: absolute;
  top: calc(58px + var(--safe-t));
  right: calc(var(--s4) + var(--safe-r));
  width: min(320px, calc(100vw - 2 * var(--s4)));
  padding: var(--s2);
  z-index: var(--z-search);
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - var(--rail-clear) - 88px);
}

.field {
  position: relative;
  flex: none;
}
.glyph {
  position: absolute;
  left: 11px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--muted);
  pointer-events: none;
  transition: color var(--fast);
}
.field:focus-within .glyph {
  color: var(--brass);
}
input {
  width: 100%;
  box-sizing: border-box;
  background: rgba(6, 10, 18, 0.7);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--frost);
  padding: 9px 12px 9px 33px;
  font-size: 14px;
  outline: none;
  transition:
    border-color var(--fast),
    box-shadow var(--fast),
    background-color var(--fast);
}
input:hover {
  border-color: #2b3d58;
}
input:focus {
  border-color: var(--brass-line);
  background: rgba(6, 10, 18, 0.9);
  box-shadow: 0 0 0 3px var(--brass-soft);
}
input::placeholder {
  color: var(--muted);
}
input::-webkit-search-cancel-button {
  filter: invert(0.6);
  cursor: pointer;
}

ul {
  list-style: none;
  margin: var(--s2) 0 0;
  padding: 0;
  /* rows keep their own height when the list is taller than the panel */
  align-content: start;
  grid-auto-rows: min-content;
  display: grid;
  gap: 1px;
  min-height: 0;
}
li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s3);
  padding: 8px 10px;
  border-radius: 7px;
  cursor: pointer;
  font-size: var(--t-md);
  transition:
    background-color var(--fast),
    color var(--fast);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* the first row is what Enter selects — mark it quietly */
li.first {
  box-shadow: inset 2px 0 0 var(--brass-line);
}
li:hover,
li.first:hover {
  background: var(--brass-soft);
  color: #fff;
}
li:active {
  background: rgba(227, 167, 88, 0.2);
}
.year {
  color: var(--brass);
  font-family: var(--cond);
  font-size: var(--t-xs);
  white-space: nowrap;
  flex: none;
}
.empty {
  margin: var(--s2) 10px var(--s1);
  font-size: var(--t-sm);
  color: var(--muted);
  line-height: 1.5;
}

@media (max-width: 640px) {
  .wrap {
    top: calc(60px + var(--safe-t));
    left: calc(var(--s3) + var(--safe-l));
    right: calc(var(--s3) + var(--safe-r));
    width: auto;
    max-height: min(60dvh, calc(100dvh - var(--rail-clear) - 80px));
  }
  input {
    padding-top: 11px;
    padding-bottom: 11px;
    font-size: 16px; /* no iOS zoom on focus */
  }
  li {
    min-height: 44px;
    box-sizing: border-box;
    padding: 9px 10px;
  }
}
</style>
