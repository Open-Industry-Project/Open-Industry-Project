/** A failure of a harness or its environment rather than of what it tests: the scripts exit 2 for it, not 1. */
export class HarnessError extends Error {}
