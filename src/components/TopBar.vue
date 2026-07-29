<script setup lang="ts">
import { computed } from 'vue'
import { useTimeStore } from '../stores/time'
import { useUiStore } from '../stores/ui'
import { formatYear } from '../lib/time'
import { eraAt } from '../lib/eras'

const time = useTimeStore()
const ui = useUiStore()
const era = computed(() => eraAt(time.currentTime))
</script>

<template>
  <header class="bar">
    <div class="mark">
      <span class="title">History</span>
      <span class="rule" />
      <span class="era" :style="{ color: era?.color }">{{ era?.name ?? 'Deep time' }}</span>
    </div>

    <div class="right">
      <span class="stamp">{{ formatYear(time.currentTime) }}</span>
      <button class="icon-btn" :class="{ on: ui.search }" aria-label="Search events" @click="ui.toggle('search')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" />
        </svg>
      </button>
      <button class="icon-btn" :class="{ on: ui.settings }" aria-label="Settings" @click="ui.toggle('settings')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
          <circle cx="15" cy="7" r="2" /><circle cx="8" cy="17" r="2" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  pointer-events: none;
}
.bar > * { pointer-events: auto; }
.mark { display: flex; align-items: center; gap: 10px; min-width: 0; }
.title {
  font-family: var(--cond);
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}
.rule { width: 18px; height: 1px; background: var(--line); flex: none; }
.era {
  font-family: var(--cond);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.right { display: flex; align-items: center; gap: 8px; }
.stamp {
  font-family: var(--cond);
  font-size: 13px;
  letter-spacing: 0.08em;
  color: var(--brass);
  padding-right: 4px;
  white-space: nowrap;
}
@media (max-width: 640px) {
  .title { font-size: 13px; letter-spacing: 0.16em; }
  .era { display: none; }
}
</style>
