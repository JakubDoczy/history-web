import {
  DataTexture,
  GLSL3,
  LinearFilter,
  LinearMipmapLinearFilter,
  RedFormat,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  Vector4,
  RepeatWrapping,
  type WebGLRenderer,
} from 'three'
import type { EraPlan } from './paleo'
import { ATLAS_COLS, INDEX_ROWS, INDEX_W, LOW_PX, type Grid } from './tileAtlas'
import { TILE_PX } from './tilePyramid'
import { PALETTE_GAMMA, type Palette } from './palette'
import { CLOUD_UPSCALE, cloudUpscaleWorthIt } from './cloudUpscale'
import { cloudDriftPhase } from './scale'
import { fadeTowards } from './mapFade'
import { PAPER } from './drawnTile'
import type { CloudUpscaleRequest, CloudUpscaleResponse } from './cloudUpscale.worker'

/**
 * One material for the whole planet surface.
 *
 * Everything that used to be a separate concentric sphere — the day/night map,
 * the two paleo-era crossfade shells, and the cloud film — is composited here in
 * a single pass. Stacked shells only 0.2–1% of a radius apart cannot be
 * separated by the depth buffer, which is what made the surface flicker while
 * zooming; with one shell there is nothing left to fight.
 */
const vertex = /* glsl */ `
out vec2 vUv;
out vec3 vNormalW;
out vec3 vWorldPos;
void main() {
  vUv = uv;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

/**
 * The enhanced-mode tone curve.
 *
 * The old grade was a plain smoothstep S-curve on the albedo, which pushes
 * everything under 0.5 *down*. Two things were wrong with that. The curve
 * darkened exactly the range that needed opening up, and it ran on the *linear*
 * albedo — the colour maps are sRGB, so three decades of interesting terrain
 * are squeezed into the bottom few percent there. Measured on the basemap,
 * central European land is 0.012–0.064 linear; the Sahara is 0.16–0.47. Europe
 * had nowhere to go but muddy.
 *
 * So the remap happens in a perceptual (≈ gamma 2.2) space, where those same
 * pixels read 0.15–0.30 and the desert reads 0.44–0.71, and it is piecewise:
 *  - below `lo`: deep ocean, scaled down, so water stays black-blue
 *  - `lo`..`hi`: the land band, stretched across a much wider output range with
 *    a gamma under 1, which lifts the shadow end hardest — that is where the
 *    grey-level separation between forest, field and coastline comes from
 *  - above `hi`: highlights, compressed, so deserts and ice keep their detail
 *    instead of clipping to flat orange and white
 *
 * The numbers live here rather than inline in the GLSL so the shader and the TS
 * mirror the tests check cannot drift apart.
 */
export const ENHANCED_GRADE = {
  /** Encoding gamma the curve is expressed in. */
  gamma: 2.2,
  lo: 0.09,
  hi: 0.44,
  outLo: 0.05,
  outHi: 0.66,
  /** Curve shape inside the band; under 1 = lifted shadows, steep dark end. */
  bandGamma: 0.72,
  /** Chroma multiplier applied around the new luminance. */
  saturation: 1.2,
  /**
   * How much of the *land* grade to withhold from water. Open ocean shares
   * Europe's luminance band, so grading the sea with the same curve lifts it
   * along with the land and the coastline one is trying to reveal disappears
   * again. Water is the one thing on this map that is reliably more blue than
   * it is anything else, so a blueness mask holds the land curve back.
   */
  waterHold: 0.75,
  /**
   * The blueness mask, as a *ratio* of blue excess to luminance.
   *
   * It used to be an absolute difference — smoothstep(0, 0.02, b - max(r, g))
   * — which is the reason the mid-Pacific rendered black. Deep ocean is so
   * dark in linear light that its channels are only thousandths apart, so the
   * absolute test scored the abyss at 0.16: the water everybody was complaining
   * about was the water the water mask barely recognised, and it took nearly
   * the full land curve, which scales it *down*. Dividing by luminance first
   * makes the test scale-free, so the abyss and the shelf are both read as
   * water.
   */
  waterLo: 0.05,
  waterHi: 0.35,
  /**
   * What water gets *instead* of the land curve: a plain multiplier.
   *
   * Withholding the grade used to mean withholding everything, and the curve's
   * bottom segment scales deep water *down* — the mid-Pacific rendered at a
   * blue channel of ~22/255, i.e. black with a rim of atmosphere. A multiplier
   * is the right shape for water because it touches all three channels
   * equally: the sea comes up without shifting hue, so it brightens toward a
   * lighter blue rather than toward cyan or grey. It stays well under the
   * land's lift, so ocean is still plainly darker than any coast it meets.
   *
   * This is the slope at black, not a flat multiplier — see `waterCeiling`.
   */
  waterGain: 8,
  /**
   * Where the water lift levels off, in linear luminance.
   *
   * A bare multiplier is right for the abyss and wrong for bright shallows: at
   * the gain the mid-Pacific needs, sunlit coastal water would overtake the
   * forest beside it and the coastline would vanish from the other direction.
   * So water runs through `ceiling * (1 - exp(-gain * l / ceiling))`: slope
   * `gain` where the sea was black, asymptotic to `ceiling` where it was
   * already bright. A hard clamp would do the same job at the ends and flatten
   * every bathymetric shade in between into one tone; this keeps them ordered.
   */
  waterCeiling: 0.045,
  /** Overall exposure lift in enhanced mode, applied everywhere including night. */
  exposure: 0.1,
  /**
   * Extra exposure on the *lit* side only. Gated on `daylight`, so the night
   * side keeps exactly the lift it had and space is never touched at all.
   */
  dayExposure: 0.15,
} as const

/**
 * TS mirror of the GLSL curve: linear luminance in, graded linear luminance
 * out. Kept in step with the shader by the constants above.
 */
export function enhancedLuma(linear: number): number {
  const { gamma, lo, hi, outLo, outHi, bandGamma } = ENHANCED_GRADE
  const p = Math.pow(Math.max(linear, 0), 1 / gamma)
  const out =
    p < lo
      ? (p / lo) * outLo
      : p > hi
        ? outHi + ((p - hi) / (1 - hi)) * (1 - outHi)
        : outLo + (outHi - outLo) * Math.pow((p - lo) / (hi - lo), bandGamma)
  return Math.pow(out, gamma)
}

/**
 * TS mirror of the water branch: what a fully-blue pixel's luminance becomes.
 *
 * The gain is a per-channel multiplier, so it scales luminance by exactly the
 * same factor — which is why this can be written on luminance alone.
 */
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * TS mirror of the blueness mask: 1 where a linear-light colour is water, 0
 * where it is land, cloud or ice.
 */
export function waterMask(r: number, g: number, b: number): number {
  const { waterLo, waterHi } = ENHANCED_GRADE
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return smoothstep(waterLo, waterHi, (b - Math.max(r, g)) / Math.max(lum, 0.0008))
}

export function enhancedWaterLuma(linear: number): number {
  const { waterHold, waterGain, waterCeiling: c } = ENHANCED_GRADE
  const sea = c * (1 - Math.exp((-waterGain * Math.max(linear, 0)) / c))
  return enhancedLuma(linear) * (1 - waterHold) + sea * waterHold
}

/**
 * City lights: how the night map becomes an emissive term.
 *
 * The shipped map (public/textures/base/earth-night.webp, 4096×2048) is a
 * black-marble composite over a *blue moonlit base* — measured, the mean pixel
 * is sRGB (4, 23, 39) and open ocean is (6, 24, 46). That base is albedo: it is
 * the planet seen by moonlight, not something that emits. The lights themselves
 * are the warm excess on top of it, and they are dim and barely warm in the
 * asset: the brightest texel anywhere is sRGB (139, 130, 152) and a typical big
 * city core is (110, 102, 101), i.e. about 8% redder than it is blue.
 *
 * Adding the map wholesale — which is what this used to do — therefore adds the
 * blue base as light, so every city sits on a blue wash that is nearly as
 * bright as it is; and it scales a near-neutral 0.15-linear core by 1.6 to get
 * 0.24 linear, which is mid grey. That is exactly the reported symptom: white
 * or grey specks, not lights.
 *
 * So the base is subtracted and the remainder is treated as energy:
 *
 *   energy = max(0, r - blueBase * b)
 *
 * one subtract, no branch, and it separates cleanly because everything in the
 * map that is *not* a light is blue-dominant. Measured over the whole asset:
 * open Pacific 0.0000, Sahara 0.0005, Antarctica 0.0035, Greenland 0.024,
 * against 0.14 for Europe's cores and 0.16 for the brightest pixel on Earth.
 * Ice and moonlit desert used to be indistinguishable from a small town under a
 * luminance test; here they are three orders of magnitude apart.
 *
 * The same expression is linear in the texture, so blurring commutes with it:
 * evaluating it on a high-LOD tap gives exactly the low-passed light energy,
 * which is the halo, with no second extraction to keep in step.
 */
export const NIGHT_LIGHTS = {
  /**
   * How much of the blue channel counts as the moonlit base.
   *
   * 0.55 rather than 1: a mercury-vapour or LED city is very nearly neutral,
   * and subtracting all of its blue would erase it along with the ocean. At
   * 0.55 a neutral light keeps 45% of its energy while the base — whose blue
   * runs 4-14x its red — is driven to zero with room to spare.
   */
  blueBase: 0.55,
  /** The brightest lights energy in the shipped map; normalises the scale below. */
  peak: 0.162,
  /** Encoding gamma the reveal sweeps in; matches ENHANCED_GRADE.gamma. */
  gamma: 2.2,
  /**
   * The electrification reveal: a threshold on the *normalised perceptual*
   * energy, which is in [0, 1] by construction, swept down as uLights rises.
   *
   *   thresh = threshAt0 - span * pow(uLights, curve)
   *
   * The old form ran the same numbers against a raw luminance and assumed it
   * could reach 1. It cannot: the map's peak luminance is 0.215 linear, so the
   * window did not open until uLights ≈ 0.64 and did not open fully until
   * ≈ 0.93 — city lights first appeared in 1978 and were only complete in 2013.
   * 1900, 1930 and 1950 rendered with no lights at all, which is why the era
   * ramp read as broken. Normalising first is what makes the constants mean
   * what they say: `threshAt0 - edge >= 1` is provably zero at uLights = 0
   * (rather than provably-zero-given-an-assumption-about-the-asset), and
   * `threshAt0 - span + edge <= 0` puts the faintest lit texel in view at
   * uLights = 1.
   *
   * `curve` under 1 is what puts the first sparks on the map early. The era
   * factor (lib/sun.ts) is very nearly linear in the year, so a linear sweep
   * spends its first third of travel in a band the map barely reaches: 1900
   * sits at uLights 0.11 and would show nothing at all, against a documented
   * intent of "major city cores visible by ~1900-1930". At 0.75 the threshold
   * has already fallen to 0.93 by 1900 — the dozen brightest cores on Earth and
   * nothing else — and the rest of the sweep still has room to hand out
   * suburbs through the 1950s and 60s.
   */
  threshAt0: 1.2,
  span: 1.38,
  edge: 0.18,
  curve: 0.75,
  /** Emissive gain on the sharp tap: peak energy × core lands just past white. */
  core: 7,
  /** Emissive gain on the wide tap — the halo. Deliberately a fraction of core. */
  halo: 1.6,
  /**
   * LOD bias for the halo tap. A *bias*, not an absolute level, so the spill is
   * always ~6 mips wider than whatever the sharp tap resolved to and can never
   * be undersampled at the limb — an absolute level shimmers there, because the
   * limb's own LOD is far above it.
   */
  haloLod: 2.6,
  /**
   * The sodium ramp, in linear light: amber at the outskirts, warm white at the
   * cores. Low-pressure sodium is what most of the world was lit by when this
   * imagery was taken, and it is why a black-marble photograph reads amber
   * rather than white; the cores go pale because they are clipped, not because
   * they are a different colour, so the ramp ends at warm white and only the
   * very peak reaches 1 in every channel.
   */
  dim: [1, 0.362, 0.078],
  hot: [1, 0.806, 0.578],
  /** Where the ramp runs, on the same normalised perceptual scale. */
  hotLo: 0.35,
  hotHi: 0.95,
} as const

/**
 * TS mirror of the GLSL extraction: a linear-light night-map pixel in, lights
 * energy out. Zero for anything the map paints with moonlight rather than
 * sodium.
 */
export function lightsEnergy(r: number, b: number): number {
  return Math.max(0, r - NIGHT_LIGHTS.blueBase * b)
}

/** TS mirror of the normalised perceptual scale the reveal and the ramp use. */
export function lightsScale(energy: number): number {
  const { peak, gamma } = NIGHT_LIGHTS
  return Math.pow(Math.min(Math.max(energy / peak, 0), 1), 1 / gamma)
}

/** TS mirror of the era reveal: 0 before electrification, 1 when fully lit. */
export function lightsReveal(energy: number, uLights: number): number {
  const { threshAt0, span, edge, curve } = NIGHT_LIGHTS
  if (uLights <= 0) return 0 // the shader skips the whole block
  const thresh = threshAt0 - span * Math.pow(uLights, curve)
  return smoothstep(thresh - edge, thresh + edge, lightsScale(energy))
}

/**
 * What makes a 2D coverage mask read as a lit, three-dimensional deck.
 *
 * The cloud layer is one greyscale mask composited over the surface, and it was
 * reported — correctly — as looking painted on. Nothing in the old composite
 * varied *across* a cloud: every covered pixel got the same white, so the film
 * carried outline and nothing else. Outline is the one cue a real cloud field
 * shares with a stencil.
 *
 * Three cues are added here, all from the mask itself and all inside the
 * existing pass:
 *
 *  - **A real surface normal**, baked (scripts/bake_clouds.py, sampled from
 *    public/textures/clouds-nrm.webp). This started as a runtime finite
 *    difference of the coverage mask along the sun direction, and that was
 *    always the weak version of the idea: the mask is a smooth composite whose
 *    gradient is tiny, and a difference taken along *one* axis carries no shape
 *    across it, so a cloud got a light side and a dark side but never a form.
 *    Offline there is room to treat the mask as a heightfield properly — a
 *    three-octave blur pyramid, so a mass domes toward its middle instead of
 *    sitting flat — and the answer arrives as one tap instead of two, in both
 *    axes at once.
 *  - **Ambient occlusion**, from the same bake, by horizon scan. This is the
 *    cue no amount of N·L can produce, because it is about what stands *around*
 *    a point rather than which way it faces: the creases where two cells have
 *    grown together, and the low ground between towers, stay dark even with the
 *    sun straight down them.
 *  - **A silver lining.** The lit face, rectified and confined to the
 *    terminator band, where a real deck is lit edge-on and its sunward rims go
 *    hot while its bodies go blue-grey. The old code had a flat warm add over
 *    the whole band, which tinted cloud and gap alike.
 *  - **Thickness.** Thin cover is a translucent, faintly blue veil; thick cover
 *    is an opaque white core. The opacity curve already said something like
 *    this; the colour did not, so haze and core were the same white at different
 *    alphas, which is what an alpha-blended stencil looks like.
 *
 * And the ground shadow is put on the same footing: it runs through a curve of
 * the same shape as the film's opacity, so the cloud that reads as thick is the
 * cloud that casts, and a veil that is barely visible no longer drops a solid
 * grey patch on the sea.
 */
export const CLOUD_DEPTH = {
  /**
   * How steep a full-deflection gradient in the baked map renders, as a tangent
   * slope. 1.0 is 45°.
   *
   * This is the one number this file and scripts/bake_clouds.py have to agree
   * on, and the script states it too (SHADER_RELIEF): the occlusion channel is
   * a *geometric* measurement of the very surface these normals describe, and
   * an occlusion baked for a gentler or steeper relief than the one being lit
   * is worse than none — it would darken creases the normals say are not there.
   * tests/shader.test.ts checks the two have not drifted apart.
   *
   * Measured on the bake, the gradient's median over visible cloud is 13% of
   * full deflection and its 90th percentile 46%, so a typical flank lands
   * around 7° and a steep one around 25°. That is far more relief than a real
   * cloud deck has at this horizontal scale — a 2 km tower over a 40 km cell is
   * under 3° — and it is the same exaggeration every planet render makes for
   * the same reason: at honest scale the shading is invisible.
   */
  normalRelief: 1.0,
  /**
   * Wrap lighting: how far the light bends past the geometric terminator of a
   * cloud, in units of cos.
   *
   * A water-droplet cloud forward-scatters heavily, so the side facing away
   * from the sun is not black — it is lit through, by the cloud in front of it.
   * A plain N·L gives it a hard, waxy terminator instead, which is the single
   * most common way a normal-mapped cloud layer reads as plastic.
   */
  wrap: 0.35,
  /**
   * The wrap-lit differential, mapped onto the [-1, 1] shading scale.
   *
   * What is composited is a *modulation* of the film's colour, not its
   * illumination: the rest of the pipeline already lights the deck as a flat
   * shell, so what this term carries is only how much more (or less) light a
   * tilted face receives than that flat shell would. At a 60° sun a typical
   * flank differs by about 0.09 of wrapped cos either way, so 4.5 puts it at
   * 0.4 of the scale and saturates only the steepest faces at the most
   * side-on light.
   */
  slope: 3.6,
  /** How far a sunward face brightens, and a far face darkens. */
  lit: 0.30,
  /**
   * Darkening is more than twice the brightening on purpose. Cloud tops are
   * already close to white, so there is very little headroom above and a great
   * deal below; symmetric gains give a film that clips on one side and barely
   * moves on the other, which reads as glare rather than as shape.
   */
  shade: 0.60,
  /**
   * How much of the baked sky visibility to apply.
   *
   * Not 1: the channel measures the sky lost to *cloud*, and a cloud that has
   * taken away half the sky has also filled it with something bright. So the
   * occlusion is real but partial, and at 0.85 the deepest creases in the map
   * (0.46 of open sky) reach about 0.54 of the colour they would otherwise
   * have, which is roughly the contrast a photograph of a cumulus field shows
   * between a crown and the gap beside it.
   */
  ao: 0.75,
  /** Silver lining: added on sunward slopes, inside the terminator band. */
  rim: [0.42, 0.26, 0.10],
  /** Half-width of that band, in cos(sun zenith). ~18° either side. */
  rimBand: 0.32,
  /**
   * Thin haze and thick core. The haze is deliberately blue rather than grey:
   * a thin cloud is mostly the sky seen through it plus forward-scattered
   * light, and rendering it as dim white is what made high cirrus look like
   * smeared paint.
   */
  thin: [0.66, 0.745, 0.90],
  thick: [0.93, 0.925, 0.912],
  /** Coverage window over which haze becomes core. */
  bodyLo: 0.12,
  bodyHi: 0.62,
  /**
   * The ground shadow's thickness curve, `occ * (knee + (1 - knee) * occ)`.
   *
   * Same shape as the film's opacity and for the same reason: a linear occlusion
   * meant a 20% veil — invisible in the film — dropped a 20% grey patch on the
   * sea, and those orphaned patches are a large part of why the shadows read as
   * a separate painted layer rather than as the clouds' own.
   *
   * Gentler than the film's own curve up to about 0.7 of coverage and steeper
   * above it, because a shadow integrates through the whole depth of a cloud
   * while the film only shows its top: a veil still darkens the sea a little,
   * and a solid deck never casts more than it hides.
   */
  shadowKnee: 0.3,
  /**
   * Mip bias on the single shadow tap: a penumbra for one instruction.
   *
   * Honest about what it is — a real deck 8 km up casts a penumbra of about
   * 70 m, far under a pixel. What this actually fixes is that the shadow is a
   * projection of a mask that is itself sampled sharply, so it arrived with
   * crisper edges than the cloud casting it, and a shadow sharper than its
   * object is the single most reliable way to make a composite look pasted.
   */
  shadowBlur: 1.0,
  /**
   * Shadow strength, and how it fades out at the terminator.
   *
   * The old gate was `cosGeo > 0.03` — a hard per-pixel cutoff, so the shadows
   * ended along a line where `daylight` was still 0.52, and (worse) it put a
   * texture fetch inside non-uniform control flow, where implicit derivatives
   * are undefined. Both go away by making it a factor instead of a branch.
   */
  strength: 0.62,
  fadeLo: 0.0,
  fadeHi: 0.12,
} as const

/**
 * TS mirror of the wrap-lit differential: the shader's `cloudSlope`.
 *
 * Both arguments are cosines of the sun angle — the first against the baked
 * cloud normal, the second against the plain surface normal, which is what the
 * rest of the pipeline has already lit the film by. The answer is how much more
 * light this face gets than that flat shell, on a [-1, 1] scale.
 *
 * The clamp at zero is what makes it non-linear, and it is the whole reason the
 * wrap is not merely a scale factor: past a cloud's own terminator both terms
 * bottom out together and the modelling switches itself off, instead of
 * inventing contrast on a face that receives no light at all.
 */
export function cloudFormSlope(nDotL: number, flatNDotL: number): number {
  const { wrap, slope } = CLOUD_DEPTH
  const w = (c: number) => Math.max(0, Math.min(1, (c + wrap) / (1 + wrap)))
  return Math.max(-1, Math.min(1, (w(nDotL) - w(flatNDotL)) * slope))
}

/**
 * TS mirror of the multiplier applied to the cloud's lit colour.
 *
 * `slope` is `cloudFormSlope` above, already clamped; `ao` is the baked sky
 * visibility, 1 for open sky. Returns the factor the film's colour is
 * multiplied by, so 1 is "no modelling at all".
 */
export function cloudShading(slope: number, ao: number, daylight: number): number {
  const { lit, shade, ao: aoK } = CLOUD_DEPTH
  const form = slope * daylight
  return (1 + form * (form >= 0 ? lit : shade)) * (1 - aoK + aoK * ao)
}

/**
 * TS mirror of the ground shadow's thickness curve: raw mask occlusion in,
 * the fraction of sunlight it removes out (before strength and daylight).
 */
export function cloudShadowDensity(occ: number): number {
  const k = CLOUD_DEPTH.shadowKnee
  return occ * (k + (1 - k) * occ)
}

/**
 * HOW A STREAMED TILE REACHES THE SCREEN — and the one place the drawn map
 * could not reuse the imagery pipeline as it stood.
 *
 * `ratio` is what this shader has always done, and it is right for a
 * photograph: divide the sharp tap by the same tile reduced to the base map's
 * density and multiply the base map by the result, so Sentinel-2 contributes
 * structure and NASA keeps the colour. It rests on an assumption nobody had to
 * state — that the sharp tile and the base map are THE SAME PICTURE at two
 * resolutions, so their low frequencies cancel.
 *
 * A drawing breaks that assumption, and the design's expectation that "the
 * blurred tap of a drawn tile against a drawn base map is self-consistent by
 * construction" turns out to be false. The reason is the pen. Ink is a fixed
 * 1.15 tile pixels and the shoreline wash a fixed 11, at EVERY level, because
 * that is what makes a drawn map look drawn — so the level-3 base texture
 * carries a wash about a degree of ground wide and a level-9 tile carries one
 * a sixtieth of that. Reduced to the base map's density the tile's wash is a
 * fifth of a texel, i.e. gone, while the base map's is eight texels of solid
 * tone. The two do not cancel; they emboss. Photographed, at the Aegean: crisp
 * coastline ink standing on a soft grey doubling of itself.
 *
 * So map mode PAINTS instead. Where a tile is resident it simply is the ground,
 * blending parent to target and to the base map underneath by the same per-slot
 * dissolve the ratio path uses — which is not a weaker answer but a stronger
 * one, because a drawn tile already carries the right colour by construction
 * and needs nothing from the map beneath it. The base texture then does exactly
 * the job it should: it is what you see until a finer drawing of that ground
 * arrives.
 */
export const DETAIL_MODE = { ratio: 0, paint: 1 } as const

/** sRGB hex to linear light — the space this shader's albedo lives in. */
const linearOf = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]

/**
 * The two ends of the paper grade, taken from the drawn map's own palette so
 * that a paleo frame and a drawn tile are printed with the same ink on the same
 * sheet. Derived rather than restated: a second copy of these colours would
 * drift from lib/drawnTile.ts the first time either was tuned.
 */
export const PAPER_TONES = {
  ink: linearOf(PAPER.ink),
  paper: linearOf(PAPER.land),
  /** Open sea and the deepest shoreline-wash step — the morph's flat palette. */
  sea: linearOf(PAPER.ocean),
  wash: linearOf(PAPER.wash[2]),
} as const

/**
 * THE DEEP-TIME MORPH, map mode's answer to "the blending is very apparent".
 *
 * A crossfade of two drawn plates is a double exposure of two inked
 * coastlines: mid-blend, every coast is two grey ghosts of itself and the sea
 * shows through the land. So when both frames of a drawn-timeline blend carry
 * a coastline SDF (`ps*.webp`, rendered by `render_sdf` in
 * scripts/gen_paleo_v4.py from the same land masks the pd twins are inked
 * from), the shader mixes the two DISTANCES instead of the two pictures and
 * thresholds the result: one crisp coastline that genuinely moves — bays
 * close, epicontinental seas drain, plates advance — with the pen drawn
 * in-shader at the blended zero crossing.
 *
 * The colours still come from the two pd twins, weighted by each frame's own
 * INTERIOR distance on the morph's side of the coast. That weighting is the
 * half of the idea that keeps the drawing whole: highlands, ice, shelf
 * bathymetry and the graticule all ride along from the textures (they blend
 * softly, which is right for washes), while a frame's own inked coast and
 * shoreline wash — which live exactly where its distance is zero, i.e. where
 * its weight is zero — can never print into the middle of the other frame's
 * land or sea. Where neither frame has interior signal (the hairline strip
 * along the moving coast itself) the flat palette takes over, which is exactly
 * what a coast strip is made of: parchment, wash, sea. At f→0 and f→1 the
 * whole construction converges to the settled pd frame, so there is no
 * handoff to hide.
 *
 * All lengths are in pixels of the 2048-wide equirect grid the masks were
 * rendered on, matching the pd pen's own units.
 */
export const SDF_MORPH = {
  /** Half-range of the encoded distance. See SDF_CLAMP in the generator. */
  clampPx: 128,
  /**
   * The pen at the blended zero crossing: same alpha as render_drawn's, but
   * measured in SCREEN pixels via the blended field's own gradient (fwidth) —
   * a mix of two SDFs is not an SDF, and where the two coasts moved far apart
   * the field flattens toward zero across the whole corridor, so a
   * texture-width test inked entire islets solid (measured on 541→515 Ma).
   */
  inkAlpha: 0.85,
  inkScreenPx: 1.3,
  /** The shoreline wash hugging the moving coast: screen-px reach, and depth. */
  washScreenPx: 6,
  washMax: 0.7,
  /** Interior weight (px of the 2048 grid) under which colours fall back flat. */
  trustPx: 5,
} as const

const G = ENHANCED_GRADE
const N = NIGHT_LIGHTS
const C = CLOUD_DEPTH
const f = (n: number) => n.toFixed(4)
const v3 = (c: readonly number[]) => `vec3(${c.map(f).join(', ')})`

const fragment = /* glsl */ `
precision highp float;

