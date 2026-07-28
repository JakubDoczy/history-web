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
void main() {
  vUv = uv;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const fragment = /* glsl */ `
uniform sampler2D dayTex;
uniform sampler2D nightTex;
uniform vec3 sunDir;
varying vec2 vUv;
varying vec3 vNormal;
void main() {
  float daylight = smoothstep(-0.12, 0.12, dot(vNormal, sunDir));
  vec3 day = texture2D(dayTex, vUv).rgb;
  vec3 night = texture2D(nightTex, vUv).rgb * 1.3; // let city lights glow
  gl_FragColor = vec4(mix(night, day, daylight), 1.0);
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
