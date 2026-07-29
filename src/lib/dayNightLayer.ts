import {
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  TextureLoader,
  Vector3,
  type Scene,
  type Texture,
} from 'three'

const vertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
  vUv = uv;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const fragment = /* glsl */ `
uniform sampler2D dayTex;
uniform sampler2D nightTex;
uniform sampler2D cloudTex;
uniform vec3 sunDir;
uniform float lightsF;    // 0 = pre-electric era, 1 = fully lit present
uniform float cloudRot;   // must match the cloud layer's drift
uniform float cloudShadow;// 0 = no shadows
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;

const float PI_ = 3.14159265;

/** Direction to equirectangular UV (same convention as the sphere's own UVs). */
vec2 dirToUv(vec3 d) {
  vec3 l = vec3(d.z, d.y, -d.x);
  return vec2(atan(l.z, -l.x) / (2.0 * PI_) + 0.5, 0.5 + asin(clamp(l.y, -1.0, 1.0)) / PI_);
}

void main() {
  float cosSun = dot(vNormal, sunDir);
  float daylight = smoothstep(-0.18, 0.22, cosSun);
  vec3 day = texture2D(dayTex, vUv).rgb;
  vec3 nightRaw = texture2D(nightTex, vUv).rgb;

  // city lights reveal from the brightest cores outward as lightsF grows;
  // threshold sweeps the actual luminance range of city pixels (~0.5 → 0)
  float lum = dot(nightRaw, vec3(0.333));
  float th = 0.5 * (1.0 - lightsF);
  float reveal = smoothstep(th, th + 0.12, lum);
  vec3 moonlit = day * vec3(0.05, 0.07, 0.12);
  vec3 night = moonlit + nightRaw * 1.6 * (0.4 + 0.6 * lightsF) * reveal;

  vec3 color = mix(night, day, daylight);

  // Clouds cast shadows: follow the sun ray from this point up to cloud altitude
  // and sample the coverage there. The offset is taken as a *difference* of UVs,
  // so it stays correct regardless of the texture's absolute orientation, and it
  // lengthens naturally as the sun drops toward the horizon.
  if (cloudShadow > 0.0 && cosSun > 0.03) {
    vec3 n = normalize(vNormal);
    vec3 up = n + sunDir * (0.02 / max(cosSun, 0.18));
    vec2 duv = dirToUv(normalize(up)) - dirToUv(n);
    duv.x -= (abs(duv.x) > 0.5) ? sign(duv.x) : 0.0; // cross the seam cleanly
    float occ = texture2D(cloudTex, vec2(fract(vUv.x + duv.x + cloudRot), clamp(vUv.y + duv.y, 0.0, 1.0))).r;
    color *= 1.0 - occ * cloudShadow * daylight;
  }

  // warm sunrise/sunset band along the terminator
  float twilight = smoothstep(0.25, 0.0, abs(cosSun)) * daylight;
  color += vec3(0.25, 0.09, 0.0) * twilight;

  // soft blue atmospheric rim, stronger on the day side
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float rim = pow(1.0 - max(dot(viewDir, vNormal), 0.0), 3.0);
  color += vec3(0.2, 0.45, 1.0) * rim * (0.25 + 0.55 * daylight);

  gl_FragColor = vec4(color, 1.0);
}`

/** Modern globe with sun-driven day/night terminator and city lights at night. */
export class DayNightLayer {
  private mesh: Mesh<SphereGeometry, ShaderMaterial>

  constructor(scene: Scene, radius: number, dayUrl: string, nightUrl: string) {
    const loader = new TextureLoader()
    this.mesh = new Mesh(
      new SphereGeometry(radius * 1.002, 80, 80),
      new ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: {
          dayTex: { value: loader.load(dayUrl) },
          nightTex: { value: loader.load(nightUrl) },
          sunDir: { value: new Vector3(1, 0, 0) },
          lightsF: { value: 1 },
          cloudTex: { value: null },
          cloudRot: { value: 0 },
          cloudShadow: { value: 0 },
        },
      }),
    )
    this.mesh.rotation.y = -Math.PI / 2
    scene.add(this.mesh)
  }

  setSunDirection(dir: Vector3) {
    this.mesh.material.uniforms.sunDir.value.copy(dir).normalize()
  }

  setCityLights(f: number) {
    this.mesh.material.uniforms.lightsF.value = f
  }

  /** Feed the cloud coverage map so the surface picks up cloud shadows. */
  setClouds(map: Texture | null, rotation: number, strength: number) {
    const u = this.mesh.material.uniforms
    u.cloudTex.value = map
    u.cloudRot.value = rotation
    u.cloudShadow.value = map ? strength : 0
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