in vec2 vUv;
in vec3 vNormalW;
in vec3 vWorldPos;
out vec4 fragColor;

uniform sampler2D uEraA;      // surface texture, era A
uniform sampler2D uEraB;      // surface texture, era B
uniform float uEraMix;        // 0 = A, 1 = B
uniform sampler2D uSdfA;      // coastline signed distance, era A (drawn timeline)
uniform sampler2D uSdfB;      // …and era B
uniform float uMorph;         // 1 = morph the coastline instead of crossfading
uniform sampler2D uNight;     // city lights
uniform float uNightMix;      // 0 until the night map has landed, then ramps in
uniform sampler2D uRelief;    // topography, used as a height field
uniform sampler2D uClouds;    // cloud coverage mask
uniform sampler2D uCloudNrm;  // baked cloud relief: rg = dH/duv, b = sky visibility
uniform float uCloudNrmMix;   // 0 until that map lands, and until then the deck is flat
uniform sampler2D uDetail;      // tile atlas: 8x8 slots of 512, streamed imagery
uniform sampler2D uDetailLow;   // the same tiles at the base map's own density
uniform sampler2D uDetailIndex; // grid cell -> slot; rows 0-7 target, 8-15 parent
uniform vec4 uDetailGrid;       // origin col, origin row, width, height at uDetailZ
uniform vec4 uDetailGridP;      // …and the same for the parent level
uniform float uDetailZ;         // pyramid level of the target grid
uniform float uDetailMix;
uniform vec3 uSunDir;
uniform float uLights;        // electrification, 0..1
uniform float uCloudRot;      // cloud drift, in UV units
uniform float uCloudAlpha;    // 0 hides clouds
uniform float uCloudShadow;
uniform float uCloudH;      // cloud deck height, in globe radii
uniform float uCloudSharp;    // unsharp amount for the cloud mask, 0 = off
uniform vec2 uCloudTexel;     // 1 / cloud *source* size, the sharpen radius
uniform float uRelief_;       // relief strength
uniform vec2 uTexel;          // 1 / relief texture size
uniform float uFlatLight;     // 1 = ignore the terminator (close-up imagery is already lit)
uniform float uBoost;         // 0 = realistic lighting, 1 = enhanced (brighter, lifted shadows)
uniform vec3 uPalette;        // experimental grade: saturation, grayscale, contrast
uniform float uDetailPaint;   // 0 = the sharp/blurred ratio, 1 = the tile IS the ground
uniform float uRim;           // 0 removes the atmospheric limb and terminator band
uniform float uPaperMix;      // 0 = the map as it is, 1 = printed on the drawn map's paper
uniform float uEncode;        // 1 = write sRGB-encoded, for a surface that is already a picture

