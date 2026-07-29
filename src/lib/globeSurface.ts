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
uniform vec3 uSunDir;
uniform float uLights;        // electrification, 0..1
uniform float uCloudRot;      // cloud drift, in UV units
uniform float uCloudAlpha;    // 0 hides clouds
uniform float uCloudShadow;
uniform float uCloudH;      // cloud deck height, in globe radii
uniform float uRelief_;       // relief strength
uniform vec2 uTexel;          // 1 / relief texture size
uniform float uFlatLight;     // 1 = ignore the terminator (close-up imagery is already lit)

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
  float lambert = mix(clamp(cosSun * 0.65 + 0.45, 0.0, 1.3), 1.0, uFlatLight);

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
    vec2 f = smoothstep(vec2(0.0), vec2(0.07), d) * (1.0 - smoothstep(vec2(0.93), vec2(1.0), d));
    // the patch carries its own alpha: any tile that failed to load stays
    // transparent, so the base map shows through instead of a black hole
    vec4 det = textureLod(uDetail, clamp(d, 0.0, 1.0), 0.0);
    albedo = mix(albedo, det.rgb, inside.x * inside.y * f.x * f.y * uDetailMix * det.a);
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
  vec3 night = surface * vec3(0.05, 0.07, 0.12) + rawNight * 1.6 * reveal;

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
    const relief = this.texture(urls.relief, 'data')
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
        uSunDir: { value: new Vector3(1, 0, 0) },
        uLights: { value: 1 },
        uCloudRot: { value: 0 },
        uCloudAlpha: { value: 1 },
        uCloudShadow: { value: 0.5 },
        uCloudH: { value: 0.012 },
        uRelief_: { value: 0.7 },
        uTexel: { value: new Vector2(1 / 4096, 1 / 2048) },
        uFlatLight: { value: 0 },
      },
    })
  }

  /**
   * Loads once. Colour maps are sRGB; masks and height fields are data and must
   * stay linear, or their mid-tones get crushed. Anisotropy everywhere, since a
   * globe is mostly grazing angles.
   */
  texture(url: string, kind: 'color' | 'data' = 'color'): Texture {
    let t = this.cache.get(url)
    if (!t) {
      t = this.loader.load(url)
      if (kind === 'color') t.colorSpace = SRGBColorSpace
      t.anisotropy = this.maxAniso
      t.wrapS = RepeatWrapping
      this.cache.set(url, t)
    }
    return t
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
  setDetail(map: Texture | null, rect: [number, number, number, number], mix: number) {
    const u = this.material.uniforms
    u.uDetail.value = map
    u.uDetailRect.value.set(...rect)
    u.uDetailMix.value = map ? mix : 0
  }

  /**
   * How far to suppress the terminator. Close up, the imagery carries its own
   * lighting and a day/night boundary crossing the view just looks wrong.
   */
  setFlatLight(v: number) {
    this.material.uniforms.uFlatLight.value = v
  }

  setClouds(visible: boolean, opacity = 1) {
    const u = this.material.uniforms
    u.uCloudAlpha.value = visible ? opacity : 0
    u.uCloudShadow.value = visible ? 0.5 * opacity : 0
  }

  dispose() {
    this.cache.forEach((t) => t.dispose())
    this.material.dispose()
  }
}
