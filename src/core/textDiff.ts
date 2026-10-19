// The one span where two texts differ. Shared by the ST editor, which applies a program edit outside its own history,
// and a room's shared program text, whose replacement should leave a peer's typing elsewhere alone: both want the
// smallest single edit that takes one text to the other. Dependency-free, so the solo bundle can use it without Yjs.

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff

/** Where `before` and `after` differ: past their common start and end, and never through the middle of a surrogate pair. */
export function changedSpan(before: string, after: string): { from: number; removed: number; inserted: string } {
  const max = Math.min(before.length, after.length)
  let start = 0
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--
  let end = 0
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++
  if (end > 0 && isLowSurrogate(before.charCodeAt(before.length - end))) end--
  return { from: start, removed: before.length - start - end, inserted: after.slice(start, after.length - end) }
}
