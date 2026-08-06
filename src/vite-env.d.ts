/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

/**
 * The build stamp, substituted into the bundle by vite.config.ts.
 *
 * Constants rather than an import, so the value is in the same file as the code
 * it identifies and there is nothing to fetch, cache or get wrong. Read through
 * `BUILD` in lib/build.ts and nowhere else.
 */
declare const __BUILD_ID__: string
declare const __BUILD_AT__: string
