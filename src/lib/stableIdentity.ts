/**
 * Keeping object identity across rebuilds.
 *
 * globe.gl's layers join data by *object identity*: a datum the layer has seen
 * before keeps its element and is merely repositioned, a datum it has not is
 * built from scratch — a new DOM node for a pin, a new mesh and a fresh
 * tessellation for an arc. So handing a layer a freshly-spread `{...item}` on
 * every layout rebuilds everything it draws, and a zoom rebuilds the layout
 * several times on its way in.
 *
 * The fix is one object per logical key, reused: look the key up, and if it is
 * held, copy the new values onto the object the layer already knows instead of
 * replacing it.
 *
 * The part that is easy to get wrong, and was gotten wrong twice, is the copy.
 * A datum that keeps its identity must not keep *stale fields*: the pin cache
 * once refreshed only the position, and a pin's `fanned` flag stayed true after
 * its cluster had closed. The legs cache had the same shape of bug waiting in
 * it — it refreshed four coordinates by name and left `event` pointing at
 * whichever object it first saw. Copying the whole item, always, is the only
 * version of this that does not need a per-field audit every time a field is
 * added.
 */

/**
 * Reconcile `items` against `store`, returning one stable object per item.
 *
 * Held objects are refreshed in place and returned; unheld ones are built by
 * `make` and remembered. Keys that no longer appear are dropped, and `onEvict`
 * fires for each so callers can clear anything they keep alongside (the pin
 * layer caches its elements by the same key).
 */
export function stableByKey<In extends object, Out extends In>(
  store: Map<string, Out>,
  items: readonly In[],
  keyOf: (item: In) => string,
  make: (item: In, key: string) => Out,
  onEvict?: (key: string) => void,
): Out[] {
  const live = new Set<string>()
  const out = items.map((item) => {
    const key = keyOf(item)
    live.add(key)
    const held = store.get(key)
    if (held) {
      // Everything, not just the position — see the note above. `make`'s extra
      // fields survive: they are not on `item`, so nothing overwrites them, and
      // anything derived from them is part of the key anyway.
      Object.assign(held, item)
      return held
    }
    const fresh = make(item, key)
    store.set(key, fresh)
    return fresh
  })
  for (const key of [...store.keys()])
    if (!live.has(key)) {
      store.delete(key)
      onEvict?.(key)
    }
  return out
}
