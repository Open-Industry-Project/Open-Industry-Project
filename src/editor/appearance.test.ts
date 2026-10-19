import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * styles.css carries both themes: a colour is a :root token or an inline light-dark(<light>, <dark>)
 * pair, and the root's color-scheme picks (appearance.ts). A bare colour paints one theme, and the
 * one that breaks is a dark-UI grey - a panel fill or border written for the dark theme, which in the
 * light one comes out as a dark slab on a light panel.
 *
 * So that is what this refuses: a bare opaque grey that is dark or light, and a bare translucent
 * white (the dark theme's "lift"). Colours that read on either ground are left alone, which is most
 * of what stays bare: status and accent fills (saturated), scrims and shadows
 * (translucent black), white text on a fill, mid-grey badges and rails. The HUD drawn over the 3D
 * scene is exempt because it is pinned `color-scheme: dark`.
 */
/** styles.css is a list of `@import './styles/<area>.css'`: read with each import inlined, in order */
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(
  /^@import '(\.\/styles\/[\w-]+\.css)';\r?$/gm,
  (_, part: string) => readFileSync(new URL(part, import.meta.url), 'utf8'),
)

const HUD = /^\.(pilot-|stats-overlay|bench-overlay|model-loading)/

function rgba(lit: string): [number, number, number, number] {
  if (lit.startsWith('#')) {
    let h = lit.slice(1)
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    const n = (i: number): number => Number.parseInt(h.slice(i, i + 2), 16)
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1]
  }
  const p = lit.slice(lit.indexOf('(') + 1, -1).split(/[,/]/).map((x) => Number.parseFloat(x))
  return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]
}

/** a colour written for the dark theme only: see the header */
function oneThemeOnly(lit: string): boolean {
  const [r, g, b, a] = rgba(lit)
  if (r === 255 && g === 255 && b === 255) return a < 1
  if (a < 1) return false
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const l = (max + min) / 2
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
  return s < 0.16 && (l <= 0.38 || l >= 0.72)
}

describe('styles.css paints both themes', () => {
  it('pairs every dark-UI grey with its light twin', () => {
    const blank = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const bare: string[] = []
    for (const rule of blank.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const sel = rule[1]!.trim().split('\n').pop()!.trim()
      if (sel.startsWith(':root') || HUD.test(sel)) continue
      // what is left once every light-dark() pair is taken out is what paints one theme
      const body = rule[2]!.replace(/light-dark\((?:[^()]|\([^()]*\))*\)/g, '')
      for (const d of body.matchAll(/([a-z-]+)\s*:([^;]*)/g)) {
        for (const m of d[2]!.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
          // dark text only ever sits on a light fill (a status badge), so it reads the same in both
          if (d[1] === 'color' && rgba(m[0])[0] < 60) continue
          if (oneThemeOnly(m[0])) bare.push(`${sel} ${d[1]}: ${m[0]}`)
        }
      }
    }
    expect(bare, 'use a :root token or light-dark(<light>, <dark>) - see the head of styles/base.css').toEqual([])
  })

  it('defines every token for both themes', () => {
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
    const tokens = [...root.matchAll(/(--[a-z-]+):\s*([^;]+);/g)]
    expect(tokens.length).toBeGreaterThan(10)
    for (const [, name, value] of tokens) expect(value, name).toMatch(/^light-dark\(/)
  })

  it('names only tokens that exist', () => {
    const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]))
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
    // set per element from TSX, not in here
    const inline = new Set(['--op-hue'])
    // A known gap: --border is never defined, so .autosave-banner-action draws no border. Defining it would
    // change the dark theme, so it is left as it is.
    const undefinedSinceTheStart = new Set(['--border'])
    expect([...used].filter((u) => !defined.has(u) && !inline.has(u!) && !undefinedSinceTheStart.has(u!))).toEqual([])
  })
})
