<script setup lang="ts">
import { useSettingsStore } from '../stores/settings'
import type { RenderMode } from '../lib/present'

/**
 * GLOBE OR MAP, on the edge of the screen where the thing it changes is.
 *
 * The setting already existed under Settings → Display, and it stays there —
 * this is the same store action, not a second piece of state (`settings.mode`
 * is the one source of truth, and both controls read and write it). What it
 * adds is reach: the mode is a way of LOOKING at the world rather than a
 * preference about it, and a look you have to open a panel to change is a look
 * nobody compares.
 *
 * Two rules it is built to:
 *
 *  · **SVG geometry only.** Round 47's rule, and it is not a stylistic
 *    preference: a glyph from a font is a character the font may not have, and
 *    on the devices that lack it the control renders as a box. Both icons here
 *    are circles, arcs and lines with a symmetric viewBox, so what is on screen
 *    is what was drawn.
 *  · **A radiogroup, not a switch.** Two named states the reader can point at
 *    beat one state with a hidden opposite: arrow keys move between them,
 *    `aria-checked` says which is live, and the label of each says what it
 *    does rather than what it is called.
 */

const settings = useSettingsStore()

const OPTIONS: { mode: RenderMode; label: string; hint: string }[] = [
  { mode: 'realistic', label: 'Globe', hint: 'Globe — the photographed planet' },
  { mode: 'schematic', label: 'Map', hint: 'Map — a drawn atlas of the world' },
]

/**
 * A POINTER ON THE CONTROL IS THE FIRST NEWS THAT MAP MODE IS COMING.
 *
 * The drawn map builds itself on demand — a worker, 1.1 MB of vector data and a
 * 4096x2048 parchment world — and the click is where all of it used to land.
 * Hovering, touching or focusing this control is a few hundred milliseconds of
 * warning, and it is the only signal available that does not make the reader
 * who never opens map mode pay for it. See `warmMap` in stores/settings.ts.
 *
 * `pointerenter` covers a mouse, `pointerdown` a touch (which has no hover),
 * and `focusin` a keyboard. All three land on the group rather than on the map
 * button alone: a reader on the globe button is one arrow key from the other,
 * and warming from the wrong half of a two-state control is not a mistake worth
 * a branch.
 */
const warm = () => settings.warmMap()

/** Arrow keys walk the pair; Home/End land on an end. One key, one move. */
const onKey = (e: KeyboardEvent) => {
  const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft'
  const fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight'
  if (!back && !fwd && e.key !== 'Home' && e.key !== 'End') return
  e.preventDefault()
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : back ? 0 : 1
  settings.setMode(OPTIONS[next].mode)
  // the focused button is the checked one, so focus has to follow the choice
  const host = e.currentTarget as HTMLElement
  host.querySelectorAll('button')[next]?.focus()
}
</script>

<template>
  <div
    class="mode-toggle"
    role="radiogroup"
    aria-label="Map mode"
    data-test="mode-toggle"
    @keydown="onKey"
    @pointerenter="warm"
    @pointerdown="warm"
    @focusin="warm"
  >
    <span class="thumb" :class="`at-${settings.mode}`" aria-hidden="true" />
    <button
      v-for="o in OPTIONS"
      :key="o.mode"
      role="radio"
      class="opt"
      :class="{ on: settings.mode === o.mode }"
      :aria-checked="settings.mode === o.mode"
      :aria-label="o.hint"
      :title="o.hint"
      :tabindex="settings.mode === o.mode ? 0 : -1"
      :data-test="`mode-toggle-${o.mode}`"
      @click="settings.setMode(o.mode)"
    >
      <!-- THE GLOBE: a sphere with a meridian and a parallel. The ellipse is
           the meridian seen at an angle, which is the one line that reads as
           "this is round" without shading. -->
      <svg
        v-if="o.mode === 'realistic'"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="8.5" />
        <ellipse cx="12" cy="12" rx="3.6" ry="8.5" />
        <path d="M3.9 9h16.2M3.9 15h16.2" />
      </svg>
      <!-- THE MAP: a folded sheet. Three panels of a paper map, the folds
           alternating up and down, which is what distinguishes it from a page. -->
      <svg
        v-else
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20 9 17.5 3 20z" />
        <path d="M9 4v13.5M15 6.5V20" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* The right edge, clear of the rail and the top bar, and vertically where the
   eye already is. It is `translate` rather than a `top` of 50% minus half its
   own height, because the control's height is two buttons plus a gap and
   nothing should have to restate that arithmetic. */
.mode-toggle {
  position: absolute;
  right: calc(var(--s3) + var(--safe-r));
  top: 50%;
  translate: 0 -50%;
  z-index: var(--z-scalebar);
  display: grid;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: rgba(13, 20, 32, 0.72);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
}

/* The moving mark, so the change reads as one control with a position rather
   than two buttons that light up. Same language as the segmented control in
   Settings, which is the other place this setting lives. */
.thumb {
  position: absolute;
  left: 3px;
  right: 3px;
  height: 32px;
  border-radius: 7px;
  background: var(--brass-soft);
  border: 1px solid var(--brass-line);
  transition: translate var(--slow);
  pointer-events: none;
}
.at-realistic {
  translate: 0 0;
}
.at-schematic {
  translate: 0 34px;
}

.opt {
  position: relative;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: none;
  color: var(--frost-dim);
  cursor: pointer;
  transition: color var(--fast);
}
.opt:hover {
  color: var(--frost);
}
.opt.on {
  color: var(--brass);
}

/* On a phone the rail and the pill own the bottom and the panel owns the left;
   the right edge is still free, but the control sits a little higher than dead
   centre so a thumb reaching it does not cover the equator. */
@media (max-width: 640px) {
  .mode-toggle {
    top: 42%;
    right: calc(var(--s2) + var(--safe-r));
  }
}

@media (prefers-reduced-motion: reduce) {
  .thumb {
    transition: none;
  }
}
</style>
