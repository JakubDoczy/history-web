import { assertNever, featureOf, type Item, type Subject } from '../events'
import type { Step } from '../steps'
import type { Time } from '../time'

/**
 * SAGAHOOD, RESOLVED — the presentation layer's answer to "is this a saga?".
 *
 * A saga is not a kind (see docs/design/sagas.md): it is an `HistoricalEvent`
 * that carries steps, and that is the whole of the model. Nothing is gained by
 * a `kind: 'saga'` — the id space, the pins, the relations and the focus stack
 * would all be the same — and a great deal is lost, because every exhaustive
 * switch in the app would have to grow a case for something that is an event in
 * every respect that matters to it.
 *
 * What the *presentation* needs is a name for the composition, in one place, so
 * that the pin ring, the panel's chip and the strip's copy all say "saga" about
 * exactly the same set of items. That is this module: it sits beside the other
 * resolvers for the same reason they do — a component asking `!!e.steps?.length`
 * is a component holding an opinion about the domain.
 */

/**
 * The steps a subject is told in, or `undefined` — the resolution of sagahood
 * itself, and the only place the composition is read.
 *
 * `undefined` rather than `[]` on purpose: absence is the answer, and the two
 * callers that want a list (the strip, the panel) already have `focusSteps`.
 * A life marker, a person and an idea are never sagas; nor is an event that
 * carries an empty `steps`, which the parser and the validator both refuse
 * anyway.
 */
export const sagaOf = (i: Subject | undefined): readonly Step[] | undefined =>
  i?.kind === 'event' && i.steps?.length ? i.steps : undefined

/**
 * A saga with the two things a rail needs to draw it: its steps and the span
 * they are measured against (see lib/steps.ts, rule 3).
 *
 * The pair, resolved once, because the alternative is a component asking
 * `focused.kind === 'event' && focused.time` for itself — which is the same
 * opinion about the domain `sagaOf` exists to keep out of components, and the
 * two halves must come from the SAME item or the fractions are measured against
 * someone else's years.
 */
export interface SagaView {
  id: string
  name: string
  steps: readonly Step[]
  span: Time
}

export const sagaViewOf = (i: Subject | undefined): SagaView | undefined => {
  const steps = sagaOf(i)
  return steps && i?.kind === 'event'
    ? { id: i.id, name: i.name, steps, span: i.time }
    : undefined
}

/**
 * What one chip on the step strip IS.
 *
 * Two variants, because a step with a `child` does something categorically
 * different from a step without one: a page turns *within* this event, an
 * entrance descends *into another*. The reader has to be able to tell before
 * pressing — descending changes what the whole map is about — so the strip
 * draws the two differently (a chevron), and the difference is a variant here
 * rather than a `v-if="step.child"` in the template.
 */
export type StepChip =
  /** A reading of this event: its page, its ink, its camera. */
  | { kind: 'page'; step: Step }
  /** A way down into another item, which supplies its own everything. */
  | { kind: 'entrance'; step: Step; child: string }

export const resolveStepChip = (step: Step): StepChip =>
  step.child === undefined
    ? { kind: 'page', step }
    : { kind: 'entrance', step, child: step.child }

/**
 * What the pill calls a subject: the most specific true thing about it.
 *
 * The pill has no date and no body, so this word is all it says about what kind
 * of thing has been put down — and "saga" outranks the shapes below it because
 * an event told in steps is a *reading*, which is the one thing a pill cannot
 * show and the reader most needs to know is waiting.
 */
export function resolvePillKind(i: Item): string {
  switch (i.kind) {
    case 'event':
      if (sagaOf(i)) return 'Saga'
      if (i.drawing) return 'Plan'
      return featureOf(i.location, 'line') ? 'Route' : 'Event'
    case 'person':
      return 'Person'
    case 'concept':
      return 'Concept'
    default:
      return assertNever(i)
  }
}