const float PI = 3.14159265;

/**
 * The cloud mask, high-frequency band restored as the camera closes in.
 *
 * The mask is upscaled 2x on load (lib/cloudUpscale.ts), which removes the
 * texel facets but leaves the result soft — Lanczos reconstructs detail, it
 * does not add contrast to it. Four extra taps give a cheap blur of the same
 * texture; c + k * (c - blur) is an unsharp mask, and puts the edge acutance
 * back without a second map. Isotropic on purpose: two taps along one axis
 * sharpens cloud edges facing that axis and leaves the rest soft, which reads
 * as smearing.
 *
 * The radius is the *source* texel, not the upscaled one, so the band being
 * lifted is the same whether or not the upscale has landed yet — the swap is
 * then invisible except for being sharper. The offsets may leave 0..1 in u;
 * the texture repeats, so the antimeridian needs no special case, and v clamps
 * at the poles like every other sample here.
 */
float cloudMask(vec2 uv) {
  float c = texture(uClouds, uv).r;
  if (uCloudSharp <= 0.0) return c;
  vec2 d = uCloudTexel * 1.5;
  float blur = 0.25 * (
    texture(uClouds, uv + vec2(d.x, 0.0)).r + texture(uClouds, uv - vec2(d.x, 0.0)).r +
    texture(uClouds, uv + vec2(0.0, d.y)).r + texture(uClouds, uv - vec2(0.0, d.y)).r);
  return clamp(c + uCloudSharp * (c - blur), 0.0, 1.0);
}

/**
 * One cell of the tile index, or all-zero where the grid does not reach.
 *
 * texelFetch rather than texture(): an integer fetch has no filtering to round
 * the wrong way between two slots and no derivative to be undefined, which is
 * what makes it safe to do this per fragment. The range test is a multiply
 * rather than a branch for the same reason the rest of this shader avoids
 * per-pixel branches — and because an out-of-range texelFetch is undefined,
 * the coordinate is clamped as well as weighted.
 */
vec4 atlasCell(vec2 g, vec2 size, float row) {
  vec2 ok = step(vec2(0.0), g) * step(g, size - 1.0);
  vec2 c = clamp(g, vec2(0.0), vec2(${INDEX_W - 1}.0, ${INDEX_ROWS - 1}.0));
  return texelFetch(uDetailIndex, ivec2(c.x, c.y + row), 0) * (ok.x * ok.y);
}

/**
 * Sample a slot.
 *
 * The half-texel gutter is the whole of the anti-bleed rule. With no mip chain
 * on the atlas the only way a slot can reach its neighbour is bilinear picking
 * up the texel across the boundary, and clamping the in-tile coordinate to
 * [0.5, size-0.5] texels is exactly what CLAMP_TO_EDGE does for a standalone
 * tile: the geometry inside the tile is untouched and only the outermost half
 * texel is held, so two tiles still meet without a seam.
 */
vec3 atlasTap(sampler2D atlas, float code, vec2 inTile, float gutter) {
  float slot = max(floor(code * 255.0 + 0.5) - 1.0, 0.0);
  vec2 at = vec2(mod(slot, ${ATLAS_COLS}.0), floor(slot / ${ATLAS_COLS}.0));
  return texture(atlas, (at + clamp(inTile, gutter, 1.0 - gutter)) * ${f(1 / ATLAS_COLS)}).rgb;
}

/**
 * Equirectangular UV of a direction — but only ever needed for directions that
 * are *not* the surface normal.
 *
 * For the normal itself the answer is already interpolated across the triangle:
 * three's SphereGeometry lays u along the same azimuth this function measures,
 * and three-globe rotates the globe mesh by -90° in y, which lines the two up
 * to a constant half-turn offset — dirToUv(n) == vec2(fract(vUv.x + 0.5), vUv.y)
 * exactly, away from the poles. Both call sites subtract it from another
 * dirToUv, so the offset cancels and the seam wrap that follows is unchanged.
 * That is two atan/asin pairs per fragment saved, every frame.
 */
vec2 dirToUv(vec3 d) {
  vec3 l = vec3(d.z, d.y, -d.x);
  return vec2(atan(l.z, -l.x) / (2.0 * PI) + 0.5, 0.5 + asin(clamp(l.y, -1.0, 1.0)) / PI);
}

