import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { stExtensions, stPhraseTable } from './stLang'

// The CodeMirror packages whose words the ST editor can show (stPhrases in stLang.ts)
const CM_PACKAGES = ['@codemirror/search', '@codemirror/view', '@codemirror/language', '@codemirror/lint', '@codemirror/autocomplete']

describe('ST editor phrases', () => {
  it('names only phrases CodeMirror actually looks up', () => {
    // CodeMirror finds a phrase by its exact English text. A key that drifts from its source after an
    // upgrade silently falls back to English, so each key must still appear there as a string literal.
    const require = createRequire(import.meta.url)
    const source = CM_PACKAGES.map((p) => readFileSync(require.resolve(p), 'utf8')).join('\n')
    const stale = Object.keys(stPhraseTable()).filter((k) => !source.includes(JSON.stringify(k)))
    expect(stale).toEqual([])
  })

  it('reaches the editor state, so the Go To Line dialog reads OIP text', () => {
    const state = EditorState.create({ extensions: stExtensions(() => []) })
    const table = stPhraseTable()
    expect(state.phrase('Go to line')).toBe(table['Go to line'])
    expect(state.phrase('go')).toBe(table.go)
    // $ is CodeMirror's placeholder; the message must keep it so the line number lands
    expect(state.phrase('replaced match on line $', 7)).toBe(table['replaced match on line $']?.replace('$', '7'))
  })
})
