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
      <span class="era">
        <i class="dot" :style="{ background: era?.color }" />
        <span class="era-name">{{ era?.name ?? 'Deep time' }}</span>
      </span>
    </div>

    <div class="right">
      <span class="stamp tnum">{{ formatYear(time.currentTime) }}</span>
      <button
        class="icon-btn"
        :class="{ on: ui.search }"
        aria-label="Search events"
        @click="ui.toggle('search')"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.6-3.6" />
        </svg>
      </button>
      <button
        class="icon-btn"
        :class="{ on: ui.settings }"
        aria-label="Settings"
        @click="ui.toggle('settings')"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
          <circle cx="15" cy="7" r="2" />
          <circle cx="8" cy="17" r="2" />
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
  gap: var(--s3);
  padding: calc(var(--s3) + var(--safe-t)) calc(var(--s4) + var(--safe-r)) var(--s3)
    calc(var(--s4) + var(--safe-l));
  pointer-events: none;
  z-index: 9;
}
/* a whisper of scrim so the wordmark survives a bright limb of the globe */
.bar::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(6, 10, 18, 0.62), rgba(6, 10, 18, 0));
  pointer-events: none;
}
.bar > * {
  pointer-events: auto;
  position: relative;
}

.mark {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-width: 0;
}
.title {
  font-family: var(--cond);
  font-weight: 600;
  font-size: var(--t-lg);
  letter-spacing: 0.22em;
  text-transform: uppercase;
}
.rule {
  width: 18px;
  height: 1px;
  background: var(--line);
  flex: none;
}
.era {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--frost-dim);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  background: var(--muted);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.07);
  transition: background-color var(--slow);
}
.era-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.right {
  display: flex;
  align-items: center;
  gap: var(--s2);
}
.stamp {
  font-family: var(--cond);
  font-size: var(--t-md);
  letter-spacing: 0.08em;
  color: var(--brass);
  padding-right: var(--s1);
  white-space: nowrap;
}

@media (max-width: 640px) {
  .bar {
    padding-left: calc(var(--s3) + var(--safe-l));
    padding-right: calc(var(--s3) + var(--safe-r));
  }
  .title {
    font-size: var(--t-md);
    letter-spacing: 0.16em;
  }
  .rule,
  .era {
    display: none;
  }
  /* comfortable touch targets */
  .right :deep(.icon-btn) {
    width: 40px;
    height: 40px;
  }
}
</style>
