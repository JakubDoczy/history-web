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
})
