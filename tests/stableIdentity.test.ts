import { describe, it, expect } from 'vitest'
import { stableByKey } from '../src/lib/stableIdentity'

type Item = { id: string; lat: number; payload?: object }
type Keyed = Item & { key: string }

const run = (store: Map<string, Keyed>, items: Item[], evicted?: string[]) =>
  stableByKey<Item, Keyed>(
    store,
    items,
    (i) => i.id,
    (i, key) => ({ ...i, key }),
    (key) => evicted?.push(key),
  )

describe('stableByKey', () => {
  it('returns the same object for the same key across rebuilds', () => {
    const store = new Map<string, Keyed>()
    const first = run(store, [{ id: 'a', lat: 1 }])
    const second = run(store, [{ id: 'a', lat: 2 }])
    expect(second[0]).toBe(first[0]) // identity held: the layer repositions, not rebuilds
    expect(second[0].lat).toBe(2)
  })

  it('builds a new object for a key it has not seen', () => {
    const store = new Map<string, Keyed>()
    const first = run(store, [{ id: 'a', lat: 1 }])
    const second = run(store, [{ id: 'b', lat: 1 }])
    expect(second[0]).not.toBe(first[0])
  })

  it('refreshes every field, not the ones a caller remembered to list', () => {
    // The bug this helper exists to prevent: a held datum keeping a stale field.
    const store = new Map<string, Keyed>()
    const before = { foo: 1 }
    const after = { foo: 2 }
    run(store, [{ id: 'a', lat: 1, payload: before }])
    const held = run(store, [{ id: 'a', lat: 1, payload: after }])
    expect(held[0].payload).toBe(after)
  })

  it('keeps the fields `make` added, which are not on the item', () => {
    const store = new Map<string, Keyed>()
    run(store, [{ id: 'a', lat: 1 }])
    expect(run(store, [{ id: 'a', lat: 9 }])[0].key).toBe('a')
  })

  it('drops keys that stopped appearing, and says so', () => {
    const store = new Map<string, Keyed>()
    const evicted: string[] = []
    run(store, [{ id: 'a', lat: 1 }, { id: 'b', lat: 1 }], evicted)
    run(store, [{ id: 'b', lat: 1 }], evicted)
    expect(evicted).toEqual(['a'])
    expect([...store.keys()]).toEqual(['b'])
  })

  it('does not evict a key that merely moved position in the list', () => {
    const store = new Map<string, Keyed>()
    const evicted: string[] = []
    const first = run(store, [{ id: 'a', lat: 1 }, { id: 'b', lat: 2 }], evicted)
    const second = run(store, [{ id: 'b', lat: 2 }, { id: 'a', lat: 1 }], evicted)
    expect(evicted).toEqual([])
    expect(second[1]).toBe(first[0])
    expect(second[0]).toBe(first[1])
  })

  it('returns one entry per item, in order', () => {
    const store = new Map<string, Keyed>()
    const out = run(store, [{ id: 'c', lat: 3 }, { id: 'a', lat: 1 }, { id: 'b', lat: 2 }])
    expect(out.map((o) => o.id)).toEqual(['c', 'a', 'b'])
  })

  it('empties the store when handed nothing', () => {
    const store = new Map<string, Keyed>()
    const evicted: string[] = []
    run(store, [{ id: 'a', lat: 1 }], evicted)
    expect(run(store, [], evicted)).toEqual([])
    expect(store.size).toBe(0)
    expect(evicted).toEqual(['a'])
  })

  it('handles a duplicate key in one batch without evicting it', () => {
    const store = new Map<string, Keyed>()
    const evicted: string[] = []
    const out = run(store, [{ id: 'a', lat: 1 }, { id: 'a', lat: 2 }], evicted)
    expect(out[0]).toBe(out[1]) // one object, so the last value wins
    expect(out[0].lat).toBe(2)
    expect(evicted).toEqual([])
  })
})
