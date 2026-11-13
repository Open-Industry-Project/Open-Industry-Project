// A running program's value table arrives as a new object on every send, and holds the same keys for as long as the
// program is the same. Whatever is derived from the keys alone (a name index, a structure's members) is kept per key
// set, not per table: on a program that publishes half a million values, indexing them took ~830 ms per table.
//
// Whoever replaces the table says which key set the new one has (the sim client, from the worker's count of attached
// programs). A table nobody spoke for is its own key set, so its readers index it as they did before.

const keySets = new WeakMap<object, object>()

/** Say that `table` holds exactly the keys of the key set `set` (any object: it is only an identity). */
export function markKeySet(table: object, set: object): void {
  keySets.set(table, set)
}

/** The key set `table` belongs to: what {@link markKeySet} said, else the table itself. */
export function keySetOf(table: object): object {
  return keySets.get(table) ?? table
}

/** Was `table` given a key set by {@link markKeySet}? A reader with a cheaper test of its own uses it when not. */
export function hasKeySet(table: object): boolean {
  return keySets.has(table)
}

/** `table` with `key` set to `value`, in the same key set when the key was already there (a write shown at once). */
export function withWatchValue<V>(table: Readonly<Record<string, V>>, key: string, value: V): Record<string, V> {
  const next = { ...table, [key]: value }
  if (Object.hasOwn(table, key)) markKeySet(next, keySetOf(table))
  return next
}
