import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * An absolute path, because the importers being redirected live in node_modules
 * and dev-mode prebundling resolves aliases with esbuild, which has no notion of
 * Vite's root-relative ids. `new URL(...).pathname` rather than
 * `fileURLToPath` so this needs no @types/node (see tsconfig.node.json).
 */
const stub = (name: string) => new URL(`./build/stubs/${name}.js`, import.meta.url).pathname

export default defineConfig({
  base: '/history-web/',
  plugins: [vue()],
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
