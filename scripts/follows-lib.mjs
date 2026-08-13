/**
 * BORDERS V3: a frontier DECLARES what it follows, and the build derives it.
 *
 * The contract is docs/design/borders-v3.md. The insight it turns into code:
 * a hand-authored frontier is a dozen points guessed over a mental map, and no
 * pipeline can add truth to a guess — but most real frontiers FOLLOW A NAMED
 * FEATURE, and we already ship the feature. So `nations.json` stops storing the
 * geometry of the Rhine limes and starts storing the *claim* that it is the
 * Rhine, between two places:
 *
 *     { "river": "Rhine", "from": [4.1,51.98], "to": [7.59,47.56],
 *       "note": "the limes from the mouth to Basel" }
 *     { "modern": "FRA-ESP" }
 *     { "line": [[...],[...]] }        // explicit, where nothing helps
 *
 * The historian's judgement stays hardcoded — WHICH feature, between WHICH
 * points, in which year — and the geometric detail comes out of Natural Earth.
 * The thing that changes is that the error stops being invisible: the distance
 * from a declared endpoint to the nearest vertex of the feature it claims is a
 * NUMBER this module returns, per declaration, and the build prints it.
 *
 * FIVE STEPS, and each is a place the old format could not fail because it
 * could not try:
 *
 *  1. EXTRACT   the feature — a named river out of `src/data/rivers-named.json`
 *               (`scripts/vendor-rivers.mjs`), or the arcs two countries share
 *               in the NE 50m topology (`modern`, the same arcs the modern
 *               border layer is built from).
 *  2. MAINLINE  NE stores a river as several features that meet at confluences
 *               and lake crossings — the Indus is thirteen — so "the Danube" is
 *               the LONGEST CONTINUOUS CHAIN of them, and the pieces it did not
 *               take are recorded rather than silently dropped.
 *  3. SNAP      each declared endpoint to the nearest vertex of that chain, and
 *               report how far it had to go. This is the error number.
 *  4. ORIENT    the extracted run so it leaves the ring where the author's
 *               `from` was and arrives where their `to` was — the ring is wound
 *               clockwise and a river is stored source-to-mouth or mouth-to-
 *               source depending on which NE digitised.
 *  5. SPLICE    it in over the run of authored vertices between those two
 *               points, and check the ring still closes.
 *
 * WHAT THIS IS NOT. It does not move a frontier: the declaration says where the
 * frontier is, exactly as the authored points did, and the derived geometry is
 * only the shape BETWEEN those two statements. A declaration that names the
 * wrong river or the wrong reach produces a large snap distance and a loud
 * build line, which is the whole point of measuring it.
 */

/* ------------------------------------------------------------- the metric */

const RAD = Math.PI / 180
const EARTH_KM = 6371.0088

