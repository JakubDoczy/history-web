/**
 * CONTESTED TERRITORY: ground with no single honest holder.
 *
 * The contract is docs/design/contested-territory.md. Its one structural idea:
 * a contested zone is CARVED, not overlapped. The nations layer promises that
 * every point at every date has exactly one holder — that is what the overlap
 * validator exists to enforce — and the way to keep the promise while telling
 * the truth about Crimea is to take the ground away from both claimants and
 * give it to the zone. So at build time a zone is subtracted from every
 * claimant whose keyframe overlaps its dates, exactly the way the sea is
 * subtracted from everyone, and the overlap validator needs no exemption.
 *
 * This module is the part of that which is worth testing on its own: who a
 * claimant is, whether the claim is checkable, and how a zone is measured.
 */

import polygonClipping from 'polygon-clipping'

/* --------------------------------------------------------- who is claiming */

/**
 * A CLAIMANT THAT IS NOT IN THE CORPUS.
 *
 * `claimants` names polities by their `nations.json` id wherever one exists —
 * `india` is a polity here and a claimant of Kashmir, and the carve takes the
 * disputed ground out of its fill. Most claimants are not: this corpus is
 * historical and thins to a handful of powers after 1900, so Ukraine, Russia,
 * Pakistan, Morocco, Sudan and South Sudan have no entry, and round 57 decided
 * on purpose that the present-day states arrive as INK rather than as polities
 * (see docs/design/nations-rework.md — 241 units against a globe that caps
 * itself at ten).
 *
 * A claimant like that still has to be checkable, or `claimants` is a free-text
 * field and a typo ships. So it resolves to a unit of Natural Earth's admin-0
 * layer — the same `countries-50m.json` the modern-border ink is built from —
 * and the validator asks that the zone intersect it or abut it. The display
 * name is written out here rather than taken from NE because NE's is an atlas
 * label ("S. Sudan", "W. Sahara") and this one goes in a hover label.
 * The keys may not collide with a polity id and the validator says so, which is
 * why the Russian Federation is `russianfederation` here: `russia` is already
 * the Russian Empire, 1547–1917, and one key that means the Tsar's state in one
 * zone and Putin's in another is exactly the silent wrong answer this pipeline
 * keeps refusing to ship.
 */
export const MODERN_CLAIMANTS = {
  morocco: { ne: 'Morocco', name: 'Morocco' },
  pakistan: { ne: 'Pakistan', name: 'Pakistan' },
  russianfederation: { ne: 'Russia', name: 'Russian Federation' },
  sahrawi: { ne: 'W. Sahara', name: 'Sahrawi Arab Democratic Republic' },
  southsudan: { ne: 'S. Sudan', name: 'South Sudan' },
  sudan: { ne: 'Sudan', name: 'Sudan' },
  ukraine: { ne: 'Ukraine', name: 'Ukraine' },
}

/**
 * One claimant key, resolved against the corpus first and Natural Earth second.
 *
 * `kind` is the whole difference downstream: a `polity` claimant is one the
 * carve takes ground away from and whose colour a stripe of the hatch can be,
 * and a `modern` claimant is a name the map has no fill for — so the zone's
 * hatch goes neutral on that side (see lib/contested.ts) and the only thing
 * the build can check is that the claim is geographically possible.
 */
export function resolveClaimant(key, byId) {
  const polity = byId.get(key)
  if (polity) return { kind: 'polity', id: key, name: polity.name, color: polity.color }
  const modern = MODERN_CLAIMANTS[key]
  if (modern) return { kind: 'modern', id: key, name: modern.name, ne: modern.ne }
  return undefined
}

/* ------------------------------------------------------------ measurement */

const RAD = Math.PI / 180
const EARTH_KM = 6371.0088

/**
 * Area of a closed ring on the sphere, in km².
 *
 * The rest of the pipeline measures in square degrees, which is the right unit
 * for comparing a sliver with a province and the wrong one for a number a human
 * checks against an almanac: a square degree is 12 300 km² at the equator and
 * 6 200 km² in Ladakh. The error report prints km² for exactly that reason —
 * "Crimea is 28 533 km²" is a claim an author can be wrong about, and
 * "0.42 sq°" is not.
 */
export function ringAreaKm2(ring) {
  let s = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    s += (x2 - x1) * RAD * (2 + Math.sin(y1 * RAD) + Math.sin(y2 * RAD))
  }
  return Math.abs((s * EARTH_KM * EARTH_KM) / 2)
}

/** …and of a multipolygon, holes subtracted. */
export function areaKm2(mp) {
  let a = 0
  for (const poly of mp) poly.forEach((ring, i) => (a += (i ? -1 : 1) * ringAreaKm2(ring)))
  return a
}

/* ------------------------------------------------- is the claim even possible */

/** Great-circle distance in km — `follows-lib`'s, repeated rather than imported
 * so this module has no opinion about that one's shape. */
function distKm(a, b) {
  const dLat = (b[1] - a[1]) * RAD
  const dLng = (b[0] - a[0]) * RAD
  const la = a[1] * RAD
  const lb = b[1] * RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Nearest point of segment ab to p, in degrees-as-plane, then measured in km. */
function gapKm(p, a, b) {
  const vx = b[0] - a[0]
  const vy = b[1] - a[1]
  const l2 = vx * vx + vy * vy
  if (!l2) return distKm(p, a)
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2
  t = Math.max(0, Math.min(1, t))
  return distKm(p, [a[0] + t * vx, a[1] + t * vy])
}

export const bboxOf = (mp) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity]
  for (const poly of mp)
    for (const ring of poly)
      for (const [x, y] of ring) {
        if (x < b[0]) b[0] = x
        if (y < b[1]) b[1] = y
        if (x > b[2]) b[2] = x
        if (y > b[3]) b[3] = y
      }
  return b
}

