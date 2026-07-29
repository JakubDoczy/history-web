import {
  AdditiveBlending,
  BackSide,
  Mesh,
  MeshPhongMaterial,
  ShaderMaterial,
  SphereGeometry,
  TextureLoader,
  Vector3,
  type Scene,
} from 'three'

/** Clouds lit by the scene's sun, with a bump map so billows catch the light. */
export class CloudLayer {
  private mesh: Mesh<SphereGeometry, MeshPhongMaterial>

  constructor(scene: Scene, radius: number, mapUrl: string, bumpUrl: string) {
    const loader = new TextureLoader()
    this.mesh = new Mesh(
      new SphereGeometry(radius * 1.018, 96, 96),
      new MeshPhongMaterial({
        map: loader.load(mapUrl),
        bumpMap: loader.load(bumpUrl),
        bumpScale: 0.9,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        shininess: 3,
      }),
    )
    this.mesh.rotation.y = -Math.PI / 2
    scene.add(this.mesh)
  }

  /** Slow prevailing drift; `seconds` is elapsed wall time. */
  drift(seconds: number) {
    this.mesh.rotation.y = -Math.PI / 2 + seconds * 0.006
  }

  set visible(v: boolean) {
    this.mesh.visible = v
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.map?.dispose()
    this.mesh.material.bumpMap?.dispose()
    this.mesh.material.dispose()
  }
}

const atmoVertex = /* glsl */ `
varying vec3 vNormal;
varying vec3 vWorldNormal;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const atmoFragment = /* glsl */ `
uniform vec3 sunDir;
varying vec3 vNormal;
varying vec3 vWorldNormal;
void main() {
  // rim falloff: brightest at the limb, fading toward the centre of the disc
  float rim = pow(0.68 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.2);
  // sunlit air scatters; the night limb keeps only a trace
  float lit = smoothstep(-0.45, 0.35, dot(vWorldNormal, sunDir));
  vec3 color = mix(vec3(0.10, 0.20, 0.42), vec3(0.32, 0.56, 1.0), lit);
  gl_FragColor = vec4(color, 1.0) * clamp(rim, 0.0, 1.6) * (0.22 + 0.95 * lit);
}`

/** Outer shell of scattered light — the halo you see around Earth from orbit. */
export class AtmosphereLayer {
  private mesh: Mesh<SphereGeometry, ShaderMaterial>

  constructor(scene: Scene, radius: number) {
    this.mesh = new Mesh(
      new SphereGeometry(radius * 1.13, 64, 64),
      new ShaderMaterial({
        vertexShader: atmoVertex,
        fragmentShader: atmoFragment,
        uniforms: { sunDir: { value: new Vector3(1, 0, 0) } },
        side: BackSide,
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    )
    scene.add(this.mesh)
  }

  setSunDirection(dir: Vector3) {
    this.mesh.material.uniforms.sunDir.value.copy(dir).normalize()
  }

  set visible(v: boolean) {
    this.mesh.visible = v
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
