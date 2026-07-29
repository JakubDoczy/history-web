import {
  FrontSide,
  GLSL3,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  TextureLoader,
  Vector3,
  RepeatWrapping,
  type Scene,
  type Texture,
} from 'three'

const vertex = /* glsl */ `
out vec2 vUv;
out vec3 vNormalW;
void main() {
  vUv = uv;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const fragment = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec3 vNormalW;
out vec4 fragColor;

uniform sampler2D uMap;
uniform vec3 uSunDir;
uniform float uRot;      // longitudinal drift, in UV units
uniform float uOpacity;

void main() {
  float cover = texture(uMap, vec2(fract(vUv.x + uRot), vUv.y)).r;
  if (cover < 0.004) discard;

  float cosSun = dot(normalize(vNormalW), uSunDir);
  float day = smoothstep(-0.18, 0.22, cosSun);

  // sunlit cloud tops are near-white; the night side keeps only a faint blue cast
  vec3 col = mix(vec3(0.05, 0.07, 0.12), vec3(1.0, 0.995, 0.98), day);
  // warm band along the terminator, as in sunrise photographs from orbit
  col += vec3(0.30, 0.12, 0.02) * smoothstep(0.30, 0.0, abs(cosSun)) * day;

  // thin cloud is translucent; thick cloud is opaque. Night side barely registers.
  float alpha = cover * uOpacity * (0.16 + 0.84 * day);
  fragColor = vec4(col, alpha);
}
`

/**
 * Clouds as a thin film hugging the surface — the way they read from orbit.
 * The coverage mask is satellite-derived, so the fine filament structure is real
 * rather than invented; this layer only handles how sunlight falls on it.
 */
export class CloudLayer {
  private mesh: Mesh<SphereGeometry, ShaderMaterial>
  readonly texture: Texture

  constructor(scene: Scene, radius: number, mapUrl: string) {
    this.texture = new TextureLoader().load(mapUrl)
    this.texture.wrapS = RepeatWrapping

    this.mesh = new Mesh(
      new SphereGeometry(radius * 1.003, 128, 128), // barely above the ground
      new ShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: {
          uMap: { value: this.texture },
          uSunDir: { value: new Vector3(1, 0, 0) },
          uRot: { value: 0 },
          uOpacity: { value: 1 },
        },
        transparent: true,
        depthWrite: false,
        side: FrontSide,
      }),
    )
    this.mesh.rotation.y = -Math.PI / 2
    this.mesh.renderOrder = 2
    scene.add(this.mesh)
  }

  get rotation() {
    return this.mesh.material.uniforms.uRot.value as number
  }

  setSun(dir: Vector3) {
    this.mesh.material.uniforms.uSunDir.value.copy(dir).normalize()
  }

  /** Slow prevailing drift; `seconds` is elapsed wall time. */
  drift(seconds: number) {
    this.mesh.material.uniforms.uRot.value = (seconds * 0.0016) % 1
  }

  /** 0 hides the layer entirely (used to retire clouds in deep time). */
  setOpacity(v: number) {
    this.mesh.material.uniforms.uOpacity.value = v
    this.mesh.visible = this.on && v > 0.01
  }

  private on = true
  set visible(v: boolean) {
    this.on = v
    this.mesh.visible = v && (this.mesh.material.uniforms.uOpacity.value as number) > 0.01
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.texture.dispose()
  }
}
