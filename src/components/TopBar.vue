<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useTimeStore } from '../stores/time'
import { useUiStore } from '../stores/ui'
import { formatYear } from '../lib/time'
import { HISTORICAL, erasOverlapping, spanEraLabel, type Era } from '../lib/eras'

const time = useTimeStore()
const ui = useUiStore()

// The chip names the *selection* — that is what the globe is showing — and
// opens a picker that sets the selection to a whole era.
const touched = computed(() => erasOverlapping(time.selection.start, time.selection.end))
const era = computed(() => touched.value[0])
const label = computed(() => spanEraLabel(time.selection.start, time.selection.end))
const isCurrent = (e: Era) => touched.value.includes(e)

const open = ref(false)
function pick(e: Era) {
  time.selectEra(e)
  open.value = false
}
// click-away and Escape, captured on the document so a globe drag also dismisses
const onDocDown = (e: PointerEvent) => {
  if (!(e.target as Element).closest?.('.era-picker')) open.value = false
}
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') open.value = false
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocDown, true)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <header class="bar">
    <div class="mark">
      <span class="title">History</span>
      <span class="rule" />
      <div class="era-picker">
        <button
          class="era"
          :class="{ on: open }"
          aria-haspopup="listbox"
          :aria-expanded="open"
          aria-label="Selected era"
          @click="open = !open"
        >
          <i class="dot" :style="{ background: era?.color }" />
          <span class="era-name">{{ label }}</span>
          <!-- a phone has no room for a range of eras; the first one names it well enough -->
          <span class="era-name short">{{ era?.name ?? 'Deep time' }}</span>
          <svg class="caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </button>
        <Transition name="pop">
          <ul v-if="open" class="menu sheet" role="listbox">
            <li v-for="e in HISTORICAL" :key="e.name">
              <button
                class="opt"
                role="option"
                :aria-selected="isCurrent(e)"
                :class="{ sel: isCurrent(e) }"
                @click="pick(e)"
              >
                <i class="dot" :style="{ background: e.color }" />
                <span class="opt-name">{{ e.name }}</span>
                <span class="opt-span tnum">
                  {{ formatYear(e.start) }} – {{ formatYear(e.end) }}
                </span>
              </button>
            </li>
          </ul>
        </Transition>
      </div>
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
  z-index: var(--z-topbar);
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
.era-picker {
  position: relative;
  min-width: 0;
}
.era {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 250px;
  height: 26px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: var(--r-md);
  background: transparent;
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--frost-dim);
  cursor: pointer;
  transition:
    border-color var(--fast),
    color var(--fast),
    background-color var(--fast);
}
.era:hover {
  border-color: var(--line);
  background: rgba(13, 20, 32, 0.7);
  color: var(--frost);
}
.era.on {
  border-color: var(--brass-line);
  background: var(--brass-soft);
  color: var(--brass);
}
.caret {
  flex: none;
  opacity: 0.7;
}
.era.on .caret {
  transform: rotate(180deg);
}

.menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  margin: 0;
  padding: var(--s1);
  list-style: none;
  min-width: 224px;
  max-height: 60vh;
  overflow-y: auto;
}
.opt {
  display: flex;
  align-items: center;
  gap: var(--s2);
  width: 100%;
  padding: 7px var(--s2);
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--frost);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--fast);
}
.opt:hover {
  background: rgba(255, 255, 255, 0.06);
}
.opt.sel {
  color: var(--brass);
}
.opt-name {
  font-family: var(--cond);
  font-size: var(--t-sm);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  flex: 1;
  white-space: nowrap;
}
.opt-span {
  font-family: var(--cond);
  font-size: var(--t-xs);
  color: var(--muted);
  white-space: nowrap;
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
.era-name.short {
  display: none;
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
  .rule {
    display: none;
  }
  /* the picker stays — it is the fastest way to move around on a phone */
  .era-name {
    display: none;
  }
  .era-name.short {
    display: block;
  }
  /* no room for the caret next to the year stamp; the framed chip reads as a control */
  .caret {
    display: none;
  }
  .era {
    height: 34px;
    max-width: 126px;
    font-size: var(--t-micro);
    letter-spacing: 0.05em;
    border-color: var(--line);
  }
  .menu {
    min-width: 208px;
  }
  .opt {
    padding: 10px var(--s2);
  }
  /* comfortable touch targets */
  .right :deep(.icon-btn) {
    width: 40px;
    height: 40px;
  }
}
</style>
