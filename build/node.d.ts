/**
 * The few Node globals the build config actually reaches for.
 *
 * This project carries no @types/node on purpose (see tsconfig.node.json): it
 * pulls a second, conflicting copy of the DOM-adjacent globals into a config
 * that is type-checked alongside a browser app, and it is a dependency the
 * whole repository needs for two function signatures. So the two are declared
 * here, minimally and by hand, and `vue-tsc -b` checks vite.config.ts against
 * them like anything else.
 */
declare module 'node:child_process' {
  export function execSync(
    command: string,
    options?: { encoding?: string; stdio?: unknown; cwd?: string },
  ): string
}
