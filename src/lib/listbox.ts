/**
 * Keyboard navigation over a list of options — the arithmetic, and nothing else.
 *
 * The search results are an `aria-activedescendant` listbox: focus stays in the
 * text field (typing must never be interrupted) and one row is "active", named
 * by the field so a screen reader announces it. That pattern needs exactly two
 * things from logic — which row a key moves to, and what happens to the active
 * row when the list underneath it changes — and both are arithmetic, so both
 * live here rather than in the component (see components/SearchBox.vue).
 */

/** Nothing is active: an empty list, or a list nobody has moved into yet. */
export const NO_ACTIVE = -1

/**
 * Where a key press moves the active row, or `null` for a key this does not
 * handle — which the caller must treat as "not mine", so Escape still closes,
 * Tab still leaves and every printable character still reaches the field.
 *
 * The ends WRAP. A list of results is a ring, not a shelf: holding ArrowDown to
 * the bottom and finding the key dead is the one outcome that makes a reader
 * reach for the mouse, and wrapping costs nothing to learn because the marker
 * moves visibly. Wrapping is also what makes the first press useful from
 * nowhere at all — ArrowUp with no active row goes to the last one, which is
 * how every native select behaves.
 */
export function stepActive(key: string, active: number, count: number): number | null {
  if (count <= 0) return null
  const at = active >= 0 && active < count ? active : NO_ACTIVE
  switch (key) {
    case 'ArrowDown':
      return at === NO_ACTIVE ? 0 : (at + 1) % count
    case 'ArrowUp':
      return at === NO_ACTIVE ? count - 1 : (at - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/**
 * The same ring, read left to right.
 *
 * A row of stations on a rail (components/SagaTimeline.vue) is a listbox laid
 * on its side: the arithmetic of "where does this key move the marker" is
 * identical, only the two keys that spell it change. Translating the keys is
 * the whole of the difference, and it keeps one implementation of the wrap —
 * which is the part with a decision in it.
 */
export const stepActiveX = (key: string, active: number, count: number): number | null => {
  // A rail owns the horizontal keys and nothing else. ArrowUp/ArrowDown are
  // deliberately NOT passed through: on a rail they mean nothing, and a control
  // that swallows them takes the page's scroll with them.
  const vertical = { ArrowLeft: 'ArrowUp', ArrowRight: 'ArrowDown', Home: 'Home', End: 'End' }[key]
  return vertical ? stepActive(vertical, active, count) : null
}

/**
 * The active row for a NEW QUERY.
 *
 * It goes back to the top rather than trying to follow the row that was
 * highlighted. The rows are a ranking of a different question after every
 * keystroke, so "the same row" is not a thing that survives; what does survive
 * is the promise that Enter takes the best match, which is what a reader who
 * has not touched the arrows is relying on.
 *
 * Only for a new query. A list that changes *under* an unchanged query — a
 * chunk of events streaming in — must not move the highlight the reader put
 * somewhere: `stepActive` above already treats an index the list no longer has
 * as no index at all, which is the whole recovery that case needs.
 */
export const clampActive = (count: number): number => (count > 0 ? 0 : NO_ACTIVE)
