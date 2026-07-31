import {
  GLSL3,
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
uniform sampler2D uRelief;    // topography, used as a height field
uniform sampler2D uClouds;    // cloud coverage mask
uniform sampler2D uDetail;    // streamed high-resolution patch over the viewed region
uniform vec4 uDetailRect;     // u0, v0, du, dv of that patch
uniform float uDetailMix;
uniform float uDetailLod;    // mip level whose blur matches the base map
uniform float uDetailTint;   // how much of the sharp source's own colour to keep
uniform vec3 uSunDir;
uniform float uLights;        // electrification, 0..1
uniform float uCloudRot;      // cloud drift, in UV units
uniform float uCloudAlpha;    // 0 hides clouds
uniform float uCloudShadow;
uniform float uCloudH;      // cloud deck height, in globe radii
uniform float uRelief_;       // relief strength
uniform vec2 uTexel;          // 1 / relief texture size
uniform float uFlatLight;     // 1 = ignore the terminator (close-up imagery is already lit)
uniform float uBoost;         // 0 = realistic lighting, 1 = enhanced (brighter, lifted shadows)
uniform vec3 uPalette;        // experimental grade: saturation, grayscale, contrast

const float PI = 3.14159265;

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
  vec3 albedo = mix(texture(uEraA, vUv).rgb, texture(uEraB, vUv).rgb, uEraMix);

  // --- high-resolution patch, feathered at its edges so the join is invisible ---
  // uDetailMix is uniform across the draw, so branching on it is safe. Branching
  // on the per-pixel test is not: sampling a texture inside non-uniform control
  // flow leaves the derivatives undefined, which several mobile GPUs render as
  // flicker or dropouts. So the patch is sampled unconditionally with an
  // explicit LOD, and the region test becomes a weight instead of a branch.
  if (uDetailMix > 0.0) {
    vec2 d = (vUv - uDetailRect.xy) / uDetailRect.zw;
    vec2 inside = step(vec2(0.0), d) * step(d, vec2(1.0));
    // a wide feather, and never a full replacement: the sharp source is a
    // different sensor with a different palette, and blending most of the way
    // keeps its detail while holding the base map's colour
    vec2 f = smoothstep(vec2(0.0), vec2(0.08), d) * (1.0 - smoothstep(vec2(0.92), vec2(1.0), d));
    // the patch carries its own alpha: any tile that failed to load stays
    // transparent, so the base map shows through instead of a black hole
    vec2 dc = clamp(d, 0.0, 1.0);
    vec4 det = textureLod(uDetail, dc, 0.0);
    // a blurred copy of the patch, matched to the base map's own sharpness
    vec3 detLow = textureLod(uDetail, dc, uDetailLod).rgb;

    // Colour matching: dividing the patch by its blurred self leaves only the
    // structure the base map is missing. Multiplying that onto the base map's
    // colour adopts Sentinel-2's detail while keeping NASA's palette, so the
    // two cannot disagree on hue no matter how the sensors differ.
    const vec3 guard = vec3(0.05);
    vec3 matched = albedo * (det.rgb + guard) / (detLow + guard);
    matched = clamp(mix(matched, det.rgb, uDetailTint), 0.0, 1.5);

    albedo = mix(albedo, matched, inside.x * inside.y * f.x * f.y * uDetailMix * det.a);
  }

  // Enhanced grades the albedo itself: a luminance remap (see ENHANCED_GRADE)
  // plus a chroma lift. Graded before lighting so coastlines, vegetation and
  // desert separate clearly without blowing out the lit side. Applied after the
  // detail patch so the streamed imagery gets the same treatment.
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

  // --- palette lab: saturation, grayscale, contrast, after the grade above ---
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
  vec3 rawNight = texture(uNight, vUv).rgb;
  float lum = dot(rawNight, vec3(0.333));
  float thresh = 1.15 - uLights * 1.25;
  float reveal = smoothstep(thresh - 0.18, thresh + 0.18, lum);
  vec3 night = surface * vec3(0.05, 0.07, 0.12) * (1.0 + 2.2 * uBoost) + rawNight * 1.6 * reveal;

  vec3 color = mix(night, surface, daylight);

  // --- clouds, composited as the thin film they are ---
  float cover = texture(uClouds, cloudUv).r * uCloudAlpha;
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

  constructor(urls: GlobeSurfaceUrls, renderer: WebGLRenderer) {
    this.maxAniso = renderer.capabilities.getMaxAnisotropy()
    const day = this.texture(urls.day)
    const night = this.texture(urls.night)
    // The relief map is not the same size as the colour maps (2048×1024 against
    // 4096×2048), so its texel step has to come from the image itself. Stepping
    // by the colour map's texel takes the finite difference over half a texel
    // and halves every slope — terrain that is lit, but only half as much as the
    // strength setting says.
    const relief = this.texture(urls.relief, 'data', (t) => this.setReliefTexel(t))
    const clouds = this.texture(urls.clouds, 'data')

    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uEraA: { value: day },
        uEraB: { value: day },
        uEraMix: { value: 0 },
        uNight: { value: night },
        uRelief: { value: relief },
        uClouds: { value: clouds },
        uDetail: { value: null },
        uDetailRect: { value: new Vector4(0, 0, 1, 1) },
        uDetailMix: { value: 0 },
        uDetailLod: { value: 4 },
        uDetailTint: { value: 0.12 },
        uSunDir: { value: new Vector3(1, 0, 0) },
        uLights: { value: 1 },
        uCloudRot: { value: 0 },
        uCloudAlpha: { value: 1 },
        uCloudShadow: { value: 0.5 },
        uCloudH: { value: 0.012 },
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

  /** Point the shader at the streamed detail patch (null clears it). */
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
  }

  /**
   * How far to suppress the terminator. Close up, the imagery carries its own
   * lighting and a day/night boundary crossing the view just looks wrong.
   */
  setFlatLight(v: number) {
    this.material.uniforms.uFlatLight.value = v
  }

  setClouds(visible: boolean, opacity = 1, shadows = true) {
    const u = this.material.uniforms
    u.uCloudAlpha.value = visible ? opacity : 0
    u.uCloudShadow.value = visible && shadows ? 0.5 * opacity : 0
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
    this.material.uniforms.uRelief_.value = strength
  }

  dispose() {
    this.cache.forEach((t) => t.dispose())
    this.material.dispose()
  }
}
