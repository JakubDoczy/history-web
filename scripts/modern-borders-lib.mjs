/**
 * THE MODERN STATES, as frontier ink — the second half of round 57.
 *
 * The 73-polity corpus is historical, and it stops being a political map of the
 * world some time in the nineteenth century: at 2000 the globe draws the United
 * States, China and India and nothing else, so Europe, Africa and the Middle
 * East have no borders at all in the years the reader knows best. This module
 * builds the missing layer out of Natural Earth's 1:50m admin-0 countries — the
 * SAME topology `land-50m.json` is cut from (`world-atlas@2`'s
 * countries-50m.json carries both `countries` and `land` off one arc table), so
 * coast agreement here is not a tolerance, it is identity.
 *
 * THREE DECISIONS, and they are the whole design.
 *
 * 1. **Ink, not polities.** These are 241 units, and the nations layer caps the
 *    globe at ten (`MAX_VISIBLE`) precisely because a political map of the whole
 *    world is not what it is for. So nothing here becomes a `Nation`: there are
 *    no fills, no hover targets, no entries in `visibleNations`, and nothing to
 *    click. What ships is the *lines between* countries — the frontier ink the
 *    `FrontierLayer` already draws in one call — and a modern state's coastline
 *    is drawn by the map, as everybody's is.
 *
 * 2. **A shared arc is one line.** A TopoJSON topology stores the boundary
 *    between two countries ONCE, as an arc both reference. So the frontiers are
 *    exactly the arcs with two owners (362 of 1959), and they come out deduped
 *    by construction rather than by tolerance — the France/Germany line is one
 *    line, not two opinions of one, which is the invariant round 52 had to
 *    build a difference operator to get for the hand-authored corpus. The arcs
 *    with ONE owner are the coast (and the odd unclaimed edge), and they are
 *    dropped: the drawn map inks the coastline itself, and a second pen over it
 *    is the doubled shore the reader reported in round 52.
 *
 * 3. **A two-owner arc names its pair**, which is what makes the honesty
 *    threshold cheap — see `MERGES`.
 */

import { onCoast } from './nations-clip-lib.mjs'

/**
 * FROM WHICH YEAR IS A CURRENT-DAY BORDER SET AN HONEST ANSWER? — the decision
 * this round was asked to make and write down.
 *
 * Natural Earth ships *today's* borders. Drawn at 1960 they would be a lie with
 * a hundred and thirty wrong lines in it (the whole decolonisation of Africa is
 * after them, the USSR is one state, Yugoslavia is one state). The two clean
 * places to start are:
 *
 *  · **2011 and later** — every line NE draws is correct, unpatched, because
 *    South Sudan's secession on 9 July 2011 is the last change to the world's
 *    land frontiers that a 1:50m map can see. Nothing to build, nothing to
 *    justify, and it leaves the twentieth century's last two decades — the end
 *    of the USSR, the Balkan wars, the reunification of Germany — with no
 *    borders on the map at all.
 *  · **1992 and later, with a patch set** — the first full year after the
 *    Soviet Union dissolved (26 December 1991), by which point all fifteen
 *    republics, Namibia, and a reunified Germany are on today's map exactly as
 *    NE draws them. Six frontiers have to be *withheld* until the year they
 *    became frontiers, and — because this layer ships the lines BETWEEN
 *    countries and nothing else — withholding one is literally "do not draw
 *    this line yet". A merge is a deletion. There is no geometry to build, no
 *    boolean union to run, and no second copy of a country's outline: the
 *    external border of Sudan-plus-South-Sudan is already the union of their
 *    outlines the moment the line between them is not drawn.
 *
 * The patch set is that cheap, so it is the one that shipped, and 1992 is the
 * threshold. `MERGES` is the whole of it.
 *
 * WHAT IS STILL NOT TRUE between 1992 and now, written down rather than
 * quietly shipped:
 *
 *  · Hong Kong (1997) and Macao (1999) are separate units in NE and their lines
 *    are drawn for the whole window; before the handovers they were a British
 *    colony and a Portuguese one, which is a different fact about the same line.
 *  · Somaliland (1991), Northern Cyprus (1983) and Kosovo after 2008 are drawn
 *    because NE draws them; each is a de-facto boundary a good many states do
 *    not recognise. Western Sahara's line with Morocco is the berm, not a
 *    frontier anybody agreed. Palestine's is the 1949 armistice line.
 *  · Crimea is drawn as Ukraine, which is where NE's admin-0 leaves it, and
 *    which is a de-jure answer to a question that has had a de-facto answer
 *    since 2014.
 *  · Small demarcations settled inside the window (Iraq/Kuwait 1993, the
 *    Bakassi transfer in 2006, the India/Bangladesh enclave exchange in 2015)
 *    move lines by less than the 400 m this data can express.
 */
