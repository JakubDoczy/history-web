import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { execSync } from 'node:child_process'

/**
 * An absolute path, because the importers being redirected live in node_modules
 * and dev-mode prebundling resolves aliases with esbuild, which has no notion of
 * Vite's root-relative ids. `new URL(...).pathname` rather than
 * `fileURLToPath` so this needs no @types/node (see tsconfig.node.json).
 */
const stub = (name: string) => new URL(`./build/stubs/${name}.js`, import.meta.url).pathname

/**
 * THE BUILD STAMP — one identity, in the bundle AND beside it.
 *
 * GitHub Pages serves index.html with a ten-minute max-age and mobile browsers
 * keep an SPA tab alive for days, so "I deployed it" and "the device is running
 * it" are two different facts and there was no way to tell them apart: a reader
 * describing a bug two rounds old and a reader describing a live one wrote the
 * same sentence. Everything downstream of that — the settings footer that names
 * the build, the toast that offers a reload, the line deploy.sh prints — is a
 * reading of the pair emitted here.
 *
 * It is emitted TWICE ON PURPOSE, from one value:
 *
 *  · into the JavaScript, as `__BUILD_ID__` / `__BUILD_AT__`, which is what the
 *    running tab *is*. Nothing can fetch it, cache it or get it wrong: it was
 *    compiled into the same file as the code it describes.
 *  · into `version.json` beside index.html, which is what the SERVER has. It is
 *    a 60-byte file, so it can be fetched with `cache: 'no-store'` and a
 *    cache-busting query as often as is polite.
 *
 * The two differing is the whole signal, and it means exactly one thing: the
 * tab is running a build the server has replaced. See src/lib/build.ts.
 *
 * The hash is the commit; the timestamp is the build. Both are needed — a
 * rebuild of a dirty tree has the commit of the last one, and that is precisely
 * the case where a stale device is hardest to spot.
 */
function gitShort(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // A tarball, a shallow checkout, no git at all: the stamp still has to
    // exist, because the mechanism that reads it must not need a repository.
    return 'nogit'
  }
}

/** The two of Node's http shapes the dev middleware below actually touches. */
interface DevReq {
  url?: string
}
interface DevRes {
  setHeader(name: string, value: string): void
  end(body: string): void
}

function buildStamp(): Plugin {
  const id = gitShort()
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const json = `${JSON.stringify({ id, at })}\n`
  return {
    name: 'history-web:build-stamp',
    config: () => ({
      define: { __BUILD_ID__: JSON.stringify(id), __BUILD_AT__: JSON.stringify(at) },
    }),
    // Dev serves it too, so the update check is the same code path in both
    // modes — a mechanism that only exists in the build is a mechanism nothing
    // exercises until it is too late to find out it is wrong.
    configureServer(server) {
      const serve = (req: DevReq, res: DevRes, next: () => void) => {
        if (!req.url || !req.url.split('?')[0].endsWith('/version.json')) return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(json)
      }
      // Connect types its handlers in terms of Node's http shapes, which this
      // project has no @types/node for (tsconfig.node.json). The three fields
      // actually touched are declared above instead of pulling that dependency
      // in for one middleware.
      ;(server.middlewares.use as (fn: typeof serve) => void)(serve)
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: json })
    },
  }
}

export default defineConfig({
  base: '/history-web/',
  plugins: [vue(), buildStamp()],
  resolve: {
    /**
     * globe.gl's three-globe imports three subsystems unconditionally that no
     * layer this app enables can reach: H3 (the hex-bin layers), and the WebGPU
     * renderer plus the TSL node language behind its compute heatmap. Measured,
     * they were 196 kB brotli of a 515 kB bundle — a third of the JavaScript for
     * code that cannot run.
     *
     * The stubs throw a named error naming the alias to delete, so enabling one
     * of those layers later fails loudly rather than silently — see
     * build/stubs/README.md.
     */
    alias: [
      { find: 'h3-js', replacement: stub('h3-js') },
      { find: 'three/webgpu', replacement: stub('three-webgpu') },
      { find: 'three/tsl', replacement: stub('three-tsl') },
    ],
  },
})
