/**
 * The one piece of vocabulary every closed union in this codebase shares.
 *
 * It lives alone, in a module that imports nothing, for a reason that is
 * structural rather than tidy: `Time` (lib/time.ts) is a variant, and so is
 * `Feature` (lib/events.ts), and so is `Step`'s drawing — and lib/events.ts
 * imports lib/time.ts. Keeping the closer in either of them would make the
 * module graph a cycle the moment the *other* one needed it. Here it is
 * reachable from both and pulls nothing in behind it.
 *
 * `lib/events.ts` re-exports it, so every existing `import { assertNever } from
 * './events'` still reads the way the architecture note describes.
 */

/**
 * The closer on every `switch` over a variant. Unreachable by construction: if
 * it compiles, the switch was exhaustive, and if it ever runs the data lied
 * about its own discriminant.
 */
export function assertNever(x: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(x)}`)
}
