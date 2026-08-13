import { Color, DoubleSide, MeshBasicMaterial } from 'three'

/**
 * THE HATCH — how a map says "disputed" without picking a side.
 *
 * Cartography settled this long before we got here: the ground two states both
 * claim is not painted in either's colour, it is HATCHED in both. This module
 * is that pattern as a shader, and everything about how it is written down is
 * decided by one requirement from the contract:
 *
 *   **the stripes must be fixed to the ground, not to the screen.**
 *
 * A hatch computed in screen space is the obvious cheap version and it is
 * unusable here: the reader turns this globe constantly, and a pattern whose
 * bands are pinned to the viewport crawls across the territory on every drag —
 * the disputed ground appears to be moving, which is exactly the impression a
 * disputed border must not give. So the stripe coordinate is derived in the
 * fragment shader from the cap vertex's OWN POSITION, which the polygon layer
 * built out of longitude and latitude and which no camera can change. Turn the
 * planet and the hatch turns with Crimea, because it is painted on Crimea.
 *
 * ONE DRAW CALL, and the same one a polity's fill costs. This is a
 * `MeshBasicMaterial` with the stripe patched into its fragment shader rather
 * than a `ShaderMaterial` written from scratch, for two reasons that both bite:
 * three's built-in materials get the output colour-space conversion and the
 * tone-mapping chunks that a raw ShaderMaterial silently does not (see the long
 * note in lib/globeSurface.ts about what that costs), and `forceSinglePass` —
 * round 59's draw-call fix, which halved the frame's calls at 1941 — is a
 * property of the material, so a new transparent DoubleSide material that
 * forgot it would quietly hand back what that round bought.
 */

/**
 * HOW WIDE A STRIPE IS, in degrees of ground.
 *
 * Fixed on the ground rather than on the screen, so it has to suit both ends of
 * the zoom the zones are read at. The five shipped zones span from the Abyei
 * box (1.17° wide) to Western Sahara (8.4°): at 0.22° the box gets five stripes
 * across and the Sahara thirty-eight, which is a pattern in both cases rather
 * than a stripe in one and a moiré in the other. Zoomed out past the point where
 * a stripe is under a pixel the shader stops trying — see the fade below — so
 * the far view shows the average of the two colours instead of aliasing.
 */
export const HATCH_PERIOD_DEG = 0.22

/**
 * …and which way they run: at 45° in lng/lat, which is the contract's own
 * wording and — measured — the only version of it that behaves.
 *
 * The first attempt scaled longitude by cos(latitude) first, on the reasoning
 * that a stripe should be the same number of kilometres wide everywhere. It is
 * wrong, and wrong in a way only a photograph catches: `lng * cos(lat)` uses
 * the ABSOLUTE longitude, so the level sets of `lng·cos(lat) + lat` shear by an
 * amount proportional to how far the zone is from Greenwich. Measured off the
 * shipped frames, the hatch came out at 47° over Abyei (28°E), 76° over Kashmir
 * (76°E) and −79° over Western Sahara (−13°E) — a pattern that changes
 * direction as the reader pans, which is the screen-space defect wearing a
 * different hat.
 *
 * Plain degrees have no such term. What varies instead is the stripe's width
 * and screen angle with latitude, and only gently: 17 km and 45° at the
 * equator, 14 km and 55° at 45°N, 13 km and 57° over the occupied oblasts. A
 * quarter of a stripe's width across the whole corpus, and it is stable at any
 * one place, which is what "fixed to the ground" has to mean.
 */
export const HATCH_BEARING_DEG = 45

