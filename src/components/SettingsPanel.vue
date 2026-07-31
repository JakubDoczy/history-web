<script setup lang="ts">
import { ref } from 'vue'
import { useEventStore } from '../stores/events'
import { useNationStore } from '../stores/nations'
import { useSettingsStore, MAX_EVENTS } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useViewStore } from '../stores/view'

const events = useEventStore()
const nations = useNationStore()
const settings = useSettingsStore()
const ui = useUiStore()
const view = useViewStore()

type Section = 'events' | 'imagery' | 'sky' | 'light' | 'display'
const open = ref<Section | null>('imagery')
const toggleSection = (s: Section) => (open.value = open.value === s ? null : s)

const tagOn = (t: string) => events.filter.tags?.includes(t) ?? false

const clock = () => {
  const h = Math.floor(settings.sunHour)
  const m = Math.round((settings.sunHour - h) * 60)
  return `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')} UTC`
}

const metres = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`)

const imageryLine = () => {
  if (!settings.detail) return 'Off — showing the base map only.'
  if (view.detailStatus === 'loading') return 'Loading imagery…'
  if (view.detailStatus === 'unavailable') return 'Imagery service unreachable.'
  if (view.detailStatus === 'ready') {
    const r = view.detailGroundRes
    return `${view.detailSource}${r ? ` · ${metres(r)} per pixel` : ''}`
  }
  return 'Zoom in to stream sharper imagery.'
}
</script>

<template>
  <aside class="sheet panel">
    <header class="head">
      <span class="eyebrow">Settings</span>
      <button class="close" aria-label="Close settings" @click="ui.close()">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </header>

    <div class="scroll scroll-y">
      <section>
        <button
          class="row-head"
          :class="{ open: open === 'events' }"
          :aria-expanded="open === 'events'"
          @click="toggleSection('events')"
        >
          <span>Events</span>
          <svg
            class="chev"
            :class="{ up: open === 'events' }"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div v-if="open === 'events'" class="body">
          <p class="hint">
            {{ events.filter.tags?.length ? 'Filtered by tag.' : 'Showing all categories.' }}
          </p>
          <div class="chips">
            <button
              v-for="t in events.allTags"
              :key="t"
              :class="{ on: tagOn(t) }"
              @click="events.toggleTag(t)"
            >
              {{ t }}
            </button>
          </div>
          <label class="slider-row" for="max-events"
            ><span>Events on globe</span><strong class="tnum">{{ settings.maxEvents }}</strong></label
          >
          <input
            id="max-events"
            v-model.number="settings.maxEvents"
            type="range"
            :min="MAX_EVENTS.min"
            :max="MAX_EVENTS.max"
            :step="MAX_EVENTS.step"
          />
          <p class="hint">The highest-priority events in the window; the rest are hidden.</p>
          <button
            v-if="events.filter.tags?.length || events.filter.parent"
            class="link"
            @click="events.clearFilter()"
          >
            Clear all filters
          </button>
        </div>
      </section>

      <section>
        <button
          class="row-head"
          :class="{ open: open === 'imagery' }"
          :aria-expanded="open === 'imagery'"
          @click="toggleSection('imagery')"
        >
          <span>Imagery</span>
          <svg
            class="chev"
            :class="{ up: open === 'imagery' }"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div v-if="open === 'imagery'" class="body">
          <label class="row">
            <input type="checkbox" :checked="settings.detail" @change="settings.toggle('detail')" />
            <span>Stream high-detail imagery</span>
          </label>
          <p class="hint status" :class="view.detailStatus"><i class="led" />{{ imageryLine() }}</p>
          <p class="hint">
            Streams in every era. Before 1930 the zoom stops at a 20 km view, so modern
            cities never fill the screen in a century that had none.
          </p>
          <label class="row">
            <input type="checkbox" :checked="settings.relief" @change="settings.toggle('relief')" />
            <span>Terrain relief shading</span>
          </label>
          <p class="hint credit">
            {{ view.detailAttribution || 'Imagery: NASA GIBS / Worldview' }}
          </p>
        </div>
      </section>

      <section>
        <button
          class="row-head"
          :class="{ open: open === 'sky' }"
          :aria-expanded="open === 'sky'"
          @click="toggleSection('sky')"
        >
          <span>Sky</span>
          <svg
            class="chev"
            :class="{ up: open === 'sky' }"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div v-if="open === 'sky'" class="body">
          <label class="row">
            <input type="checkbox" :checked="settings.clouds" @change="settings.toggle('clouds')" />
            <span>Cloud cover</span>
          </label>
          <label class="row">
            <input
              type="checkbox"
              :checked="settings.cloudShadows"
              @change="settings.toggle('cloudShadows')"
            />
            <span>Cloud shadows</span>
          </label>
          <label class="row">
            <input
              type="checkbox"
              :checked="settings.atmosphere"
              @change="settings.toggle('atmosphere')"
            />
            <span>Atmospheric glow</span>
          </label>
          <p class="hint">All fade out as you zoom in close.</p>
        </div>
      </section>

      <section>
        <button
          class="row-head"
          :class="{ open: open === 'light' }"
          :aria-expanded="open === 'light'"
          @click="toggleSection('light')"
        >
          <span>Light &amp; motion</span>
          <svg
            class="chev"
            :class="{ up: open === 'light' }"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div v-if="open === 'light'" class="body">
          <label class="slider-row"
            ><span>Time of day</span><strong>{{ clock() }}</strong></label
          >
          <input v-model.number="settings.sunHour" type="range" min="0" max="23.75" step="0.25" />
          <label class="row">
            <input
              type="checkbox"
              :checked="settings.autoRotate"
              @change="settings.toggle('autoRotate')"
            />
            <span>Rotate the globe slowly</span>
          </label>
        </div>
      </section>

      <section>
        <button
          class="row-head"
          :class="{ open: open === 'display' }"
          :aria-expanded="open === 'display'"
          @click="toggleSection('display')"
        >
          <span>Display</span>
          <svg
            class="chev"
            :class="{ up: open === 'display' }"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div v-if="open === 'display'" class="body">
          <div class="group">
            <span class="eyebrow">Visual style</span>
            <div class="seg" :class="settings.visuals" role="radiogroup" aria-label="Visual style">
              <span class="thumb" aria-hidden="true" />
              <button
                :class="{ on: settings.visuals === 'enhanced' }"
                role="radio"
                :aria-checked="settings.visuals === 'enhanced'"
                @click="settings.setVisuals('enhanced')"
              >
                Enhanced
              </button>
              <button
                :class="{ on: settings.visuals === 'realistic' }"
                role="radio"
                :aria-checked="settings.visuals === 'realistic'"
                @click="settings.setVisuals('realistic')"
              >
                Realistic
              </button>
            </div>
            <p class="hint">
              {{
                settings.visuals === 'enhanced'
                  ? 'Enhanced — the whole globe stays readable, day and night.'
                  : 'Realistic — lighting follows the sun, so the far side goes dark.'
              }}
            </p>
          </div>

          <label class="row">
            <input
              type="checkbox"
              :checked="settings.scaleBar"
              @change="settings.toggle('scaleBar')"
            />
            <span>Scale bar</span>
          </label>
          <label class="row">
            <input
              type="checkbox"
              :checked="nations.showExtremes"
              @change="nations.toggleExtremes()"
            />
            <span>Nation borders: largest and smallest extent</span>
          </label>
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: calc(58px + var(--safe-t));
  right: calc(var(--s4) + var(--safe-r));
  width: min(324px, calc(100vw - 2 * var(--s4)));
  max-height: calc(100dvh - var(--rail-clear) - 78px - var(--safe-t));
  display: flex;
  flex-direction: column;
  padding: 0;
  z-index: var(--z-settings);
  overflow: hidden;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--s3) var(--s3) var(--s3) var(--s4);
  border-bottom: 1px solid var(--line);
  flex: none;
}
.close {
  display: grid;
  place-items: center;
  background: none;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--frost);
  width: 30px;
  height: 30px;
  cursor: pointer;
  transition:
    border-color var(--fast),
    color var(--fast),
    background-color var(--fast),
    transform var(--fast);
}
.close:hover {
  border-color: var(--brass-line);
  color: var(--brass);
  background: var(--brass-soft);
}
.close:active {
  transform: scale(0.94);
}

.scroll {
  flex: 1;
  min-height: 0;
}
section {
  border-bottom: 1px solid var(--line-soft);
}
section:last-child {
  border-bottom: none;
}

.row-head {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--s2);
  background: none;
  border: none;
  color: var(--frost);
  padding: 13px var(--s4);
  font-size: var(--t-md);
  cursor: pointer;
  text-align: left;
  transition:
    color var(--fast),
    background-color var(--fast);
}
.row-head:hover {
  color: var(--brass);
  background: rgba(255, 255, 255, 0.03);
}
/* an open section gets a brass edge so you can see where you are */
.row-head.open {
  box-shadow: inset 2px 0 0 var(--brass);
}
.chev {
  color: var(--muted);
  transition:
    transform var(--slow),
    color var(--fast);
  flex: none;
}
.chev.up {
  transform: rotate(180deg);
  color: var(--brass);
}

.body {
  padding: 0 var(--s4) var(--s4);
  display: grid;
  gap: var(--s3);
  animation: reveal 0.2s var(--ease);
}
@keyframes reveal {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}
/* a labelled cluster of related controls */
.group {
  display: grid;
  gap: var(--s2);
}
.hint {
  margin: 0;
  font-size: var(--t-sm);
  color: var(--muted);
  line-height: 1.5;
}
.status {
  display: flex;
  align-items: baseline;
  gap: 7px;
  color: var(--brass);
}
.led {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
  transform: translateY(-1px);
}
.status.loading .led {
  animation: pulse 1.1s ease-in-out infinite;
}
.status.unavailable {
  color: var(--ember);
}
.status.ready {
  color: var(--patina);
}
@keyframes pulse {
  50% {
    opacity: 0.25;
  }
}
.credit {
  font-size: var(--t-micro);
  opacity: 0.75;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chips button {
  font-family: var(--cond);
  font-size: var(--t-sm);
  letter-spacing: 0.06em;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  color: var(--muted);
  padding: 4px 12px;
  cursor: pointer;
  transition:
    color var(--fast),
    border-color var(--fast),
    background-color var(--fast);
}
.chips button:hover {
  color: var(--brass);
  border-color: var(--brass-line);
  background: var(--brass-soft);
}
.chips button.on {
  color: var(--void);
  background: var(--brass);
  border-color: var(--brass);
  font-weight: 500;
}
.chips button:active {
  transform: scale(0.96);
}

/* segmented control: one recessed track, one sliding brass thumb */
.seg {
  position: relative;
  display: flex;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: rgba(6, 10, 18, 0.55);
  padding: 3px;
  isolation: isolate;
}
.thumb {
  position: absolute;
  z-index: -1;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc(50% - 3px);
  border-radius: 7px;
  background: var(--brass);
  box-shadow: 0 2px 8px rgba(227, 167, 88, 0.25);
  transition: transform var(--slow);
}
.seg.realistic .thumb {
  transform: translateX(100%);
}
.seg button {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--muted);
  font-family: var(--cond);
  font-size: var(--t-sm);
  letter-spacing: 0.06em;
  padding: 8px 0;
  cursor: pointer;
  transition: color var(--fast);
}
.seg button:hover {
  color: var(--frost);
}
.seg button.on {
  color: var(--void);
  font-weight: 600;
}

.row {
  display: flex;
  gap: var(--s3);
  align-items: center;
  font-size: var(--t-md);
  line-height: 1.4;
  cursor: pointer;
  transition: color var(--fast);
}
.row:hover {
  color: #fff;
}
.row input {
  accent-color: var(--brass);
  width: 17px;
  height: 17px;
  flex: none;
  cursor: pointer;
}

.slider-row {
  display: flex;
  justify-content: space-between;
  gap: var(--s3);
  font-size: var(--t-md);
}
.slider-row strong {
  font-family: var(--cond);
  font-variant-numeric: tabular-nums;
  color: var(--brass);
  font-weight: 500;
}

input[type='range'] {
  width: 100%;
  margin: 0;
  height: 18px;
  background: transparent;
  accent-color: var(--brass);
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}
input[type='range']::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: var(--r-pill);
  background: var(--line);
}
input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -5.5px;
  border-radius: 50%;
  background: var(--brass);
  border: none;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
  transition:
    transform var(--fast),
    box-shadow var(--fast);
}
input[type='range']:hover::-webkit-slider-thumb {
  transform: scale(1.12);
}
input[type='range']:active::-webkit-slider-thumb {
  box-shadow: 0 0 0 6px var(--brass-soft);
}
input[type='range']::-moz-range-track {
  height: 3px;
  border-radius: var(--r-pill);
  background: var(--line);
}
input[type='range']::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 50%;
  background: var(--brass);
}

.link {
  justify-self: start;
  background: none;
  border: none;
  color: var(--brass);
  font-size: var(--t-sm);
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
  transition: color var(--fast);
}
.link:hover {
  color: #f2c68c;
}

@media (max-width: 640px) {
  /* a sheet that hugs its content instead of stretching to the timeline */
  .panel {
    top: calc(56px + var(--safe-t));
    left: calc(var(--s3) + var(--safe-l));
    right: calc(var(--s3) + var(--safe-r));
    width: auto;
    max-height: calc(100dvh - var(--rail-clear) - 72px - var(--safe-t));
  }
  .row-head {
    padding: 15px var(--s4);
    min-height: 48px;
    box-sizing: border-box;
  }
  .close {
    width: 42px;
    height: 42px;
    box-sizing: border-box;
  }
  /* every tappable thing clears 40px */
  .row {
    min-height: 40px;
  }
  .row input {
    width: 20px;
    height: 20px;
  }
  .chips button {
    min-height: 40px;
    box-sizing: border-box;
    padding: 8px 14px;
  }
  .seg button {
    min-height: 42px;
    padding: 11px 0;
  }
  input[type='range'] {
    height: 40px;
  }
  .link {
    min-height: 40px;
  }
}
</style>
