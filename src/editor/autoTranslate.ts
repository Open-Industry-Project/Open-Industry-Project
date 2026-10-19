/**
 * Shows the editor in the browser's language by feeding its messages to the browser's own on-device translator
 * (the Translator API), so the app ships no translations.
 *
 * Only the messages declared in core/i18n are translated, never the page: /app/ keeps `translate="no"`, so tags,
 * ST source, part ids and keywords stay as written. Anything that doesn't work out leaves English in place: no
 * Translator API (Firefox, Safari and Electron today), an unsupported language, a refused download, or a
 * translation that dropped a `{placeholder}`.
 *
 * - Translations are cached in localStorage per message, with the English they were made from, so a later visit
 *   installs them before React mounts and only new or reworded messages go back to the translator.
 * - A lazily loaded dialog declares its messages when it loads (`onMessageDefined`); those are translated then and
 *   show from the next render or the next visit.
 * - A translator whose model still has to be downloaded can only be created from a click, so the first visit asks
 *   (TranslateToast.tsx). "Keep English" and the Settings choice store `en`, which turns all of this off.
 */
import { messageCatalog, onMessageDefined, setLocale, type MessageId } from '../core/i18n'

/** 'en' once the person chose English; absent means follow the browser. A per-browser preference. */
export const LANGUAGE_KEY = 'oip-web/language'
/** { lang, entries: { [id]: [english, translation] } } */
export const TRANSLATIONS_KEY = 'oip-web/translations'

export type LanguagePref = 'auto' | 'en'

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available'

interface TranslatorInstance {
  translate(text: string): Promise<string>
}

interface TranslatorFactory {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>
  create(o: {
    sourceLanguage: string
    targetLanguage: string
    monitor?: (m: EventTarget) => void
  }): Promise<TranslatorInstance>
}

export type TranslateStatus =
  | { kind: 'off' }
  /** the model has to be downloaded, which needs a click */
  | { kind: 'ask'; lang: string }
  | { kind: 'downloading'; lang: string; progress: number }
  | { kind: 'translating'; lang: string; done: number; total: number; shown: boolean }
  /** a first pass finished while most of the page was still English: a reload shows it all */
  | { kind: 'ready'; lang: string }
  | { kind: 'failed'; lang: string }

// ── Pure parts (unit-tested) ─────────────────────────────────────────────────────────────────────────

/** The language to translate into: the browser's first choice, unless that is English. */
export function targetLanguage(languages: readonly string[]): string | null {
  const first = languages[0]?.trim()
  if (!first || /^en(-|$)/i.test(first)) return null
  return first
}

/**
 * `{name}` placeholders, and the tutorial's `{key:fly.forward}` / `{nav:orbit}` tokens, become `{0}`, `{1}`...
 * before translation: a translator leaves a number in braces alone more reliably than a word, which it may translate.
 */
const PLACEHOLDER = /\{(\w+(?::[\w.-]+)?)\}/g

export function protect(source: string): { text: string; names: string[] } {
  const names: string[] = []
  const text = source.replace(PLACEHOLDER, (_whole, name: string) => {
    let i = names.indexOf(name)
    if (i < 0) i = names.push(name) - 1
    return `{${i}}`
  })
  return { text, names }
}

/** Put the names back; null when the translation lost, added or duplicated a placeholder. */
export function restore(protectedSource: string, translated: string, names: readonly string[]): string | null {
  const tokens = (s: string): string => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',')
  if (tokens(protectedSource) !== tokens(translated)) return null
  return translated.replace(/\{(\d+)\}/g, (whole, i: string) => {
    const name = names[Number(i)]
    return name === undefined ? whole : `{${name}}`
  })
}

/** A message with no words outside its placeholders ('{label} ({chord})') reads the same in every language. */
export function needsTranslation(source: string): boolean {
  return /[A-Za-z]{2,}/.test(source.replace(PLACEHOLDER, ''))
}

/**
 * "German (Deutsch)": the English name for whoever reads it in English now, the language's own for whoever it is
 * for. A tag Intl can't name comes back as given.
 */
export function languageName(lang: string): string {
  try {
    const base = baseLanguage(lang)
    const english = new Intl.DisplayNames(['en'], { type: 'language' }).of(base)
    const own = new Intl.DisplayNames([lang], { type: 'language' }).of(base)
    if (!english) return lang
    return own && own !== english ? `${english} (${own})` : english
  } catch {
    return lang
  }
}

