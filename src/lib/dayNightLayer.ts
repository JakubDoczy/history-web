import {
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  TextureLoader,
  Vector3,
  type Scene,
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
uniform vec3 sunDir;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
  float cosSun = dot(vNormal, sunDir);
  float daylight = smoothstep(-0.18, 0.22, cosSun);
  vec3 day = texture2D(dayTex, vUv).rgb;
  vec3 night = texture2D(nightTex, vUv).rgb * 1.5; // let city lights glow
  vec3 color = mix(night, day, daylight);

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
        },
      }),
    )
    this.mesh.rotation.y = -Math.PI / 2
    scene.add(this.mesh)
  }

  setSunDirection(dir: Vector3) {
    this.mesh.material.uniforms.sunDir.value.copy(dir).normalize()
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
