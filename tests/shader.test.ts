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
