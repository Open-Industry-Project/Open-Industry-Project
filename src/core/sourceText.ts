// The spans of program text that are text (string literals, comments and pragmas), read exactly as lexer.ts reads
// them, for code that edits a program by offsets without tokenising it.
//
// Every splice into a declaration (a saved value, a type, a description, a tag's whole line) finds its span by
// scanning for a `;` or a `:=` at bracket depth 0. Each of those scanners has to step over text: the `;` in
// `Msg : STRING[20] := 'a;b';` ends nothing, and the apostrophe in `(* the operator's count *)` opens no string.
// The scanners all use this function, so the rule is defined in one place and a gap is fixed for all of them.

/**
 * Where the text that starts at `i` ends (a string literal, a comment or a pragma), or `i` itself when none starts
 * there. The lexer's rules: `'…'` with IEC's `$` escape, never spanning a line (an unterminated literal stops at the
 * newline, as the lexer reports it); `(* … *)` and `// …` comments; `{ … }` pragmas.
 *
 * `"…"` is not text: the lexer refuses a double quote outright (WSTRING is not implemented). On text that is never
 * lexed (a clipboard, a section sniffed for its dialect), treating a stray `"` as a string would hide everything after
 * it on the line, an IEC contact included.
 */
export function skipText(source: string, i: number): number {
  const c = source[i]
  if (c === "'") {
    for (let j = i + 1; j < source.length; j++) {
      const d = source[j]
      if (d === '\n') return j
      if (d === '$') j++
      else if (d === "'") return j + 1
    }
    return source.length
  }
  if (c === '/' && source[i + 1] === '/') {
    const eol = source.indexOf('\n', i)
    return eol < 0 ? source.length : eol
  }
  if (c === '(' && source[i + 1] === '*') {
    const end = source.indexOf('*)', i + 2)
    return end < 0 ? source.length : end + 2
  }
  if (c === '{') {
    const end = source.indexOf('}', i + 1)
    return end < 0 ? source.length : end + 1
  }
  return i
}

/**
 * The first index at or after `from` (and before `to`) where `match` holds, looking only at code (never inside a
 * string, a comment or a pragma) and, with `depth0`, only outside brackets. -1 when there is none. `match` is given
 * the index, so a caller can look at two characters (`:=`).
 */
export function findInCode(source: string, from: number, match: (i: number) => boolean, opts: { depth0?: boolean; to?: number } = {}): number {
  const to = Math.min(opts.to ?? source.length, source.length)
  let depth = 0
  for (let i = from; i < to; i++) {
    const past = skipText(source, i)
    if (past !== i) {
      i = past - 1
      continue
    }
    const c = source[i]!
    if (opts.depth0) {
      if (c === '[' || c === '(') {
        depth++
        continue
      }
      if (c === ']' || c === ')') {
        depth--
        continue
      }
      if (depth !== 0) continue
    }
    if (match(i)) return i
  }
  return -1
}
