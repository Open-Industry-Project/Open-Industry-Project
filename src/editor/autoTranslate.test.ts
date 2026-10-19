// The browser-translator bridge: what it sends, what it refuses to install, and that a fake Translator's output
// reaches t() without a reload.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { needsTranslation, parseCache, protect, restore, targetLanguage } from './autoTranslate'

describe('targetLanguage', () => {
  it("is the browser's first language unless that is English", () => {
    expect(targetLanguage(['de-DE', 'en-US'])).toBe('de-DE')
    expect(targetLanguage(['en-GB', 'de'])).toBe(null)
    expect(targetLanguage(['en'])).toBe(null)
    expect(targetLanguage([])).toBe(null)
  })
})

describe('placeholders survive translation or the message stays English', () => {
  it('numbers the names and puts them back, in the translated order', () => {
    const { text, names } = protect('Saved {what} to {where}, {what} again')
    expect(text).toBe('Saved {0} to {1}, {0} again')
    expect(restore(text, '{1} hat {0} erhalten, {0} wieder', names)).toBe('{where} hat {what} erhalten, {what} wieder')
  })

  it('protects the tutorial key and nav tokens too', () => {
    const { text, names } = protect('Hold {key:fly.forward} and {nav:orbit} on {tag}')
    expect(text).toBe('Hold {0} and {1} on {2}')
    expect(restore(text, 'Halte {0} und {1} an {2}', names)).toBe('Halte {key:fly.forward} und {nav:orbit} an {tag}')
  })

  it('refuses a translation that lost, added or translated a placeholder', () => {
    const { text, names } = protect('Rename {name}')
    expect(restore(text, 'Umbenennen', names)).toBe(null)
    expect(restore(text, '{0} {0} umbenennen', names)).toBe(null)
    expect(restore(text, '{Name} umbenennen', names)).toBe(null)
  })

  it('skips a message with no words outside its placeholders', () => {
    expect(needsTranslation('{label} ({chord})')).toBe(false)
    expect(needsTranslation('{count} more')).toBe(true)
  })
})

describe('parseCache', () => {
  it("reads the language's entries and drops anything malformed", () => {
    const raw = JSON.stringify({ lang: 'de', entries: { a: ['Save', 'Speichern'], b: ['x'], c: 3 } })
    expect(parseCache(raw, 'de')).toEqual({ a: ['Save', 'Speichern'] })
    expect(parseCache(raw, 'fr')).toEqual({})
    expect(parseCache('{not json', 'de')).toEqual({})
  })
})

/** The module and core/i18n are singletons, so each run gets fresh copies under a stubbed browser. */
async function boot(opts: { languages: string[]; stored?: Record<string, string>; translator?: (s: string) => string }) {
  vi.resetModules()
  const store = new Map(Object.entries(opts.stored ?? {}))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('navigator', { languages: opts.languages, language: opts.languages[0] })
  const sent: string[] = []
  if (opts.translator) {
    const fn = opts.translator
    vi.stubGlobal('Translator', {
      availability: async () => 'available',
      create: async () => ({
        translate: async (s: string) => {
          sent.push(s)
          return fn(s)
        },
      }),
    })
  }
  const i18n = await import('../core/i18n')
  const bridge = await import('./autoTranslate')
  return { i18n, bridge, sent, store }
}

afterEach(() => vi.unstubAllGlobals())

