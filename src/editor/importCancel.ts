// Cancelling a model or robot import. Each importer takes an AbortSignal and rejects with ImportCancelled when it
// aborts, so a caller can tell a stop the person asked for from a failure.

export class ImportCancelled extends Error {}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportCancelled()
}
