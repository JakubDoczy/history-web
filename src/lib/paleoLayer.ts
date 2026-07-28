import {
  Mesh,
  MeshPhongMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  type Scene,
  type Texture,
} from 'three'
import type { TextureBlend } from './paleo'

/**
 * Crossfading paleo-globe: two texture spheres just above the base globe.
 * Sphere A shows the "from" era; sphere B fades in the "to" era with the blend
 * factor. When the blend reaches the modern texture, both hide and the base
 * globe (already modern) shows through.
 */
export class PaleoLayer {
  private loader = new TextureLoader()
  private cache = new Map<string, Texture>()
  private spheres: [Mesh<SphereGeometry, MeshPhongMaterial>, Mesh<SphereGeometry, MeshPhongMaterial>]

  constructor(scene: Scene, radius: number, private modernUrl: string) {
    this.spheres = ([1.005, 1.01] as const).map((scale) => {
      const mesh = new Mesh(
        new SphereGeometry(radius * scale, 80, 80),
        new MeshPhongMaterial({ transparent: true, depthWrite: false }),
      )
      mesh.rotation.y = -Math.PI / 2 // align equirectangular u=0 with lng 0, as three-globe does
      mesh.visible = false
      scene.add(mesh)
      return mesh
    }) as typeof this.spheres
  }

  private texture(url: string): Texture {
    let t = this.cache.get(url)
    if (!t) {
      t = this.loader.load(url)
      t.colorSpace = SRGBColorSpace
      this.cache.set(url, t)
    }
    return t
  }

  setBlend({ from, to, f }: TextureBlend) {
    const [a, b] = this.spheres
    if (from === this.modernUrl) {
      a.visible = b.visible = false // base globe is already the modern map
      return
    }
    a.visible = true
    a.material.map = this.texture(from)
    a.material.needsUpdate = true

    b.visible = f > 0 && to !== from
    if (b.visible) {
      b.material.map = this.texture(to)
      b.material.opacity = f
      b.material.needsUpdate = true
    }
  }

  dispose() {
    for (const s of this.spheres) {
      s.removeFromParent()
      s.geometry.dispose()
      s.material.dispose()
    }
    this.cache.forEach((t) => t.dispose())
  }
}
