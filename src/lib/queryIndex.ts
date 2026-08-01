/**
 * The two indexes a "what is on screen right now" query needs, and the bounded
 * selection it feeds.
 *
 * Both are static: built once per dataset merge, never updated in place, and
 * deliberately free of any knowledge of events — they take flat arrays of
 * `{start, end}` and `{lat, lng, radiusDeg}` so they can be tested (and
 * benchmarked) without a dataset, and so `events.ts` can own the policy while
 * this file owns the data structure.
 *
 * Everything here is index-based: a query hands back positions into the array
 * it was built from, which is what lets `EventIndex` keep one canonical order
 * (its priority order) and use it as the identity of a pin across both indexes.
 */

/** First index with `arr[i] >= v`. */
export function lowerBound(arr: ArrayLike<number>, v: number, hi = arr.length): number {
  let lo = 0
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** First index with `arr[i] > v`. */
export function upperBound(arr: ArrayLike<number>, v: number, hi = arr.length): number {
  let lo = 0
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Indices of `keys`, ordered by key ascending — an argsort without a comparator.
 *
 * The obvious `[...].sort((a, b) => keys[a] - keys[b])` costs 25 ms on 68 000
 * keys, which is a quarter of the whole index build budget spent on one sort.
 * A comparator-free `TypedArray.sort` is four times faster, so when the keys are
 * integers in a range narrow enough to leave room for an index in the low bits
 * of a double, key and index are packed into one number and sorted as one. The
 * arithmetic is exact below 2^53, and the guard is checked rather than assumed —
 * a fractional or astronomically large key falls back to the comparator.
 *
 * Packing the index in the low bits also makes the order total: equal keys come
 * out in index order, so the structures built on it are deterministic.
 */
export function argsortAscending(keys: ArrayLike<number>): Int32Array {
  const n = keys.length
  const out = new Int32Array(n)
  if (n === 0) return out
  let min = Infinity
  let max = -Infinity
  let packable = true
  for (let i = 0; i < n; i++) {
    const k = keys[i]
    if (!Number.isInteger(k)) {
      packable = false
      break
    }
    if (k < min) min = k
    if (k > max) max = k
  }
  const scale = 2 ** Math.ceil(Math.log2(Math.max(2, n)))
  if (packable && (max - min + 1) * scale <= 2 ** 53) {
    const packed = new Float64Array(n)
    for (let i = 0; i < n; i++) packed[i] = (keys[i] - min) * scale + i
    packed.sort()
    for (let i = 0; i < n; i++) out[i] = packed[i] % scale
    return out
  }
  for (let i = 0; i < n; i++) out[i] = i
  return out.sort((a, b) => keys[a] - keys[b])
}

/* --------------------------------------------------------------- time index */

/** What the time index needs of an item: a closed span, `end` omitted = point. */
export interface Spanned {
  start: number
  end?: number
}

/**
 * Intervals by span magnitude — an interval tree's pruning without the tree.
 *
 * The query is "every span that intersects [s, e]", and the obstacle is the
 * classic one: sorting by start lets a binary search find everything that
 * *begins* before `e`, but says nothing about which of those have already
 * ended, and history's spans differ in length by nine orders of magnitude (a
 * battle lasts a day, the Palaeozoic 289 million years). Scanning back to the
 * first candidate means scanning back past the dinosaurs.
 *
 * So spans are filed by `ceil(log2(span))` — one sorted start-array per
 * magnitude — and each bucket is scanned over starts in `[s − maxSpan_b, e]`.
 * Because `maxSpan_b` is the longest span *in that bucket*, no candidate is
 * missed, and the wasted scan is bounded by the number of items in the bucket
 * that begin in one bucket-width before the window: short spans, of which
 * there are many, cost almost no slack, and the long spans that would cost a
 * lot of slack are few. In practice that is within a factor of two of the exact
 * answer over the real dataset, for a build that is two sorts and no pointers.
 *
 * The endpoint arrays on the side answer a different question in O(log n) and
 * without touching any item: *how many* spans intersect the window. That count
 * is what the query planner in `events.ts` runs on, and it has to be cheap or
 * planning costs more than the plan saves.
 */
export class SpanIndex {
  /** Every start, ascending — the "how many begin before the window ends" half. */
  private readonly startsAsc: Float64Array
  /** Every end, ascending — the "how many finished before it began" half. */
  private readonly endsAsc: Float64Array
  private readonly buckets: {
    maxSpan: number
    starts: Float64Array
    ends: Float64Array
    idx: Int32Array
  }[] = []
  readonly size: number

  /**
   * From columns, which is how `EventIndex` builds it: one pass over the events
   * fills every array both indexes need, and nothing per-item is allocated.
   * `starts` and `ends` are taken as given — normalised (start ≤ end) and owned
   * by the index from here on.
   */
  static fromColumns(starts: Float64Array, ends: Float64Array): SpanIndex {
    return new SpanIndex(undefined, starts, ends)
  }

  constructor(items?: ArrayLike<Spanned>, startCol?: Float64Array, endCol?: Float64Array) {
    const n = (this.size = startCol ? startCol.length : (items?.length ?? 0))
    const starts = startCol ?? new Float64Array(n)
    const ends = endCol ?? new Float64Array(n)
    // Fixed-width and flat throughout: a span can occupy at most 64 magnitude
    // buckets, so the counters are one small typed array rather than a sparse
    // JS array with holes in it — which the fill loop below reads once per
    // event, and which measured 3x slower for no reason but its shape.
    const BUCKETS = 64
    const bucketOf = new Uint8Array(n)
    const counts = new Int32Array(BUCKETS)
    for (let i = 0; i < n; i++) {
      if (items && !startCol) {
        const it = items[i]
        const s = it.start
        const e = it.end === undefined ? s : it.end
        starts[i] = s < e ? s : e
        ends[i] = s < e ? e : s
      }
      const span = ends[i] - starts[i]
      // ceil(log2(span + 1)): span 0 → 0, 1 → 1, 2..3 → 2, 4..7 → 3 …
      const b = span <= 0 ? 0 : Math.min(BUCKETS - 1, Math.ceil(Math.log2(span + 1)))
      bucketOf[i] = b
      counts[b]++
    }
    // Bucket columns are held in flat arrays for the fill loop, then handed to
    // the bucket records: the loop below runs once per event and a property
    // chain (`this.buckets[b].starts[k] = …`) inside it is three lookups.
    const bStarts: Float64Array[] = []
    const bEnds: Float64Array[] = []
    const bIdx: Int32Array[] = []
    const maxSpan = new Float64Array(BUCKETS)
    const fill = new Int32Array(BUCKETS)
    for (let b = 0; b < BUCKETS; b++) {
      bStarts.push(new Float64Array(counts[b]))
      bEnds.push(new Float64Array(counts[b]))
      bIdx.push(new Int32Array(counts[b]))
    }
    // Items arrive in the caller's canonical order, which has nothing to do
    // with time; one argsort by start, walked once, leaves every bucket sorted.
    const order = argsortAscending(starts)
    this.startsAsc = new Float64Array(n)
    for (let k = 0; k < n; k++) {
      const i = order[k]
      const s = starts[i]
      const e = ends[i]
      this.startsAsc[k] = s
      const b = bucketOf[i]
      const at = fill[b]++
      bStarts[b][at] = s
      bEnds[b][at] = e
      bIdx[b][at] = i
      if (e - s > maxSpan[b]) maxSpan[b] = e - s
    }
    for (let b = 0; b < BUCKETS; b++)
      if (counts[b])
        this.buckets.push({ maxSpan: maxSpan[b], starts: bStarts[b], ends: bEnds[b], idx: bIdx[b] })
    this.endsAsc = new Float64Array(ends)
    this.endsAsc.sort()
  }

  /**
   * Exactly how many spans intersect `[s, e]`, in two binary searches.
   *
   * A span misses the window in one of two disjoint ways: it begins after the
   * window ends, or it ended before the window began (disjoint because a span
   * that begins after `e` also ends after `e ≥ s`). Neither set needs the items
   * themselves, so both are counts over the endpoint arrays.
   */
  countIntersecting(s: number, e: number): number {
    if (!(e >= s)) return 0
    return Math.max(0, upperBound(this.startsAsc, e) - lowerBound(this.endsAsc, s))
  }

  /** Every index whose span intersects `[s, e]`, in no particular order. */
  forEach(s: number, e: number, visit: (i: number) => void): void {
    if (!(e >= s)) return
    for (const b of this.buckets) {
      const n = b.starts.length
      if (n === 0) continue
      const hi = upperBound(b.starts, e, n)
      if (hi === 0) continue
      const lo = lowerBound(b.starts, s - b.maxSpan, hi)
      for (let k = lo; k < hi; k++) if (b.ends[k] >= s) visit(b.idx[k])
    }
  }
}

/* ------------------------------------------------------------ space index */

const RAD = Math.PI / 180
const hav = (deg: number) => Math.sin((deg * RAD) / 2) ** 2

/** Longitude difference in (−180, 180]. */
const wrapLng = (d: number) => {
  const x = (((d + 180) % 360) + 360) % 360 - 180
  return x === -180 ? 180 : x
}

/**
 * Great-circle separation in degrees (haversine).
 *
 * Duplicated from lib/eventClusters rather than imported: this file is the one
 * thing in the app with no dependencies at all, which is what lets the bench
 * script load it on its own, and a six-line formula is a cheaper price for that
 * than an import graph.
 */
export function separationDeg(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const s =
    hav(bLat - aLat) + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * hav(wrapLng(bLng - aLng))
  return (2 * Math.asin(Math.min(1, Math.sqrt(s)))) / RAD
}

/** What the space index needs: a point, plus an optional footprint radius. */
export interface Located {
  lat: number
  lng: number
  /** Angular radius of an area item about its centroid; absent = a point. */
  radiusDeg?: number
}

/** A circle on the sphere: the shape a camera frame is approximated by. */
export interface Cap {
  lat: number
  lng: number
  radiusDeg: number
}

/**
 * Items whose footprint is wider than this are held aside and scanned whole.
 *
 * The grid finds an area item by its *centroid*, so a cap query has to be
 * widened by the largest footprint in the grid or it will miss an item whose
 * centre is outside the frame and whose edge is inside it. One continent-sized
 * event would therefore widen every query on the dataset. Five degrees (~550
 * km) is about the largest footprint the corpus actually carries in bulk;
 * anything bigger goes on a list short enough to test in full.
 */
export const BIG_RADIUS_DEG = 5

/**
 * A lat/lng bucket grid over point-ish items.
 *
 * A kd-tree was the alternative and was rejected on the shape of the query
 * rather than on asymptotics: every query here is a cap that usually holds
 * *many* items, so the win is in touching few cells and then testing items in
 * a tight loop over typed arrays, which a CSR grid does with no pointer chasing
 * and no per-node objects. A kd-tree's advantage — adapting to clustered data —
 * costs a traversal per query and an object per node, and event locations are
 * clustered at a scale (cities) far below any cell the camera ever asks about.
 *
 * ── A quadtree was built and measured against this, and lost. ──────────────
 *
 * The reasoning for trying it was sound: B+ trees suit date ranges, not space,
 * and the grid's resolution *does* stop growing (bands are capped at 64), so at
 * a hundred times the present dataset one cell over Paris holds a thousand
 * events. A capacity-splitting quadtree was written to the same interface and
 * given every advantage the argument above asks for — no per-node objects, no
 * recursion, five typed arrays, items in one permutation array with each node
 * owning a contiguous slice, rectangles recomputed on descent, per-node subtree
 * radius bounds in place of this file's global pad and big-list, and free
 * arithmetic early-outs before any trigonometry.
 *
 * On isolated cap queries it won, and not narrowly — over 25 zoom/place cases
 * (both poles and the seam included), summed:
 *
 *   scale          build           structure        all cap queries
 *   1x     683     0.08 → 0.16 ms  15 → 23 B/event  0.51 → 0.36 ms   1.4x
 *   10x    6,830   0.62 → 1.51 ms   8 →  9 B/event  4.35 → 1.51 ms   2.9x
 *   100x   68,300  5.16 → 18.6 ms  0.33 → 0.50 MB   47.0 → 9.15 ms   5.2x
 *
 * And it lost anyway, because that table measures a question the app does not
 * ask. Almost all of the quadtree's margin is in wide caps, and the app never
 * hands the space index a wide cap: at world view `cameraScope` publishes no
 * scope at all, and by continent zoom the planner has chosen `priority`. What
 * the app actually does is (a) call `candidateCount` on *every* query, whatever
 * plan it then picks, and (b) run `forEach` only for small caps at close zoom.
 * A grid answers (a) with closed-form band arithmetic; a tree has to walk. And
 * the count cannot be approximated to make it cheap — the planner divides by it,
 * so an inflated count makes the priority scan look better than it is, which it
 * disproves by overrunning its budget and running the query a second time. That
 * was measured too: the cheap-count variant was the slowest of the three.
 *
 * End-to-end, same machine, alternating runs, `EventIndex.query` over the same
 * corpus (grid → quadtree; sum of the 25 selection/camera cases, and the two
 * loops the app actually runs):
 *
 *   scale     25 queries        20-step pan (country zoom)
 *   1x        0.32 → 0.48 ms    0.008 → 0.013 ms/query
 *   10x       1.82 → 2.42 ms    0.035 → 0.056 ms/query
 *   100x      7.70 → 10.5 ms    0.026 → 0.045 ms/query   (build 101 → 112 ms)
 *
 * The grid is ~35% faster on the query mix and ~1.7x faster on panning, at
 * every scale tested. So the grid stays, the quadtree is gone, and the fixed
 * cell size is a known limitation rather than an open question: if it ever does
 * bite, the thing to fix first is the 64-band cap, not the structure.
 * `scripts/bench-eventIndex.mjs --spatial` still runs the harness that settled
 * it — build, memory, and cap queries across zooms and latitudes, every answer
 * checked against brute force — so the next candidate gets the same treatment.
 *
 * Cell selection is deliberately conservative: a band is entered whenever it
 * *might* hold a member, and every candidate is then tested exactly. The bound
 * used for the longitude range comes straight from the haversine identity with
 * the band's worst-case latitude substituted in, so it can over-include (a few
 * extra cells) but never under-include.
 */
export class GeoGrid {
  private readonly lats: Float64Array
  private readonly lngs: Float64Array
  private readonly radii: Float64Array | undefined
  private readonly bands: number
  private readonly cols: number
  /**
   * Two CSR layers over the same cell geometry: points, and items with a
   * footprint.
   *
   * They are separated because the pad is per layer, and the pad is what a
   * close camera pays for. A grid holding both has to widen *every* query by
   * the largest footprint in it — a 5° plague makes a 0.35° city view scan a
   * 5.35° circle, which at 100x is two thousand candidates for a frame holding
   * three. Split, the point layer is scanned at exactly the cap's radius and
   * only the footprint layer (5% of the corpus) pays the widening.
   */
  private readonly layers: { offsets: Int32Array; cells: Int32Array; pad: number }[] = []
  /** Items too wide to file by centroid; tested on every query. */
  private readonly big: Int32Array
  readonly size: number

  /**
   * From columns — see `SpanIndex.fromColumns`. The arrays are owned by the
   * grid from here on; `radii` may be omitted when nothing has a footprint.
   */
  static fromColumns(
    lats: Float64Array,
    lngs: Float64Array,
    radii?: Float64Array,
    bandsHint?: number,
  ): GeoGrid {
    return new GeoGrid(undefined, bandsHint, { lats, lngs, radii })
  }

  constructor(
    items?: ArrayLike<Located>,
    bandsHint?: number,
    cols?: { lats: Float64Array; lngs: Float64Array; radii?: Float64Array },
  ) {
    const n = (this.size = cols ? cols.lats.length : (items?.length ?? 0))
    this.lats = cols?.lats ?? new Float64Array(n)
    this.lngs = cols?.lngs ?? new Float64Array(n)
    let anyRadius = false
    const pads = [0, 0]
    const big: number[] = []
    const radii = cols ? (cols.radii ?? new Float64Array(n)) : new Float64Array(n)
    // layer 0 = points, layer 1 = footprints, −1 = too wide for either
    const layerOf = new Int8Array(n)
    for (let i = 0; i < n; i++) {
      if (items && !cols) {
        const it = items[i]
        this.lats[i] = it.lat
        this.lngs[i] = it.lng
        radii[i] = it.radiusDeg ?? 0
      }
      const r = radii[i]
      if (r > 0) anyRadius = true
      if (r > BIG_RADIUS_DEG) {
        layerOf[i] = -1
        big.push(i)
      } else if (r > 0) {
        layerOf[i] = 1
        if (r > pads[1]) pads[1] = r
      }
    }
    this.radii = anyRadius ? radii : undefined
    this.big = Int32Array.from(big)
    // Roughly a handful of items per cell at any dataset size, bounded so the
    // grid stays small on a tiny corpus and cell iteration stays cheap on a
    // huge one. Bands are latitude rows; columns are twice as many, matching
    // the 2:1 shape of the lat/lng rectangle.
    this.bands = Math.max(4, Math.min(64, bandsHint ?? Math.round(Math.sqrt(n / 4))))
    this.cols = this.bands * 2
    const cellCount = this.bands * this.cols
    const cellOf = new Int32Array(n)
    for (let i = 0; i < n; i++)
      cellOf[i] = layerOf[i] < 0 ? -1 : this.cellIndex(this.lats[i], this.lngs[i])
    for (const layer of [0, 1]) {
      const counts = new Int32Array(cellCount)
      for (let i = 0; i < n; i++) if (layerOf[i] === layer && cellOf[i] >= 0) counts[cellOf[i]]++
      const offsets = new Int32Array(cellCount + 1)
      for (let c = 0; c < cellCount; c++) offsets[c + 1] = offsets[c] + counts[c]
      const cellsArr = new Int32Array(offsets[cellCount])
      const fill = Int32Array.from(offsets.subarray(0, cellCount))
      for (let i = 0; i < n; i++)
        if (layerOf[i] === layer && cellOf[i] >= 0) cellsArr[fill[cellOf[i]]++] = i
      this.layers.push({ offsets, cells: cellsArr, pad: pads[layer] })
    }
  }

  private cellIndex(lat: number, lng: number): number {
    const b = Math.max(0, Math.min(this.bands - 1, Math.floor(((lat + 90) / 180) * this.bands)))
    const c =
      ((Math.floor(((wrapLng(lng) + 180) / 360) * this.cols) % this.cols) + this.cols) % this.cols
    return b * this.cols + c
  }

  /**
   * Every cell that might hold a member of the cap.
   *
   * The longitude half-width per band is the haversine identity solved for Δλ,
   *
   *     sin²(d/2) = sin²(Δφ/2) + cos φ · cos φc · sin²(Δλ/2)
   *
   * with the band's *smallest* cos φ and *smallest* |Δφ| substituted in. Both
   * substitutions lower-bound the true separation, so the Δλ that comes out is
   * an over-estimate — cells that cannot hold a member may be visited, cells
   * that can never be skipped. When the right-hand side leaves the domain of
   * asin (a cap that reaches over a pole, or a centre so near one that cos φc
   * vanishes) the whole band is taken, which is the correct answer there.
   */
  private eachCell(cap: Cap, pad: number, visit: (cell: number) => void): void {
    const r = Math.min(180, cap.radiusDeg + pad)
    const bandDeg = 180 / this.bands
    const b0 = Math.max(0, Math.floor(((cap.lat - r + 90) / 180) * this.bands))
    const b1 = Math.min(this.bands - 1, Math.floor(((cap.lat + r + 90) / 180) * this.bands))
    const sinR2 = hav(r)
    const cosC = Math.cos(cap.lat * RAD)
    for (let b = b0; b <= b1; b++) {
      const lat0 = -90 + b * bandDeg
      const lat1 = lat0 + bandDeg
      const dPhi = cap.lat < lat0 ? lat0 - cap.lat : cap.lat > lat1 ? cap.lat - lat1 : 0
      if (dPhi > r) continue
      const cosMin = Math.cos(Math.max(Math.abs(lat0), Math.abs(lat1)) * RAD)
      const denom = cosMin * cosC
      let dLng = 180
      if (denom > 1e-9) {
        const s2 = (sinR2 - hav(dPhi)) / denom
        if (s2 < 1) dLng = (2 * Math.asin(Math.sqrt(Math.max(0, s2)))) / RAD
      }
      const row = b * this.cols
      if (dLng >= 180) {
        for (let c = 0; c < this.cols; c++) visit(row + c)
        continue
      }
      const c0 = Math.floor(((cap.lng - dLng + 180) / 360) * this.cols)
      const c1 = Math.floor(((cap.lng + dLng + 180) / 360) * this.cols)
      const span = Math.min(this.cols - 1, c1 - c0)
      for (let k = 0; k <= span; k++)
        visit(row + ((((c0 + k) % this.cols) + this.cols) % this.cols))
    }
  }

  /** How many items the cap's cells hold — the planner's cost estimate. */
  candidateCount(cap: Cap): number {
    let total = this.big.length
    for (const layer of this.layers)
      if (layer.cells.length)
        this.eachCell(cap, layer.pad, (c) => {
          total += layer.offsets[c + 1] - layer.offsets[c]
        })
    return total
  }

  /**
   * Every index whose location is inside the cap, footprints included: an area
   * item counts as inside when its footprint touches the cap at all.
   */
  forEach(cap: Cap, visit: (i: number) => void): void {
    const test = (i: number) => {
      const reach = cap.radiusDeg + (this.radii ? this.radii[i] : 0)
      if (separationDeg(cap.lat, cap.lng, this.lats[i], this.lngs[i]) <= reach) visit(i)
    }
    for (const layer of this.layers)
      if (layer.cells.length)
        this.eachCell(cap, layer.pad, (c) => {
          const end = layer.offsets[c + 1]
          for (let k = layer.offsets[c]; k < end; k++) test(layer.cells[k])
        })
    for (let k = 0; k < this.big.length; k++) test(this.big[k])
  }

  /** Whether one item is in the cap — the test the other query plans use. */
  contains(cap: Cap, i: number): boolean {
    const reach = cap.radiusDeg + (this.radii ? this.radii[i] : 0)
    return separationDeg(cap.lat, cap.lng, this.lats[i], this.lngs[i]) <= reach
  }
}

/* ------------------------------------------------------- bounded selection */

/**
 * The best `cap` items by (score desc, order asc), kept in a binary min-heap.
 *
 * `order` is the caller's canonical position and breaks every tie, so the
 * result of a query does not depend on which plan produced it — three ways of
 * enumerating the same candidates have to agree to the last element, or zooming
 * would silently reshuffle pins.
 *
 * A heap rather than "collect and sort": a wide selection over a large corpus
 * offers tens of thousands of candidates for thirty slots, and sorting all of
 * them costs more than the query it belongs to. Rejection is one comparison
 * against the root once the heap is full, which is what almost every candidate
 * costs.
 */
export class TopScored<T> {
  private readonly items: T[] = []
  private readonly scores: number[] = []
  private readonly orders: number[] = []
  readonly cap: number
  // an assignment rather than a constructor parameter property: Node runs these
  // sources directly (type stripping) for scripts/bench-eventIndex.mjs, and
  // parameter properties are the one TS-ism that is not just an annotation
  constructor(cap: number) {
    this.cap = cap
  }

  get size(): number {
    return this.items.length
  }
  get full(): boolean {
    return this.items.length >= this.cap
  }
  /** Score of the weakest kept item — −∞ until the heap is full. */
  get worstScore(): number {
    return this.full ? this.scores[0] : -Infinity
  }

  /** True when `worse` loses to `better` under the total order. */
  private loses(worse: number, better: number): boolean {
    return (
      this.scores[worse] < this.scores[better] ||
      (this.scores[worse] === this.scores[better] && this.orders[worse] > this.orders[better])
    )
  }

  push(item: T, score: number, order: number): void {
    // A heap with no room is not "full of the best nothing": with cap 0 the
    // eviction branch below would read an empty root and let the item in.
    if (this.cap <= 0) return
    if (this.full) {
      // the root is the current worst; a candidate that does not beat it cannot
      // enter, and equal scores are settled by the canonical order
      if (score < this.scores[0] || (score === this.scores[0] && order > this.orders[0])) return
      this.items[0] = item
      this.scores[0] = score
      this.orders[0] = order
      this.sink(0)
      return
    }
    this.items.push(item)
    this.scores.push(score)
    this.orders.push(order)
    this.swim(this.items.length - 1)
  }

  private swap(a: number, b: number): void {
    ;[this.items[a], this.items[b]] = [this.items[b], this.items[a]]
    ;[this.scores[a], this.scores[b]] = [this.scores[b], this.scores[a]]
    ;[this.orders[a], this.orders[b]] = [this.orders[b], this.orders[a]]
  }

  private swim(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.loses(i, parent)) break
      this.swap(i, parent)
      i = parent
    }
  }

  private sink(i: number): void {
    const n = this.items.length
    for (;;) {
      const l = 2 * i + 1
      if (l >= n) break
      const r = l + 1
      const child = r < n && this.loses(r, l) ? r : l
      if (!this.loses(child, i)) break
      this.swap(i, child)
      i = child
    }
  }

  /** Best first. Consumes nothing; the heap stays usable. */
  drain(): T[] {
    return this.items
      .map((e, i) => ({ e, s: this.scores[i], o: this.orders[i] }))
      .sort((a, b) => b.s - a.s || a.o - b.o)
      .map((x) => x.e)
  }
}
