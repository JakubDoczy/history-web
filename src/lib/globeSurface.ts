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
import type { TextureBlend } from './paleo'
import { PALETTE_GAMMA, type Palette } from './palette'
import { CLOUD_UPSCALE, cloudUpscaleWorthIt } from './cloudUpscale'
import { fadeTowards } from './mapFade'
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

const G = ENHANCED_GRADE
const f = (n: number) => n.toFixed(4)

const fragment = /* glsl */ `
precision highp float;

in vec2 vUv;
in vec3 vNormalW;
in vec3 vWorldPos;
out vec4 fragColor;

uniform sampler2D uEraA;      // surface texture, era A
uniform sampler2D uEraB;      // surface texture, era B
uniform float uEraMix;        // 0 = A, 1 = B
uniform sampler2D uNight;     // city lights
uniform float uNightMix;      // 0 until the night map has landed, then ramps in
uniform sampler2D uRelief;    // topography, used as a height field
uniform sampler2D uClouds;    // cloud coverage mask
uniform sampler2D uDetail;    // streamed high-resolution patch over the viewed region
uniform vec4 uDetailRect;     // u0, v0, du, dv of that patch
uniform float uDetailMix;
uniform float uDetailLod;    // mip level whose blur matches the base map
uniform vec2 uDetailSize;    // the patch texture's size in texels
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

vec2 dirToUv(vec3 d) {
  vec3 l = vec3(d.z, d.y, -d.x);
  return vec2(atan(l.z, -l.x) / (2.0 * PI) + 0.5, 0.5 + asin(clamp(l.y, -1.0, 1.0)) / PI);
}

void main() {
  vec3 n = normalize(vNormalW);

  // --- relief: perturb the normal from the height field so terrain catches light ---
  float hL = texture(uRelief, vUv - vec2(uTexel.x, 0.0)).r;
  float hR = texture(uRelief, vUv + vec2(uTexel.x, 0.0)).r;
  float hD = texture(uRelief, vUv - vec2(0.0, uTexel.y)).r;
  float hU = texture(uRelief, vUv + vec2(0.0, uTexel.y)).r;
  vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), n));
  vec3 north = cross(n, east);
  vec3 nRelief = normalize(n - (east * (hR - hL) + north * (hU - hD)) * uRelief_);

  float cosSun = dot(nRelief, uSunDir);
  float cosGeo = dot(n, uSunDir);           // geometric terminator, no relief
  float daylight = mix(smoothstep(-0.18, 0.22, cosGeo), 1.0, uFlatLight);
  // "Enhanced" lifts the lambert floor and flattens its slope: the day side
  // stays readable everywhere instead of falling off toward the limb.
  float slope = mix(0.65, 0.45, uBoost);
  float floor_ = mix(0.45, 0.72, uBoost);
  float lambert = mix(clamp(cosSun * slope + floor_, 0.0, 1.3), 1.0, uFlatLight);

  // --- surface: crossfade between two era textures (both are the modern map today) ---
  // uEraMix is 0 except during a paleo crossfade — textureBlend returns f = 0
  // for every time that is not between two frames, which is the whole modern
  // era and most of deep time. Sampling the second map unconditionally spent a
  // full-resolution fetch per fragment on a mix of zero, every frame, forever.
  // Branching is safe here for the same reason it is safe for uDetailMix: the
  // condition is a uniform, so it is the same for every fragment in the draw and
  // the derivatives inside stay defined.
  vec3 albedo = texture(uEraA, vUv).rgb;
  if (uEraMix > 0.0) albedo = mix(albedo, texture(uEraB, vUv).rgb, uEraMix);

  // --- high-resolution patch, feathered at its edges so the join is invisible ---
  // uDetailMix is uniform across the draw, so branching on it is safe. Branching
  // on the per-pixel test is not: sampling a texture inside non-uniform control
  // flow leaves the derivatives undefined, which several mobile GPUs render as
  // flicker or dropouts. So the patch is sampled unconditionally, at mip levels
  // computed rather than inferred, and the region test becomes a weight instead
  // of a branch.
  //
  // What comes out of this block is a single number: how much brighter or
  // darker than the base map the patch says this piece of ground is. It is
  // applied at the very end, after the grade — see below.
  float detailGain = 1.0;
  if (uDetailMix > 0.0) {
    vec2 d = (vUv - uDetailRect.xy) / uDetailRect.zw;
    vec2 inside = step(vec2(0.0), d) * step(d, vec2(1.0));
    vec2 f = smoothstep(vec2(0.0), vec2(0.08), d) * (1.0 - smoothstep(vec2(0.92), vec2(1.0), d));
    vec2 dc = clamp(d, 0.0, 1.0);

    // Three explicit mip levels, all derived from one number: how many patch
    // texels this pixel covers.
    //
    // Sampling the sharp tap at mip 0 unconditionally — which is what this used
    // to do — is right only while the patch is being magnified. As soon as the
    // patch is denser than the screen (every zoom-out, and any composite drawn
    // larger than the view), mip 0 is an aliased point sample of a minified
    // texture, and dividing one aliased sample by a blurred one turned bright
    // features into dark smears: measured, the patch made the picture *less*
    // detailed than no patch at all at wide zoom, and 7/255 darker.
    vec2 texels = max(abs(dFdx(d)), abs(dFdy(d))) * uDetailSize;
    float lodPix = max(0.0, log2(max(max(texels.x, texels.y), 1e-6)));
    // never let the blurred tap be sharper than the sharp one: where the patch
    // is minified past the base map's own scale the two levels meet, the ratio
    // below becomes exactly 1, and the patch fades to a no-op instead of
    // fighting the base map for the same frequency band
    float lodLo = max(uDetailLod, lodPix);
    vec4 det = textureLod(uDetail, dc, lodPix);
    vec4 low = textureLod(uDetail, dc, lodLo);
    // A composite canvas is transparent wherever no cached patch reached, and
    // the mip chain averages that transparent black into the colour — which
    // showed as a bright halo just inside the edge of a partly-covered
    // composite. Straight (un-premultiplied) alpha makes the fix exact:
    // mean(rgb) / mean(a) is the mean over covered texels alone.
    vec3 hi = det.rgb / max(det.a, 0.004);
    vec3 lo = low.rgb / max(low.a, 0.004);

    // Colour matching, unconditional and on luminance alone.
    //
    // The patch contributes *structure*: how much brighter or darker the ground
    // is than the base map knows. The base map contributes the colour. Taking
    // the ratio per channel — the earlier form — transferred the sharp sensor's
    // chroma as well, so Sentinel-2's greener, higher-contrast palette leaked
    // through as hue shifts of up to 20/255 along coastlines and snow lines.
    // One scalar cannot move a hue: it scales all three channels together, so
    // the base map's colour survives by construction rather than by tuning.
    //
    // The limits are what "stability beats maximal sharpness" buys: a gain of
    // 2.5x is a real reading over a snow line or a coast, and it is also enough
    // to drive the graded highlights past white and leave the patch looking
    // blown rather than sharp. Under a stop either way, ordinary ground (0.8 to
    // 1.3) is untouched and only the extremes are held back.
    const vec3 luma = vec3(0.2126, 0.7152, 0.0722);
    float k = clamp((dot(hi, luma) + 0.004) / (dot(lo, luma) + 0.004), 0.55, 1.8);

    // Coverage, softened. The alpha at the sharp tap alone is a one-texel step
    // at the boundary between covered and uncovered parts of a composite — a
    // hard edge across the middle of the patch. A tap a couple of mips up turns
    // it into a ramp as wide as the feather at the rectangle edge, so the join
    // reads the same wherever it falls.
    float cover = smoothstep(0.15, 0.85, textureLod(uDetail, dc, clamp(lodPix + 1.0, 1.0, 4.0)).a);
    detailGain = mix(1.0, k, inside.x * inside.y * f.x * f.y * uDetailMix * cover);
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
  // which is why this can sit in the hot path unconditionally.
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

  vec3 surface = albedo * lambert;

  vec3 viewDir = normalize(cameraPosition - vWorldPos);

  // --- parallax: the deck sits above the ground, so it slides against it as
  // the globe turns. Following the view ray up to cloud height is what makes
  // the layer read as floating rather than painted on. ---
  vec3 liftedView = normalize(n + viewDir * (uCloudH / max(dot(n, viewDir), 0.25)));
  vec2 pduv = dirToUv(liftedView) - dirToUv(n);
  pduv.x -= (abs(pduv.x) > 0.5) ? sign(pduv.x) : 0.0;
  vec2 cloudUv = vec2(fract(vUv.x + pduv.x + uCloudRot), clamp(vUv.y + pduv.y, 0.0, 1.0));

  // --- cloud shadows: follow the sun ray up to the same height and sample there ---
  if (uCloudShadow > 0.0 && cosGeo > 0.03) {
    vec3 lifted = normalize(n + uSunDir * (uCloudH / max(cosGeo, 0.18)));
    vec2 duv = dirToUv(lifted) - dirToUv(n);
    duv.x -= (abs(duv.x) > 0.5) ? sign(duv.x) : 0.0;   // cross the seam cleanly
    float occ = texture(uClouds, vec2(fract(vUv.x + duv.x + uCloudRot), clamp(vUv.y + duv.y, 0.0, 1.0))).r;
    surface *= 1.0 - occ * uCloudShadow * daylight;
  }

  // --- night side: city lights revealed from the brightest cores outward ---
  // uNightMix is 0 until the map arrives, so the night side is the day
  // albedo darkened and nothing else — which is what it looks like anyway on
  // the half of the planet with no cities on it.
  vec3 rawNight = texture(uNight, vUv).rgb * uNightMix;
  float lum = dot(rawNight, vec3(0.333));
  float thresh = 1.15 - uLights * 1.25;
  float reveal = smoothstep(thresh - 0.18, thresh + 0.18, lum);
  vec3 night = surface * vec3(0.05, 0.07, 0.12) * (1.0 + 2.2 * uBoost) + rawNight * 1.6 * reveal;

  vec3 color = mix(night, surface, daylight);

  // --- clouds, composited as the thin film they are ---
  // shadows keep the plain tap: they are a soft projection onto the ground and
  // sharpening them would only cost four taps to make a blur look edgy
  float cover = (uCloudAlpha > 0.0 ? cloudMask(cloudUv) : 0.0) * uCloudAlpha;
  if (cover > 0.002) {
    vec3 lit = mix(vec3(0.06, 0.08, 0.13), vec3(1.0, 0.995, 0.98), daylight);
    lit += vec3(0.30, 0.12, 0.02) * smoothstep(0.30, 0.0, abs(cosGeo)) * daylight;
    // thin cloud is translucent and thick cloud is not, so lean on the mask's
    // own gradient rather than pushing everything to full opacity
    float opacity = clamp(cover * cover * (0.35 + 1.15 * cover), 0.0, 1.0);
    color = mix(color, lit, opacity * (0.18 + 0.82 * daylight));
  }

  // --- warm terminator band and blue limb ---
  color += vec3(0.22, 0.08, 0.0) * smoothstep(0.25, 0.0, abs(cosGeo)) * daylight;
  float rim = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
  color += vec3(0.2, 0.45, 1.0) * rim * (0.25 + 0.55 * daylight);

  // Exposure lift for the enhanced look. The day term is gated on daylight,
  // so the night side keeps exactly the exposure it had — brightening it
  // further would wash out the city lights it exists to show — and space,
  // which this shader never draws, cannot be touched either way.
  color *= 1.0 + uBoost * (${f(G.exposure)} + ${f(G.dayExposure)} * daylight);

  fragColor = vec4(color, 1.0);
}
`