/** Great-circle distance in km. Snapping happens in this, not in degrees. */
export function distKm(a, b) {
  const dLat = (b[1] - a[1]) * RAD
  const dLng = (b[0] - a[0]) * RAD
  const la = a[1] * RAD
  const lb = b[1] * RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Length of an open polyline, in km. */
export const lengthKm = (line) => {
  let s = 0
  for (let i = 0; i + 1 < line.length; i++) s += distKm(line[i], line[i + 1])
  return s
}

/* ------------------------------------------------------- feature extraction */

/** `src/data/rivers-named.json` -> { name: [[lng,lat], ...][] }, decoded. */
export function decodeRivers(file, quantum = file.quantum ?? 1e-4) {
  const out = new Map()
  for (const [name, lines] of Object.entries(file.rivers)) {
    out.set(
      name,
      lines.map((enc) => {
        const line = []
        let x = 0
        let y = 0
        for (let i = 0; i < enc.length; i += 2) {
          x += enc[i]
          y += enc[i + 1]
          line.push([x * quantum, y * quantum])
        }
        return line
      }),
    )
  }
  return out
}

/**
 * THE MAINLINE: the longest continuous path through a river's pieces.
 *
 * Natural Earth digitises a river as a set of LineStrings that meet end to end
 * at confluences, at the points where it crosses a lake, and wherever the
 * source data changed hand — and it gives the same `name` to distributaries and
 * to named headwater branches. The Danube is three features, the Amur five, the
 * Indus thirteen. "Follow the Danube" has to mean one polyline, so:
 *
 *   · pieces are nodes joined where their endpoints coincide (to the vendored
 *     quantum, which is exact — they are the same stored point);
 *   · the mainline is the path through that graph of greatest total LENGTH;
 *   · every piece the path did not take is returned in `dropped`, with its
 *     length, so a build can print the choice instead of hiding it.
 *
 * The search is exhaustive rather than greedy. It is a depth-first walk over
 * an edge set that is thirteen at its largest in this corpus, so "try every
 * path" costs nothing and removes the class of bug where a greedy walk takes a
 * long tributary at the first fork and loses a longer trunk behind it.
 */
export function mainline(lines, tolKm = JOIN_TOL_KM) {
  if (!lines.length) return { line: [], dropped: [], forks: 0, joins: [], km: 0 }
  // Endpoints within the join tolerance are ONE node. Greedy clustering over at
  // most a few dozen points, so the O(n²) is free and the order is stable.
  const nodes = []
  const nodeOf = (p) => {
    for (let i = 0; i < nodes.length; i++)
      if (distKm(p, nodes[i].at) <= tolKm) {
        nodes[i].gaps.push(distKm(p, nodes[i].at))
        return i
      }
    nodes.push({ at: p, gaps: [] })
    return nodes.length - 1
  }
  const edges = lines.map((line, i) => ({
    i,
    line,
    a: nodeOf(line[0]),
    b: nodeOf(line[line.length - 1]),
    len: lengthKm(line),
  }))
  const at = new Map()
  const join = (node, e) => {
    let list = at.get(node)
    if (!list) at.set(node, (list = []))
    list.push(e)
  }
  for (const e of edges) {
    join(e.a, e)
    if (e.b !== e.a) join(e.b, e)
  }
  const forks = [...at.values()].filter((l) => l.length > 2).length

  let best = { len: -1, used: [] }
  const used = new Set()
  /** Walk on from `node`, having already covered `len` km through `path`. */
  const walk = (node, len, path) => {
    if (len > best.len) best = { len, used: [...path] }
    for (const e of at.get(node) ?? []) {
      if (used.has(e.i)) continue
      used.add(e.i)
      path.push(e)
      walk(e.a === node ? e.b : e.a, len + e.len, path)
      path.pop()
      used.delete(e.i)
    }
  }
  for (const e of edges) {
    used.add(e.i)
    walk(e.b, e.len, [e])
    used.delete(e.i)
    used.add(e.i)
    walk(e.a, e.len, [e])
    used.delete(e.i)
  }

  // Stitch the chosen pieces, flipping each so it continues the one before it.
  const chain = best.used
  const line = []
  let node = chain.length > 1 ? (chain[0].a === chain[1].a || chain[0].a === chain[1].b ? chain[0].b : chain[0].a) : chain[0].a
  for (const e of chain) {
    const pts = e.a === node ? e.line : [...e.line].reverse()
    for (const p of line.length ? pts.slice(1) : pts) line.push(p)
    node = e.a === node ? e.b : e.a
  }
  const taken = new Set(chain.map((e) => e.i))
  const dropped = edges
    .filter((e) => !taken.has(e.i))
    .map((e) => ({ index: e.i, km: e.len, points: e.line.length }))
    .sort((x, y) => y.km - x.km)
  const joins = nodes.flatMap((n) => n.gaps).filter((g) => g > 0)
  return { line, dropped, forks, joins, km: best.len }
}

/**
 * HOW WIDE A HOLE IN A RIVER IS STILL THE SAME RIVER.
 *
 * Natural Earth digitises a long river as several reaches, and where two of
 * them meet the stored endpoints are usually the same point — but not always:
 * measured over the vendored set, the Ussuri's two halves miss each other by
 * 129 m, the Amur's by 11 m and the Euphrates' worst seam is 361 m. Read with
 * an exact key those rivers are two rivers, and "the Ussuri" resolves to its
 * lower half.
 *
 * The number that separates a seam from a real discontinuity is the data's own
 * step: the median segment in this file is 1.8 km, so a hole of a kilometre is
 * a pair of points Natural Earth could not have distinguished in the first
 * place, while the next-largest endpoint pair in the corpus that is NOT a seam
 * sits out at tens of kilometres (two tributaries near one confluence). Every
 * hole actually bridged is returned in `joins`, so the build prints them rather
 * than papering over them.
 */
export const JOIN_TOL_KM = 1

/* ----------------------------------------------------- the modern-line arcs */

/**
 * ISO 3166-1 alpha-3 to the name Natural Earth's admin-0 layer uses.
 *
 * `countries-50m.json` identifies a country by its NUMERIC ISO code and its
 * English name, and neither is what a historian writes in a declaration —
 * `{"modern":"FRA-ESP"}` is legible and `{"modern":"250-724"}` is not. This is
 * therefore a lookup table and not a derivation, and it is deliberately only as
 * long as the declarations need: an unknown code is a build error naming the
 * code, which is a two-line fix here rather than a silent wrong border.
 */
export const ISO_A3 = {
  AFG: 'Afghanistan', AND: 'Andorra', AUT: 'Austria', BEL: 'Belgium', BGR: 'Bulgaria',
  BIH: 'Bosnia and Herz.', BLR: 'Belarus', CAN: 'Canada', CHE: 'Switzerland', CHN: 'China',
  CZE: 'Czechia', DEU: 'Germany', DNK: 'Denmark', DZA: 'Algeria', ESP: 'Spain',
  FIN: 'Finland', FRA: 'France', GBR: 'United Kingdom', GRC: 'Greece', HRV: 'Croatia',
  HUN: 'Hungary', IND: 'India', IRL: 'Ireland', ITA: 'Italy', KOR: 'South Korea',
  LUX: 'Luxembourg', MAR: 'Morocco', MEX: 'Mexico', MDA: 'Moldova', MRT: 'Mauritania',
  NLD: 'Netherlands', NOR: 'Norway', PAK: 'Pakistan', POL: 'Poland', PRK: 'North Korea',
  PRT: 'Portugal', ROU: 'Romania', RUS: 'Russia', SDN: 'Sudan', SRB: 'Serbia',
  SSD: 'S. Sudan', SVK: 'Slovakia', SVN: 'Slovenia', SWE: 'Sweden', TUR: 'Turkey',
  UKR: 'Ukraine', USA: 'United States of America',
  // NOT COUNTRIES, and in the table for the same reason the countries are: a
  // declaration has to be able to NAME them. Natural Earth's admin-0 layer
  // carries three disputed territories as their own units, so the boundary
  // between (say) China and Pakistan-administered Kashmir is stored as three
  // arcs rather than one, and a frontier that runs along all of them is written
  // `CHN-PAK + CHN-SIA + CHN-IND` — the `FRA-ESP + AND-ESP` pattern, for the
  // same reason. The codes are placeholders: ISO does not assign one to a
  // glacier.
  ESH: 'W. Sahara', SIA: 'Siachen Glacier',
}

/** "FRA-ESP" -> the two NE country names, sorted the way `arcOwners` sorts. */
export function modernPair(code) {
  const parts = code.trim().split('-')
  if (parts.length !== 2) throw new Error(`follows: "${code}" is not an ISO pair like "FRA-ESP"`)
  const names = parts.map((p) => {
    const name = ISO_A3[p.toUpperCase()]
    if (!name) throw new Error(`follows: no ISO alpha-3 "${p}" in ISO_A3 (scripts/follows-lib.mjs)`)
    return name
  })
  return names.sort()
}

/**
 * The pieces of the boundary between two modern countries.
 *
 * A TopoJSON topology stores a shared boundary ONCE, as an arc both countries
 * reference, which is the same fact round 57's modern-border layer is built on
 * — so this asks the same question of the same file and gets the same answer,
 * and the two layers cannot disagree about where the France/Spain line is.
 * `frontierArcs` is passed in rather than imported so this module has no
 * opinion about which topology it reads.
 *
 * A MICRO-STATE INTERRUPTS A PAIR, and that is what `+` is for. France and
 * Spain share two arcs, not one, because Andorra sits between them: asking for
 * `FRA-ESP` alone gets the western 346 km and stops at the tripoint. Writing
 * `FRA-ESP + AND-ESP` adds the Andorran side of the gap, chains exactly (a
 * tripoint is one stored node, so the join is at zero distance) and states in
 * the data WHICH SIDE of the micro-state the historical frontier ran — which is
 * a judgement, so it belongs in the declaration rather than in a tolerance.
 */
export function modernLines(arcs, code) {
  const out = []
  for (const one of code.split('+')) {
    const [a, b] = modernPair(one)
    const want = `${a} | ${b}`
    const got = arcs.filter((arc) => arc.key === want).map((arc) => arc.points)
    if (!got.length) throw new Error(`follows: the topology has no shared arc for ${one.trim()} (${want})`)
    out.push(...got)
  }
  return out
}

/* ------------------------------------------------------------- the resolver */

/** Nearest vertex of `line` to `p`: its index and the distance in km. */
export function snapToLine(p, line) {
  let bestI = 0
  let best = Infinity
  for (let i = 0; i < line.length; i++) {
    const d = distKm(p, line[i])
    if (d < best) {
      best = d
      bestI = i
    }
  }
  return { index: bestI, km: best }
}

/** The run of `line` between two vertex indices, oriented i -> j. */
export const subPath = (line, i, j) => (i <= j ? line.slice(i, j + 1) : line.slice(j, i + 1).reverse())

/**
 * ONE DECLARATION, resolved against one feature.
 *
 * Returns the derived polyline plus everything a report needs to be honest
 * about it: how far each declared endpoint was from the feature it claims, how
 * many vertices came back for the two that went in, and — for a river — which
 * branches the mainline choice left behind.
 */
export function resolveOne(decl, features) {
  const feature = featureOf(decl, features)
  const from = decl.from ?? feature.line[0]
  const to = decl.to ?? feature.line[feature.line.length - 1]
  const a = snapToLine(from, feature.line)
  const b = snapToLine(to, feature.line)
  if (a.index === b.index)
    throw new Error(`follows: ${label(decl)} snaps both endpoints to the same vertex of ${feature.name}`)
  const path = subPath(feature.line, a.index, b.index)
  return {
    decl,
    name: feature.name,
    path,
    from,
    to,
    snapFromKm: a.km,
    snapToKm: b.km,
    km: lengthKm(path),
    dropped: feature.dropped ?? [],
    joins: feature.joins ?? [],
    forks: feature.forks ?? 0,
  }
}

const label = (decl) => (decl.river ? `river ${decl.river}` : decl.modern ? `modern ${decl.modern}` : 'line')

/**
 * A declaration's feature, as one polyline with a name.
 *
 * `line` needs no extraction at all — it is the escape hatch for a frontier
 * that follows nothing the data holds, and its only job is to be spliced like
 * the others so the format has one shape.
 */
function featureOf(decl, { rivers, modernArcs }) {
  if (decl.river) {
    const lines = rivers?.get(decl.river)
    if (!lines)
      throw new Error(
        `follows: no river named "${decl.river}" in src/data/rivers-named.json — ` +
          `add it to RIVERS in scripts/vendor-rivers.mjs and re-run npm run map:rivers`,
      )
    return { name: decl.river, ...mainline(lines) }
  }
  if (decl.modern) {
    const lines = modernLines(modernArcs, decl.modern)
    return { name: decl.modern, ...mainline(lines) }
  }
  if (decl.line) return { name: 'line', line: decl.line.map((p) => [p[0], p[1]]) }
  throw new Error(`follows: a declaration must name a river, a modern pair or a line: ${JSON.stringify(decl)}`)
}

/**
 * HOW FAR A SPLICE MAY MOVE THE RING'S OWN ENDPOINTS BEFORE IT IS A MISTAKE.
 *
 * Two different distances get measured here and they answer different
 * questions. The SNAP is declared-endpoint-to-feature: "is this really the
 * Danube?", and it should be small because the author is pointing at a river.
 * The SEAM is feature-vertex-to-the-authored-ring-vertex it replaces: "how
 * wrong was the old freehand line here?", and it is allowed to be large,
 * because a large seam is the defect being fixed rather than a defect being
 * introduced. So the snap gets a threshold and the seam gets printed.
 */
export const SNAP_WARN_KM = 40

/**
 * Every declaration on one authored ring, spliced in.
 *
 * The declared `from` and `to` locate the run of AUTHORED vertices the derived
 * geometry replaces: each is snapped to the nearest vertex of the ring as well
 * as to the nearest vertex of the feature, and the run between them — forward,
 * in ring order, which is the order the declarations are written in — is what
 * comes out. Runs may not overlap; two declarations that claim the same
 * authored vertices are a data error, because the second would silently
 * discard the first.
 *
 * Rings are stored OPEN and wound clockwise, so a run that wraps past the end
 * is handled by rotating the ring rather than by a special case: an open ring's
 * first vertex is not a property of the polity, it is where the author started
 * typing.
 */
export const spliceFollows = (ring, decls, features) => spliceResolved(ring, decls.map((d) => resolveOne(d, features)))

export function spliceResolved(ring, resolved) {
  if (!resolved.length) return { ring, segments: [] }
  const runs = resolved.map((r) => {
    const a = snapToRing(r.from, ring)
    const b = snapToRing(r.to, ring)
    if (a.index === b.index)
      throw new Error(`follows: ${label(r.decl)} snaps both endpoints to the same authored vertex`)
    return { ...r, a: a.index, b: b.index, seamFromKm: a.km, seamToKm: b.km }
  })

  // Rotate so no run wraps the seam of the open ring, then work in one pass.
  const wrapping = runs.filter((r) => r.b < r.a)
  if (wrapping.length > 1) throw new Error('follows: two declarations wrap the start of one ring')
  const shift = wrapping.length ? wrapping[0].a : 0
  const rot = shift ? [...ring.slice(shift), ...ring.slice(0, shift)] : ring
  const n = ring.length
  const placed = runs
    .map((r) => ({ ...r, a: (r.a - shift + n) % n, b: (r.b - shift + n) % n }))
    .sort((x, y) => x.a - y.a)
  // Two declarations may TOUCH at one authored vertex and often must: the Yalu
  // and the Tumen meet on the Paektu watershed, the Ussuri joins the Amur at
  // Khabarovsk, and the ring has one vertex there. What is forbidden is
  // overlapping, where the second splice would silently discard the first.
  for (let i = 1; i < placed.length; i++)
    if (placed[i].a < placed[i - 1].b)
      throw new Error(
        `follows: ${label(placed[i].decl)} and ${label(placed[i - 1].decl)} claim the same authored vertices`,
      )

  const out = []
  const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9
  let at = 0
  for (const r of placed) {
    for (let i = at; i < r.a; i++) out.push(rot[i])
    // The path is oriented so it leaves where `from` was and arrives at `to`;
    // that is what `subPath` already did, and it is what keeps the ring's
    // clockwise winding — a reversed splice would tie a bow in the polygon.
    for (const p of r.path) {
      if (out.length && same(out[out.length - 1], p)) continue
      out.push([p[0], p[1]])
    }
    at = r.b + 1
  }
  for (let i = at; i < n; i++) out.push(rot[i])
  return { ring: out, segments: placed }
}

/** Nearest AUTHORED vertex to a declared endpoint. */
export function snapToRing(p, ring) {
  return snapToLine(p, ring)
}

/**
 * A whole keyframe: its rings, and the declarations spread over them.
 *
 * WHICH RING a declaration belongs to is not stated in the data and does not
 * need to be. Rome at 117 is five pieces and the Rhine is unambiguously in the
 * European one; the ring a declaration lands on is the one whose vertices are
 * nearest its two endpoints, which is the same question the splice asks anyway.
 * Storing an index instead would be a second thing to keep right when a piece
 * is added, for no gain — and a declaration that is genuinely ambiguous between
 * two pieces of one polity is a declaration in the wrong place.
 */
export function resolveKeyframe(rings, decls, features) {
  const resolved = decls.map((d) => resolveOne(d, features))
  const groups = rings.map(() => [])
  for (const r of resolved) {
    let best = 0
    let bestKm = Infinity
    rings.forEach((ring, i) => {
      const km = snapToLine(r.from, ring).km + snapToLine(r.to, ring).km
      if (km < bestKm) {
        bestKm = km
        best = i
      }
    })
    groups[best].push(r)
  }
  const out = []
  const segments = []
  const checks = []
  rings.forEach((ring, i) => {
    if (!groups[i].length) {
      out.push(ring)
      return
    }
    const spliced = spliceResolved(ring, groups[i])
    checks.push({ ring: i, ...checkSplice(ring, spliced.ring) })
    out.push(spliced.ring)
    segments.push(...spliced.segments)
  })
  return { rings: out, segments, checks }
}

/**
 * The ring closes, and the splice did not turn it inside out.
 *
 * A ring is stored open, so "closes" is about the last vertex being able to
 * reach the first: the check is that the closing edge is no longer than the
 * longest edge the splice was allowed to leave, and that the winding did not
 * flip — the globe's polygon layer fills the clockwise side, and a
 * counter-clockwise outer ring paints the whole planet except the nation.
 */
export function checkSplice(before, after) {
  const area = (r) => {
    let s = 0
    for (let i = 0; i < r.length; i++) {
      const [x, y] = r[i]
      const [nx, ny] = r[(i + 1) % r.length]
      s += x * ny - nx * y
    }
    return s / 2
  }
  const a0 = area(before)
  const a1 = area(after)
  return {
    closed: after.length > 2,
    windingKept: Math.sign(a0) === Math.sign(a1),
    areaBefore: Math.abs(a0),
    areaAfter: Math.abs(a1),
    closingKm: distKm(after[after.length - 1], after[0]),
  }
}

/* ---------------------------------------------------------- the error report */

/**
 * HOW CLOSE AN EDGE HAS TO BE TO A DECLARED SEGMENT TO COUNT AS DECLARED.
 *
 * The report cannot ask the clipper what an edge's provenance is: clipping
 * against the coastline cuts rings, inserts intersection points and renumbers
 * everything, and the difference operator that resolves a shared frontier does
 * it again. So provenance is recovered geometrically — an edge is declared if
 * its midpoint lies on a declared polyline — and the tolerance is set by what
 * the pipeline can move a point that it did NOT cut: nothing, except the
 * `QUANTUM` = 1e-4° of the integer codec. 5e-4° (55 m) is five quanta, well
 * under the 400 m the land data itself can assert, so this measures provenance
 * rather than proximity: a freehand line that happens to run near the Danube is
 * not counted as the Danube.
 */
export const DECLARED_TOL_DEG = 5e-4

/** A grid over polyline segments — `coastIndex`'s structure, for any lines. */
export function segmentIndex(lines, cell = 1) {
  const grid = new Map()
  const add = (ix, iy, seg) => {
    const k = ix * 100000 + iy
    let list = grid.get(k)
    if (!list) grid.set(k, (list = []))
    list.push(seg)
  }
  for (const line of lines)
    for (let i = 0; i + 1 < line.length; i++) {
      const seg = [line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]]
      const x0 = Math.floor(Math.min(seg[0], seg[2]) / cell)
      const x1 = Math.floor(Math.max(seg[0], seg[2]) / cell)
      const y0 = Math.floor(Math.min(seg[1], seg[3]) / cell)
      const y1 = Math.floor(Math.max(seg[1], seg[3]) / cell)
      for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) add(ix, iy, seg)
    }
  return { grid, cell }
}

function distSqToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const qx = ax + t * dx
  const qy = ay + t * dy
  return (px - qx) * (px - qx) + (py - qy) * (py - qy)
}

export function nearSegment(index, x, y, tol = DECLARED_TOL_DEG) {
  const ix = Math.floor(x / index.cell)
  const iy = Math.floor(y / index.cell)
  const tol2 = tol * tol
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      const list = index.grid.get((ix + dx) * 100000 + (iy + dy))
      if (!list) continue
      for (const s of list) if (distSqToSegment(x, y, s[0], s[1], s[2], s[3]) <= tol2) return true
    }
  return false
}

/**
 * THE METRIC: how much of a keyframe's inland frontier is derived, and how much
 * is still a guess.
 *
 * Inland is the classification the pipeline already makes — a coastal edge is
 * not political ink and is not this round's business. Of what is left, an edge
 * is DECLARED if it lies on a resolved declaration, and the answer is a ratio
 * of LENGTHS rather than of edge counts, because a derived run is a hundred
 * short edges where the guess it replaced was one long one and counting edges
 * would flatter it by two orders of magnitude.
 */
export function declaredShare(rings, index, tol = DECLARED_TOL_DEG) {
  let inland = 0
  let declared = 0
  for (const { ring, coastal } of rings)
    for (let i = 0; i < ring.length; i++) {
      if (coastal[i]) continue
      const j = (i + 1) % ring.length
      const km = distKm(ring[i], ring[j])
      inland += km
      const mx = (ring[i][0] + ring[j][0]) / 2
      const my = (ring[i][1] + ring[j][1]) / 2
      if (nearSegment(index, mx, my, tol)) declared += km
    }
  return { inlandKm: inland, declaredKm: declared, share: inland > 0 ? declared / inland : 0 }
}

/** The report's one line per polity, and the corpus total. */
export function errorTable(rows) {
  const total = rows.reduce(
    (a, r) => ({
      inlandKm: a.inlandKm + r.inlandKm,
      declaredKm: a.declaredKm + r.declaredKm,
      snaps: a.snaps.concat(r.snaps),
    }),
    { inlandKm: 0, declaredKm: 0, snaps: [] },
  )
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  return {
    rows: rows
      .map((r) => ({ ...r, share: r.inlandKm > 0 ? r.declaredKm / r.inlandKm : 0, meanSnapKm: mean(r.snaps) }))
      .sort((a, b) => b.declaredKm - a.declaredKm),
    total: { ...total, share: total.inlandKm > 0 ? total.declaredKm / total.inlandKm : 0, meanSnapKm: mean(total.snaps) },
  }
}
