<script setup lang="ts">
import { computed } from 'vue'
import { useEventStore } from '../stores/events'
import { resolveStepChip } from '../lib/present/saga'

/**
 * THE STEP STRIP — the steps of the focused SAGA, as chips.
 *
 * It belongs with the pill, not with the timeline, and it sits directly above
 * it: this is a control over *one event*, and putting it on the rail would say
 * the opposite — that it is a control over time, which is the one thing it is
 * not. The rail's whole grammar is continuous (drag anywhere, land on any
 * year); a step strip's is discrete (there are five moments, and between them
 * there is nothing to select). Two different grammars in one bar would teach
 * the reader that they can scrub between Smolensk and Kiev, and they cannot —
 * see lib/steps.ts, rule 2.
 *
 * So it is chips, in time order, with "Overview" first and always present. The
 * overview is not a step; it is the state of not being in one, and it reads
 * as the leftmost chip because that is where "all of it" belongs and because a
 * reader who has stepped in must never have to hunt for the way back.
 *
 * It renders in BOTH shapes of the panel — over the pill, and under an expanded
 * article — because stepping through the steps is the thing the reader came to
 * do, and it survives the panel folding either way. Its position is fixed
 * against the rail rather than against the pill, so folding the article does
 * not make the chips jump.
 */
const events = useEventStore()

/**
 * "SAGA · 5 STEPS" — the strip saying, in words, what this is and that there is
 * more here than the article.
 *
 * The chips alone did not carry that. They read as a row of labels about the
 * thing already on screen (which is what a row of borderless words on a map
 * looks like), so the per-step detail was found by accident or not at all. The
 * count is the smallest honest advertisement there is — it names the quantity
 * of pages — and the word in front of it names the SHAPE: a saga is an event
 * told in chapters, and that is worth one word of the reader's attention
 * before they spend a click finding out.
 */
const count = computed(() => {
  const n = events.focusSteps.length
  return `Saga · ${n} ${n === 1 ? 'step' : 'steps'}`
})

/**
 * The chips, as what they ARE — a page of this event, or an entrance into
 * another one (lib/present/saga.ts).
 *
 * Resolved rather than tested for in the template: pressing an entrance changes
 * what the whole map is about, and the reader has to be able to see the
 * difference before they press it, so it is a variant with two renderings and
 * not a `v-if` on a field.
 */
const chips = computed(() => events.focusSteps.map(resolveStepChip))
</script>

<template>
  <nav
    v-if="events.focusSteps.length"
    class="strip"
    data-test="step-strip"
    aria-label="Steps of this event"
  >
    <button
      class="chip overview"
      data-test="step-chip"
      data-step="overview"
      :class="{ on: !events.stepId }"
      :aria-pressed="!events.stepId"
      @click="events.selectStep()"
    >
      Overview
    </button>
    <span class="rule" aria-hidden="true" />
    <!-- Labels the group it stands in front of, not the strip as a whole: the
         Overview is not one of the steps it is counting. -->
    <span class="count" data-test="step-count">{{ count }}</span>
    <div class="steps scroll-x">
      <button
        v-for="(c, i) in chips"
        :key="c.step.id"
        class="chip"
        :class="{ on: events.stepId === c.step.id, entrance: c.kind === 'entrance' }"
        data-test="step-chip"
        :data-step="c.step.id"
        :data-entrance="c.kind === 'entrance' ? '' : undefined"
        :aria-pressed="events.stepId === c.step.id"
        :title="c.kind === 'entrance' ? `Go into ${c.step.name}` : undefined"
        @click="events.selectStep(c.step.id)"
      >
        <span class="tick tnum" aria-hidden="true">{{ i + 1 }}</span>
        <span class="label">{{ c.step.name }}</span>
        <!-- The descent cue. A chevron pointing DOWN, in the app's own stroke
             language (the pill's restore arrow, the panel's minimise): every
             other chevron in this app means "there is another layer this way",
             and this one means it about the map rather than about the panel. -->
        <svg
          v-if="c.kind === 'entrance'"
          class="descend"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    </div>
  </nav>
</template>

<style scoped>
/* Docked above the pill's row and on the pill's own axis — bottom-centre, since
   that is where the pill went — so the two read as one stack of controls about
   the same thing. Laid out against `--strip-clear` (tokens.css), which the
   article also reads — a shared token rather than a measurement, because a
   ResizeObserver for four pixels of offset would be a lifecycle bug bought for
   nothing. The offset is the same whether the pill is there or the article is
   up, so folding the panel does not make the chips jump.

   `translate`, not a transform: the entrance animation below owns `transform`,
   and centring with it would be dropped for the length of the entrance. */
.strip {
  position: absolute;
  left: 50%;
  translate: -50% 0;
  bottom: calc(var(--strip-clear) - var(--strip-h));
  z-index: var(--z-event-panel);
  display: flex;
  align-items: center;
  gap: var(--s1);
  /* Shrink-to-fit up to the width of the window: a five-step saga with
     the months in its chip names runs to about a thousand pixels, and a cap
     narrower than that would clip a chip mid-word on a desktop with room to
     spare. Narrower screens get the scroll instead (see `.steps`). */
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

/* The steps scroll; "Overview" does not. A five-step saga on a phone
   overflows, and the one chip that must always be reachable is the way out. */
.steps {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
.steps::-webkit-scrollbar {
  display: none;
}

.rule {
  flex: none;
  width: 1px;
  height: 16px;
  background: var(--line);
}

/* the count (see `count` in the script): an eyebrow, not a chip — it is the
   only thing on this bar that cannot be pressed, and it must not look as
   though it can be */
.count {
  flex: none;
  padding: 0 var(--s1) 0 2px;
  font-family: var(--cond);
  font-size: var(--t-eyebrow);
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
}

/* A step chip is a PAGE you can turn to, and it says so while still: a framed
   surface with a number on it. It used to be bare text on a transparent
   background until hovered, which on a desktop is discoverable and on a touch
   screen — where there is no hover at all — is not discoverable in any sense.
   The frame is the app's own quiet one (--line, the tag and place chips' 4%
   fill); the brass "on" state below is unchanged and still outranks it. */
.chip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px var(--s2);
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.04);
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
  border-color: var(--brass-line);
  background: rgba(255, 255, 255, 0.08);
}
.chip:hover .tick {
  border-color: var(--brass-line);
  color: var(--brass);
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

/* AN ENTRANCE reads as a way in, not as a page: the chevron is the affordance
   and this is the frame around it. A page chip is a flat surface with a number
   on it; an entrance is deeper — a stronger edge and a hint of the brass the
   "on" state uses, so the row says at a glance which of its chips lead
   somewhere else. Deliberately quieter than `.on`, which is a statement about
   where the reader IS and must still outrank everything. */
.chip.entrance {
  border-color: var(--brass-line);
  background: rgba(255, 255, 255, 0.07);
}
.chip.entrance .tick {
  border-color: var(--brass-line);
}
.descend {
  flex: none;
  margin-left: 1px;
  color: var(--brass);
  opacity: 0.8;
}
.chip:hover .descend {
  opacity: 1;
}

@media (max-width: 640px) {
  /* The word count goes: a phone's strip is already scrolling its chips, and
     the room it takes is a chip's worth of the two that fit. The framed chips
     carry the affordance on their own — which is the half of it that a touch
     screen, with no hover to reveal anything, actually needed. */
  .count {
    display: none;
  }
  /* A phone shows two chips and scrolls to the rest, rather than five ellipsed
     to the point of saying nothing. */
  .label {
    max-width: 132px;
  }
}
</style>