/**
 * THE TWO NEUTRAL TONES, for the stripe of a claimant the map has no fill for.
 *
 * The contract says a claimant absent from the frame hatches grey, and the
 * reasoning is sound: a colour that appears nowhere else on the globe is a code
 * with no legend, so inventing one for the Russian Federation would be worse
 * than saying nothing. But four of the five shipped zones have BOTH claimants
 * absent — this corpus is historical and stops drawing polities in the years
 * these disputes belong to — and one grey against the same grey is not a hatch,
 * it is a flat wash, which is precisely the "somebody holds this" statement the
 * whole feature exists to avoid making.
 *
 * So neutral is two tones rather than one: same hue as the map's own pen, a
 * light band and a dark one. The zone still reads as hatched, and it still says
 * nothing about who holds it.
 *
 * The pair is DARK FIRST and near-paper second, which is what makes the result
 * read as hatching rather than as a texture: a band of ink with a band of
 * ground between it is what an engraver would have drawn, and it is what the
 * eye already knows means "not settled". Measured on the drawn map at
 * `CONTESTED.fill.schematic`, the two bands land 30 levels apart against
 * parchment, which is a pattern; the first pair tried here was a light tone at
 * full weight against a dark one at half weight and came out 11 levels apart,
 * i.e. a wash with a rumour of stripes in it.
 */
export const HATCH_NEUTRAL = ['#6b6558', '#efe9dc'] as const

/** The stripe, in the middle of `MeshBasicMaterial`'s fragment shader. */
const STRIPE_GLSL = /* glsl */ `
  // Ground coordinates, recovered from the cap's own vertex. The polygon layer
  // built this position out of (lng, lat), so this inverts exactly what it did
  // and the result cannot depend on the camera.
  vec3 g = normalize(vGround);
  float lat = asin(clamp(g.y, -1.0, 1.0));
  float lng = atan(g.x, g.z);
  // Degrees of longitude and latitude, unscaled — see HATCH_BEARING_DEG for
  // what scaling longitude by its own parallel did to the pattern.
  vec2 ground = vec2(lng, lat) * ${(180 / Math.PI).toFixed(6)};
  float s = dot(ground, uHatchDir) / uHatchPeriod;

  // A procedural stripe, antialiased on its own derivative: without this the
  // pattern aliases into moiré the moment a band is near a pixel wide, which on
  // a globe that zooms from a continent to a city is most of the range.
  float e = clamp(fwidth(s), 0.0001, 0.5);
  float f = fract(s);
  float m = smoothstep(0.5 - e, 0.5 + e, f) - smoothstep(1.0 - e, 1.0 + e, f);
  // …and past the point where a whole period is under a pixel, stop striping
  // and show the average of the two bands. Aliasing is what a hatch looks like
  // when it is wrong; a wash is what it looks like when it is far away.
  m = mix(m, 0.5, clamp((e - 0.15) * 4.0, 0.0, 1.0));

  diffuseColor.rgb = mix(uHatchA, uHatchB, m);
`

/** A colour, or the neutral tone for that side when the claimant has no fill. */
export const hatchTone = (color: string, side: 0 | 1): string => color || HATCH_NEUTRAL[side]

/**
 * The material for one zone's cap, given the two stripe colours.
 *
 * Held by the caller, one per colour pair, for the reason `capMaterial` is: the
 * polygon layer compares materials by identity on every digest and a fresh
 * object swaps the material on every ring, every time the list is re-set.
 * `customProgramCacheKey` is what keeps that from also costing a shader
 * recompile — every hatch material patches the same source and differs only in
 * uniforms, so they must all share one program.
 */
export function hatchMaterial(a: string, b: string, opacity: number): MeshBasicMaterial {
  const bear = (HATCH_BEARING_DEG * Math.PI) / 180
  const material = new MeshBasicMaterial({
    transparent: true,
    opacity,
    depthWrite: false,
    side: DoubleSide,
    // Round 59's draw-call fix; the note is on `capMaterial` in GlobeView.
    forceSinglePass: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHatchA = { value: new Color(a) }
    shader.uniforms.uHatchB = { value: new Color(b) }
    shader.uniforms.uHatchDir = { value: { x: Math.cos(bear), y: Math.sin(bear) } }
    shader.uniforms.uHatchPeriod = { value: HATCH_PERIOD_DEG }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGround;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGround = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vGround;\nuniform vec3 uHatchA;\nuniform vec3 uHatchB;\n' +
          'uniform vec2 uHatchDir;\nuniform float uHatchPeriod;',
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${STRIPE_GLSL}`)
  }
  // One program for every zone on the globe; see above.
  material.customProgramCacheKey = () => 'contested-hatch'
  return material
}
