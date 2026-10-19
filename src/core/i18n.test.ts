// The i18n seam's own invariants, mainly the fallback chain. With one locale shipped, every lookup
// resolves to the English source, so a mistake in this module is invisible in the UI until a second
// locale exists. These tests pin the behaviour before that happens.

import { afterEach, describe, expect, it } from 'vitest'
import { activeLocale, defineMessage, defineMessages, messageCatalog, setLocale, t, tParts } from './i18n'

// module state is a singleton; every test starts from English
afterEach(() => setLocale('en', null))

describe('defineMessage', () => {
  it('returns the id and registers the English source', () => {
    const id = defineMessage('test.greet', 'Hello')
    expect(id).toBe('test.greet')
    expect(t(id)).toBe('Hello')
  })

  it('tolerates re-declaring an id with the same source (a module evaluated twice)', () => {
    defineMessage('test.dup', 'Same')
    expect(() => defineMessage('test.dup', 'Same')).not.toThrow()
  })

  it('throws when an id is re-declared with a different source', () => {
    defineMessage('test.collide', 'First')
    // two unrelated strings collapsing onto one translation is the bug this catches
    expect(() => defineMessage('test.collide', 'Second')).toThrow(/redeclared/)
  })
})

describe('t', () => {
  it('falls back to the English source when no locale is installed', () => {
    defineMessage('test.fallback', 'English text')
    expect(t('test.fallback')).toBe('English text')
  })

  it('prefers the active locale over the source', () => {
    const id = defineMessage('test.active', 'Save')
    setLocale('de', new Map([[id, 'Speichern']]))
    expect(t(id)).toBe('Speichern')
  })

  it('falls back to English for a key the active locale is missing', () => {
    const covered = defineMessage('test.covered', 'Covered')
    const gap = defineMessage('test.gap', 'Not translated yet')
    setLocale('de', new Map([[covered, 'Abgedeckt']]))
    expect(t(covered)).toBe('Abgedeckt')
    // a partial translation degrades to English, never to a blank
    expect(t(gap)).toBe('Not translated yet')
  })

  it('returns the id itself for an entirely unknown message', () => {
    // should look wrong in the UI, not take the editor down
    expect(t('test.never.declared')).toBe('test.never.declared')
  })

  it('setLocale(null) goes back to the English sources', () => {
    const id = defineMessage('test.revert', 'Run')
    setLocale('de', new Map([[id, 'Starten']]))
    expect(t(id)).toBe('Starten')
    setLocale('en', null)
    expect(t(id)).toBe('Run')
    expect(activeLocale()).toBe('en')
  })
})

describe('placeholders', () => {
  it('fills {named} placeholders', () => {
    const id = defineMessage('test.params', 'Saved to "{name}", {count} parts')
    expect(t(id, { name: 'line-a', count: 12 })).toBe('Saved to "line-a", 12 parts')
  })

  it('leaves a placeholder the caller did not supply intact', () => {
    const id = defineMessage('test.missingParam', 'Hi {who}')
    expect(t(id, { other: 'x' })).toBe('Hi {who}')
  })

  it('interpolates the translated string, so word order is the translation to make', () => {
    const id = defineMessage('test.order', 'Saved {what} to {where}')
    setLocale('xx', new Map([[id, '{where} received {what}']]))
    expect(t(id, { what: 'scene', where: 'disk' })).toBe('disk received scene')
  })
})

describe('defineMessages', () => {
  it('prefixes each key and registers its source', () => {
    const M = defineMessages('test.group', { title: 'Problems', hint: 'Click a row' })
    expect(M.title).toBe('test.group.title')
    expect(t(M.hint)).toBe('Click a row')
  })
})

describe('plurals', () => {
  it('picks the English form from count', () => {
    const id = defineMessage('test.errors', { one: '{count} error', other: '{count} errors' })
    expect(t(id, { count: 1 })).toBe('1 error')
    expect(t(id, { count: 0 })).toBe('0 errors')
    expect(t(id, { count: 3 })).toBe('3 errors')
  })

  it("uses the locale's own categories, which English lacks", () => {
    const id = defineMessage('test.files', { one: '{count} file', other: '{count} files' })
    setLocale(
      'pl',
      new Map([
        [`${id}#one`, '{count} plik'],
        [`${id}#few`, '{count} pliki'],
        [`${id}#many`, '{count} plików'],
      ]),
    )
    expect(t(id, { count: 1 })).toBe('1 plik')
    expect(t(id, { count: 3 })).toBe('3 pliki')
    expect(t(id, { count: 5 })).toBe('5 plików')
  })

  it('falls back to English when the locale lacks the message', () => {
    const id = defineMessage('test.rows', { one: '{count} row', other: '{count} rows' })
    setLocale('de', new Map())
    expect(t(id, { count: 2 })).toBe('2 rows')
  })

  it('survives a malformed locale tag', () => {
    const id = defineMessage('test.bad', { one: '{count} bad', other: '{count} bads' })
    setLocale('not a tag!', null)
    expect(t(id, { count: 2 })).toBe('2 bads')
  })

  it('throws when a plain message and a plural share an id', () => {
    defineMessage('test.mixed', 'Plain')
    expect(() => defineMessage('test.mixed', { one: 'a', other: 'b' })).toThrow(/plural/)
  })
})

describe('tParts', () => {
  it('splits the text around non-string values, in the translated order', () => {
    const id = defineMessage('test.parts', 'Press {key} to {what}')
    const key = { el: 'kbd' }
    expect(tParts(id, { key, what: 'open' })).toEqual(['Press ', key, ' to ', 'open'])
    setLocale('xx', new Map([[id, '{what}: {key}']]))
    expect(tParts(id, { key, what: 'open' })).toEqual(['open', ': ', key])
  })

  it('leaves an unsupplied placeholder in the text', () => {
    const id = defineMessage('test.partsMissing', 'A {x} B')
    expect(tParts(id, {})).toEqual(['A {x} B'])
  })
})

describe('messageCatalog', () => {
  it('hands out id -> English source, sorted, for a translator to work from', () => {
    defineMessage('test.zeta', 'Z')
    defineMessage('test.alpha', 'A')
    const ids = [...messageCatalog().keys()].filter((k) => k.startsWith('test.'))
    expect(ids).toEqual([...ids].sort())
    expect(messageCatalog().get('test.alpha')).toBe('A')
  })

  it('is a copy: mutating it cannot corrupt the sources', () => {
    const id = defineMessage('test.frozen', 'Original')
    ;(messageCatalog() as Map<string, string>).set(id, 'Tampered')
    expect(t(id)).toBe('Original')
  })
})