/**
 * HOW FAR APART TWO SHAPES MAY BE AND STILL BE THE SAME DISPUTE.
 *
 * The contract asks that a zone intersect each claimant, because "a zone nobody
 * claimed is a typo". Intersection alone is too strong for the half of the
 * claimants that are present-day states, and for a reason that is not a
 * tolerance problem but a fact about the data: Natural Earth draws the DE FACTO
 * line, so its Sudan does not contain Abyei's southern neighbour's claim, its
 * Morocco stops at the berm, and its Russia does not contain Crimea — Crimea is
 * inside NE's Ukraine. A claim is a claim about ground the claimant does not
 * hold, so demanding that the claimant's polygon already cover it convicts
 * exactly the honest cases.
 *
 * So the test is intersect-OR-ABUT, and the abut distance is set by the
 * narrowest real separation in the corpus: the Kerch Strait, 3.1 km of water
 * between Crimea and Krasnodar Krai. 25 km is eight times that and still an
 * order of magnitude under any distance that could hide a typo — the nearest
 * wrong answer to "who claims Crimea" is a country hundreds of kilometres away.
 */
export const ABUT_TOL_KM = 25

/**
 * The gap between two multipolygons in km, given up on past `within`.
 *
 * Zero if they intersect. Otherwise the smallest distance from a vertex of
 * either to a segment of the other, restricted to the neighbourhood of the
 * first — a claimant polygon is Russia, and walking eleven thousand of its
 * vertices against a Crimean ring is a second of build time to answer a
 * question that only the vertices near Crimea can affect.
 */
export function gapBetweenKm(a, b, within = ABUT_TOL_KM) {
  if (polygonClipping.intersection(a, b).length) return 0
  const pad = within / 111 + 0.05
  const box = bboxOf(a)
  const near = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad]
  const inBox = ([x, y]) => x >= near[0] && x <= near[2] && y >= near[1] && y <= near[3]
  let best = Infinity
  const walk = (points, rings) => {
    for (const p of points) {
      if (!inBox(p)) continue
      for (const ring of rings)
        for (let i = 0; i < ring.length; i++) {
          const g = gapKm(p, ring[i], ring[(i + 1) % ring.length])
          if (g < best) best = g
        }
    }
  }
  const ringsOf = (mp) => mp.flatMap((poly) => poly)
  const clip = (mp) => ringsOf(mp).filter((ring) => ring.some(inBox))
  const bNear = clip(b)
  if (!bNear.length) return Infinity
  walk(ringsOf(a).flat(), bNear)
  walk(bNear.flat(), ringsOf(a))
  return best
}

/* ------------------------------------------------------------- the validator */

/**
 * EVERYTHING THE CONTRACT ASKS OF A ZONE, as a list of strings.
 *
 * Returned rather than thrown, and one entry per fault rather than the first,
 * because the caller prints them all in the error report next to the numbers
 * they belong with — the same shape `checkModern` uses. An empty array is the
 * only passing answer.
 *
 *   zones      [{ zone, mp, carved }] — the authored entry, the clipped
 *              geometry before the carve, and after it
 *   byId       corpus polities by id
 *   geometryOf (polityId, from, to) -> multipolygon union over that span, or []
 *   countryOf  (neName) -> multipolygon, or undefined if NE has no such unit
 */
export function zoneFaults(zones, byId, geometryOf, countryOf) {
  const faults = []
  const seen = new Set()
  for (const { zone, from, to, mp, carved } of zones) {
    const at = `contested "${zone.id}"`
    if (seen.has(zone.id)) faults.push(`${at}: duplicate id`)
    seen.add(zone.id)
    if (!(to > from)) faults.push(`${at}: ends at ${to}, which is not after ${from}`)
    if (!mp.length) faults.push(`${at}: clipped to land it is empty — is it drawn over the sea?`)
    if (!carved.length) faults.push(`${at}: an earlier zone carved all of it away`)
    const claimants = zone.claimants ?? []
    if (claimants.length < 2)
      faults.push(`${at}: ${claimants.length} claimant(s) — contested ground needs at least two`)
    if (new Set(claimants).size !== claimants.length) faults.push(`${at}: a claimant is named twice`)
    for (const key of claimants) {
      if (byId.has(key) && MODERN_CLAIMANTS[key])
        faults.push(`${at}: "${key}" is both a polity id and a modern claimant — rename one`)
      const who = resolveClaimant(key, byId)
      if (!who) {
        faults.push(
          `${at}: no polity or modern claimant "${key}" — add it to nations.json, or to` +
            ` MODERN_CLAIMANTS in scripts/contested-lib.mjs`,
        )
        continue
      }
      if (who.kind === 'polity') {
        const p = byId.get(key)
        if (p.to < from || p.from > to)
          faults.push(
            `${at}: ${key} exists ${p.from}..${p.to} and the zone runs ${from}..${to} — they never overlap`,
          )
        else {
          const claim = geometryOf(key, from, to)
          if (!claim.length || !polygonClipping.intersection(mp, claim).length)
            faults.push(`${at}: ${key} is drawn nowhere near it, so the carve would take nothing`)
        }
      } else {
        const country = countryOf(who.ne)
        if (!country) {
          faults.push(`${at}: Natural Earth has no admin-0 unit named "${who.ne}" for claimant ${key}`)
          continue
        }
        const gap = gapBetweenKm(mp, country)
        if (gap > ABUT_TOL_KM)
          faults.push(
            `${at}: ${key} (${who.ne}) is ${gap === Infinity ? 'nowhere near' : `${gap.toFixed(0)} km from`}` +
              ` the zone — over the ${ABUT_TOL_KM} km a claim may reach across`,
          )
      }
    }
  }
  return faults
}
