<script setup lang="ts">
import { ref } from 'vue'
import { useEventStore } from '../stores/events'
import { useNationStore } from '../stores/nations'
import { useSettingsStore } from '../stores/settings'
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
      <button class="close" aria-label="Close settings" @click="ui.close()">×</button>
    </header>

    <div class="scroll">
      <section>
        <button class="row-head" :aria-expanded="open === 'events'" @click="toggleSection('events')">
          <span>Events</span><span class="chev" :class="{ up: open === 'events' }">›</span>
        </button>
        <div v-if="open === 'events'" class="body">
          <p class="hint">{{ events.filter.tags?.length ? 'Filtered by tag.' : 'Showing all categories.' }}</p>
          <div class="chips">
            <button v-for="t in events.allTags" :key="t" :class="{ on: tagOn(t) }" @click="events.toggleTag(t)">
              {{ t }}
            </button>
          </div>
          <label class="slider-row"><span>Most shown at once</span><strong>{{ events.maxVisible }}</strong></label>
          <input v-model.number="events.maxVisible" type="range" min="10" max="400" step="10" />
          <button v-if="events.filter.tags?.length || events.filter.parent" class="link" @click="events.clearFilter()">
            Clear all filters
          </button>
        </div>
      </section>

      <section>
        <button class="row-head" :aria-expanded="open === 'imagery'" @click="toggleSection('imagery')">
          <span>Imagery</span><span class="chev" :class="{ up: open === 'imagery' }">›</span>
        </button>
        <div v-if="open === 'imagery'" class="body">
          <label class="row">
            <input type="checkbox" :checked="settings.detail" @change="settings.toggle('detail')" />
            <span>Stream high-detail imagery</span>
          </label>
          <p class="hint status">{{ imageryLine() }}</p>
          <p class="hint">Available from 1930 onward — earlier, satellite imagery would show modern cities.</p>
          <label class="row">
            <input type="checkbox" :checked="settings.relief" @change="settings.toggle('relief')" />
            <span>Terrain relief shading</span>
          </label>
          <p class="hint credit">{{ view.detailAttribution || 'Imagery: NASA GIBS / Worldview' }}</p>
        </div>
      </section>

      <section>
        <button class="row-head" :aria-expanded="open === 'sky'" @click="toggleSection('sky')">
          <span>Sky</span><span class="chev" :class="{ up: open === 'sky' }">›</span>
        </button>
        <div v-if="open === 'sky'" class="body">
          <label class="row">
            <input type="checkbox" :checked="settings.clouds" @change="settings.toggle('clouds')" />
            <span>Cloud cover</span>
          </label>
          <label class="row">
            <input type="checkbox" :checked="settings.cloudShadows" @change="settings.toggle('cloudShadows')" />
            <span>Cloud shadows</span>
          </label>
          <label class="row">
            <input type="checkbox" :checked="settings.atmosphere" @change="settings.toggle('atmosphere')" />
            <span>Atmospheric glow</span>
          </label>
          <p class="hint">All fade out as you zoom in close.</p>
        </div>
      </section>

      <section>
        <button class="row-head" :aria-expanded="open === 'light'" @click="toggleSection('light')">
          <span>Light &amp; motion</span><span class="chev" :class="{ up: open === 'light' }">›</span>
        </button>
        <div v-if="open === 'light'" class="body">
          <label class="slider-row"><span>Time of day</span><strong>{{ clock() }}</strong></label>
          <input v-model.number="settings.sunHour" type="range" min="0" max="24" step="0.25" />
          <label class="row">
            <input type="checkbox" :checked="settings.autoRotate" @change="settings.toggle('autoRotate')" />
            <span>Rotate the globe slowly</span>
          </label>
        </div>
      </section>

      <section>
        <button class="row-head" :aria-expanded="open === 'display'" @click="toggleSection('display')">
          <span>Display</span><span class="chev" :class="{ up: open === 'display' }">›</span>
        </button>
        <div v-if="open === 'display'" class="body">
          <label class="row">
            <input type="checkbox" :checked="settings.scaleBar" @change="settings.toggle('scaleBar')" />
            <span>Scale bar</span>
          </label>
          <label class="row">
            <input type="checkbox" :checked="nations.showExtremes" @change="nations.toggleExtremes()" />
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
  top: 60px;
  right: 16px;
  width: min(320px, calc(100vw - 32px));
  max-height: calc(100dvh - 76px - var(--rail));
  display: flex;
  flex-direction: column;
  padding: 0;
  z-index: 7;
  overflow: hidden;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  flex: none;
}
.close {
  background: none;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--frost);
  font-size: 18px;
  line-height: 1;
  width: 32px;
  height: 32px;
  cursor: pointer;
}
.close:hover { border-color: var(--brass); color: var(--brass); }

.scroll { overflow-y: auto; overscroll-behavior: contain; flex: 1; }
section { border-bottom: 1px solid var(--line-soft); }
section:last-child { border-bottom: none; }

.row-head {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: none;
  border: none;
  color: var(--frost);
  padding: 13px 14px;
  font-size: 13.5px;
  cursor: pointer;
  text-align: left;
}
.row-head:hover { color: var(--brass); }
.chev { color: var(--muted); transform: rotate(90deg); transition: transform 0.18s var(--ease); }
.chev.up { transform: rotate(-90deg); }

.body { padding: 0 14px 14px; display: grid; gap: 9px; }
.hint { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.45; }
.status { color: var(--brass); }
.credit { font-size: 10.5px; opacity: 0.8; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chips button {
  font-family: var(--cond);
  font-size: 12px;
  letter-spacing: 0.06em;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  padding: 3px 11px;
  cursor: pointer;
}
.chips button.on { color: var(--void); background: var(--brass); border-color: var(--brass); }

.row { display: flex; gap: 9px; align-items: center; font-size: 13px; cursor: pointer; }
.row input { accent-color: var(--brass); width: 17px; height: 17px; flex: none; }
.slider-row { display: flex; justify-content: space-between; font-size: 13px; }
.slider-row strong { font-family: var(--cond); color: var(--brass); font-weight: 500; }
input[type='range'] { width: 100%; accent-color: var(--brass); }

.link {
  justify-self: start;
  background: none;
  border: none;
  color: var(--brass);
  font-size: 12.5px;
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
}

@media (max-width: 640px) {
  /* a proper sheet: most of the screen, clear of browser chrome at both ends */
  .panel {
    top: 56px;
    bottom: calc(var(--rail) + 10px);
    left: 10px;
    right: 10px;
    width: auto;
    max-height: none;
    transform: none;
  }
}
</style>
