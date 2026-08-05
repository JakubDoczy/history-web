import { describe, it, expect } from 'vitest'
import { NO_ACTIVE, clampActive, stepActive } from '../src/lib/listbox'

describe('stepActive', () => {
  it('walks down and up the list', () => {
    expect(stepActive('ArrowDown', 0, 5)).toBe(1)
    expect(stepActive('ArrowDown', 3, 5)).toBe(4)
    expect(stepActive('ArrowUp', 3, 5)).toBe(2)
    expect(stepActive('ArrowUp', 1, 5)).toBe(0)
  })

  it('wraps at both ends, so neither key ever goes dead', () => {
    expect(stepActive('ArrowDown', 4, 5)).toBe(0)
    expect(stepActive('ArrowUp', 0, 5)).toBe(4)
  })

  it('enters the list from nowhere at either end', () => {
    expect(stepActive('ArrowDown', NO_ACTIVE, 5)).toBe(0)
    expect(stepActive('ArrowUp', NO_ACTIVE, 5)).toBe(4)
  })

  it('jumps to the ends', () => {
    expect(stepActive('Home', 3, 5)).toBe(0)
    expect(stepActive('End', 3, 5)).toBe(4)
    expect(stepActive('End', NO_ACTIVE, 1)).toBe(0)
  })

  it('answers nothing for a key it does not handle, and for an empty list', () => {
    for (const key of ['Escape', 'Enter', 'Tab', 'a', 'ArrowLeft'])
      expect(stepActive(key, 0, 5), key).toBeNull()
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End'])
      expect(stepActive(key, NO_ACTIVE, 0), key).toBeNull()
  })

  it('recovers from an index the list no longer has', () => {
    // the results shrank under the cursor: a stale index must not step to a
    // stale index, or the marker lands on a row that is not there
    expect(stepActive('ArrowDown', 9, 3)).toBe(0)
    expect(stepActive('ArrowUp', 9, 3)).toBe(2)
    expect(stepActive('ArrowDown', -4, 3)).toBe(0)
  })

  it('stays inside a single-row list', () => {
    expect(stepActive('ArrowDown', 0, 1)).toBe(0)
    expect(stepActive('ArrowUp', 0, 1)).toBe(0)
  })
})

describe('clampActive', () => {
  it('takes a new result set back to its best match, or to nothing', () => {
    expect(clampActive(7)).toBe(0)
    expect(clampActive(1)).toBe(0)
    expect(clampActive(0)).toBe(NO_ACTIVE)
  })
})
