import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  CLOUD_DEPTH,
  NIGHT_LIGHTS,
  cloudFormSlope,
  cloudShading,
  cloudShadowDensity,
} from '../src/lib/globeSurface'

/**
 * Duplicate uniform declarations are a GLSL compile error, and a failed compile
 * renders the globe black with no console-visible clue in production. These
 * checks are cheap insurance against reintroducing that.
 */
const sources = ['src/lib/globeSurface.ts', 'src/lib/skyLayer.ts', 'src/lib/celestialLayer.ts']

const shaderBlocks = (src: string) =>
  [...src.matchAll(/\/\* glsl \*\/ `([\s\S]*?)`/g)].map((m) => m[1])

describe('shader hygiene', () => {
  it.each(sources)('%s declares each uniform exactly once', (file) => {
    for (const glsl of shaderBlocks(readFileSync(file, 'utf8'))) {
      const names = [...glsl.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)].map((m) => m[1])
      expect(names).toEqual([...new Set(names)])
    }
  })

  it.each(sources)('%s declares each varying exactly once', (file) => {
    for (const glsl of shaderBlocks(readFileSync(file, 'utf8'))) {
      for (const kw of ['in', 'out', 'varying']) {
        const names = [...glsl.matchAll(new RegExp(`^\\s*${kw}\\s+\\w+\\s+(\\w+)\\s*;`, 'gm'))].map((m) => m[1])
        expect(names).toEqual([...new Set(names)])
      }
    }
  })

  it('does not mix GLSL1 texture2D into GLSL3 sources', () => {
    const glsl3 = readFileSync('src/lib/globeSurface.ts', 'utf8')
    expect(glsl3).not.toMatch(/texture2D\s*\(/)
  })
})

/**
 * The streamed-patch block, which is where the reported colour shifts came
 * from. These are text checks on the GLSL because there is no GL in a unit
 * test, and every one of them stands for a bug that shipped.
 */
