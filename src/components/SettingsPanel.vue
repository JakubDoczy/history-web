<script setup lang="ts">
import { ref } from 'vue'
import { useEventStore } from '../stores/events'
import { useSettingsStore, MAX_EVENTS } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useViewStore } from '../stores/view'
import { useTimeStore } from '../stores/time'
import { PALETTE_RANGE } from '../lib/palette'
import { imageryCredit } from '../lib/paleo'
import { PALEO_FRAMES } from '../data/paleoTextures'
import { buildLabel } from '../lib/build'

const events = useEventStore()
const settings = useSettingsStore()
const ui = useUiStore()
const view = useViewStore()
const time = useTimeStore()

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

/** The three palette controls, so the markup is one loop rather than three. */
const PALETTE_CONTROLS = [
  { key: 'saturation', label: 'Saturation' },
  { key: 'grayscale', label: 'Grayscale' },
  { key: 'contrast', label: 'Contrast' },
] as const

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
          <label class="row">
            <input
              type="checkbox"
              :checked="settings.showMinorEvents"
              @change="settings.toggle('showMinorEvents')"
            />
            <span>Show minor events</span>
          </label>
          <p class="hint">
            Everything left off the importance ranking, including the birth and death of
            everyone with an article. They are last in line for the slots above, so narrow
            the timeline to make room. Searchable either way.
          </p>
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
            Streams in every era. Before 1930 the zoom stops at a 100 km view, so modern
            cities never fill the screen in a century that had none.
          </p>
          <label class="row">
            <input type="checkbox" :checked="settings.relief" @change="settings.toggle('relief')" />
            <span>Terrain relief shading</span>
          </label>
          <p class="hint credit">
            {{ imageryCredit(PALEO_FRAMES, time.currentTime, view.detailAttribution) }}
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
          <!-- MAP MODE. Not a theme and not a toggle on the look below: it
               selects a whole GlobeStyle (lib/present/globe.ts), which is why
               it sits above the visual style rather than beside it. The
               settings under it are left alone rather than disabled, so
               switching back restores exactly what the reader had. -->
          <div class="group">
            <div class="group-head">
              <span class="eyebrow">Mode</span>
              <span class="tag-experimental">Experimental</span>
            </div>
            <div
              class="seg"
              :class="`mode-${settings.mode}`"
              role="radiogroup"
              aria-label="Render mode"
            >
              <span class="thumb" aria-hidden="true" />
              <button
                :class="{ on: settings.mode === 'realistic' }"
                role="radio"
                data-test="mode-realistic"
                :aria-checked="settings.mode === 'realistic'"
                @click="settings.setMode('realistic')"
              >
                Globe
              </button>
              <button
                :class="{ on: settings.mode === 'schematic' }"
                role="radio"
                data-test="mode-schematic"
                :aria-checked="settings.mode === 'schematic'"
                @click="settings.setMode('schematic')"
              >
                Map
              </button>
            </div>
            <p class="hint">
              {{
                settings.mode === 'realistic'
                  ? 'Globe — the photographed planet: imagery, relief, clouds, night and stars.'
                  : 'Map — a drawn scheme: no clouds, no relief, no night, no stars. Early days.'
              }}
            </p>
          </div>

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

          <div class="group palette">
            <div class="group-head">
              <span class="eyebrow">Palette</span>
              <button class="reset" type="button" @click="settings.resetPalette()">
                Reset
              </button>
            </div>

            <template v-for="c in PALETTE_CONTROLS" :key="c.key">
              <label class="slider-row" :for="`palette-${c.key}`"
                ><span>{{ c.label }}</span
                ><strong class="tnum">{{ settings.palette[c.key].toFixed(2) }}</strong></label
              >
              <input
                :id="`palette-${c.key}`"
                type="range"
                :min="PALETTE_RANGE[c.key].min"
                :max="PALETTE_RANGE[c.key].max"
                :step="PALETTE_RANGE[c.key].step"
                :value="settings.palette[c.key]"
                @input="
                  settings.setPalette({
                    [c.key]: Number(($event.target as HTMLInputElement).value),
                  })
                "
              />
            </template>
            <p class="hint">
              Applied after the visual style, in both styles. Switching the style above
              restores its defaults.
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
        </div>
      </section>

      <!-- WHICH BUILD THIS IS.
           Not a setting, and not decoration: it is the one thing on screen that
           says whether the tab in front of the reader is the code that was
           deployed. A phone can serve an SPA from a two-round-old cache for
           days, and until this line existed "I still see the old bug" and "the
           bug is back" were the same sentence. Selectable, quiet, and at the
           foot of the panel where a version number has always lived. See
           lib/build.ts. -->
      <p class="build tnum" data-test="build-stamp">{{ buildLabel() }}</p>
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
/* the palette sliders are their own block within Display */
.palette {
  border-top: 1px solid var(--line);
  padding-top: var(--s3);
}
.group-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s2);
}
/* Says what it is without a paragraph: this look is not finished. */
.tag-experimental {
  font-family: var(--cond);
  font-size: var(--t-micro);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--brass);
  border: 1px solid var(--brass-line);
  border-radius: var(--r-pill);
  padding: 1px 7px;
}
/* a quiet text button: the sliders are the control, this is only an escape hatch */
.reset {
  font-family: var(--cond);
  font-size: var(--t-micro);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  background: none;
  border: 0;
  padding: 2px 0;
  cursor: pointer;
}
.reset:hover {
  color: var(--brass);
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
/* The thumb sits over the SECOND option. Two segmented controls live in this
   panel and their second options are named differently, so both are listed
   rather than one being made to stand for the other. */
.seg.realistic .thumb,
.seg.mode-schematic .thumb {
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

/* The build stamp: the quietest thing in the panel, and selectable — it exists
   to be read out or copied into a message, which is the whole of its job. */
.build {
  margin: 0;
  padding: var(--s3) var(--s4) var(--s4);
  font-family: var(--cond);
  font-size: var(--t-micro);
  letter-spacing: 0.08em;
  color: var(--muted);
  opacity: 0.7;
  user-select: text;
  -webkit-user-select: text;
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
