<script setup lang="ts">
import { computed } from 'vue'
import { useEventStore } from '../stores/events'

/**
 * THE STEP STRIP — the authored steps of the focused event, as chips.
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
 * "5 steps" — the strip saying, in words, that there is more here than the
 * article.
 *
 * The chips alone did not carry that. They read as a row of labels about the
 * thing already on screen (which is what a row of borderless words on a map
 * looks like), so an operation's per-step detail was found by accident or not
 * at all. A count is the smallest honest advertisement there is: it names the
 * quantity of pages, so a reader can tell before clicking whether it is worth
 * a click.
 */
const count = computed(() => {
  const n = events.focusSteps.length
  return `${n} ${n === 1 ? 'step' : 'steps'}`
})
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
        v-for="(s, i) in events.focusSteps"
        :key="s.id"
        class="chip"
        data-test="step-chip"
        :data-step="s.id"
        :class="{ on: events.stepId === s.id }"
        :aria-pressed="events.stepId === s.id"
        @click="events.selectStep(s.id)"
      >
        <span class="tick tnum" aria-hidden="true">{{ i + 1 }}</span>
        <span class="label">{{ s.name }}</span>
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
  /* Shrink-to-fit up to the width of the window: a five-step operation with
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

/* The steps scroll; "Overview" does not. A five-step operation on a phone
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
