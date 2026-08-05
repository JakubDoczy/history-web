<script setup lang="ts">
import { useEventStore } from '../stores/events'

/**
 * THE STAGE STRIP — the authored steps of the focused event, as chips.
 *
 * It belongs with the pill, not with the timeline, and it sits directly above
 * it: this is a control over *one event*, and putting it on the rail would say
 * the opposite — that it is a control over time, which is the one thing it is
 * not. The rail's whole grammar is continuous (drag anywhere, land on any
 * year); a stage strip's is discrete (there are five moments, and between them
 * there is nothing to select). Two different grammars in one bar would teach
 * the reader that they can scrub between Smolensk and Kiev, and they cannot —
 * see lib/stages.ts, rule 2.
 *
 * So it is chips, in `at` order, with "Overview" first and always present. The
 * overview is not a stage; it is the state of not being in one, and it reads
 * as the leftmost chip because that is where "all of it" belongs and because a
 * reader who has stepped in must never have to hunt for the way back.
 *
 * It renders in BOTH shapes of the panel — over the pill, and under an expanded
 * article — because stepping through the stages is the thing the reader came to
 * do, and it survives the panel folding either way. Its position is fixed
 * against the rail rather than against the pill, so folding the article does
 * not make the chips jump.
 */
const events = useEventStore()
</script>

<template>
  <nav
    v-if="events.focusStages.length"
    class="strip"
    data-test="stage-strip"
    aria-label="Stages of this event"
  >
    <button
      class="chip overview"
      data-test="stage-chip"
      data-stage="overview"
      :class="{ on: !events.stageId }"
      :aria-pressed="!events.stageId"
      @click="events.selectStage()"
    >
      Overview
    </button>
    <span class="rule" aria-hidden="true" />
    <div class="stages scroll-x">
      <button
        v-for="(s, i) in events.focusStages"
        :key="s.id"
        class="chip"
        data-test="stage-chip"
        :data-stage="s.id"
        :class="{ on: events.stageId === s.id }"
        :aria-pressed="events.stageId === s.id"
        @click="events.selectStage(s.id)"
      >
        <span class="tick tnum" aria-hidden="true">{{ i + 1 }}</span>
        <span class="label">{{ s.name }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
/* Docked above the pill's row, on the pill's own left edge, so the two read as
   one stack of controls about the same thing. Laid out against `--strip-clear`
   (tokens.css), which the article also reads — a shared token rather than a
   measurement, because a ResizeObserver for four pixels of offset would be a
   lifecycle bug bought for nothing. The offset is the same whether the pill is
   there or the article is up, so folding the panel does not make the chips
   jump. */
.strip {
  position: absolute;
  left: calc(var(--s4) + var(--safe-l));
  bottom: calc(var(--strip-clear) - var(--strip-h));
  z-index: var(--z-event-panel);
  display: flex;
  align-items: center;
  gap: var(--s1);
  /* Shrink-to-fit up to the width of the window: a five-stage operation with
     the months in its chip names runs to about a thousand pixels, and a cap
     narrower than that would clip a chip mid-word on a desktop with room to
     spare. Narrower screens get the scroll instead (see `.stages`). */
  max-width: calc(100vw - 2 * var(--s4) - var(--safe-l) - var(--safe-r));
  padding: 3px 5px;
  min-height: var(--strip-h);
  box-sizing: border-box;
  border-radius: var(--r-pill);
  border: 1px solid var(--line);
  background: linear-gradient(180deg, var(--panel-hi), transparent 40px), var(--panel);
  backdrop-filter: blur(16px) saturate(120%);
  -webkit-backdrop-filter: blur(16px) saturate(120%);
  box-shadow: var(--lift);
  animation: strip-in var(--slow);
}
@keyframes strip-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

/* The stages scroll; "Overview" does not. A five-stage operation on a phone
   overflows, and the one chip that must always be reachable is the way out. */
.stages {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
.stages::-webkit-scrollbar {
  display: none;
}

.rule {
  flex: none;
  width: 1px;
  height: 16px;
  background: var(--line);
}

.chip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px var(--s2);
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  background: none;
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.04em;
  color: var(--frost-dim);
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--fast),
    border-color var(--fast),
    background-color var(--fast);
}
.chip:hover {
  color: var(--frost);
  background: rgba(255, 255, 255, 0.05);
}
.chip.on {
  color: var(--brass);
  border-color: var(--brass-line);
  background: var(--brass-soft);
}
.overview {
  font-size: var(--t-eyebrow);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

/* The step number. It is what makes a row of chips read as a sequence rather
   than as a set of filters — the same job the rule after "Overview" does. */
.tick {
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 1px solid var(--line);
  font-size: var(--t-micro);
  color: var(--muted);
}
.chip.on .tick {
  border-color: var(--brass-line);
  color: var(--brass);
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 640px) {
  /* A phone shows two chips and scrolls to the rest, rather than five ellipsed
     to the point of saying nothing. */
  .label {
    max-width: 132px;
  }
}
</style>