export const MODERN_FROM = 1992

/** …and the last year it is drawn. The corpus's own convention for "now". */
export const MODERN_TO = 2100

/**
 * The frontiers that were not frontiers yet, and the year each became one.
 *
 * Keyed by the pair of NE country names the shared arc carries. Everything else
 * about a merged state is already right: Czechoslovakia's external border is
 * Czechia's and Slovakia's minus the line between them, and that is what
 * dropping the line leaves.
 */
export const MERGES = [
  {
    pair: ['Czechia', 'Slovakia'],
    from: 1993,
    why: 'The Velvet Divorce, 1 January 1993. Before it, one Czechoslovakia with exactly this outline.',
  },
  {
    pair: ['Eritrea', 'Ethiopia'],
    from: 1993,
    why: 'Eritrean independence, 24 May 1993, after the referendum in April. Before it, Ethiopia had a coast.',
  },
  {
    pair: ['Indonesia', 'Timor-Leste'],
    from: 2002,
    why: 'East Timor restored to independence on 20 May 2002, after the 1999 referendum and the UN transitional administration. Indonesia had annexed it in 1976.',
  },
  {
    pair: ['Montenegro', 'Serbia'],
    from: 2006,
    why: 'Montenegro leaves the state union on 3 June 2006. Before it, one country — FR Yugoslavia, then Serbia and Montenegro.',
  },
  {
    pair: ['Kosovo', 'Montenegro'],
    from: 2006,
    why: 'The same union: while Serbia and Montenegro are one state, Kosovo has no boundary with Montenegro that is not internal to it.',
  },
  {
    pair: ['Kosovo', 'Serbia'],
    from: 2008,
    why: 'Kosovo declares independence on 17 February 2008. Drawn from then because NE draws it; recognition is not universal, and this line is the most contested in the set.',
  },
  {
    pair: ['S. Sudan', 'Sudan'],
    from: 2011,
    why: "South Sudan's secession on 9 July 2011 — the last change to the world's land frontiers this map can see, and the reason 2011 is the other honest threshold.",
  },
]

const pairKey = (a, b) => [a, b].sort().join(' | ')

/** The merge table as a lookup from pair key to entry. */
export const mergeIndex = () => new Map(MERGES.map((m) => [pairKey(...m.pair), m]))

/* ------------------------------------------------------------- the topology */

/**
 * Quantised TopoJSON arcs as absolute degrees.
 *
 * The same forty lines as lib/drawnGeometry.ts and scripts/vendor-map-data.mjs,
 * and for the same reason they are there rather than in `topojson-client`: a
 * quantised topology is delta-coded integers, a scale and a translate.
 */
export function decodeArcs(topo) {
  const [sx, sy] = topo.transform.scale
  const [tx, ty] = topo.transform.translate
  return topo.arcs.map((arc) => {
    let x = 0
    let y = 0
    return arc.map(([dx, dy]) => {
      x += dx
      y += dy
      return [x * sx + tx, y * sy + ty]
    })
  })
}

/** Which countries reference each arc. A frontier is an arc two of them do. */
export function arcOwners(topo, object = 'countries') {
  const owners = topo.arcs.map(() => new Set())
  const walk = (a, name) => {
    if (Array.isArray(a)) for (const v of a) walk(v, name)
    else owners[a < 0 ? ~a : a].add(name)
  }
  for (const g of topo.objects[object].geometries) walk(g.arcs ?? [], g.properties?.name ?? g.id)
  return owners
}

