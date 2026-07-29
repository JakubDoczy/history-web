import {
  BackSide,
  Color,
  Data3DTexture,
  DataTexture,
  GLSL3,
  LinearFilter,
  Mesh,
  RGFormat,
  RedFormat,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Scene,
} from 'three'
import { CloudField } from './field'
import { buildNoiseVolume } from './noise3d'
import { cloudVertex, cloudFragment } from './shaders/cloud.glsl'

export interface CloudShellOptions {
  /** Raymarch steps through the shell, and steps toward the sun per sample. */
  viewSteps?: number
  lightSteps?: number
  /** Simulated seconds per real second. */
  simSpeed?: number
  seed?: number
}

/**
 * Volumetric cloud shell: a raymarched slab between two radii above the globe.
 * Shape comes from the simulated coverage field (the weather map) crossed with a
 * tileable Perlin–Worley volume; lighting is Beer–Lambert extinction along a
 * short march toward the sun, so clouds self-shadow and stay lit above a surface
 * that has already fallen into darkness.
 */
export class CloudShell {
  readonly field: CloudField
  private mesh: Mesh<SphereGeometry, ShaderMaterial>
  private weatherTex: DataTexture
  private noiseTex: Data3DTexture
  private alpha: Uint8Array
  private sinceUpload = 0
  private simSpeed: number

  constructor(scene: Scene, radius: number, opts: CloudShellOptions = {}) {
    const viewSteps = opts.viewSteps ?? 36
    const lightSteps = opts.lightSteps ?? 4
    this.simSpeed = opts.simSpeed ?? 4

    this.field = new CloudField({ width: 192, height: 96, seed: opts.seed ?? 1 })
    this.alpha = this.field.toAlpha()

    this.weatherTex = new DataTexture(this.alpha, this.field.width, this.field.height, RedFormat)
    this.weatherTex.wrapS = RepeatWrapping
    this.weatherTex.minFilter = this.weatherTex.magFilter = LinearFilter
    this.weatherTex.needsUpdate = true

    const size = 64
    this.noiseTex = new Data3DTexture(buildNoiseVolume(size, opts.seed ?? 1), size, size, size)
    this.noiseTex.format = RGFormat
    this.noiseTex.minFilter = this.noiseTex.magFilter = LinearFilter
    this.noiseTex.wrapS = this.noiseTex.wrapT = this.noiseTex.wrapR = RepeatWrapping
    this.noiseTex.needsUpdate = true

    const material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: cloudVertex,
      fragmentShader: cloudFragment,
      defines: { VIEW_STEPS: viewSteps, LIGHT_STEPS: lightSteps },
      uniforms: {
        uCenter: { value: new Vector3(0, 0, 0) },
        uRin: { value: radius * 1.014 },
        uRout: { value: radius * 1.055 },
        uRplanet: { value: radius * 1.008 },
        uSunDir: { value: new Vector3(1, 0, 0) },
        uSunColor: { value: new Color(1.0, 0.97, 0.92) },
        uWeather: { value: this.weatherTex },
        uNoise: { value: this.noiseTex },
        uTime: { value: 0 },
        uCoverage: { value: 1.15 },
        uDensity: { value: 1.0 },
      },
      transparent: true,
      depthWrite: false,
      // the march is already clipped at the planet surface, so depth testing would
      // only reject the back face we deliberately rasterise
      depthTest: false,
      premultipliedAlpha: true,
      side: BackSide, // exactly one fragment per pixel, camera inside or outside
    })

    // the mesh only has to cover the globe's disc, so the march is cheap compared
    // with a full-screen pass
    this.mesh = new Mesh(new SphereGeometry(radius * 1.056, 48, 48), material)
    this.mesh.renderOrder = 5
    scene.add(this.mesh)
  }

  private get u() {
    return this.mesh.material.uniforms
  }

  setSun(dir: Vector3) {
    this.u.uSunDir.value.copy(dir).normalize()
  }

  private visibleFlag = true
  private coverageScale = 1

  /** Fade clouds out in deep time, where they are anachronistic detail. */
  setCoverage(scale: number) {
    this.coverageScale = scale
    this.u.uCoverage.value = 1.15 * scale
    this.sync()
  }

  set visible(v: boolean) {
    this.visibleFlag = v
    this.sync()
  }

  private sync() {
    this.mesh.visible = this.visibleFlag && this.coverageScale > 0.01
  }

  /** Advance the simulation and animation; `dt` is real seconds. */
  update(dt: number) {
    this.u.uTime.value += dt
    this.sinceUpload += dt
    if (this.sinceUpload >= 0.2) {
      this.field.step(this.sinceUpload * this.simSpeed)
      this.field.toAlpha(this.alpha)
      this.weatherTex.needsUpdate = true
      this.sinceUpload = 0
    }
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.weatherTex.dispose()
    this.noiseTex.dispose()
  }
}