export interface GlobeSurfaceUrls {
  day: string
  night: string
  relief: string
  clouds: string
}

export class GlobeSurface {
  readonly material: ShaderMaterial
  private loader = new TextureLoader()
  private cache = new Map<string, Texture>()
  private maxAniso: number
  private maxTexture: number
  private urls!: GlobeSurfaceUrls
  /** Fires when the day map is decoded, which is when a globe can be shown. */
  onDayReady?: () => void
  private dayReady = false
  /** Ramps 0 to 1 as each deferred map arrives; see lib/mapFade.ts. */
  private fade = { night: 0, relief: 0, clouds: 0 }
  private landed = { night: false, relief: false, clouds: false }
  /** The settings these ramps are applied to, held so a frame can re-apply them. */
  private reliefStrength = 0.7
  private cloudSetting = { visible: false, opacity: 1, shadows: true }
  /** Set while the camera is moving, so the cloud upscale can wait for a lull. */
  private busy = false

  constructor(urls: GlobeSurfaceUrls, renderer: WebGLRenderer) {
    this.maxAniso = renderer.capabilities.getMaxAnisotropy()
    this.maxTexture = renderer.capabilities.maxTextureSize
    this.urls = urls
    // The one map the first frame cannot do without. The other three are
    // requested by `loadRest`, once there is a globe on screen to add them to —
    // see lib/mapFade.ts. An unbound sampler reads as transparent black in
    // three, which is exactly the right absence for all three of them: no city
    // lights, a flat height field, and no cloud cover.
    const day = this.texture(urls.day, 'color', () => this.dayLoaded())

    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uEraA: { value: day },
        uEraB: { value: day },
        uEraMix: { value: 0 },
        uNight: { value: null },
        uNightMix: { value: 0 },
        uRelief: { value: null },
        uClouds: { value: null },
        uDetail: { value: null },
        uDetailRect: { value: new Vector4(0, 0, 1, 1) },
        uDetailMix: { value: 0 },
        uDetailLod: { value: 4 },
        uDetailSize: { value: new Vector2(1024, 1024) },
        uSunDir: { value: new Vector3(1, 0, 0) },
        uLights: { value: 1 },
        uCloudRot: { value: 0 },
        uCloudAlpha: { value: 1 },
        uCloudShadow: { value: 0.5 },
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
      },
    })
  }

  /**
   * Loads once. Colour maps are sRGB; masks and height fields are data and must
   * stay linear, or their mid-tones get crushed. Anisotropy everywhere, since a
   * globe is mostly grazing angles.
   */
  texture(url: string, kind: 'color' | 'data' = 'color', onLoad?: (t: Texture) => void): Texture {
    let t = this.cache.get(url)
    if (!t) {
      t = this.loader.load(url, onLoad)
      if (kind === 'color') t.colorSpace = SRGBColorSpace
      t.anisotropy = this.maxAniso
      t.wrapS = RepeatWrapping
      this.cache.set(url, t)
    }
    return t
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
  }

  /**
   * Advance the arrival ramps by one frame.
   *
   * Driven from the render loop rather than from a timer so a backgrounded tab
   * does not fade three maps in while nobody is watching and then present the
   * result as a jump.
   */
  advance(dtMs: number) {
    const u = this.material.uniforms
    this.fade.night = fadeTowards(this.fade.night, this.landed.night ? 1 : 0, dtMs)
    this.fade.relief = fadeTowards(this.fade.relief, this.landed.relief ? 1 : 0, dtMs)
    this.fade.clouds = fadeTowards(this.fade.clouds, this.landed.clouds ? 1 : 0, dtMs)
    u.uNightMix.value = this.fade.night
    u.uRelief_.value = this.reliefStrength * this.fade.relief
    this.applyClouds()
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
    this.whenIdle(() => this.runCloudUpscale(url, t, img))
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
      sharper.anisotropy = this.maxAniso
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
      sharper.anisotropy = this.maxAniso
      sharper.wrapS = RepeatWrapping
      sharper.needsUpdate = true
      const previous = this.cache.get(url)
      this.cache.set(url, sharper)
      for (const key of ['uEraA', 'uEraB', 'uNight']) {
        if (this.material.uniforms[key].value === previous) {
          this.material.uniforms[key].value = sharper
        }
      }
      previous?.dispose()
    }
    img.onerror = () => {} // keep what we have
    img.src = betterUrl
  }

  setEra({ from, to, f }: TextureBlend) {
    const u = this.material.uniforms
    u.uEraA.value = this.texture(from)
    u.uEraB.value = this.texture(to)
    u.uEraMix.value = f
  }

  setSun(dir: Vector3) {
    this.material.uniforms.uSunDir.value.copy(dir).normalize()
  }

  setCityLights(f: number) {
    this.material.uniforms.uLights.value = f
  }

  setCloudDrift(seconds: number) {
    this.material.uniforms.uCloudRot.value = (seconds * 0.0016) % 1
  }

  /**
   * Point the shader at the streamed detail patch (null clears it).
   *
   * The texture's own size goes with it: the shader needs it to work out how
   * many patch texels each screen pixel covers, which is what decides every mip
   * level it samples. Reading it here, from the texture actually being bound,
   * is the only place it cannot disagree with what is on the GPU.
   */
  setDetail(
    map: Texture | null,
    rect: [number, number, number, number],
    mix: number,
    lod = 4,
  ) {
    const u = this.material.uniforms
    u.uDetail.value = map
    u.uDetailRect.value.set(...rect)
    u.uDetailMix.value = map ? mix : 0
    u.uDetailLod.value = lod
    const img = map?.image as { width?: number; height?: number } | undefined
    if (img?.width && img?.height) u.uDetailSize.value.set(img.width, img.height)
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
  }

  /** The cloud settings, scaled by however far the mask has faded in. */
  private applyClouds() {
    const { visible, opacity, shadows } = this.cloudSetting
    const f = this.fade.clouds
    const u = this.material.uniforms
    u.uCloudAlpha.value = visible ? opacity * f : 0
    u.uCloudShadow.value = visible && shadows ? 0.5 * opacity * f : 0
  }

  /** 0 = realistic lighting, 1 = enhanced (brighter day side, lifted night side). */
  setVisuals(boost: number) {
    this.material.uniforms.uBoost.value = boost
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
