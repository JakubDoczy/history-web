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

type CloudMesh = Mesh<SphereGeometry, MeshPhongMaterial>

/**
 * Two cloud decks lit by the scene's sun: the main deck carries a bump map so
 * billows catch the light, and a thin cirrus deck sits higher and drifts faster,
 * giving parallax as the globe turns.
 */
export class CloudLayer {
  private decks: { mesh: CloudMesh; speed: number }[]

  constructor(scene: Scene, radius: number, mapUrl: string, bumpUrl: string, cirrusUrl: string) {
    const loader = new TextureLoader()
    const deck = (scale: number, material: MeshPhongMaterial, speed: number) => {
      const mesh = new Mesh(new SphereGeometry(radius * scale, 96, 96), material) as CloudMesh
      mesh.rotation.y = -Math.PI / 2
      scene.add(mesh)
      return { mesh, speed }
    }
    this.decks = [
      deck(1.016, new MeshPhongMaterial({
        map: loader.load(mapUrl),
        bumpMap: loader.load(bumpUrl),
        bumpScale: 0.35,
        transparent: true,
        depthWrite: false,
        shininess: 0,
        specular: 0x000000,
      }), 0.016),
      deck(1.032, new MeshPhongMaterial({
        map: loader.load(cirrusUrl),
        transparent: true,
        depthWrite: false,
        shininess: 0,
        specular: 0x000000,
      }), 0.027),
    ]
  }

  /** Prevailing drift; `seconds` is elapsed wall time. */
  drift(seconds: number) {
    for (const d of this.decks) d.mesh.rotation.y = -Math.PI / 2 + seconds * d.speed
  }

  set visible(v: boolean) {
    for (const d of this.decks) d.mesh.visible = v
  }

  dispose() {
    for (const { mesh } of this.decks) {
      mesh.removeFromParent()
      mesh.geometry.dispose()
      mesh.material.map?.dispose()
      mesh.material.bumpMap?.dispose()
      mesh.material.dispose()
    }
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