void main() {
  vec3 n = normalize(vNormalW);
  // what dirToUv(n) would return; see above
  vec2 nUv = vec2(fract(vUv.x + 0.5), vUv.y);

  // --- relief: perturb the normal from the height field so terrain catches light ---
  // Four dependent taps and a normalize, skipped whole whenever the height field
  // contributes nothing — which is every deep-time frame (those carry their own
  // baked hillshade), the relief setting off, and the first 450 ms of every load
  // while the map fades in. uRelief_ is a uniform, so the branch is uniform
  // across the draw and the derivatives inside it stay defined.
  vec3 nRelief = n;
  if (uRelief_ > 0.0) {
    float hL = texture(uRelief, vUv - vec2(uTexel.x, 0.0)).r;
    float hR = texture(uRelief, vUv + vec2(uTexel.x, 0.0)).r;
    float hD = texture(uRelief, vUv - vec2(0.0, uTexel.y)).r;
    float hU = texture(uRelief, vUv + vec2(0.0, uTexel.y)).r;
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), n));
    vec3 north = cross(n, east);
    nRelief = normalize(n - (east * (hR - hL) + north * (hU - hD)) * uRelief_);
  }

  float cosSun = dot(nRelief, uSunDir);
  float cosGeo = dot(n, uSunDir);           // geometric terminator, no relief
  float daylight = mix(smoothstep(-0.18, 0.22, cosGeo), 1.0, uFlatLight);
  // "Enhanced" lifts the lambert floor and flattens its slope: the day side
  // stays readable everywhere instead of falling off toward the limb.
  float slope = mix(0.65, 0.45, uBoost);
  float floor_ = mix(0.45, 0.72, uBoost);
  float lambert = mix(clamp(cosSun * slope + floor_, 0.0, 1.3), 1.0, uFlatLight);

  // --- surface: two era textures, crossfaded — or, on the drawn timeline, MORPHED ---
  // uEraMix is 0 except during a paleo crossfade — textureBlend returns f = 0
  // for every time that is not between two frames, which is the whole modern
  // era and most of deep time. Sampling the second map unconditionally spent a
  // full-resolution fetch per fragment on a mix of zero, every frame, forever.
  // Branching is safe here for the same reason it is safe for uDetailMix: the
  // condition is a uniform, so it is the same for every fragment in the draw and
  // the derivatives inside stay defined.
  //
  // uMorph is only ever 1 while uEraMix is strictly between 0 and 1 AND both
  // SDFs are decoded (see applyEra), so the branches are uniform across the
  // draw and mutually exclusive, and every fetch inside them is straight-line.
  // See SDF_MORPH in the TS above for what the morph is and why; distances
  // here are in clamp units (1.0 = ${SDF_MORPH.clampPx} px of the 2048 grid).
  vec3 albedo = texture(uEraA, vUv).rgb;
  if (uMorph > 0.0) {
    vec3 eraB = texture(uEraB, vUv).rgb;
    // square-root encoded (see render_sdf): decode to linear distance before
    // mixing, or the blend's timing would warp with depth
    float msA = texture(uSdfA, vUv).r * 2.0 - 1.0;
    float msB = texture(uSdfB, vUv).r * 2.0 - 1.0;
    float mdA = sign(msA) * msA * msA;
    float mdB = sign(msB) * msB * msB;
    float md = mix(mdA, mdB, uEraMix);
    // A MIX OF TWO SDFs IS NOT AN SDF. Where the two frames' coasts moved far
    // and their distance ramps oppose, the blended field flattens toward zero
    // across the whole corridor: its zero "line" degenerates into an area, and
    // an 8-bit plateau dithers across it. Measured on the 541→515 Ma pair, a
    // texture-width pen test (|md| < pen) inked entire islets as brown blobs
    // with speckled edges. So everything below is scaled by the field's HEALTH:
    // its screen-space gradient against the gradient a true SDF would have here
    // (1/clamp per SDF texel). ~1 on any honest coast; ~0 on a plateau, where
    // 8-bit dither tops out at half a true gradient — the 0.55 floor is above
    // that on purpose.
    float mStep = max(fwidth(vUv.x) * ${f(2048 / SDF_MORPH.clampPx)},
      fwidth(vUv.y) * ${f(1024 / SDF_MORPH.clampPx)});
    float mHealth = fwidth(md) / max(mStep, 1e-6);
    float mConf = smoothstep(0.30, 0.55, mHealth);
    // The land/sea threshold: crisp where the field is healthy, dissolving
    // into a soft gradient where it is degenerate — a fast-moving coast melts
    // and re-forms rather than flickering a quantisation staircase. The
    // softening starts earlier than the pen gives up (0.85 against 0.55),
    // because a half-dithered edge drawn crisp is a staircase.
    float mAa = mix(0.10, max(fwidth(md) * 0.75, ${f(0.5 / SDF_MORPH.clampPx)}),
      smoothstep(0.30, 0.85, mHealth));
    float mLand = smoothstep(-mAa, mAa, md);
    // Each frame's picture is trusted as far as ITS OWN coast is from here, on
    // the morph's side of the blended coast — a frame's inked coastline and
    // shoreline wash live exactly where its distance is zero, so they carry
    // zero weight and cannot double-expose; its highlands, ice, shelf tones
    // and graticule are interior and ride along. The side selection is mLand
    // rather than sign(md), so a degenerate strip blends the two shores
    // instead of strobing between them.
    float mWA = (1.0 - uEraMix) * mix(max(-mdA, 0.0), max(mdA, 0.0), mLand);
    float mWB = uEraMix * mix(max(-mdB, 0.0), max(mdB, 0.0), mLand);
    vec3 sorted = (albedo * mWA + eraB * mWB) / max(mWA + mWB, 1e-6);
    // The hairline strip along the moving coast, where neither frame has
    // interior colour: flat parchment against flat sea, which is exactly what
    // a coast strip is made of.
    vec3 paperFlat = mix(${v3(PAPER_TONES.sea)}, ${v3(PAPER_TONES.paper)}, mLand);
    albedo = mix(paperFlat, sorted,
      smoothstep(0.0, ${f(SDF_MORPH.trustPx / SDF_MORPH.clampPx)}, mWA + mWB));
    // The pen and the wash measure their distance in SCREEN pixels, by the
    // field's own gradient, and carry its confidence: a healthy coast keeps
    // the ink, a degenerate corridor gets the soft wash edge alone.
    float mPx = abs(md) / max(fwidth(md), 1e-4);
    // the engraver's wash, hugging the sea side of the moving coast — the pd
    // twins only carry it at their own coasts, which the weighting suppressed
    float mWash = ${f(SDF_MORPH.washMax)} * mConf *
      (1.0 - smoothstep(0.0, ${f(SDF_MORPH.washScreenPx)}, mPx)) * (1.0 - mLand);
    albedo = mix(albedo, ${v3(PAPER_TONES.wash)}, mWash);
    // and the pen, at the blended zero crossing
    float mInk = ${f(SDF_MORPH.inkAlpha)} * mConf * (1.0 - smoothstep(
      ${f(SDF_MORPH.inkScreenPx * 0.45)}, ${f(SDF_MORPH.inkScreenPx * 1.55)}, mPx));
    albedo = mix(albedo, ${v3(PAPER_TONES.ink)}, mInk);
  } else if (uEraMix > 0.0) {
    albedo = mix(albedo, texture(uEraB, vUv).rgb, uEraMix);
  }

  // --- streamed imagery, assembled here from the tile atlas ---
  // uDetailMix is uniform across the draw, so branching on it is safe. Branching
  // on the per-pixel tests is not: sampling a texture inside non-uniform control
  // flow leaves the derivatives undefined, which several mobile GPUs render as
  // flicker or dropouts. So every tap below is unconditional and presence is a
  // weight rather than a branch.
  //
  // This block used to read one composite texture through one rectangle. The
  // rectangle was a canvas the CPU had assembled and re-uploaded whole on every
  // arrival; what replaces it is an indirection — surface point to tile, tile to
  // slot, slot to a rectangle of the atlas — so nothing on the CPU has to
  // assemble anything and a tile arriving costs one 512 upload.
  //
  // Two levels are resolved, and the fall-through between them is the point:
  // where the target level has not arrived, the parent's slot shows the same
  // ground one level coarser. Coarse but present beats sharp but absent, so a
  // pan shows soft imagery rather than a hole, and each tile dissolves in over
  // its own fade rather than popping.
  //
  // What comes out is a single number: how much brighter or darker than the base
  // map the imagery says this piece of ground is. It is applied at the very end,
  // after the grade — see below.
  float detailGain = 1.0;
  // …and, in paint mode, the tile itself and how much of this pixel it covers.
  float paintCover = 0.0;
  vec3 paintColor = vec3(0.0);
  if (uDetailMix > 0.0) {
    // Surface point to tile. Longitude gives the column; the row runs *down*
    // from the north pole, which is the pyramid's convention (lib/tilePyramid)
    // and the row order the tiles were uploaded in.
    float cols = exp2(uDetailZ);
    vec2 tile = vec2(vUv.x * cols, (1.0 - vUv.y) * cols * 0.5);
    vec2 up = tile * 0.5;                       // …and in the parent's grid
    // THE COLUMN IS TAKEN THE SHORT WAY ROUND. A view straddling ±180 has a
    // grid whose origin is near the last column and which runs on past zero
    // (gridOf, lib/tileAtlas.ts), so the offset has to wrap with it — without
    // the mod, every tile east of the seam lands at a negative cell, the range
    // test rejects it, and the far half of the frame shows base map with a hard
    // edge down the meridian. GLSL's mod is floored, so it is already positive.
    vec2 gT = floor(tile) - uDetailGrid.xy;
    vec2 gP = floor(up) - uDetailGridP.xy;
    gT.x = mod(gT.x, cols);
    gP.x = mod(gP.x, max(cols * 0.5, 1.0));
    vec4 cell = atlasCell(gT, uDetailGrid.zw, 0.0);
    vec4 cellP = atlasCell(gP, uDetailGridP.zw, ${INDEX_ROWS}.0);
    // R is the slot, offset by one so zero means absent; G is the fade
    float onT = step(0.5 / 255.0, cell.r) * cell.g;
    float onP = step(0.5 / 255.0, cellP.r) * cellP.g;

    vec2 fT = fract(tile);
    vec2 fP = fract(up);
    vec3 hiT = atlasTap(uDetail, cell.r, fT, ${f(0.5 / TILE_PX)});
    vec3 hiP = atlasTap(uDetail, cellP.r, fP, ${f(0.5 / TILE_PX)});
    // THE RATIO IS MULTIPLIED OUT IN PAINT MODE RATHER THAN BRANCHED AROUND,
    // and that is a measurement rather than an oversight.
    //
    // uDetailPaint is 1 in map mode and every line below is then dead: the tap
    // of the reduced atlas (a texture map mode does not even fill — see
    // SourcePlan.paint), two divisions and two clamps, per fragment of a
    // full-screen sphere. Round 61 gated it exactly as the relief, the clouds
    // and the city lights above are gated, and the frame got FOUR TIMES SLOWER:
    // map mode at world view went 750 ms to 3 500 ms on the software
    // rasteriser, against 433 ms for the same build with this one branch taken
    // back out (tests/e2e/surfaceCost.e2e.mjs, three runs each). The other two
    // gate of that round was pure arithmetic; this one puts a TEXTURE FETCH
    // inside nested dynamic control flow, which is the one thing a shader
    // compiler cannot hoist the sampler setup out of.
    //
    // A real GPU would very likely take a uniform branch for free. This is the
    // renderer that can be measured here, and one fetch of five is not worth
    // shipping a change whose only evidence says it costs eight times what it
    // saves. If a GPU-capable harness ever exists, re-measure and revisit.
    //
    // One blurred tap, not two. The reduced copies of a tile and of its parent
    // describe the same ground at the same (base-map) density, so whichever of
    // the two is present answers for both — and one tap here is the difference
    // between three fetches and four.
    vec3 lo = atlasTap(uDetailLow, mix(cellP.r, cell.r, step(0.5 / 255.0, cell.r)),
      mix(fP, fT, step(0.5 / 255.0, cell.r)), ${f(0.5 / LOW_PX)});

    // Colour matching, unconditional and on luminance alone.
    //
    // The imagery contributes *structure*: how much brighter or darker the
    // ground is than the base map knows. The base map contributes the colour.
    // Taking the ratio per channel — the earlier form — transferred the sharp
    // sensor's chroma as well, so Sentinel-2's greener, higher-contrast palette
    // leaked through as hue shifts of up to 20/255 along coastlines and snow
    // lines. One scalar cannot move a hue: it scales all three channels
    // together, so the base map's colour survives by construction.
    //
    // The divisor is the same tile reduced to the base map's own density, held
    // in a second atlas (see lib/tileAtlas.ts). It used to be a mip of the
    // composite; the atlas has no mip chain, because a chain over 8x8 slots
    // averages unrelated ground into every texel above level 0.
    //
    // The limits are what "stability beats maximal sharpness" buys: a gain of
    // 2.5x is a real reading over a snow line or a coast, and it is also enough
    // to drive the graded highlights past white and leave the imagery looking
    // blown rather than sharp. Under a stop either way, ordinary ground (0.8 to
    // 1.3) is untouched and only the extremes are held back.
    const vec3 luma = vec3(0.2126, 0.7152, 0.0722);
    float base = dot(lo, luma) + 0.004;
    float k = clamp((dot(hiT, luma) + 0.004) / base, 0.55, 1.8);
    float kP = clamp((dot(hiP, luma) + 0.004) / base, 0.55, 1.8);
    // parent over base map, target over parent — so a tile arriving dissolves
    // into the coarse level it is replacing, never through the bare base map
    float stack = mix(mix(1.0, kP, onP), k, onT);
    detailGain = mix(1.0, mix(stack, 1.0, uDetailPaint), uDetailMix);
    paintCover = mix(onP, 1.0, onT) * uDetailMix * uDetailPaint;
    paintColor = mix(hiP, hiT, onT);
  }

  // Enhanced grades the albedo itself: a luminance remap (see ENHANCED_GRADE)
  // plus a chroma lift. Graded before lighting so coastlines, vegetation and
  // desert separate clearly without blowing out the lit side.
  //
  // The grade runs on the *base map's* colour, before the patch's structure is
  // applied — the reverse of the order this used to be in, and the reason a
  // patch used to darken the ground it covered. The curve is strongly concave
  // through the land band, so pushing a zero-mean modulation through it comes
  // out with a negative mean: measured, 7/255 of darkening inside the patch and
  // a visible brightness step at its edge, growing with however much detail the
  // patch had to add. Multiplying afterwards instead leaves the mean exactly
  // where the base map put it, and the patch's own contrast reaches the screen
  // as the sensor recorded it rather than as the curve reshaped it.
  //
  // NOT gated on uBoost, and that is round 61's answer rather than its
  // oversight. uBoost is 0 in map mode and in the realistic visual style, so
  // this whole block — three pow, an exp, two divisions, a smoothstep — is
  // computed and then discarded by the mix at its end, and gating it looks like
  // free money. Measured on the software rasteriser with the camera pinned and
  // frames that uploaded thrown out (tests/e2e/surfaceCost.e2e.mjs, three runs
  // of 24 frames each): map mode at world view 200 ms against 217, at
  // continental 417 against 400 — the same two vsync ticks either side of the
  // noise, in both directions. The arithmetic is not what a frame of this
  // surface is made of; the taps are. A branch with no number behind it is not
  // a fix, so it was taken back out.
  float lumA = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  float p = pow(max(lumA, 0.0), ${f(1 / G.gamma)});   // into perceptual space
  float below = (p / ${f(G.lo)}) * ${f(G.outLo)};
  float band = ${f(G.outLo)} + ${f(G.outHi - G.outLo)} *
    pow(clamp((p - ${f(G.lo)}) / ${f(G.hi - G.lo)}, 0.0, 1.0), ${f(G.bandGamma)});
  float above = ${f(G.outHi)} + (p - ${f(G.hi)}) * ${f((1 - G.outHi) / (1 - G.hi))};
  // step(), not if(): the branch would be non-uniform, and this is cheaper
  float pG = mix(mix(below, band, step(${f(G.lo)}, p)), above, step(${f(G.hi)}, p));
  float lumG = pow(max(pG, 0.0), ${f(G.gamma)});      // and back to linear
  // rescale the colour to the new luminance, then push chroma around it — the
  // hue survives, only the contrast and the vividness change
  vec3 graded = albedo * (lumG / max(lumA, 0.0008));
  graded = clamp(mix(vec3(lumG), graded, ${f(G.saturation)}), 0.0, 1.6);
  // Water takes a hue-preserving gain in place of the land curve: the curve's
  // bottom segment scales deep ocean *down*, and simply withholding it left the
  // open sea black. Multiplying every channel by the same number lifts the
  // water without moving its hue, so it reads as lighter blue, not cyan.
  // blueness as a ratio, not a difference: deep ocean's channels are only
  // thousandths apart in linear light, so an absolute test scored the abyss at
  // 0.16 and handed the blackest water to the land curve, which darkens it
  float blueness = (albedo.b - max(albedo.r, albedo.g)) / max(lumA, 0.0008);
  float water = smoothstep(${f(G.waterLo)}, ${f(G.waterHi)}, blueness);
  // the lift levels off toward a ceiling, so bright shallows cannot overtake
  // the land they meet; scaling the colour by a scalar keeps the hue exactly
  float seaLum = ${f(G.waterCeiling)} *
    (1.0 - exp(-${f(G.waterGain)} * lumA / ${f(G.waterCeiling)}));
  vec3 sea = albedo * (seaLum / max(lumA, 0.0008));
  vec3 target = mix(graded, sea, ${f(G.waterHold)} * water);
  albedo = mix(albedo, target, uBoost);

  // --- palette: saturation, grayscale, contrast, after the grade above ---
  // Outside the uBoost mix on purpose, so the controls behave identically in
  // both visual styles: the style decides what the map looks like, this decides
  // what is then done to it. Neutral values (1, 0, 1) are an exact identity,
  // which is why this can sit in the hot path unconditionally — and round 61
  // measured the alternative rather than assuming it: skipping the two
  // pow(vec3) when the triple is neutral (which is exactly what map mode asks
  // for) moved the frame by less than one vsync tick. See the note on the
  // enhanced grade above.
  {
    float pl = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    vec3 sat = mix(vec3(pl), albedo, uPalette.x);
    vec3 grey = mix(sat, vec3(pl), uPalette.y);
    // contrast pivots on mid grey in perceptual space; in linear light the same
    // pivot sits far above every land tone on this map and crushes the lot
    vec3 perceptual = pow(max(grey, 0.0), vec3(${f(1 / PALETTE_GAMMA)}));
    vec3 pushed = (perceptual - 0.5) * uPalette.z + 0.5;
    albedo = pow(max(pushed, 0.0), vec3(${f(PALETTE_GAMMA)}));
  }

  // --- the paper grade: a deep-time frame, printed rather than photographed ---
  // A duotone between the drawn map's own ink and its own paper, by luminance.
  // Map mode's answer to deep time is not to redraw the Cretaceous from vectors
  // nobody has — it is to keep the existing reconstruction and put it on the
  // same sheet as everything else, so a scrub from 1940 to 200 Ma changes the
  // geography without changing the medium. The exponent lifts the mid tones: a
  // paleo frame is mostly dark ocean, and a linear ramp printed it near-black.
  if (uPaperMix > 0.0) {
    float pl = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    vec3 sheet = mix(${v3(PAPER_TONES.ink)}, ${v3(PAPER_TONES.paper)},
      pow(clamp(pl, 0.0, 1.0), 0.45));
    albedo = mix(albedo, sheet, uPaperMix);
  }

  // The streamed patch, at last: a plain gain on the finished colour. Nothing
  // downstream of this reshapes it, so what the patch says about the ground is
  // what reaches the screen — and because it is a single multiplier, it cannot
  // move the hue the grade and the palette just settled on.
  //
  // Darkening is unconditional; brightening is not. The grade compresses
  // highlights on purpose, so that snow, ice and desert keep their shape
  // instead of clipping to flat white, and a gain applied on top of that pushes
  // them over anyway — which is what a patch over the Alps looked like: sharper
  // and glaring. Headroom falls to nothing as the graded colour approaches
  // white, so the patch keeps every bit of its structure where there is room
  // for it and stops competing with the ceiling where there is not.
  float head = clamp((1.0 - dot(albedo, vec3(0.2126, 0.7152, 0.0722))) / 0.45, 0.0, 1.0);
  float gain = min(detailGain, 1.0) * mix(1.0, max(detailGain, 1.0), head);
  albedo = clamp(albedo * gain, 0.0, 1.6);
  // PAINT. Zero for imagery, so the line above is still the whole story there;
  // in map mode it is the tile standing in for the ground it covers, at the
  // coverage the per-slot dissolve says. See DETAIL_MODE.
  albedo = mix(albedo, paintColor, paintCover);

  vec3 surface = albedo * lambert;

  vec3 viewDir = normalize(cameraPosition - vWorldPos);

  // --- parallax: the deck sits above the ground, so it slides against it as
  // the globe turns. Following the view ray up to cloud height is what makes
  // the layer read as floating rather than painted on. ---
  // Skipped entirely when no cloud film is drawn — a uniform branch, and clouds
  // are off for the whole of deep time and for every view closer than ~10°.
  vec2 cloudUv = vec2(0.0);
  // How much more sunlight this piece of cloud top gets than the flat shell the
  // rest of the pipeline lights: +1 fully sunward, -1 fully away. Zero whenever
  // no film is drawn.
  float cloudSlope = 0.0;
  // Baked sky visibility; 1 is open sky, and 1 is also what "no film" means.
  float cloudAO = 1.0;
  if (uCloudAlpha > 0.0) {
    vec3 liftedView = normalize(n + viewDir * (uCloudH / max(dot(n, viewDir), 0.25)));
    vec2 pduv = dirToUv(liftedView) - nUv;
    pduv.x -= (abs(pduv.x) > 0.5) ? sign(pduv.x) : 0.0;
    cloudUv = vec2(fract(vUv.x + pduv.x + uCloudRot), clamp(vUv.y + pduv.y, 0.0, 1.0));

    // --- the baked relief: one tap, where two finite differences used to be ---
    //
    // The tangent frame is the relief block's, and it is the frame the UV
    // mapping is defined in: +u runs along cross(Y, n) and +v along
    // cross(n, east) — that identity is what tests/shader.test.ts pins down.
    //
    // The map stores dH/du and dH/dv, in texture space, and the conversion to a
    // slope along the *ground* happens here because equirectangular UV is not
    // isotropic: a texel of u is cos(latitude) times the arc of a texel of v.
    // Baked the other way the map would carry a latitude in every texel and be
    // wrong for every row but one. Same correction the sun step this replaced
    // had to make, for the same reason.
    //
    // cosLat is floored at 0.05 (~87°) rather than at an epsilon: past that the
    // parameterisation is degenerate — a v texel spans every longitude — and a
    // 1/cosLat gradient would describe a cloud wrapped around the pole.
    float cosLat = max(sqrt(max(1.0 - n.y * n.y, 0.0)), 0.05);
    vec3 east = vec3(n.z, 0.0, -n.x) / cosLat;
    vec3 north = cross(n, east);
    vec3 bake = texture(uCloudNrm, cloudUv).rgb;
    // uCloudNrmMix is a correctness guard as much as a transition: an unbound
    // sampler reads as transparent black in three, which decodes to a hard -1
    // tilt in both axes, so the deck has to be provably flat until the map is
    // really there.
    vec2 grad = (bake.xy * 2.0 - 1.0) * (uCloudNrmMix * ${f(C.normalRelief)});
    cloudAO = mix(1.0, bake.z, uCloudNrmMix);
    // the same construction as the relief block above: the surface tilts away
    // from the up-slope direction, and the height axis is the sphere normal
    vec3 cloudN = normalize(n - east * (grad.x / cosLat) - north * grad.y);

    // Wrap-lit, and *differential* — see cloudFormSlope. The clamp at zero is
    // what makes the difference non-linear: past a cloud's own terminator both
    // terms bottom out together and the modelling switches itself off.
    float faceLit = clamp((dot(cloudN, uSunDir) + ${f(C.wrap)}) * ${f(1 / (1 + C.wrap))}, 0.0, 1.0);
    float flatLit = clamp((cosGeo + ${f(C.wrap)}) * ${f(1 / (1 + C.wrap))}, 0.0, 1.0);
    cloudSlope = clamp((faceLit - flatLit) * ${f(C.slope)}, -1.0, 1.0);
  }

  // --- cloud shadows: follow the sun ray up to the same height and sample there ---
  // Gated on the uniform alone. The old form also tested cosGeo > 0.03, which
  // put a texture fetch inside non-uniform control flow — undefined derivatives,
  // which is a real flicker source on tile GPUs — and ended the shadows along a
  // hard line where daylight was still above half. The grazing-sun fade below
  // does the same job as a factor.
  if (uCloudShadow > 0.0) {
    vec3 lifted = normalize(n + uSunDir * (uCloudH / max(cosGeo, 0.18)));
    vec2 duv = dirToUv(lifted) - nUv;
    duv.x -= (abs(duv.x) > 0.5) ? sign(duv.x) : 0.0;   // cross the seam cleanly
    // a mip bias, so the shadow is never sharper than the cloud casting it
    float occ = texture(uClouds,
      vec2(fract(vUv.x + duv.x + uCloudRot), clamp(vUv.y + duv.y, 0.0, 1.0)),
      ${f(C.shadowBlur)}).r;
    // the same thickness curve the film's opacity uses, so what reads as thick
    // is what casts; and a smooth grazing-sun fade in place of the old cutoff
    float dense = occ * (${f(C.shadowKnee)} + ${f(1 - C.shadowKnee)} * occ);
    surface *= 1.0 - dense * uCloudShadow * daylight *
      smoothstep(${f(C.fadeLo)}, ${f(C.fadeHi)}, cosGeo);
  }

  // --- night side: city lights, as an emissive term ---
  // uNightMix is 0 until the map arrives, so the night side is the day
  // albedo darkened and nothing else — which is what it looks like anyway on
  // the half of the planet with no cities on it.
  //
  // Everything below is deliberately downstream of the enhanced grade and the
  // palette: those two describe *albedo*, how the ground reflects sunlight, and
  // a street lamp does neither. Running the emissive term through them is how a
  // saturation of 0.75 and a grayscale of 0.10 would end up desaturating a
  // sodium lamp. See NIGHT_LIGHTS for the extraction and the constants.
  //
  // Before electrification uLights is 0, the reveal is then provably zero
  // (threshAt0 - edge >= 1 against a scale that cannot exceed 1), and the two
  // taps are skipped outright — which is most of recorded history.
  vec3 night = surface * vec3(0.05, 0.07, 0.12) * (1.0 + 2.2 * uBoost);
  if (uLights > 0.0) {
    vec3 rawNight = texture(uNight, vUv).rgb * uNightMix;
    // the halo: the same map a few mip levels up, which is a blur wide enough
    // to spill past a city's own footprint. A bias rather than a level, so it
    // stays that many levels above whatever the sharp tap resolved to and is
    // never sharper than the pixel — an absolute level aliases at the limb,
    // where the surface LOD is already well past it. This is the whole of the
    // bloom: no second pass, no render target, one extra fetch on the night
    // side only.
    vec3 wideNight = texture(uNight, vUv, ${f(N.haloLod)}).rgb * uNightMix;
    // lights, separated from the map's blue moonlit base. Linear in the
    // texture, so the wide tap's version *is* the low-passed light energy.
    float eCore = max(0.0, rawNight.r - ${f(N.blueBase)} * rawNight.b);
    float eHalo = max(0.0, wideNight.r - ${f(N.blueBase)} * wideNight.b);
    // normalised and perceptual, so the era threshold below sweeps evenly from
    // "only the largest cores" to "every lit texel" instead of spending most of
    // its travel above anything the map contains
    float q = pow(clamp(max(eCore, eHalo) * ${f(1 / N.peak)}, 0.0, 1.0), ${f(1 / N.gamma)});
    float thresh = ${f(N.threshAt0)} - ${f(N.span)} * pow(uLights, ${f(N.curve)});
    float reveal = smoothstep(thresh - ${f(N.edge)}, thresh + ${f(N.edge)}, q);
    // amber at the outskirts, warm white at the cores, white only at the peak
    vec3 tint = mix(${v3(N.dim)}, ${v3(N.hot)}, smoothstep(${f(N.hotLo)}, ${f(N.hotHi)}, q));
    night += tint * (eCore * ${f(N.core)} + eHalo * ${f(N.halo)}) * reveal;
  }

  vec3 color = mix(night, surface, daylight);

  // --- clouds, composited as the thin film they are ---
  // shadows keep the plain tap: they are a soft projection onto the ground and
  // sharpening them would only cost four taps to make a blur look edgy
  float cover = (uCloudAlpha > 0.0 ? cloudMask(cloudUv) : 0.0) * uCloudAlpha;
  if (cover > 0.002) {
    // thickness as colour, not just as alpha: a veil is the sky seen through it
    // and reads cool, a core is opaque water droplet and reads white
    vec3 body = mix(${v3(C.thin)}, ${v3(C.thick)},
      smoothstep(${f(C.bodyLo)}, ${f(C.bodyHi)}, cover));
    vec3 lit = mix(vec3(0.06, 0.08, 0.13), body, daylight);
    // The shape, from the baked normal: a modulation, because the film has
    // already been lit as a flat shell and what is left to say is only how this
    // face differs from that.
    float form = cloudSlope * daylight;
    lit *= 1.0 + form * mix(${f(C.shade)}, ${f(C.lit)}, step(0.0, form));
    // and the occlusion, which no amount of N.L can produce: the creases where
    // two cells have grown together stay dark with the sun straight down them,
    // because what is above them is more cloud
    lit *= mix(1.0, cloudAO, ${f(C.ao)});
    // silver lining: the sunward slopes alone, inside the terminator band. The
    // old warm add ran on the band and nothing else, so it tinted every cloud
    // there uniformly — including the flanks that are facing away from the sun.
    lit += ${v3(C.rim)} * max(cloudSlope, 0.0) *
      smoothstep(${f(C.rimBand)}, 0.0, abs(cosGeo)) * daylight;
    // thin cloud is translucent and thick cloud is not, so lean on the mask's
    // own gradient rather than pushing everything to full opacity
    float opacity = clamp(cover * cover * (0.35 + 1.15 * cover), 0.0, 1.0);
    color = mix(color, max(lit, vec3(0.0)), opacity * (0.18 + 0.82 * daylight));
  }

  // --- warm terminator band and blue limb ---
  // uRim is what finally switches these off, and map mode is what needed it.
  // With the terminator flattened, daylight is 1 everywhere, so the limb term
  // ran all the way round the planet and read as a warm halo on a drawing that
  // has no atmosphere in it — the one thing lib/present/globe.ts used to have
  // to write down as "map mode cannot switch this off".
  color += vec3(0.22, 0.08, 0.0) * smoothstep(0.25, 0.0, abs(cosGeo)) * daylight * uRim;
  float rim = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
  color += vec3(0.2, 0.45, 1.0) * rim * (0.25 + 0.55 * daylight) * uRim;

  // Exposure lift for the enhanced look. The day term is gated on daylight,
  // so the night side keeps exactly the exposure it had — brightening it
  // further would wash out the city lights it exists to show — and space,
  // which this shader never draws, cannot be touched either way.
  color *= 1.0 + uBoost * (${f(G.exposure)} + ${f(G.dayExposure)} * daylight);

  // --- what actually reaches the framebuffer ---
  //
  // This material writes LINEAR values into a drawing buffer three has told the
  // browser is sRGB-encoded (drawingBufferColorSpace), because a raw
  // ShaderMaterial gets none of the output conversion the built-in materials
  // get from the colorspace_fragment chunk. Everything above — ENHANCED_GRADE, the
  // exposure lift, the water gain, the lambert floor — was tuned by eye through
  // that missing gamma, so the photographed globe is *defined* by it and
  // "fixing" it globally would change every pixel of the shipped look.
  //
  // The drawn map cannot live with it. Its ground is not a photograph to be
  // graded, it is a drawing whose two parchment tones were chosen as numbers:
  // measured, the #ece2c8 paper reached the screen as (198, 180, 135), a full
  // gamma down and visibly browner, because the blue channel loses the most.
  // So map mode encodes its own output and the photographic mode does not — one
  // uniform, exact sRGB rather than a 1/2.2 approximation, and zero change to
  // the realistic branch.
  vec3 out_ = mix(color, mix(color * 12.92,
    1.055 * pow(max(color, 0.0), vec3(1.0 / 2.4)) - 0.055,
    step(0.0031308, color)), uEncode);
  fragColor = vec4(out_, 1.0);
}
`

export interface GlobeSurfaceUrls {
  day: string
  night: string
  relief: string
  clouds: string
  /** The baked cloud relief; see scripts/bake_clouds.py. */
  cloudNrm: string
}

/**
 * How a map is meant to be read. 'color' is light and gets the sRGB decode;
 * 'data' is a single-channel mask or height field; 'vector' is multi-channel
 * data — the baked cloud relief — which needs all four channels *and* linear
 * values, so it is neither of the other two.
 */
export type TextureKind = 'color' | 'data' | 'vector'

export class GlobeSurface {
  readonly material: ShaderMaterial
  private loader = new TextureLoader()
  private cache = new Map<string, Texture>()
  private maxAniso: number
  private maxTexture: number
  /** Held for `initTexture` alone — see `warm`. Nothing here ever renders. */
  private renderer: WebGLRenderer
  private urls!: GlobeSurfaceUrls
  /** Fires when the day map is decoded, which is when a globe can be shown. */
  onDayReady?: () => void
  private dayReady = false
  /** Ramps 0 to 1 as each deferred map arrives; see lib/mapFade.ts. */
  private fade = { night: 0, relief: 0, clouds: 0, cloudNrm: 0 }
  private landed = { night: false, relief: false, clouds: false, cloudNrm: false }
  /** The settings these ramps are applied to, held so a frame can re-apply them. */
  private reliefStrength = 0.7
  private cloudSetting = { visible: false, opacity: 1, shadows: true }
  /** Set while the camera is moving, so the cloud upscale can wait for a lull. */
  private busy = false
  /**
   * Fires whenever this material's picture changed on its own — a map decoded,
   * an upscale landed, an era frame arrived. The render loop is frame-on-demand
   * (see GlobeView), so an arrival nobody asked for still has to ask for a frame.
   */
  onDirty?: () => void
  /** URLs the era layer has asked for; the only ones eviction may consider. */
  private eraUrls = new Set<string>()
  /**
   * …and the ones eviction may never consider, however far the cursor moves.
   *
   * `evictEras` exists because 40 paleo frames at 32 MB with mips is 1.2 GB, and
   * it is right about every one of them: a reconstruction of the Devonian is a
   * frame the reader is passing through. A MODE'S OWN BASE MAP is not that. It
   * is the anchor at the modern end of a timeline, it is what the other mode is
   * one keystroke away from wanting back, and the rule that keeps `urls.day`
   * resident — it is the map the globe is made of — is exactly as true of the
   * drawn world in map mode. Left evictable it was disposed on the way out of
   * map mode and re-fetched, re-decoded and re-uploaded on the way back in:
   * measured at 32 MB and a full 4096x2048 mip chain on EVERY switch
   * (tests/e2e/modeSwitch.e2e.mjs, `bigTexUploads`).
   *
   * The memory this costs is one more 4096x2048 colour map — the same 32 MB the
   * night map has held permanently since the first round, and against a budget
   * that was sized for 40 of them.
   */
  private held = new Set<string>()
  /** URLs whose image has actually decoded — the rest would render black. */
  private decoded = new Set<string>()
  /** The last era plan, re-applied whenever one of its frames lands. */
  private eraState?: EraPlan
  /** The most recent *decoded* era texture, held over undecoded ones. */
  private lastGood?: Texture
  /**
   * IS THE BOUND BASE MAP ON THIS MODE'S TIMELINE AT ALL?
   *
   * `applyEra` holds the last decoded frame over an undecoded one, and that is
   * right for a scrub through deep time: one keyframe stale for a few hundred
   * milliseconds beats blacking the planet out. It is NOT right across a change
   * of MODE, because the two modes' timelines are different pictures of the
   * same world — map mode's modern frame is the drawn world and realistic
   * mode's is the photograph (data/paleoTextures.ts) — so the frame held over
   * into map mode is a satellite photograph, which is the one thing a drawn map
   * is not. See `paper` for what is done about it.
   *
   * "Not on the timeline", rather than "not the frame the plan asked for": a
   * scrub inside one mode holds a frame of that same mode all the time, and
   * treating that as foreign would flash the paper grade over the drawn world
   * at every keyframe boundary. `baseFrames` is what makes the distinction, and
   * while nothing has set it — every caller that does not know about modes —
   * the answer is always no and this whole rule is inert.
   */
  private baseHeld = false
  private baseFrames = new Set<string>()
  /**
   * Frame URL → its coastline-SDF URL, for the timelines that morph (the drawn
   * one; see `TextureKeyframe.sdf`). Empty for every caller that never calls
   * `setBaseFrames` with SDFs, which keeps the whole morph inert there.
   */
  private sdfOf = new Map<string, string>()
  /** The URL behind `lastGood`, which is what `baseFrames` is asked about. */
  private lastGoodUrl?: string
  /**
   * The paper grade, as two numbers instead of one.
   *
   * `mix` is what the era asks for — the share of the bound frame that is a
   * deep-time reconstruction rather than the mode's own map — and `prints` is
   * whether this mode prints at all. They were one argument, and collapsing
   * them lost exactly the case this round is about: at a modern year in map
   * mode the era's share is 0, which is indistinguishable from realistic mode's
   * "never print" — so a photograph held over into map mode reached the screen
   * as a photograph.
   */
  private paper = { mix: 0, prints: false }

  constructor(urls: GlobeSurfaceUrls, renderer: WebGLRenderer) {
    this.maxAniso = renderer.capabilities.getMaxAnisotropy()
    this.maxTexture = renderer.capabilities.maxTextureSize
    this.renderer = renderer
    this.urls = urls
    // The one map the first frame cannot do without. The other three are
    // requested by `loadRest`, once there is a globe on screen to add them to —
    // see lib/mapFade.ts. An unbound sampler reads as transparent black in
    // three, which is exactly the right absence for all three of them: no city
    // lights, a flat height field, and no cloud cover.
    const day = this.texture(urls.day, 'color', () => this.dayLoaded())
    this.lastGood = day
    // …and the URL with it, because "what is bound" has to have an answer from
    // the first frame: a session that OPENS in map mode binds the photographed
    // day map here and asks for the drawn world a tick later, which is the same
    // held-over photograph the toggle produces. See `baseHeld`.
    this.lastGoodUrl = urls.day

    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uEraA: { value: day },
        uEraB: { value: day },
        uEraMix: { value: 0 },
        uSdfA: { value: null },
        uSdfB: { value: null },
        uMorph: { value: 0 },
        uNight: { value: null },
        uNightMix: { value: 0 },
        uRelief: { value: null },
        uClouds: { value: null },
        uCloudNrm: { value: null },
        uCloudNrmMix: { value: 0 },
        uDetail: { value: null },
        uDetailLow: { value: null },
        uDetailIndex: { value: null },
        uDetailGrid: { value: new Vector4(0, 0, 0, 0) },
        uDetailGridP: { value: new Vector4(0, 0, 0, 0) },
        uDetailZ: { value: 0 },
        uDetailMix: { value: 0 },
        uSunDir: { value: new Vector3(1, 0, 0) },
        uLights: { value: 1 },
        uCloudRot: { value: 0 },
        uCloudAlpha: { value: 1 },
        uCloudShadow: { value: CLOUD_DEPTH.strength },
        uCloudH: { value: 0.012 },
        uCloudSharp: { value: 0 },
        // the bundled mask's size; replaced by the loaded image's own
        uCloudTexel: { value: new Vector2(1 / 4096, 1 / 2048) },
        uRelief_: { value: 0.7 },
        // the bundled relief map's size; replaced by the loaded image's own
        uTexel: { value: new Vector2(1 / 2048, 1 / 1024) },
        uFlatLight: { value: 0 },
        uBoost: { value: 1 },
        uPalette: { value: new Vector3(1, 0, 1) },
        uDetailPaint: { value: DETAIL_MODE.ratio },
        uRim: { value: 1 },
        uPaperMix: { value: 0 },
        uEncode: { value: 0 },
      },
    })
  }

  /**
   * Loads once. Colour maps are sRGB; masks and height fields are data and must
   * stay linear, or their mid-tones get crushed.
   *
   * Anisotropy used to be the driver's maximum (16 on every desktop GPU) for
   * every map, which is 16 texel fetches per sample at a grazing angle — and a
   * globe is mostly grazing angles. It buys something real on the colour maps,
   * where the pixels at the limb are the ones being read as coastline; 4 is
   * where that stops being visible. It buys nothing on the two *data* maps: the
   * relief map is differenced into a normal and the cloud mask is a soft alpha,
   * and neither carries detail that survives the limb. So data maps drop to 1.
   */
  texture(url: string, kind: TextureKind = 'color', onLoad?: (t: Texture) => void): Texture {
    let t = this.cache.get(url)
    if (!t) {
      t = this.loader.load(url, (tex) => {
        this.decoded.add(url)
        onLoad?.(tex)
      })
      if (kind === 'color') t.colorSpace = SRGBColorSpace
      // R8 instead of RGBA8 for the data maps: the shader reads `.r` from both,
      // and the upload is a quarter of the bytes and a quarter of the mipmap
      // work. WebGL2 is a hard requirement here (the material is GLSL3), and
      // WebGL2 accepts RED/UNSIGNED_BYTE straight from an <img>.
      // 'vector' keeps all four channels — it carries a signed gradient in two
      // of them and an occlusion in a third — but is still data, so it must not
      // be tagged sRGB: decoding a normal through a transfer curve bends every
      // slope toward zero and the relief quietly halves.
      else if (kind === 'data') t.format = RedFormat
      t.anisotropy = this.anisoFor(kind)
      t.wrapS = RepeatWrapping
      this.cache.set(url, t)
    }
    return t
  }

  /** Colour maps get enough to keep the limb readable; data maps get none. */
  private anisoFor(kind: TextureKind): number {
    return kind === 'color' ? Math.min(4, this.maxAniso) : 1
  }

  /** The day map is on the GPU: there is a globe to look at. */
  private dayLoaded() {
    if (this.dayReady) return
    this.dayReady = true
    this.onDayReady?.()
  }

  /**
   * Request the maps the first frame did without.
   *
   * Called once the globe has actually drawn, so these three downloads and
   * their uploads compete with nothing: the basemap has the network to itself
   * until there is something on screen, and the 75 MB of texture upload they
   * add lands in frames a user is already looking at rather than in the gap
   * before the first one.
   */
  loadRest() {
    const urls = this.urls
    const u = this.material.uniforms
    u.uNight.value = this.texture(urls.night, 'color', () => (this.landed.night = true))
    // The relief map is not the same size as the colour maps (2048×1024 against
    // 4096×2048), so its texel step has to come from the image itself. Stepping
    // by the colour map's texel takes the finite difference over half a texel
    // and halves every slope — terrain that is lit, but only half as much as the
    // strength setting says.
    u.uRelief.value = this.texture(urls.relief, 'data', (t) => {
      this.setReliefTexel(t)
      this.landed.relief = true
    })
    u.uClouds.value = this.texture(urls.clouds, 'data', (t) => {
      this.setCloudTexel(t)
      this.landed.clouds = true
      this.upscaleClouds(urls.clouds, t)
    })
    // The baked relief. Its own ramp rather than the mask's: it is a quarter of
    // the size and arrives on its own schedule, and until it does the deck has
    // to be provably flat — an unbound sampler reads as transparent black,
    // which decodes to a full negative tilt in both axes.
    u.uCloudNrm.value = this.texture(urls.cloudNrm, 'vector', () => {
      this.landed.cloudNrm = true
    })
  }

  /**
   * Advance the arrival ramps by one frame. Returns true while any of them is
   * still moving — the render loop only draws frames that differ, so a ramp has
   * to say so (see GlobeView's `wake`).
   *
   * Driven from the render loop rather than from a timer so a backgrounded tab
   * does not fade three maps in while nobody is watching and then present the
   * result as a jump.
   */
  advance(dtMs: number): boolean {
    const u = this.material.uniforms
    const before = this.fade.night + this.fade.relief + this.fade.clouds + this.fade.cloudNrm
    this.fade.night = fadeTowards(this.fade.night, this.landed.night ? 1 : 0, dtMs)
    this.fade.relief = fadeTowards(this.fade.relief, this.landed.relief ? 1 : 0, dtMs)
    this.fade.clouds = fadeTowards(this.fade.clouds, this.landed.clouds ? 1 : 0, dtMs)
    this.fade.cloudNrm = fadeTowards(this.fade.cloudNrm, this.landed.cloudNrm ? 1 : 0, dtMs)
    u.uCloudNrmMix.value = this.fade.cloudNrm
    u.uNightMix.value = this.fade.night
    u.uRelief_.value = this.reliefStrength * this.fade.relief
    this.applyClouds()
    return this.fade.night + this.fade.relief + this.fade.clouds + this.fade.cloudNrm !== before
  }

  /** Whether any cloud film is being drawn — i.e. whether drift is visible. */
  get cloudsShown(): boolean {
    return this.material.uniforms.uCloudAlpha.value > 0
  }

  /** Whether the camera is moving; the cloud upscale waits for it to stop. */
  setBusy(busy: boolean) {
    this.busy = busy
  }

  /** The unsharp radius follows the *source* mask, so the upscale cannot move it. */
  private setCloudTexel(t: Texture) {
    const img = t.image as { width?: number; height?: number } | undefined
    if (!this.material || !img?.width || !img?.height) return
    this.material.uniforms.uCloudTexel.value.set(1 / img.width, 1 / img.height)
  }

  /**
   * Swap the loaded cloud mask for a Lanczos-3 upscale of itself, off-thread.
   *
   * Strictly an improvement on something already on screen: the raw texture is
   * live from the moment it decodes, this lands whenever it lands, and every
   * way it can fail — no worker, no OffscreenCanvas, a tainted bitmap, a
   * resample that runs out of memory — leaves that raw texture exactly where it
   * was. Nothing waits on it.
   */
  private upscaleClouds(url: string, t: Texture) {
    const img = t.image as CanvasImageSource & { width?: number; height?: number }
    if (!img?.width || typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') {
      return
    }
    const memory = (navigator as { deviceMemory?: number }).deviceMemory
    if (!cloudUpscaleWorthIt(memory, this.maxTexture)) return
    // Wait for a lull. This is a 33 MB texture upload and a worker's worth of
    // Lanczos over 33 megapixels, spent to soften the edges of a layer that
    // fades out entirely as the camera closes in — so it may have whatever the
    // browser has left over and nothing more. `whenIdle` also declines while the
    // camera is moving, which is the other time the main thread has a queue.
    this.whenIdle(() => {
      // …AND ONLY IF THE DECK IS BEING DRAWN AT ALL.
      //
      // The mask is loaded by `loadRest` at first paint, and the upscale waits
      // for a lull — which a reader who reaches straight for the map toggle
      // reaches first. Map mode has no cloud deck (`GlobeStyle.clouds` is
      // false, `uCloudAlpha` is 0), so the whole 32 MB upload and the worker's
      // 33 megapixels of Lanczos were being spent on a texture no fragment
      // samples: photographed in the switch instrument as an 8192x4096 upload
      // landing inside a mode that cannot show it. The SETTING rather than the
      // faded alpha, because the fade is still ramping when this first runs.
      if (!this.cloudSetting.visible) return this.cloudUpscaleWanted = { url, t, img }
      this.runCloudUpscale(url, t, img)
    })
  }

  /**
   * The upscale deferred above, and the switch that lets it back in.
   *
   * Held rather than dropped: a reader who turns the clouds back on — or comes
   * back out of map mode — should get the sharp mask, and re-deriving it would
   * mean re-reading the source texture from a `Texture` the era sweep may have
   * moved on from. `setClouds` is the one call that can change the answer.
   */
  private cloudUpscaleWanted?: {
    url: string
    t: Texture
    img: CanvasImageSource & { width?: number; height?: number }
  }

  /**
   * Run `job` when the browser is idle *and* the camera is still.
   *
   * requestIdleCallback alone is not enough: a zoom keeps the main thread busy
   * with composites and texture uploads, and "idle" between two of those is
   * still the middle of an interaction. The timeout is the guarantee that the
   * work happens at all on a page that never goes quiet, and the re-check is
   * what keeps it from landing mid-gesture.
   */
  private whenIdle(job: () => void, timeoutMs = 3000) {
    const idle = (window as unknown as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
    }).requestIdleCallback
    const attempt = (tries: number) => {
      const run = () => {
        if (this.busy && tries > 0) return attempt(tries - 1)
        job()
      }
      if (idle) idle(run, { timeout: timeoutMs })
      else setTimeout(run, 200)
    }
    attempt(6)
  }

  private runCloudUpscale(url: string, t: Texture, img: CanvasImageSource & { width?: number; height?: number }) {
    let worker: Worker
    try {
      worker = new Worker(new URL('./cloudUpscale.worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch {
      return
    }
    worker.onmessage = (e: MessageEvent<CloudUpscaleResponse | null>) => {
      worker.terminate()
      const out = e.data
      if (!out || this.material.uniforms.uClouds.value !== t) return
      // R8 rather than RGBA8: the shader reads `.r`, and at 8192x4096 that is
      // 32 MB of texture memory instead of 128 MB. The worker has already
      // reversed the rows, so DataTexture's flipY = false is the right one.
      const sharper = new DataTexture(out.data, out.width, out.height, RedFormat)
      sharper.wrapS = RepeatWrapping
      sharper.anisotropy = this.anisoFor('data')
      sharper.magFilter = LinearFilter
      sharper.minFilter = LinearMipmapLinearFilter
      sharper.generateMipmaps = true
      sharper.needsUpdate = true
      this.material.uniforms.uClouds.value = sharper
      this.cache.set(url, sharper)
      t.dispose()
      if (import.meta.env?.DEV) {
        console.info(
          `clouds: ${img.width}x${img.height} -> ${out.width}x${out.height} in ${out.ms.toFixed(0)} ms`,
        )
      }
    }
    worker.onerror = () => worker.terminate()
    createImageBitmap(img)
      .then((bitmap) => {
        const req: CloudUpscaleRequest = { bitmap, scale: CLOUD_UPSCALE }
        worker.postMessage(req, [bitmap])
      })
      .catch(() => worker.terminate())
  }

  /** Match the finite-difference step to the height field actually loaded. */
  private setReliefTexel(t: Texture) {
    const img = t.image as { width?: number; height?: number } | undefined
    // the material may not exist yet: a cached image can resolve before the
    // constructor has finished
    if (!this.material || !img?.width || !img?.height) return
    this.material.uniforms.uTexel.value.set(1 / img.width, 1 / img.height)
  }

  /**
   * Try to replace an already-loaded map with a sharper source. If the request
   * fails — offline, blocked, rate-limited — the original stays in place and
   * nothing visibly changes, so this can never leave the globe worse off.
   */
  upgrade(url: string, betterUrl: string) {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const sharper = new Texture(img)
      sharper.colorSpace = SRGBColorSpace
      sharper.anisotropy = this.anisoFor('color')
      sharper.wrapS = RepeatWrapping
      sharper.needsUpdate = true
      const previous = this.cache.get(url)
      this.cache.set(url, sharper)
      for (const key of ['uEraA', 'uEraB', 'uNight']) {
        if (this.material.uniforms[key].value === previous) {
          this.material.uniforms[key].value = sharper
        }
      }
      // the held fallback frame is a fourth reference to the same texture, and
      // disposing what it points at would make the next era jump hold a corpse
      if (this.lastGood === previous) this.lastGood = sharper
      this.decoded.add(url)
      previous?.dispose()
      this.onDirty?.()
    }
    img.onerror = () => {} // keep what we have
    img.src = betterUrl
  }

  /**
   * Show a moment in deep time, and decide what stays on the GPU.
   *
   * Three things happen here, and only the first is obvious:
   *
   *  - the blend pair is requested, and the next frame in the direction of
   *    travel is *started* (see EraPlan.prefetch), so a steady scrub crosses
   *    each keyframe boundary with the map already decoded;
   *  - nothing undecoded is ever bound. A texture whose image has not landed
   *    reads as black in three, so jumping eras used to black the planet out for
   *    the length of a decode. Holding the previous frame instead is at worst
   *    one keyframe stale for a few hundred milliseconds, which on a scale where
   *    a keyframe is ten million years is not a lie worth blacking a globe for;
   *  - everything outside the window is disposed. 40 paleo frames at 32 MB with
   *    mips is 1.2 GB if they are merely cached, and a cache is what this was.
   */
  setEra(plan: EraPlan) {
    this.eraState = plan
    this.requestEra(plan.from)
    this.requestEra(plan.to)
    if (plan.prefetch) this.requestEra(plan.prefetch)
    this.applyEra()
    this.evictEras(plan.keep)
  }

  /** An era frame, loading if need be, re-applied to the shader when it lands. */
  private requestEra(url: string): Texture {
    this.eraUrls.add(url)
    // …and its coastline SDF, when this timeline morphs: requested alongside
    // the frame (including the prefetch) so a steady scrub crosses a keyframe
    // boundary with the morph ready, not with one crossfaded stopgap first.
    const sdf = this.sdfOf.get(url)
    if (sdf) {
      this.eraUrls.add(sdf)
      this.texture(sdf, 'data', () => {
        this.applyEra()
        this.onDirty?.()
      })
    }
    return this.texture(url, 'color', () => {
      this.applyEra()
      // and sweep again: the frame that just landed may have released the stale
      // one the shader was holding over it, which the arriving-frame path is the
      // only chance to free — nothing else runs until the cursor moves again
      if (this.eraState) this.evictEras(this.eraState.keep)
      this.onDirty?.()
    })
  }

  /**
   * Bind whichever of the planned pair has actually decoded, holding the last
   * good frame for the rest. Called again by every frame's own load callback,
   * so the real pair goes up as soon as it exists.
   */
  private applyEra() {
    const plan = this.eraState
    if (!plan) return
    const u = this.material.uniforms
    const hasFrom = this.decoded.has(plan.from)
    const hasTo = this.decoded.has(plan.to)
    if (hasFrom && hasTo) {
      const a = this.cache.get(plan.from)!
      const b = this.cache.get(plan.to)!
      u.uEraA.value = a
      u.uEraB.value = b
      u.uEraMix.value = plan.f
      this.applyMorph(plan)
      const near = plan.f < 0.5
      this.lastGood = near ? a : b
      this.lastGoodUrl = near ? plan.from : plan.to
      this.setBaseHeld(false) // both halves are this timeline's own
      return
    }
    u.uMorph.value = 0
    u.uSdfA.value = null
    u.uSdfB.value = null
    const url = hasFrom ? plan.from : hasTo ? plan.to : this.lastGoodUrl
    const held = hasFrom
      ? this.cache.get(plan.from)!
      : hasTo
        ? this.cache.get(plan.to)!
        : this.lastGood
    this.setBaseHeld(url !== undefined && this.baseFrames.size > 0 && !this.baseFrames.has(url))
    if (!held) return
    u.uEraA.value = held
    u.uEraB.value = held
    u.uEraMix.value = 0
    this.lastGood = held
    this.lastGoodUrl = url
  }

  /**
   * The timeline this mode reads, so a held-over frame can be recognised as
   * belonging to the OTHER one. See `baseHeld`.
   *
   * Told rather than inferred: the surface holds a texture cache and an era
   * window, and neither of them knows that two different lists of keyframes
   * exist — that is `framesFor` in data/paleoTextures.ts, and it belongs to the
   * mode.
   */
  setBaseFrames(frames: readonly { url: string; sdf?: string }[]) {
    this.baseFrames = new Set(frames.map((f) => f.url))
    this.sdfOf = new Map(
      frames.filter((f): f is { url: string; sdf: string } => !!f.sdf).map((f) => [f.url, f.sdf]),
    )
    this.applyEra()
  }

  /**
   * Bind the coastline-SDF pair and arm the morph — or disarm it.
   *
   * Armed only when the blend is strictly mid-flight AND both distances are
   * really decoded; every other state falls back to the plain crossfade, so a
   * scrub that outruns the SDF downloads degrades to exactly the old picture
   * rather than thresholding an unbound sampler (which reads as black, i.e.
   * "everything is deepest ocean").
   */
  private applyMorph(plan: EraPlan) {
    const u = this.material.uniforms
    const sdfA = this.sdfOf.get(plan.from)
    const sdfB = this.sdfOf.get(plan.to)
    const on =
      plan.f > 0 &&
      plan.f < 1 &&
      sdfA !== undefined &&
      sdfB !== undefined &&
      this.decoded.has(sdfA) &&
      this.decoded.has(sdfB)
    u.uMorph.value = on ? 1 : 0
    if (!on) {
      // unbind, so the era window's eviction can take the textures with it
      u.uSdfA.value = null
      u.uSdfB.value = null
      return
    }
    u.uSdfA.value = this.cache.get(sdfA!)!
    u.uSdfB.value = this.cache.get(sdfB!)!
  }

  /** See `baseHeld`; the paper grade is the only thing that reads it. */
  private setBaseHeld(held: boolean) {
    if (this.baseHeld === held) return
    this.baseHeld = held
    this.applyPaper()
  }

  /**
   * THE MEDIUM IS A PROPERTY OF THE MODE, NOT OF THE YEAR.
   *
   * Map mode's own timeline needs no printing at all any more: since round 65
   * every deep-time frame on it is a build-time drawn twin in the map's own
   * palette (DRAWN_FRAMES; `render_drawn` in scripts/gen_paleo_v4.py), so the
   * year-derived share (`1 - modernShare`, before that round) is passed as a
   * constant zero. What the duotone (`uPaperMix`) is still FOR is the one
   * frame the timeline does not plan: the map held over from the OTHER mode
   * while this mode's own base map is still decoding.
   *
   * That is what the field reported after round 61 — *"I can sometimes see a
   * block of satellite map on the edges of screen"* and *"switching … produces
   * a weird map / satellite hybrid"*. Map mode's base texture is fetched at the
   * switch (the drawn map is lazy by contract) while its tiles need only the
   * 54 kB coarse geometry, so over any real connection the TILES WIN THE RACE:
   * drawn tiles paint the middle of the frame and the photograph they are
   * painted onto shows at the edges, which is where the streamed grid finishes
   * last. Photographed in tests/e2e/repro62.e2e.mjs with the one file put
   * behind a network: 39.9% of the frame photographic, 16.3% of it uncovered
   * and all of that in the outer eighth.
   *
   * The floor costs nothing and waits for nothing: the picture stays the
   * reader's own geography, printed in the medium the mode is in, until the
   * drawn world lands and the era's own share takes over again.
   */
  private applyPaper() {
    this.material.uniforms.uPaperMix.value = this.paper.prints
      ? Math.max(this.paper.mix, this.baseHeld ? 1 : 0)
      : 0
  }

  /**
   * Drop era frames outside the window.
   *
   * Three things are never dropped, however far the cursor has moved: the maps
   * this surface was constructed with (the last paleo keyframe *is* the day
   * basemap, and disposing it would take the modern globe with it), whatever the
   * two era samplers are bound to right now, and the held frame the next
   * `applyEra` may still need to fall back to.
   */
  private evictEras(keep: string[]) {
    const u = this.material.uniforms
    const live = new Set(keep)
    // a kept frame keeps its coastline SDF: the pair travel together
    for (const url of keep) {
      const sdf = this.sdfOf.get(url)
      if (sdf) live.add(sdf)
    }
    const pinned = new Set<string>([...Object.values(this.urls), ...this.held])
    for (const url of this.eraUrls) {
      if (live.has(url) || pinned.has(url)) continue
      const t = this.cache.get(url)
      if (!t || t === u.uEraA.value || t === u.uEraB.value || t === this.lastGood) continue
      if (t === u.uSdfA.value || t === u.uSdfB.value) continue
      t.dispose()
      this.cache.delete(url)
      this.decoded.delete(url)
      this.eraUrls.delete(url)
    }
  }

  /** Era frames currently on the GPU — the window this class promises to hold. */
  get residentEras(): string[] {
    return [...this.eraUrls]
  }

  /**
   * Never evict this map. See `held`.
   *
   * Pinning is not loading: a URL nothing has asked for costs nothing to
   * promise, and the promise is what makes the second visit to a mode free.
   */
  pin(url: string) {
    this.held.add(url)
  }

  /**
   * …and put it on the GPU now, while nothing is waiting for a frame.
   *
   * `texture()` starts a download and three uploads the result inside whichever
   * frame first BINDS it — which, for a mode's base map, is the first frame of
   * that mode. That is 391 kB of WebP decoded to 8.4 megapixels, a 32 MB
   * upload and a 4096x2048 mip chain, all inside the toggle. `initTexture` is
   * three's own name for "do that part now", and doing it from an arrival
   * callback puts it in a frame nobody is looking at.
   *
   * Called on INTENT rather than on load (see `warmMap` in stores/settings.ts):
   * the drawn map's contract is that a reader who never opens it pays for
   * nothing, and a pointer arriving at the toggle is not that reader.
   */
  warm(url: string, kind: TextureKind = 'color') {
    this.pin(url)
    if (this.decoded.has(url)) return
    this.texture(url, kind, (t) => {
      // A context that refuses (or a three without it) simply uploads on first
      // use, exactly as before: this can make the switch cheaper, never worse.
      try {
        this.renderer.initTexture(t)
      } catch {
        /* upload stays where it was */
      }
    })
  }

  /** Whether a map is decoded and on the GPU — the prewarm's own assertion. */
  isWarm(url: string): boolean {
    return this.decoded.has(url)
  }

  setSun(dir: Vector3) {
    this.material.uniforms.uSunDir.value.copy(dir).normalize()
  }

  setCityLights(f: number) {
    this.material.uniforms.uLights.value = f
  }

  /**
   * Put the deck where the clock says it is, in milliseconds since the drift
   * epoch. Called on every frame rather than on a timer of its own — see
   * `cloudDriftPhase` for why that distinction is the whole fix for the
   * staggered drift.
   */
  setCloudDrift(elapsedMs: number) {
    this.material.uniforms.uCloudRot.value = cloudDriftPhase(elapsedMs)
  }

  /**
   * Point the shader at the tile atlas (null clears it).
   *
   * Three textures and two grids, where there used to be one texture and one
   * rectangle. The rectangle described a canvas the CPU had assembled; the grids
   * describe where in the pyramid the visible tiles sit, and the shader does the
   * assembling — see `atlasCell` and the detail block above.
   *
   * `view` is a whole `AtlasIndex` rather than loose numbers so that the level,
   * the two grids and the index texture the slots are numbered in can only ever
   * be published together. They described the same frame when they were built,
   * and half of a frame's index over the other half is a picture of ground that
   * does not exist.
   */
  setDetail(
    maps: { sharp: Texture; low: Texture; index: Texture } | null,
    view: { z: number; grid: Grid; parent: Grid } | undefined,
    mix: number,
  ) {
    const u = this.material.uniforms
    u.uDetail.value = maps?.sharp ?? null
    u.uDetailLow.value = maps?.low ?? null
    u.uDetailIndex.value = maps?.index ?? null
    u.uDetailMix.value = maps && view ? mix : 0
    if (!view) return
    u.uDetailZ.value = view.z
    u.uDetailGrid.value.set(...view.grid)
    u.uDetailGridP.value.set(...view.parent)
  }

  /**
   * How far to suppress the terminator. Close up, the imagery carries its own
   * lighting and a day/night boundary crossing the view just looks wrong.
   */
  setFlatLight(v: number) {
    this.material.uniforms.uFlatLight.value = v
  }

  /** Unsharp amount for the cloud mask; 0 skips the extra taps entirely. */
  setCloudSharpen(k: number) {
    this.material.uniforms.uCloudSharp.value = k
  }

  setClouds(visible: boolean, opacity = 1, shadows = true) {
    this.cloudSetting = { visible, opacity, shadows }
    this.applyClouds()
    // A deck that has just been switched on may be owed the sharp mask; see
    // `cloudUpscaleWanted`. Still through `whenIdle`, because the reason it is
    // deferred at all has not changed.
    const owed = this.cloudUpscaleWanted
    if (visible && owed) {
      this.cloudUpscaleWanted = undefined
      this.whenIdle(() => this.runCloudUpscale(owed.url, owed.t, owed.img))
    }
  }

  /** The cloud settings, scaled by however far the mask has faded in. */
  private applyClouds() {
    const { visible, opacity, shadows } = this.cloudSetting
    const f = this.fade.clouds
    const u = this.material.uniforms
    u.uCloudAlpha.value = visible ? opacity * f : 0
    // CLOUD_DEPTH.strength rather than the old flat 0.5: the shadow now runs
    // through a thickness curve that costs a thin veil most of its occlusion, so
    // the same strength on the same sky was a visibly lighter planet
    u.uCloudShadow.value = visible && shadows ? CLOUD_DEPTH.strength * opacity * f : 0
  }

  /** 0 = realistic lighting, 1 = enhanced (brighter day side, lifted night side). */
  setVisuals(boost: number) {
    this.material.uniforms.uBoost.value = boost
  }

  /**
   * How far the streamed layer may push the ground, and whether the planet has
   * an atmosphere and a sheet of paper. Four uniforms, one call, because they
   * are one decision — see `GlobeStyle`.
   *
   * `prints` is the mode's own answer to "does this surface print at all", and
   * it is separate from `paper` because `paper` is a share of a YEAR: at a
   * modern year map mode asks for 0, exactly as realistic mode does at every
   * year, and the two zeros mean opposite things the moment a frame from the
   * other mode's timeline is what is bound. See `applyPaper`. It defaults to
   * the old meaning, so a caller that does not know about modes still gets
   * exactly the behaviour it had.
   */
  setSurfaceMode(detail: number, rim: number, paper: number, encode: number, prints = paper > 0) {
    this.material.uniforms.uDetailPaint.value = detail
    this.material.uniforms.uRim.value = rim
    this.paper = { mix: paper, prints }
    this.applyPaper()
    this.material.uniforms.uEncode.value = encode
  }

  /** The experimental palette controls; (1, 0, 1) is a no-op. */
  setPalette(p: Palette) {
    this.material.uniforms.uPalette.value.set(p.saturation, p.grayscale, p.contrast)
  }

  setRelief(strength: number) {
    this.reliefStrength = strength
    this.material.uniforms.uRelief_.value = strength * this.fade.relief
  }

  dispose() {
    this.cache.forEach((t) => t.dispose())
    this.material.dispose()
  }
}