/** "Deutsch": the language's name for itself. */
export function ownLanguageName(lang: string): string {
  try {
    return new Intl.DisplayNames([lang], { type: 'language' }).of(baseLanguage(lang)) ?? lang
  } catch {
    return lang
  }
}

/** 'de' for 'de-DE': the region doesn't change a UI's language, and a translator may only know the base. Scripts
 *  stay ('zh-Hant' is a different written language from 'zh'). */
export function baseLanguage(lang: string): string {
  try {
    const l = new Intl.Locale(lang)
    return l.script ? `${l.language}-${l.script}` : l.language
  } catch {
    return lang
  }
}

export type Cache = Record<MessageId, [english: string, translation: string]>

/** The cached translations for `lang`, or none for another language or a damaged record. */
export function parseCache(raw: string | null, lang: string): Cache {
  if (!raw) return {}
  try {
    const data = JSON.parse(raw) as { lang?: unknown; entries?: unknown }
    if (data.lang !== lang || typeof data.entries !== 'object' || data.entries === null) return {}
    const out: Cache = {}
    for (const [id, pair] of Object.entries(data.entries as Record<string, unknown>)) {
      if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') out[id] = [pair[0], pair[1]]
    }
    return out
  } catch {
    return {}
  }
}

// ── Session state ────────────────────────────────────────────────────────────────────────────────────

let status: TranslateStatus = { kind: 'off' }
const listeners = new Set<() => void>()

/** set by the toast's ✕ */
let quiet = false

function setStatus(next: TranslateStatus): void {
  if (quiet && next.kind !== 'off') next = { kind: 'off' }
  status = next
  for (const cb of listeners) cb()
}

export function translateStatus(): TranslateStatus {
  return status
}

export function subscribeTranslate(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // storage disabled
  }
}

export function languagePref(): LanguagePref {
  try {
    return storage()?.getItem(LANGUAGE_KEY) === 'en' ? 'en' : 'auto'
  } catch {
    return 'auto'
  }
}

/** Takes effect on the next load: a mounted tree keeps the strings it rendered (core/i18n setLocale). */
export function setLanguagePref(pref: LanguagePref): void {
  try {
    if (pref === 'en') storage()?.setItem(LANGUAGE_KEY, 'en')
    else storage()?.removeItem(LANGUAGE_KEY)
  } catch {
    /* storage disabled: this load keeps what it has */
  }
}

/** The browser's language when it isn't English, whatever the preference says; for the Settings label. */
export function browserLanguage(): string | null {
  return typeof navigator === 'undefined' ? null : targetLanguage(navigator.languages?.length ? navigator.languages : [navigator.language])
}

/** The browser has a Translator API at all. */
export function translatorSupported(): boolean {
  return typeof globalThis === 'object' && 'Translator' in globalThis
}

function factory(): TranslatorFactory | null {
  return translatorSupported() ? ((globalThis as unknown as { Translator: TranslatorFactory }).Translator) : null
}

/** The installed dictionary. core/i18n reads it live, so a translation added here shows from the next render. */
const dict = new Map<MessageId, string>()
let cache: Cache = {}
const queue: [MessageId, string][] = []
const queued = new Set<MessageId>()
/** the browser's language: the locale tag and the cache's key */
let lang = ''
/** what the translator was asked for: `lang`, or its base language when only that is offered */
let translatorLang = ''
let translator: TranslatorInstance | null = null
let draining = false
let persistTimer: ReturnType<typeof setTimeout> | null = null
/** how much of the boot catalog the cache covered: little means the page the person sees is mostly English */
let bootCoverage = 1

function enqueue(id: MessageId, source: string): void {
  if (!needsTranslation(source)) return
  const hit = cache[id]
  if (hit && hit[0] === source) return
  // reworded since it was translated: English until the new text is translated
  if (hit) {
    dict.delete(id)
    delete cache[id]
  }
  if (queued.has(id)) return
  queued.add(id)
  queue.push([id, source])
  if (translator) void drain()
}

function persistNow(): void {
  if (persistTimer === null) return
  clearTimeout(persistTimer)
  persistTimer = null
  try {
    storage()?.setItem(TRANSLATIONS_KEY, JSON.stringify({ lang, entries: cache }))
  } catch {
    /* quota or storage disabled: this load keeps its translations in memory */
  }
}

function persistSoon(): void {
  if (persistTimer !== null) return
  persistTimer = setTimeout(persistNow, 1000)
}

