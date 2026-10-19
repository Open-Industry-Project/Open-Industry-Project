// Ambient declaration of the `definePart` global the OIP runtime injects into every part script.
//
// Part scripts are IMPORT-FREE: the runtime provides `definePart` (see src/sim/embeddedBehavior.ts),
// so a behavior.js just calls it at top level. This declaration makes that global type-check AND - via
// contextual typing of the object literal argument - gives `ctx` full autocomplete with NO import in
// the script itself. index.d.ts triple-slash-references this file, so it loads automatically for any
// consumer of `@oip/part-sdk`.
//
// The global is typed AS the generated `DefinePart` alias (not a hand-copied signature) so the two can
// never drift: when partApi.ts grows a type parameter (as happened with lamps' `L`), regenerating
// index.d.ts updates this declaration automatically.
import type { DefinePart } from './index'

declare global {
  /**
   * Register this script's custom-part behavior. The runtime calls it once when the script loads.
   * Pass the param schema inline and
   * `ctx.params` is typed from it - e.g. `params: { speed: { type: 'number', ... } }` makes
   * `ctx.params.speed` a `number`, not a loose union. Declared `joints`/`grippers`/`lamps`/`servos` names type
   * the matching `ctx` bags the same way.
   */
  const definePart: DefinePart
}

export {}
