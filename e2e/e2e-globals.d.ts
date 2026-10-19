// Scratch globals the e2e scripts stash on `window` inside page.evaluate bodies (`window.__bay`,
// `window.__lastFrame`, `window.__cleanshotHidden`, …). They are per-test state, not an app
// contract, so they must not read as hook drift - without this every one of them is a TS2339 and
// buries the errors that actually matter (a script reaching past IRenderView).
//
// Scoped to the `__`-prefixed namespace: a typo'd `window.foo` is still an error.
declare global {
  interface Window {
    [scratch: `__${string}`]: unknown
  }
}

export {}
