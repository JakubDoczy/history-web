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

/**
 * Where the sun and the moon are, and how big.
 *
 * True scale is not available: the moon is 60 Earth radii out and half a degree
 * across, and at this globe's on-screen size that is a body a few pixels wide
 * that nobody would read as a moon. So both are stylised — but the stylisation
 * that was here read as "not realistic" from the field, and the numbers say why.
 * The moon sat 4.4 radii out at 7.0 degrees of arc, thirteen times its real
 * angular size; the sun sat 40 radii out at 6.3 degrees, twelve times its own.
 * Two bodies that large and that near read as props hung just outside the
 * window, which is exactly the complaint.
 *
 * What is here now keeps the sun honest and spends the whole exaggeration
 * budget on the moon, which is the one that has to show a phase:
 *
 *  · the moon is ten radii out and 1.5 degrees across — still about three times
 *    life size, which at a 50 degree field of view on a 900 px viewport is a
 *    disc some 27 px tall: legibly a moon, with a terminator you can read, and
 *    plainly far away;
 *  · the sun is 120 radii out at 0.55 degrees, which is life size to within a
 *    rounding error. At that distance it is glare with a disc in it rather than
 *    a sphere in the scene, which is what a star at one astronomical unit looks
 *    like. The camera's far plane is 2.5x the sky radius, decades beyond this.
 */
const MOON_ALT = 9 // radii ABOVE the surface, so ten from the centre
const MOON_RADIUS = 0.131 // -> 2*atan(0.131/10) = 1.50 deg
const SUN_ALT = 119 // 120 from the centre
const SUN_RADIUS = 0.576 // -> 2*atan(0.576/120) = 0.55 deg, life size
const GLOW_SCALE = 33 // three times the old 11, for three times the distance

/** Visible sun (glowing) and moon (lit by the sun, so phases emerge) orbiting the globe. */
export class CelestialLayer {
  private sun: Mesh<SphereGeometry, MeshBasicMaterial>
  private glow: Sprite
  private moon: Mesh<SphereGeometry, MeshPhongMaterial>

  // `radius` is a plain parameter, not a `private` field: everything it sizes is
  // sized once here, and nothing after construction asks how big the globe is.
  constructor(scene: Scene, radius: number, moonTextureUrl: string) {
    this.sun = new Mesh(
      new SphereGeometry(radius * SUN_RADIUS, 32, 32),
      new MeshBasicMaterial({ color: 0xfff6e0 }),
    )
    this.glow = new Sprite(
      new SpriteMaterial({ map: glowTexture(), blending: AdditiveBlending, depthWrite: false }),
    )
    // A sprite is size-attenuated, so tripling the sun's distance would divide
    // its glare by three; the scale carries the same factor back.
    this.glow.scale.setScalar(radius * GLOW_SCALE)
    this.moon = new Mesh(
      new SphereGeometry(radius * MOON_RADIUS, 48, 48),
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
    const s = coords(0, sunLng, SUN_ALT) // far out along the subsolar direction
    this.sun.position.set(s.x, s.y, s.z)
    this.glow.position.copy(this.sun.position)

    const mLng = moonLongitude(hour)
    const m = coords(moonLatitude(mLng), mLng, MOON_ALT)
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