/** One line at a time, since a translator drops line breaks; a blank line is kept, not sent. */
export async function translateLines(translator: TranslatorInstance, text: string): Promise<string> {
  const lines = text.split('\n')
  const out: string[] = []
  for (const line of lines) out.push(line.trim() ? await translator.translate(line) : line)
  return out.join('\n')
}

/** `report` is the first pass of a load, which the toast follows; a later dialog's messages go through quietly. */
async function drain(report = false): Promise<void> {
  if (draining || !translator) return
  draining = true
  const total = queue.length
  let done = 0
  const shown = status.kind === 'downloading' || status.kind === 'translating'
  try {
    while (queue.length > 0) {
      const [id, source] = queue.shift()!
      queued.delete(id)
      const { text, names } = protect(source)
      try {
        const out = restore(text, await translateLines(translator, text), names)
        if (out !== null) {
          dict.set(id, out)
          cache[id] = [source, out]
          persistSoon()
        }
      } catch {
        /* one message failing keeps its English */
      }
      done++
      if (report && (done % 20 === 0 || queue.length === 0)) setStatus({ kind: 'translating', lang, done, total: Math.max(total, done), shown })
    }
  } finally {
    draining = false
  }
  if (report) setStatus(bootCoverage < 0.5 ? { kind: 'ready', lang } : { kind: 'off' })
}

async function start(f: TranslatorFactory, withDownload: boolean): Promise<void> {
  try {
    translator = await f.create({
      sourceLanguage: 'en',
      targetLanguage: translatorLang,
      ...(withDownload
        ? {
            monitor: (m: EventTarget) =>
              m.addEventListener('downloadprogress', (e) => setStatus({ kind: 'downloading', lang, progress: (e as ProgressEvent).loaded ?? 0 })),
          }
        : {}),
    })
  } catch {
    setStatus({ kind: 'failed', lang })
    return
  }
  if (withDownload) setStatus({ kind: 'translating', lang, done: 0, total: queue.length, shown: true })
  await drain(true)
}

/**
 * The click on "Translate" in the toast: creating the translator from inside it is what lets the browser download
 * the model.
 */
export function acceptTranslation(): void {
  const f = factory()
  if (!f || status.kind !== 'ask') return
  setStatus({ kind: 'downloading', lang, progress: 0 })
  void start(f, true)
}

/** "Keep English": stored, so the question isn't asked again; Settings can turn it back on. */
export function declineTranslation(): void {
  setLanguagePref('en')
  setStatus({ kind: 'off' })
}

/** The toast's ✕: translation carries on, and this load shows no more about it. */
export function dismissTranslateStatus(): void {
  quiet = true
  setStatus({ kind: 'off' })
}

/**
 * Boot, before React mounts: install the cached translations so the first render is already translated, then
 * check with the browser's translator for what is missing. Called once from main.tsx.
 */
export function initLanguage(): void {
  if (languagePref() === 'en') return
  const target = browserLanguage()
  if (!target) return
  lang = target
  cache = parseCache(storage()?.getItem(TRANSLATIONS_KEY) ?? null, lang)
  for (const [id, [, translation]] of Object.entries(cache)) dict.set(id, translation)
  setLocale(lang, dict)
  // screen readers and font fallback read it; the page stays `translate="no"`
  if (typeof document !== 'undefined') document.documentElement.lang = lang

  const catalog = messageCatalog()
  let wanted = 0
  let covered = 0
  for (const [id, source] of catalog) {
    if (!needsTranslation(source)) continue
    wanted++
    if (cache[id]?.[0] === source) covered++
    enqueue(id, source)
  }
  bootCoverage = wanted === 0 ? 1 : covered / wanted
  onMessageDefined(enqueue)
  // the toast's Reload comes right after the last translation, inside the save's delay
  if (typeof window !== 'undefined') window.addEventListener('pagehide', persistNow)

  const f = factory()
  if (!f) return
  void (async () => {
    let availability: Availability = 'unavailable'
    // the browser's own tag first ('pt-BR' and 'pt' are different translations), then its base language
    for (const candidate of new Set([lang, baseLanguage(lang)])) {
      try {
        availability = await f.availability({ sourceLanguage: 'en', targetLanguage: candidate })
      } catch {
        continue
      }
      if (availability !== 'unavailable') {
        translatorLang = candidate
        break
      }
    }
    if (availability === 'unavailable') return
    if (availability === 'available') {
      await start(f, false)
      return
    }
    // everything is cached: a dialog's new messages wait for a visit with the model on hand, rather than a question
    if (queue.length === 0) return
    setStatus({ kind: 'ask', lang })
  })()
}
