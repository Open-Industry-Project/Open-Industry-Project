import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { setKeymapOverrides } from '../core/keymap'
import { DEFAULT_NAV, setActiveNav } from '../core/navigation'
import { acceleratorHint, keyHint, primaryKey, withKey, withKeys } from './keyHint'

afterEach(() => setKeymapOverrides(null))

describe('keyHint', () => {
  it('names every binding, primary first - not whichever one a string happened to hard-code', () => {
    expect(keyHint('pilot.exit', false)).toBe('Esc or P')
    expect(keyHint('view.projection', false)).toBe('O or Numpad 5')
    expect(keyHint('file.save', false)).toBe('Ctrl+S')
  })

  it('keeps a Cmd-only chord off Windows/Linux and shows only it on a Mac', () => {
    expect(keyHint('view.distractionFree', false)).toBe('Ctrl+Shift+F11')
    expect(keyHint('view.distractionFree', true)).toBe('⌘⇧D')
    // no Cmd-specific form: the portable chord, in Mac notation
    expect(keyHint('file.save', true)).toBe('⌘S')
  })

  it('follows a rebinding', () => {
    setKeymapOverrides({ 'pilot.enter': ['KeyJ'] })
    expect(keyHint('pilot.enter', false)).toBe('J')
    expect(withKey('Pilot Mode', 'pilot.enter', false)).toBe('Pilot Mode (J)')
  })

  it('drops the parentheses when an action has no binding', () => {
    expect(keyHint('no.such.action', false)).toBeNull()
    expect(withKey('Help', 'no.such.action', false)).toBe('Help')
  })
})

describe('withKeys', () => {
  it('resolves {key:…} tokens in prose, and follows a rebinding', () => {
    expect(withKeys('Press **{key:ui.shortcuts}** for the list', false)).toBe('Press **Shift+/** for the list')
    expect(withKeys('steer with {key:fly.forward}{key:fly.left}{key:fly.back}{key:fly.right}', false)).toBe('steer with WASD')
    setKeymapOverrides({ 'ui.shortcuts': ['F1'] })
    expect(withKeys('Press {key:ui.shortcuts}', false)).toBe('Press F1')
  })

  it('leaves an unknown action visibly broken, not silently blank', () => {
    expect(withKeys('Press {key:no.such.action}', false)).toBe('Press [no.such.action]')
  })
})

describe('acceleratorHint / primaryKey', () => {
  it('prints a native-menu accelerator in the keymap’s notation, per platform', () => {
    expect(acceleratorHint('CmdOrCtrl+Shift+P', false)).toBe('Ctrl+Shift+P')
    expect(acceleratorHint('CmdOrCtrl+Shift+P', true)).toBe('⌘⇧P')
    expect(acceleratorHint('Shift+F5', false)).toBe('Shift+F5')
    expect(acceleratorHint('F5', true)).toBe('F5')
  })

  it('gives a menu column one chord, where a tooltip names them all', () => {
    expect(primaryKey('pilot.enter', false)).toBe('P')
    expect(primaryKey('view.projection', false)).toBe('O')
    expect(keyHint('view.projection', false)).toBe('O or Numpad 5')
    expect(primaryKey('edit.group', true)).toBe('⌘G')
    expect(primaryKey(undefined, false)).toBe('')
  })
})

// The guard for the whole class. Every surface that names a key asks the keymap (keyHint.ts), because
// Settings can rebind them: a chord typed into a string is a label that goes stale on the first rebind,
// and on a Mac it can be wrong from the start. This fails the build on one, so a new tooltip cannot
// quietly bring the pattern back. Mouse modifiers ("Shift+click", "Alt+RMB") are gestures, not bindings,
// and a native-menu `accelerator:` is a binding spec that Electron parses, not a label.
describe('UI text names no chord by hand', () => {
  const ROOT = fileURLToPath(new URL('.', import.meta.url))
  // one or more modifiers, then a key - the whole chord, so a failure reads "Ctrl+Shift+F11", not "Ctrl+Shift"
  const CHORD = /\b(?:(?:Ctrl|Cmd|Shift|Alt|Meta|Option)\s?\+\s?)+(?!(?:click|Click|RMB|LMB|MMB|drag|Drag|wheel|Wheel|scroll|Scroll)\b)[A-Za-z0-9/.,=`[\]-]+/g

  it('finds none in src/editor', () => {
    const offenders: string[] = []
    const files = (readdirSync(ROOT, { recursive: true }) as string[]).filter(
      // either separator: readdirSync reports Windows paths with backslashes
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/(^|\\|\/)keyHint\.ts$/.test(f),
    )
    expect(files.length).toBeGreaterThan(50) // the walk found the tree, so an empty pass means something
    for (const f of files) {
      // blank block comments line for line, so reported line numbers stay true
      const text = readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      // \r?\n: a CRLF working copy leaves a \r that `.` will not match, and the comment strip then misses
      text.split(/\r?\n/).forEach((raw, i) => {
        if (/\baccelerator:/.test(raw)) return
        const line = raw.replace(/(^|[^:])\/\/.*$/, '$1') // a line comment, not the // of a URL
        for (const m of line.matchAll(CHORD)) offenders.push(`${f}:${i + 1}  ${m[0]}`)
      })
    }
    expect(offenders, 'use keyHint / withKey / primaryKey (editor/keyHint.ts) instead').toEqual([])
  })
})

describe('withKeys {nav:...}', () => {
  afterEach(() => setActiveNav(DEFAULT_NAV))

  it('names the middle-button gesture for the active navigation style', () => {
    setActiveNav({ ...DEFAULT_NAV, style: 'middlePans' })
    expect(withKeys('hold {nav:orbit} to orbit, {nav:pan} to pan', false)).toBe('hold Shift and the middle mouse button to orbit, the middle mouse button to pan')
    setActiveNav({ ...DEFAULT_NAV, style: 'middleOrbits' })
    expect(withKeys('hold {nav:orbit} to orbit, {nav:pan} to pan', false)).toBe('hold the middle mouse button to orbit, Shift and the middle mouse button to pan')
  })
})
