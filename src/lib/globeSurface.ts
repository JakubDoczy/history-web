import {
  GLSL3,
  ShaderMaterial,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  RepeatWrapping,
  type Texture,
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
uniform vec3 uSunDir;
uniform float uLights;        // electrification, 0..1
uniform float uCloudRot;      // cloud drift, in UV units
uniform float uCloudAlpha;    // 0 hides clouds
uniform float uCloudShadow;
uniform float uRelief_;       // relief strength
uniform vec2 uTexel;          // 1 / relief texture size

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
  float daylight = smoothstep(-0.18, 0.22, cosGeo);
  float lambert = clamp(cosSun * 0.65 + 0.45, 0.0, 1.3);

  // --- surface: crossfade between two era textures (both are the modern map today) ---
  vec3 surface = mix(texture(uEraA, vUv).rgb, texture(uEraB, vUv).rgb, uEraMix) * lambert;

  // --- cloud shadows: follow the sun ray up to cloud altitude and sample there ---
  float cloudUvX = fract(vUv.x + uCloudRot);
  if (uCloudShadow > 0.0 && cosGeo > 0.03) {
    vec3 lifted = normalize(n + uSunDir * (0.02 / max(cosGeo, 0.18)));
    vec2 duv = dirToUv(lifted) - dirToUv(n);
    duv.x -= (abs(duv.x) > 0.5) ? sign(duv.x) : 0.0;   // cross the seam cleanly
    float occ = texture(uClouds, vec2(fract(cloudUvX + duv.x), clamp(vUv.y + duv.y, 0.0, 1.0))).r;
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
  float cover = texture(uClouds, vec2(cloudUvX, vUv.y)).r * uCloudAlpha;
  if (cover > 0.002) {
    vec3 lit = mix(vec3(0.06, 0.08, 0.13), vec3(1.0, 0.995, 0.98), daylight);
    lit += vec3(0.30, 0.12, 0.02) * smoothstep(0.30, 0.0, abs(cosGeo)) * daylight;
    color = mix(color, lit, clamp(cover * (0.18 + 0.82 * daylight), 0.0, 1.0));
  }

  // --- warm terminator band and blue limb ---
  color += vec3(0.22, 0.08, 0.0) * smoothstep(0.25, 0.0, abs(cosGeo)) * daylight;
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
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
        uSunDir: { value: new Vector3(1, 0, 0) },
        uLights: { value: 1 },
        uCloudRot: { value: 0 },
        uCloudAlpha: { value: 1 },
        uCloudShadow: { value: 0.5 },
        uRelief_: { value: 0.7 },
        uTexel: { value: new Vector2(1 / 4096, 1 / 2048) },
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
