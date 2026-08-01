import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

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

  it('skips the night map tap before electrification', () => {
    const body = blockAfter(glsl, 'if (uLights > 0.0) {')
    expect(body).toContain('texture(uNight, vUv)')
  })

  it('leaves the city-light reveal exactly zero at uLights = 0', () => {
    // otherwise the gate above would change the picture: at the old 1.15 the
    // smoothstep window opened at 0.97, and the brightest lit texels still
    // leaked a couple of percent through a term that is meant to be absent
    const m = glsl.match(/float thresh = ([\d.]+) - uLights \* ([\d.]+);/)
    expect(m).toBeTruthy()
    const threshAt0 = Number(m![1])
    const window = Number(glsl.match(/smoothstep\(thresh - ([\d.]+), thresh \+/)![1])
    // the map's luminance is dot(rgb, vec3(0.333)), so it cannot exceed ~1
    expect(threshAt0 - window).toBeGreaterThanOrEqual(1)
    // and the lit end still reveals: at full electrification the window is open
    expect(threshAt0 - Number(m![2]) + window).toBeGreaterThan(0)
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