describe('the bridge', () => {
  it("installs the translator's output for messages declared before and after boot", async () => {
    const { i18n, bridge, sent } = await boot({ languages: ['de'], translator: (s) => `[de] ${s}` })
    const early = i18n.defineMessage('t.early', 'Rename {name}')
    bridge.initLanguage()
    const late = i18n.defineMessage('t.late', 'Delete')
    await vi.waitFor(() => expect(i18n.t(late)).toBe('[de] Delete'))
    expect(i18n.t(early, { name: 'Conv1' })).toBe('[de] Rename Conv1')
    // the translator sees numbered placeholders, never the names
    expect(sent).toContain('Rename {0}')
  })

  it('keeps line breaks, which a real translator drops', async () => {
    const { i18n, bridge } = await boot({ languages: ['de'], translator: (s) => `[de] ${s.replace(/\n/g, ' ')}` })
    const id = i18n.defineMessage('t.lines', "Couldn't copy the room:\n{error}")
    bridge.initLanguage()
    await vi.waitFor(() => expect(i18n.t(id, { error: 'x' })).toBe("[de] Couldn't copy the room:\n[de] x"))
  })

  it('keeps English when the translator drops a placeholder', async () => {
    const { i18n, bridge } = await boot({ languages: ['de'], translator: () => 'kaputt' })
    const id = i18n.defineMessage('t.ph', 'Open {file}')
    const other = i18n.defineMessage('t.plain', 'Close')
    bridge.initLanguage()
    await vi.waitFor(() => expect(i18n.t(other)).toBe('kaputt'))
    expect(i18n.t(id, { file: 'a.st' })).toBe('Open a.st')
  })

  it('installs cached translations at boot, and drops one whose English changed', async () => {
    const stored = { 'oip-web/translations': JSON.stringify({ lang: 'fr', entries: { 't.c': ['Save', 'Enregistrer'], 't.d': ['Old text', 'Ancien'] } }) }
    const { i18n, bridge } = await boot({ languages: ['fr'], stored })
    const c = i18n.defineMessage('t.c', 'Save')
    const d = i18n.defineMessage('t.d', 'New text')
    bridge.initLanguage()
    expect(i18n.t(c)).toBe('Enregistrer')
    expect(i18n.t(d)).toBe('New text')
  })

  it('does nothing when the person chose English', async () => {
    const { i18n, bridge, sent } = await boot({ languages: ['de'], stored: { 'oip-web/language': 'en' }, translator: (s) => `[de] ${s}` })
    const id = i18n.defineMessage('t.en', 'Run')
    bridge.initLanguage()
    expect(i18n.activeLocale()).toBe('en')
    expect(i18n.t(id)).toBe('Run')
    expect(sent).toEqual([])
  })

  it("falls back to the base language when the translator doesn't offer the browser's region", async () => {
    const { i18n, bridge } = await boot({ languages: ['de-AT'] })
    const asked: string[] = []
    vi.stubGlobal('Translator', {
      availability: async ({ targetLanguage }: { targetLanguage: string }) => (asked.push(targetLanguage), targetLanguage === 'de' ? 'available' : 'unavailable'),
      create: async ({ targetLanguage }: { targetLanguage: string }) => ({ translate: async (s: string) => `[${targetLanguage}] ${s}` }),
    })
    const id = i18n.defineMessage('t.base', 'Stop')
    bridge.initLanguage()
    await vi.waitFor(() => expect(i18n.t(id)).toBe('[de] Stop'))
    expect(asked).toEqual(['de-AT', 'de'])
    // the locale stays the browser's own tag, for plural rules and the page's lang
    expect(i18n.activeLocale()).toBe('de-AT')
  })

  it('names a language by its base, in English and in itself', async () => {
    const { bridge } = await boot({ languages: ['de-DE'] })
    expect(bridge.languageName('de-DE')).toBe('German (Deutsch)')
    expect(bridge.ownLanguageName('de-DE')).toBe('Deutsch')
    expect(bridge.baseLanguage('zh-Hant-TW')).toBe('zh-Hant')
  })

  it('asks before a download, and Keep English is remembered', async () => {
    const { i18n, bridge, store } = await boot({ languages: ['ja'] })
    vi.stubGlobal('Translator', { availability: async () => 'downloadable', create: async () => ({ translate: async (s: string) => s }) })
    i18n.defineMessage('t.ask', 'Run')
    bridge.initLanguage()
    await vi.waitFor(() => expect(bridge.translateStatus().kind).toBe('ask'))
    bridge.declineTranslation()
    expect(store.get('oip-web/language')).toBe('en')
    expect(bridge.translateStatus().kind).toBe('off')
  })
})