/**
 * Every land frontier in the world, once each, with the two countries it
 * separates.
 *
 * An arc with three owners would be a triple point stored as a shared edge and
 * would mean this reading is wrong; there are none in the 50m topology, and the
 * build asserts it rather than assuming it.
 */
export function frontierArcs(topo) {
  const arcs = decodeArcs(topo)
  const owners = arcOwners(topo)
  const out = []
  for (let i = 0; i < arcs.length; i++) {
    if (owners[i].size < 2) continue
    const names = [...owners[i]].sort()
    if (names.length > 2)
      throw new Error(`modern borders: arc ${i} is shared by ${names.length} countries: ${names.join(', ')}`)
    if (arcs[i].length < 2) continue
    out.push({ a: names[0], b: names[1], key: pairKey(...names), points: arcs[i] })
  }
  return out
}

/* ------------------------------------------------- the coast, same as ever */

/**
 * Cut a frontier polyline where it runs along the coast.
 *
 * Almost none of it does — an arc with two country owners is a land frontier by
 * construction — but a border that follows a river to its mouth ends ON the
 * shore, and the last edge of it is then the same line the map draws in its own
 * pen. The test is `classifyCoastal`'s, on an OPEN polyline: both ends and the
 * midpoint within `COAST_TOL_DEG` of a land segment, because ends alone would
 * condemn every frontier that merely touches the sea at each end.
 */
export function splitOffCoast(points, coasts, tol) {
  const at = points.map((p) => onCoast(coasts, p[0], p[1], tol))
  const out = []
  let cur = []
  let dropped = 0
  for (let i = 0; i + 1 < points.length; i++) {
    const mx = (points[i][0] + points[i + 1][0]) / 2
    const my = (points[i][1] + points[i + 1][1]) / 2
    const coastal = at[i] && at[i + 1] && onCoast(coasts, mx, my, tol)
    if (coastal) {
      dropped++
      if (cur.length > 1) out.push(cur)
      cur = []
      continue
    }
    if (!cur.length) cur.push(points[i])
    cur.push(points[i + 1])
  }
  if (cur.length > 1) out.push(cur)
  return { lines: out, dropped }
}

/* ------------------------------------------------------------- the payload */

/**
 * The shipped form: delta-coded polylines, plus the handful that are dated.
 *
 * `encode` is `encodeRing` from lib/nations.ts — the same integer codec, at the
 * same 1e-4° quantum, as the polity corpus, because it is the same kind of
 * thing (a walk in small steps) and because one codec is one round-trip test.
 */
export function buildModernBorders(topo, coasts, { encode, tol } = {}) {
  const merges = mergeIndex()
  const dated = new Map()
  const lines = []
  let vertices = 0
  let droppedEdges = 0
  let pairs = new Set()
  for (const arc of frontierArcs(topo)) {
    const { lines: runs, dropped } = coasts ? splitOffCoast(arc.points, coasts, tol) : { lines: [arc.points], dropped: 0 }
    droppedEdges += dropped
    if (!runs.length) continue
    pairs.add(arc.key)
    const merge = merges.get(arc.key)
    if (merge && !dated.has(arc.key))
      dated.set(arc.key, { from: merge.from, pair: arc.key, why: merge.why, lines: [] })
    const into = merge ? dated.get(arc.key).lines : lines
    for (const run of runs) {
      vertices += run.length
      into.push(encode ? encode(run) : run)
    }
  }
  const missing = MERGES.filter((m) => !dated.has(pairKey(...m.pair)))
  if (missing.length)
    throw new Error(
      `modern borders: the merge table names pairs the topology has no shared arc for: ` +
        missing.map((m) => m.pair.join(' | ')).join(', '),
    )
  return {
    source:
      'Natural Earth 1:50m Admin 0 countries (public domain), via the npm package world-atlas@2 — ' +
      'the same countries-50m.json topology public/data/map/land-50m.json is cut from.',
    from: MODERN_FROM,
    to: MODERN_TO,
    lines,
    dated: [...dated.values()].sort((x, y) => x.from - y.from || x.pair.localeCompare(y.pair)),
    stats: { vertices, pairs: pairs.size, droppedEdges },
  }
}
