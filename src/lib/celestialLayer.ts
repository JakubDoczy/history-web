import {
  AdditiveBlending,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TextureLoader,
  type Scene,
} from 'three'
import { subsolarLongitude, moonLongitude, moonLatitude } from './sun'

type Coords = (lat: number, lng: number, alt: number) => { x: number; y: number; z: number }

const glowTexture = () => {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
  g.addColorStop(0, 'rgba(255,250,235,1)')
  g.addColorStop(0.2, 'rgba(255,242,205,0.55)')
  g.addColorStop(1, 'rgba(255,240,200,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  return new CanvasTexture(c)
}

/** Visible sun (glowing) and moon (lit by the sun, so phases emerge) orbiting the globe. */
export class CelestialLayer {
  private sun: Mesh<SphereGeometry, MeshBasicMaterial>
  private glow: Sprite
  private moon: Mesh<SphereGeometry, MeshPhongMaterial>

  // `radius` is a plain parameter, not a `private` field: everything it sizes is
  // sized once here, and nothing after construction asks how big the globe is.
  constructor(scene: Scene, radius: number, moonTextureUrl: string) {
    this.sun = new Mesh(
      new SphereGeometry(radius * 2.2, 32, 32),
      new MeshBasicMaterial({ color: 0xfff6e0 }),
    )
    this.glow = new Sprite(
      new SpriteMaterial({ map: glowTexture(), blending: AdditiveBlending, depthWrite: false }),
    )
    this.glow.scale.setScalar(radius * 11)
    this.moon = new Mesh(
      new SphereGeometry(radius * 0.27, 48, 48),
      new MeshPhongMaterial({ map: new TextureLoader().load(moonTextureUrl), shininess: 2 }),
    )
    scene.add(this.sun, this.glow, this.moon)
  }

  /**
   * Show or hide the whole layer.
   *
   * A sun and a moon in the frame are the same claim the starfield is — that
   * this is a photograph of a body in space — so map mode turns all three off
   * together (see `GlobeStyle.celestial`). Set on the objects rather than by
   * removing them from the scene, so the layer keeps one lifecycle.
   */
  set visible(on: boolean) {
    for (const o of [this.sun, this.glow, this.moon]) o.visible = on
  }

  setHour(hour: number, coords: Coords) {
    const sunLng = subsolarLongitude(hour)
    const s = coords(0, sunLng, 39) // far out along the subsolar direction
    this.sun.position.set(s.x, s.y, s.z)
    this.glow.position.copy(this.sun.position)

    const mLng = moonLongitude(hour)
    const m = coords(moonLatitude(mLng), mLng, 3.4)
    this.moon.position.set(m.x, m.y, m.z)
  }

  dispose() {
    for (const o of [this.sun, this.glow, this.moon]) o.removeFromParent()
    this.sun.geometry.dispose()
    this.sun.material.dispose()
    this.glow.material.map?.dispose()
    this.glow.material.dispose()
    this.moon.geometry.dispose()
    this.moon.material.map?.dispose()
    this.moon.material.dispose()
  }
}