describe('detail patch shading', () => {
  const glsl = shaderBlocks(readFileSync('src/lib/globeSurface.ts', 'utf8')).join('\n')

  it('keeps none of the sharp sensor raw colour', () => {
    // uDetailTint mixed 12% of Sentinel-2 straight into the albedo, so the
    // greener, darker palette leaked through wherever a patch was shown
    expect(glsl).not.toMatch(/uDetailTint/)
  })

  it('matches colour on luminance, so a patch cannot move a hue', () => {
    // one scalar scales all three channels together; a per-channel ratio
    // transferred the other sensor's chroma as well
    expect(glsl).toMatch(/float k = clamp\(\(dot\(hi, luma\)/)
    expect(glsl).toMatch(/detailGain = mix\(1\.0, k,/)
  })

  it('applies the patch after the grade, not before it', () => {
    // the enhanced curve is concave through the land band, so pushing a
    // zero-mean modulation through it comes out with a negative mean: measured,
    // 7/255 of darkening inside the patch and a step at its edge
    const glsl = shaderBlocks(readFileSync('src/lib/globeSurface.ts', 'utf8')).join('\n')
    const grade = glsl.indexOf('float lumA = dot(albedo')
    const palette = glsl.indexOf('uPalette.z')
    const applied = glsl.indexOf('albedo * gain')
    expect(grade).toBeGreaterThan(0)
    expect(applied).toBeGreaterThan(palette)
    expect(palette).toBeGreaterThan(grade)
  })

  it('bounds how far a patch may push the ground', () => {
    // an unbounded ratio is a real reading over a snow line and also enough to
    // drive the graded highlights past white
    const m = glsl.match(/float k = clamp\([^;]*?,\s*([\d.]+),\s*([\d.]+)\)/)
    expect(m).toBeTruthy()
    expect(Number(m![1])).toBeGreaterThanOrEqual(0.5)
    expect(Number(m![2])).toBeLessThanOrEqual(2)
  })

  it('never point-samples the patch at mip 0 regardless of minification', () => {
    // an explicit level 0 on a minified texture is an aliased sample, and
    // dividing one by a blurred one turned highlights into dark smears
    expect(glsl).not.toMatch(/textureLod\(uDetail, dc, 0\.0\)/)
    expect(glsl).toMatch(/lodPix/)
  })

  it('never lets the blurred tap be sharper than the sharp one', () => {
    expect(glsl).toMatch(/float lodLo = max\(uDetailLod, lodPix\)/)
  })

  it('divides both taps by their own alpha', () => {
    // a composite is transparent where no cached patch reached, and the mip
    // chain averages that transparent black into the colour
    expect(glsl).toMatch(/det\.rgb \/ max\(det\.a/)
    expect(glsl).toMatch(/low\.rgb \/ max\(low\.a/)
  })

  it('softens the coverage edge instead of stepping at it', () => {
    expect(glsl).toMatch(/float cover = smoothstep\(/)
  })

  it('does not sample the second era map when nothing is crossfading', () => {
    // uEraMix is 0 for every time that is not between two paleo frames, which
    // is the whole modern era; the unconditional mix() cost a full-resolution
    // texture fetch per fragment per frame to blend by zero
    expect(glsl).toMatch(/vec3 albedo = texture\(uEraA, vUv\)\.rgb;/)
    expect(glsl).toMatch(/if \(uEraMix > 0\.0\) albedo = mix\(albedo, texture\(uEraB, vUv\)\.rgb, uEraMix\);/)
  })

  it('gates every optional tap on a uniform, never on a per-pixel value', () => {
    // sampling inside non-uniform control flow leaves the derivatives undefined,
    // which several mobile GPUs render as flicker; each of these conditions is
    // the same for every fragment in the draw
    for (const guard of ['if (uDetailMix > 0.0)', 'if (uEraMix > 0.0)', 'if (uCloudSharp <= 0.0)']) {
      expect(glsl).toContain(guard)
    }
    // and the cloud taps are behind the alpha that fades them out on approach,
    // so a close-up view pays for none of them
    expect(glsl).toContain('uCloudAlpha > 0.0 ? cloudMask(cloudUv) : 0.0')
  })
})

/**
 * Uniform-gated branches.
 *
 * Every one of these skips a texture tap (or four) for a state the globe is in
 * most of the time: no relief in deep time, no clouds close in or before the
 * Holocene, no city lights before electrification. They are asserted as text
 * because there is no GL here, and each is only *safe* because the condition is
 * a uniform — the same for every fragment in the draw, so the derivatives
 * inside stay defined.
 */
describe('uniform-gated taps', () => {
  const glsl = shaderBlocks(readFileSync('src/lib/globeSurface.ts', 'utf8')).join('\n')

  /** The body of the block introduced by `header`, by brace matching. */
  const blockAfter = (src: string, header: string): string => {
    const start = src.indexOf(header)
    expect(start, `missing: ${header}`).toBeGreaterThanOrEqual(0)
    let depth = 0
    let i = start + header.length - 1
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) break
    }
    return src.slice(start, i)
  }

  it('skips the four relief taps and the normal math when relief is off', () => {
    // ~19% of the fragment cost, and uRelief_ is 0 for every deep-time frame
    // (they carry their own hillshade), with the setting off, and for the first
    // 450 ms of every load while the height field fades in
    const body = blockAfter(glsl, 'if (uRelief_ > 0.0) {')
    for (const tap of ['hL', 'hR', 'hD', 'hU']) {
      expect(body).toContain(`float ${tap} = texture(uRelief`)
    }
    expect(body).toContain('nRelief = normalize(')
    // and with the branch not taken the normal is the plain geometric one
    expect(glsl).toContain('vec3 nRelief = n;')
  })

  it('skips the cloud parallax when no cloud film is drawn', () => {
    const body = blockAfter(glsl, 'if (uCloudAlpha > 0.0) {')
    expect(body).toContain('liftedView')
    expect(body).toContain('cloudUv = ')
  })

  it('skips both night map taps before electrification', () => {
    const body = blockAfter(glsl, 'if (uLights > 0.0) {')
    // the sharp tap and the wide one that spills the halo around it
    expect(body).toContain('texture(uNight, vUv)')
    expect(body).toContain('texture(uNight, vUv, ${f(N.haloLod)})')
  })

  it('leaves the city-light reveal exactly zero at uLights = 0', () => {
    // otherwise the gate above would change the picture. The guarantee is
    // structural rather than empirical now: the reveal runs on `q`, which is a
    // clamped 0..1 scale, so a window that opens above 1 cannot let anything
    // through whatever the map happens to contain. The previous form ran on the
    // map's raw luminance and *assumed* it reached 1 — it peaks at 0.215, which
    // is the bug this pair of assertions failed to catch.
    expect(glsl).toContain('clamp(max(eCore, eHalo) * ${f(1 / N.peak)}, 0.0, 1.0)')
    expect(glsl).toContain(
      'float thresh = ${f(N.threshAt0)} - ${f(N.span)} * pow(uLights, ${f(N.curve)});',
    )
    expect(glsl).toContain('smoothstep(thresh - ${f(N.edge)}, thresh + ${f(N.edge)}, q)')
    expect(NIGHT_LIGHTS.threshAt0 - NIGHT_LIGHTS.edge).toBeGreaterThanOrEqual(1)
    // and the lit end opens all the way: at full electrification the window's
    // top edge is at or below zero, so no lit texel is held back
    expect(NIGHT_LIGHTS.threshAt0 - NIGHT_LIGHTS.span + NIGHT_LIGHTS.edge).toBeLessThan(1e-9)
  })

  it('keeps the emissive term out of the albedo grade and the palette', () => {
    // city lights are emission, not reflectance: the enhanced luminance remap
    // and the user palette (0.75 saturation, 0.10 grayscale in the shipped
    // default) both describe how ground reflects sunlight, and pushing a sodium
    // lamp through them is how it comes out grey
    const grade = glsl.indexOf('float lumA = dot(albedo')
    const palette = glsl.indexOf('uPalette.z')
    const lights = glsl.indexOf('if (uLights > 0.0) {')
    expect(grade).toBeGreaterThan(0)
    expect(lights).toBeGreaterThan(palette)
    expect(palette).toBeGreaterThan(grade)
    // and nothing inside the block reads either of them back
    const body = blockAfter(glsl, 'if (uLights > 0.0) {')
    expect(body).not.toMatch(/uPalette|uBoost|albedo/)
  })

  it('never computes dirToUv of the surface normal', () => {
    // it is vec2(fract(vUv.x + 0.5), vUv.y) by construction — two atan/asin
    // pairs per fragment for a value the rasteriser already interpolated
    const code = glsl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code).not.toMatch(/dirToUv\(\s*n\s*\)/)
    expect(glsl).toContain('vec2 nUv = vec2(fract(vUv.x + 0.5), vUv.y);')
  })
})

/**
 * Cloud depth: the baked relief, the occlusion, the silver lining and the
 * thickness curve.
 *
 * The cues themselves can only be judged by eye, so what is pinned here is the
 * structure that made them safe and the conventions that would be silently
 * wrong if reversed — a cloud lit from the *wrong* side still looks like a
 * cloud in a screenshot, which is exactly why it needs a test.
 */
describe('cloud depth', () => {
  const glsl = shaderBlocks(readFileSync('src/lib/globeSurface.ts', 'utf8')).join('\n')

  const blockAfter = (src: string, header: string): string => {
    const start = src.indexOf(header)
    expect(start, `missing: ${header}`).toBeGreaterThanOrEqual(0)
    let depth = 0
    let i = start + header.length - 1
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) break
    }
    return src.slice(start, i)
  }

  it('takes the relief tap inside the uniform cloud gate', () => {
    // not inside `if (cover > 0.002)`, which is a per-pixel test: a texture
    // fetch under non-uniform control flow has undefined derivatives, and the
    // whole file's convention is that every optional tap hangs off a uniform
    const body = blockAfter(glsl, 'if (uCloudAlpha > 0.0) {')
    expect(body).toContain('vec3 bake = texture(uCloudNrm, cloudUv).rgb;')
    expect(body).toContain('cloudSlope = clamp(')
    // and the composite branch samples nothing
    const film = blockAfter(glsl, 'if (cover > 0.002) {')
    expect(film).not.toMatch(/texture\w*\(/)
  })

  it('replaces the two runtime finite differences with one tap', () => {
    // the whole point of scripts/bake_clouds.py: the mask's gradient is tiny
    // and a difference along one axis carries no shape across it, so the answer
    // is baked. Two textureLod taps of uClouds and the derivative machinery
    // that sized them are gone.
    expect(glsl).not.toMatch(/mSun|mAway|fwidth\(cloudUv\)/)
    expect(glsl).not.toMatch(/textureLod\(uClouds/)
    // exactly one tap in the whole gate, and it is the bake: the coverage mask
    // is read once more further down, by cloudMask(), and nowhere in here
    const body = blockAfter(glsl, 'if (uCloudAlpha > 0.0) {')
    expect(body.match(/texture\(uCloudNrm/g)).toHaveLength(1)
    expect(body).not.toMatch(/texture\(uClouds/)
  })

  it('reads the baked gradient as a slope along the ground, not along UV', () => {
    // equirectangular UV is anisotropic: a texel of u is cos(latitude) times
    // the arc of a texel of v. Without the division the relief would rotate
    // with latitude and Europe would be lit from a different side than the
    // Atlantic in the same frame.
    expect(glsl).toContain('vec3 cloudN = normalize(n - east * (grad.x / cosLat) - north * grad.y);')
    expect(glsl).toContain('float cosLat = max(sqrt(max(1.0 - n.y * n.y, 0.0)), 0.05);')
  })

  it('holds the deck flat until the baked map has actually decoded', () => {
    // an unbound sampler reads as transparent black in three, which decodes to
    // a full negative tilt in both axes — so this fade is a correctness guard
    // and not only a transition
    expect(glsl).toContain(
      'vec2 grad = (bake.xy * 2.0 - 1.0) * (uCloudNrmMix * ${f(C.normalRelief)});',
    )
    expect(glsl).toContain('cloudAO = mix(1.0, bake.z, uCloudNrmMix);')
  })

  it('agrees with the bake about how steep a full-deflection gradient is', () => {
    // the occlusion channel is a geometric measurement of the surface these
    // normals describe; baked for a different relief it darkens creases the
    // normals say are not there
    const py = readFileSync('scripts/bake_clouds.py', 'utf8')
    const m = py.match(/^SHADER_RELIEF = ([\d.]+)$/m)
    expect(m).toBeTruthy()
    expect(Number(m![1])).toBe(CLOUD_DEPTH.normalRelief)
  })

  it('leaves the whole cloud path at its defaults when no film is drawn', () => {
    // uCloudAlpha == 0 must be bit-identical to the pre-cloud picture: the
    // parallax block is skipped, so every value it would have set keeps the
    // neutral one declared here and `cover` is exactly 0
    expect(glsl).toContain('float cloudSlope = 0.0;')
    expect(glsl).toContain('float cloudAO = 1.0;')
    expect(glsl).toContain('uCloudAlpha > 0.0 ? cloudMask(cloudUv) : 0.0')
    // cloudShading with those defaults is exactly 1
    expect(cloudShading(0, 1, 1)).toBe(1)
    expect(cloudShading(0, 1, 0)).toBe(1)
  })

  it('gates the ground shadow on the uniform alone', () => {
    // it used to read `if (uCloudShadow > 0.0 && cosGeo > 0.03)` — a per-pixel
    // condition around a texture fetch, and a hard edge where daylight was
    // still above half
    expect(glsl).toContain('if (uCloudShadow > 0.0) {')
    expect(glsl).not.toMatch(/uCloudShadow > 0\.0 &&/)
    const body = blockAfter(glsl, 'if (uCloudShadow > 0.0) {')
    expect(body).toContain('smoothstep(${f(C.fadeLo)}, ${f(C.fadeHi)}, cosGeo)')
  })

  it('softens the shadow rather than sampling it sharp', () => {
    // a shadow crisper than the cloud casting it is the single most reliable
    // way to make the pair look pasted on
    const body = blockAfter(glsl, 'if (uCloudShadow > 0.0) {')
    expect(body).toContain('${f(C.shadowBlur)}).r')
  })

  it('darkens harder than it brightens', () => {
    // cloud tops sit near white, so there is far more room below than above;
    // symmetric gains clip on one side and do nothing on the other
    expect(CLOUD_DEPTH.shade).toBeGreaterThan(CLOUD_DEPTH.lit * 1.5)
    expect(cloudShading(1, 1, 1) - 1).toBeLessThan(1 - cloudShading(-1, 1, 1))
  })

  it('models the sunward face brighter and the far face darker', () => {
    expect(cloudShading(1, 1, 1)).toBeGreaterThan(1)
    expect(cloudShading(-1, 1, 1)).toBeLessThan(1)
    expect(cloudShading(0, 1, 1)).toBe(1)
    // and nothing at all on the night side, where there is no sun to model by
    expect(cloudShading(1, 1, 0)).toBe(1)
    expect(cloudShading(-1, 1, 0)).toBe(1)
  })

  it('models less with the sun overhead than with it side-on, on its own', () => {
    // no ambient fudge factor any more: a real normal gets this for free.
    // Straight down, a tilted face loses only the cosine of its own tilt; the
    // same face under a 60-degree sun swings much further either way.
    const tilt = 0.4 // radians, about the 90th percentile of the bake
    const overhead = cloudFormSlope(Math.cos(tilt), 1)
    const sideOn = cloudFormSlope(Math.cos(Math.PI / 3 - tilt), Math.cos(Math.PI / 3))
    expect(overhead).toBeLessThan(0) // a tilted face at the subsolar point loses
    expect(Math.abs(overhead)).toBeLessThan(Math.abs(sideOn))
  })

  it('switches the modelling off past a cloud\'s own terminator', () => {
    // both wrapped cosines bottom out together, so nothing is left to
    // differentiate — the alternative is inventing contrast on a face that is
    // receiving no light at all
    expect(cloudFormSlope(-1, -1)).toBe(0)
    expect(cloudFormSlope(-0.9, -1)).toBe(0)
    expect(cloudFormSlope(-1, -0.9)).toBe(0)
  })

  it('lights the face turned toward the sun and shades the one turned away', () => {
    const sun = Math.cos(Math.PI / 3)
    expect(cloudFormSlope(Math.cos(Math.PI / 3 - 0.4), sun)).toBeGreaterThan(0)
    expect(cloudFormSlope(Math.cos(Math.PI / 3 + 0.4), sun)).toBeLessThan(0)
    expect(cloudFormSlope(sun, sun)).toBe(0)
  })

  it('darkens the creases whatever the sun is doing', () => {
    // the cue N.L cannot produce: occlusion is about what stands around a
    // point, not which way it faces
    expect(cloudShading(0, 0.46, 1)).toBeLessThan(cloudShading(0, 1, 1))
    expect(cloudShading(0, 1, 1)).toBe(1)
    // and it is partial, because a cloud that took away half the sky also
    // filled it with something bright
    expect(cloudShading(0, 0, 1)).toBeGreaterThan(0.1)
    expect(CLOUD_DEPTH.ao).toBeLessThan(1)
    expect(glsl).toContain('lit *= mix(1.0, cloudAO, ${f(C.ao)});')
  })

  it('makes a thin veil cast far less shadow than a solid deck', () => {
    // a linear occlusion dropped a 20% grey patch on the sea for cover the film
    // itself barely showed, and those orphaned patches are most of why the
    // shadows read as their own painted layer
    expect(cloudShadowDensity(1)).toBeCloseTo(1, 6)
    expect(cloudShadowDensity(0)).toBe(0)
    expect(cloudShadowDensity(0.2)).toBeLessThan(0.2 * 0.6)
    // Gentler than the film's own opacity through the thin and middle range —
    // a shadow integrates through the whole depth of a cloud, not just across
    // its top, so a veil that is nearly invisible edge-on still darkens the sea
    // a little. The two cross over around 0.7, above which the film saturates
    // first, which is what keeps a solid deck from casting *more* than it hides.
    const filmOpacity = (c: number) => Math.min(1, c * c * (0.35 + 1.15 * c))
    for (const c of [0.2, 0.4, 0.6]) {
      expect(cloudShadowDensity(c)).toBeGreaterThan(filmOpacity(c))
    }
    expect(cloudShadowDensity(0.85)).toBeLessThan(filmOpacity(0.85))
    // and it is the curve the shader actually runs
    expect(glsl).toContain('float dense = occ * (${f(C.shadowKnee)} + ${f(1 - C.shadowKnee)} * occ);')
  })

  it('confines the silver lining to sunward slopes at the terminator', () => {
    // the old warm add ran on the terminator band alone, so it tinted every
    // cloud there the same — including the flanks facing away from the sun
    expect(glsl).toMatch(/max\(cloudSlope, 0\.0\) \*\s*\n?\s*smoothstep\(/)
  })
})

/**
 * The identity the shader now relies on, checked numerically against three's
 * own sphere parameterisation and three-globe's -90° globe rotation. If either
 * of those ever changes, the cloud layer would slide off the ground silently;
 * this fails instead.
 */
describe('dirToUv(n) == vec2(fract(vUv.x + 0.5), vUv.y)', () => {
  /** three's SphereGeometry, phiStart 0, thetaStart 0. */
  const sphere = (u: number, v: number) => ({
    // position
    x: -Math.cos(2 * Math.PI * u) * Math.sin(Math.PI * v),
    y: Math.cos(Math.PI * v),
    z: Math.sin(2 * Math.PI * u) * Math.sin(Math.PI * v),
    // the uv three writes for that vertex
    uv: [u, 1 - v] as [number, number],
  })
  /** three-globe rotates the globe mesh by -PI/2 about y. */
  const toWorld = (p: { x: number; y: number; z: number }) => ({ x: -p.z, y: p.y, z: p.x })
  /** the GLSL function, transcribed. */
  const dirToUv = (d: { x: number; y: number; z: number }): [number, number] => {
    const l = { x: d.z, y: d.y, z: -d.x }
    return [
      Math.atan2(l.z, -l.x) / (2 * Math.PI) + 0.5,
      0.5 + Math.asin(Math.max(-1, Math.min(1, l.y))) / Math.PI,
    ]
  }
  const fract = (x: number) => x - Math.floor(x)

  it('agrees everywhere off the poles', () => {
    for (let iu = 0; iu <= 24; iu++) {
      for (let iv = 1; iv <= 23; iv++) {
        const [u, v] = [iu / 24, iv / 24]
        const p = sphere(u, v)
        const [du, dv] = dirToUv(toWorld(p))
        expect(fract(du)).toBeCloseTo(fract(p.uv[0] + 0.5), 9)
        expect(dv).toBeCloseTo(p.uv[1], 9)
      }
    }
  })
})

describe('the area footprint cannot z-fight the map it sits on', () => {
  const src = readFileSync('src/components/GlobeView.vue', 'utf8')

  it('biases the polygon cap in depth-buffer units, not in height', () => {
    // The altitudes this globe uses are far finer than the depth buffer that
    // has to tell them apart: the area cap at 0.0014 R and the borders at
    // 0.0012 R are 1.3 km apart, against ~2.7 km for one step of a 24-bit
    // buffer at world view. Separation by height alone therefore resolves to
    // "whichever way it rounded", per pixel and per frame — the smear along an
    // area's edge that a pan drags across the screen. Polygon offset is in
    // depth-buffer units and so is right at every zoom.
    const cap = src.slice(src.indexOf('const capMaterial'), src.indexOf('capMaterials.set'))
    expect(cap).toMatch(/polygonOffset:\s*true/)
    expect(cap).toMatch(/polygonOffsetUnits:\s*-\d/)
    expect(cap).toMatch(/polygonOffsetFactor:\s*-\d/)
  })

  it('still lets the planet hide what is round the back', () => {
    // depthWrite off makes paint order renderOrder's business; depthTEST must
    // stay on, or a footprint in the Pacific shows through the Atlantic
    const cap = src.slice(src.indexOf('const capMaterial'), src.indexOf('capMaterials.set'))
    expect(cap).toMatch(/depthWrite:\s*false/)
    expect(cap).not.toMatch(/depthTest:\s*false/)
  })

  it('keeps the transition at zero, so a cap is never built coplanar', () => {
    expect(src).toContain('.polygonsTransitionDuration(0)')
  })
})
