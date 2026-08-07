import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments, type Scene } from 'three'
import type { BorderRing, Ring } from './nations'

/**
 * POLITICAL INK — the part of a polity's boundary that is a frontier.
 *
 * Why this exists at all, rather than the polygon layer's own stroke. Once the
 * polities are clipped to `land-50m.json` (scripts/clip-nations.mjs), roughly
 * three quarters of every boundary in the corpus IS the coastline — and the
 * drawn map already draws that line, in its own pen, with an eleven-pixel
 * shoreline wash over it. Stroking the polity's outline on top of it puts a
 * second coastline in a nation colour a hair off the first, which is the doubled
 * edge the reader reported. three-globe strokes a polygon as one closed loop and
 * has no way to say "all of it except these edges", so the frontier is drawn
 * here instead and the polygon layer is left with the cap: the fill that says
 * how far the polity reached, and the hover target that names it.
 *
 * ONE OBJECT for every frontier on the globe. Ten polities at a hundred and
 * thirty pieces would be a hundred and thirty draw calls as one line each; as a
 * single `LineSegments` with a colour per vertex it is one, and the colour is
 * still per polity. The DrawingLayer's fat lines were the obvious alternative
 * and are the wrong tool here: it keys its rebuild on `JSON.stringify(drawing)`
 * and measures a drawing's extent with an O(n²) walk over every point, both of
 * which are fine for a battle plan of forty coordinates and neither of which
 * survives twenty-five thousand.
 *
 * GL_LINES rather than fat lines is also what the borders already were — see
 * `polygonStrokeColor` in GlobeView — so the weight, the aliasing and the
 * behaviour under a moving camera are unchanged from what shipped. What changed
 * is which edges are in it.
 */

const RAD = Math.PI / 180

/** Mirrors three-globe's `polar2Cartesian`: y polar, z through (0, 0). */
const unit = (lng: number, lat: number): [number, number, number] => {
  const p = lat * RAD
  const l = lng * RAD
  const c = Math.cos(p)
  return [c * Math.sin(l), Math.sin(p), c * Math.cos(l)]
}

/**
 * The same height the polygon layer's border stroke was at, and for the reason
 * written down there: below this the cap's own 2° chords sag under the sphere
 * between their ends and the planet eats the line.
 */
export const FRONTIER_ALT = 0.0013

/** #rrggbb to linear-ish 0..1 triple. Three's `Color` would do it; this is two lines. */
const rgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.slice(1), 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/** What a frontier polyline contributes: one segment per step, both endpoints. */
function pushLine(
  path: Ring,
  color: [number, number, number],
  radius: number,
  positions: number[],
  colors: number[],
) {
  for (let i = 0; i + 1 < path.length; i++) {
    for (const [lng, lat] of [path[i], path[i + 1]]) {
      const u = unit(lng, lat)
      positions.push(u[0] * radius, u[1] * radius, u[2] * radius)
      colors.push(color[0], color[1], color[2])
    }
  }
}

/** One entry's ink: its frontier runs, or its whole outline where coasts are kept. */
export const inkPathsOf = (entry: BorderRing, coastal: boolean): Ring[] =>
  coastal ? entry.coordinates : entry.frontier

export class FrontierLayer {
  private geometry = new BufferGeometry()
  private material: LineBasicMaterial
  private lines: LineSegments
  /** What is drawn now, so an unchanged border list is not rebuilt per tick. */
  private currentKey = ''

  constructor(
    scene: Scene,
    private radius: number,
  ) {
    this.material = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      // Same contract as every other overlay: test depth so the planet hides
      // what is round the back, write none so nothing punches a hole in
      // anything, and bias in depth-buffer units so the line is not eaten by
      // its own map at any zoom (see `groundBias` in lib/drawingLayer.ts).
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    })
    this.lines = new LineSegments(this.geometry, this.material)
    // Under the DrawingLayer's twelve — a battle plan wins over a border — and
    // over the polygon layer's nought, so a frontier is not lost under a fill.
    this.lines.renderOrder = 6
    this.lines.frustumCulled = false
    scene.add(this.lines)
  }

  /** The scene node, exposed so a test can count what was built. */
  get object() {
    return this.lines
  }

  /**
   * Draw these polities' frontiers in these colours. Returns true if anything
   * changed — the caller's cue to wake the render pump.
   *
   * `colorOf` is a parameter rather than `entry.nation.color` because a nation
   * colour was chosen against a dark photograph and has to be re-aimed at the
   * drawn map's paper; the mode is the caller's business (see `onGround`).
   */
  set(entries: BorderRing[], colorOf: (e: BorderRing) => string, coastal: boolean): boolean {
    const key = entries.map((e) => `${e.nation.id}:${colorOf(e)}`).join('|') + (coastal ? '#c' : '')
    if (key === this.currentKey) return false
    this.currentKey = key
    const positions: number[] = []
    const colors: number[] = []
    const r = this.radius * (1 + FRONTIER_ALT)
    for (const entry of entries) {
      const color = rgb(colorOf(entry))
      for (const path of inkPathsOf(entry, coastal)) pushLine(path, color, r, positions, colors)
    }
    this.geometry.dispose()
    this.geometry = new BufferGeometry()
    this.geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    this.geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
    this.lines.geometry = this.geometry
    this.lines.visible = positions.length > 0
    return true
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
    this.lines.removeFromParent()
  }
}
