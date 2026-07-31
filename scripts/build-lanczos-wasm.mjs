/**
 * Compiles scripts/wasm/lanczos.c to WebAssembly and writes the bytes, base64
 * encoded, into src/lib/lanczosBinary.ts.
 *
 * The generated file is committed. A normal `npm run build` therefore needs no
 * clang, no wasm toolchain and no new dependency — the module is ~1 kB of
 * base64 inlined into the bundle, which is why it is worth embedding rather
 * than fetching a second asset.
 *
 *   node scripts/build-lanczos-wasm.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const src = resolve(here, 'wasm/lanczos.c')
const out = resolve(here, 'wasm/lanczos.wasm')

execFileSync('clang', [
  '--target=wasm32',
  '-O3',
  '-msimd128',
  '-flto',
  '-nostdlib',
  '-ffreestanding',
  '-Wl,--no-entry',
  '-Wl,--export-dynamic',
  '-Wl,--lto-O3',
  '-Wl,-z,stack-size=65536',
  '-o',
  out,
  src,
])

const bytes = readFileSync(out)
rmSync(out)
const b64 = bytes.toString('base64')

writeFileSync(
  resolve(root, 'src/lib/lanczosBinary.ts'),
  `/**
 * GENERATED — do not edit. See scripts/build-lanczos-wasm.mjs.
 *
 * scripts/wasm/lanczos.c compiled for wasm32, base64 encoded (${bytes.length} bytes).
 */
export const LANCZOS_WASM_BASE64 =
  '${b64}'
`,
)

console.log(`lanczos.wasm: ${bytes.length} bytes -> src/lib/lanczosBinary.ts`)
