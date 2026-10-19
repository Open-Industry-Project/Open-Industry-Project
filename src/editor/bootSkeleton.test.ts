import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOTTOM_HEIGHT, DOCK_PANEL_TITLES, SLOT_ORDER, buildDockGrid, defaultDockLayout } from './dockLayout'

/**
 * The boot skeleton (app/index.html) is static markup that stands in for the real shell until React
 * commits, so every value in it is a copy of one that lives in the app, and a copy that drifts is
 * worse than no skeleton: it makes the handoff a visible jump instead of a fill-in, which is the one
 * thing it exists to avoid. Nothing can import the HTML, so this reads both files as text and pins
 * the copies to their originals.
 */
const html = readFileSync(new URL('../../app/index.html', import.meta.url), 'utf8')
/** styles.css is a list of `@import './styles/<area>.css'`: read it with each import inlined, in
 *  order, so the rules below search the whole sheet wherever its split put a value */
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(
  /^@import '(\.\/styles\/[\w-]+\.css)';\r?$/gm,
  (_, part: string) => readFileSync(new URL(part, import.meta.url), 'utf8'),
)
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

/** the `i`th capture of `m`, or a named failure - the point of these reads is to be loud when the
 *  thing they mirror has moved, never to quietly compare against undefined */
const capture = (m: RegExpMatchArray | null, i: number, what: string): string => {
  const v = m?.[i]
  if (v === undefined) throw new Error(`${what} not found`)
  return v
}

/** the value of a custom property in styles.css `:root` */
const themeVar = (name: string): string => {
  const at = css.indexOf(`--${name}:`)
  if (at < 0) throw new Error(`--${name} not found in styles.css`)
  return capture(css.slice(at, css.indexOf(';', at)).match(/:s*(.+)$/), 1, `--${name}'s value`).trim()
}

/** a numeric field of App.tsx's DEFAULT_SIZES */
const defaultSize = (key: string): number => {
  const block = capture(app.match(/const DEFAULT_SIZES = \{([\s\S]*?)\n\}/), 1, 'DEFAULT_SIZES in App.tsx')
  const at = block.indexOf(`${key}:`)
  if (at < 0) throw new Error(`DEFAULT_SIZES.${key} not found`)
  return Number.parseInt(block.slice(at + key.length + 1), 10)
}


/** the skeleton's whole stylesheet - the page carries exactly one, inline in the head */
/** a top-level rule's body, anchored at the start of a line so it cannot match a descendant one */
const cssRule = (selector: string): string => {
  const at = css.indexOf(String.fromCharCode(10) + selector + ' {')
  if (at < 0) throw new Error(`${selector} rule not found in styles.css`)
  return css.slice(at, css.indexOf('}', at))
}

const skeleton = (): string => {
  const i = html.indexOf('<style>')
  expect(i, 'app/index.html has no inline style block').toBeGreaterThan(-1)
  expect(html, 'that style block is not the skeleton’s').toContain('#boot-skeleton')
  return html.slice(i, html.indexOf('</style>', i))
}

describe('boot skeleton mirrors the shell it stands in for', () => {
  it('paints the app’s own four colours', () => {
    const s = skeleton()
    // ground + panel bands + gutters/edge + the dim label under the logo
    expect(s).toContain(`background: ${themeVar('bg')}`)
    expect(s).toContain(`background: ${themeVar('panel')}`)
    expect(s).toContain(`1px solid ${themeVar('panel-edge')}`)
    expect(s).toContain(`color: ${themeVar('text-dim')}`)
  })

  it('lays out at the default dock sizes, so nothing moves when the real grid arrives', () => {
    const s = skeleton()
    const rows = s.match(/grid-template-rows: 48px minmax\(0, 1fr\) 6px (\d+)px/)
    const cols = s.match(/grid-template-columns: (\d+)px 6px minmax\(0, 1fr\) 6px (\d+)px/)
    expect(rows, 'skeleton rows must mirror .app’s').not.toBeNull()
    expect(cols, 'skeleton columns must mirror .app’s').not.toBeNull()
    // the bottom dock stands at the height of the panel in front, so a fresh layout's is that panel's default
    expect(Number(rows![1])).toBe(DEFAULT_BOTTOM_HEIGHT[defaultDockLayout().active.bottom!])
    expect(Number(cols![1])).toBe(defaultSize('left'))
    expect(Number(cols![2])).toBe(defaultSize('right'))
  })

  it('has the shape of the grid a fresh layout builds', () => {
    // which cell spans what - the Inspector's column running the full height beside the bottom dock - is the part of
    // the layout most likely to change without a size changing, so the skeleton's areas are read back in the app's names
    const s = skeleton()
    const block = capture(s.match(/grid-template-areas:([^;]+);/), 1, 'the skeleton’s grid-template-areas')
    const skeletonRows = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!.split(/\s+/))
    const rename: Record<string, string> = { left: 'leftA', gutl: 'gutlA', gutr: 'gutrA', inspector: 'rightA', dock: 'bottom' }
    const grid = buildDockGrid(defaultDockLayout(), { left: 1, right: 1, left2: 1, right2: 1, dock: '1px' })
    const appRows = [...grid.gridTemplateAreas.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.split(' '))
    expect(skeletonRows.map((r) => r.map((n) => rename[n] ?? n))).toEqual(appRows)
  })

  it('sizes the logo exactly as .viewport-cover-logo does', () => {
    const cover = capture(css.match(/\.viewport-cover-logo \{([\s\S]*?)\n\}/), 1, '.viewport-cover-logo')
    const width = capture(cover.match(/width: (.+);/), 1, 'its width')
    const maxHeight = capture(cover.match(/max-height: (.+);/), 1, 'its max-height')
    const ratio = capture(cover.match(/aspect-ratio: (.+);/), 1, 'its aspect-ratio')
    expect(skeleton()).toContain(`width: ${width}`)
    expect(skeleton()).toContain(`max-height: ${maxHeight}`)
    expect(skeleton()).toContain(`aspect-ratio: ${ratio}`)
  })

  it('reserves the logo’s box at the SVG’s own proportions', () => {
    // The ratio is what gives an unloaded logo its height, so a cold load does not paint it 0 tall and
    // then jump it up half its height when the file loads. It is a copy of the viewBox, so a new logo
    // with other proportions would reserve the wrong box.
    const svg = readFileSync(new URL('../../public/oip-logo.svg', import.meta.url), 'utf8')
    const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
    const w = capture(viewBox, 1, 'the logo’s viewBox width')
    const h = capture(viewBox, 2, 'the logo’s viewBox height')
    const cover = capture(css.match(/\.viewport-cover-logo \{([\s\S]*?)\n\}/), 1, '.viewport-cover-logo')
    expect(cover).toContain(`aspect-ratio: ${w} / ${h};`)
  })

  it('wears the same tab strip in each dock as a fresh layout would', () => {
    // the labels are the one bit of real content in here, so they come from the app's own default
    // layout rather than from a list typed twice. The whole strip, in order, with the right one in
    // front: a strip that only names its front tab grows under the user's eyes at the handover.
    const layout = defaultDockLayout()
    const cells = { leftTop: 'bs-left', rightTop: 'bs-right', bottom: 'bs-dock' } as const
    // the skeleton has a band for exactly these slots, so a default that fills another one needs a new band
    expect(SLOT_ORDER.filter((s) => layout[s].length > 0)).toEqual(Object.keys(cells))
    for (const [slot, cell] of Object.entries(cells) as [keyof typeof cells, string][]) {
      const strip = capture(
        html.match(new RegExp(`<div class="${cell}">\\s*<div class="bs-tabs">(.*?)</div>`)),
        1,
        `${slot}'s tab strip (.${cell} .bs-tabs)`,
      )
      const tabs = [...strip.matchAll(/<span class="bs-tab( bs-on)?">([^<]+)<\/span>/g)]
      expect(tabs.map((t) => t[2]), `${slot}'s tabs`).toEqual(layout[slot].map((p) => DOCK_PANEL_TITLES[p]))
      expect(tabs.filter((t) => t[1]).map((t) => t[2]), `${slot}'s front tab`).toEqual([DOCK_PANEL_TITLES[layout.active[slot]!]])
    }
  })

  it('drops the docks on the same breakpoint the app does', () => {
    const q = capture(app.match(/const MOBILE_QUERY = '(.+)'/), 1, 'MOBILE_QUERY in App.tsx')
    expect(skeleton()).toContain(`@media ${q}`)
  })

  it('ghosts the toolbar in the app’s own disabled shade, not an invented one', () => {
    // the point of a ghost is that it is the shade the app itself uses for a control you cannot
    // press - so both halves come from the app's rules, not from taste
    const s = skeleton()
    const button = cssRule('button')
    const disabled = cssRule('button:disabled')
    for (const decl of ['background:', 'border:', 'border-radius:']) {
      const line = button.split(String.fromCharCode(10)).find((l) => l.trim().startsWith(decl))
      expect(line, `button's ${decl}`).toBeTruthy()
      // the skeleton paints before styles.css, so it holds a token's value where the rule names the token
      const resolved = line!.trim().replace(';', '').replace(/var\(--([a-z-]+)\)/g, (_, name: string) => themeVar(name))
      expect(s, `ghost ${decl}`).toContain(resolved)
    }
    const opacity = disabled.split(String.fromCharCode(10)).find((l) => l.trim().startsWith('opacity:'))
    expect(opacity, "button:disabled's opacity").toBeTruthy()
    expect(s, 'ghost opacity').toContain(opacity!.trim().replace(';', ''))
  })

  it('leaves the desktop shell’s window buttons the room the toolbar does', () => {
    // the overlay's env(titlebar-area-*) exists from the first paint, so the skeleton can reserve the
    // strip before any script runs; if the two expressions drift, the right-hand ghosts jump at handover
    const inset = capture(
      css.match(/\.app\.desktop-shell:not\(\.desktop-mac\) \.toolbar-right \{\s*margin-right: ([^;]+);/),
      1,
      'the shell’s .toolbar-right inset',
    )
    expect(skeleton()).toContain(`margin-right: ${inset}`)
  })

  it('stands its ghosts at the height every toolbar control has', () => {
    // one height for the whole row (styles.css --toolbar-control); a ghost of another height makes the
    // handover a visible jump, which is the thing the skeleton exists to avoid
    const h = capture(css.match(/--toolbar-control: (\d+px);/), 1, 'the toolbar control height')
    const ghost = capture(skeleton().match(/\.bs-ghost \{[^}]*?height: (\d+px);/), 1, 'the ghost height')
    expect(ghost).toBe(h)
  })

  it('carries the phone tier’s own chrome, which is not just a shorter desktop', () => {
    // .app.mobile grows the toolbar by the top inset and adds a fixed bottom tab bar; both are on
    // screen the whole time, so a skeleton without them centres the logo against the wrong box
    const s = skeleton()
    const toolbar = capture(css.match(/.app.mobile .toolbar {[^}]*min-height: ([^;]+);/), 1, 'the mobile toolbar’s min-height')
    const tabbar = capture(css.match(/.mobile-tabbar {[^}]*height: ([^;]+);/), 1, 'the mobile tab bar’s height')
    expect(s, 'toolbar min-height').toContain(toolbar)
    expect(s, 'tab bar height').toContain(tabbar)
    // ...and its positioning: sticky is what lets WebKit fill the status-bar strip with the row's colour
    // instead of iOS's Liquid Glass blur, so a skeleton row that is not would blur the boot frames only
    const position = capture(css.match(/\.app\.mobile \.toolbar \{[^}]*position: ([^;]+);/), 1, 'the mobile toolbar’s position')
    expect(s, 'toolbar position').toMatch(new RegExp(`\\.bs-toolbar \\{[^}]*position: ${position};`))
    // and the app's own border-box, since styles.css is not loaded to supply it
    expect(s, 'the app’s own border-box').toContain('box-sizing: border-box')
  })

  // The tab carries the skeleton’s <title> until the first React commit swaps in the document name:
  // the project the app just opened on (App.tsx’s title effect). Same copy rule as the colours above:
  // if these two drift, every cold boot flashes one app name and settles on another.
  it('names the app the same way the title effect does', () => {
    const skeleton = capture(html.match(/<title>([^<]+)/), 1, '<title> in app/index.html')
    const appTitle = capture(app.match(/const APP_TITLE = '([^']+)'/), 1, 'APP_TITLE in App.tsx')
    expect(skeleton).toBe(appTitle)
  })

  it('is retired by App, not left to linger', () => {
    expect(app).toMatch(/useLayoutEffect\(\(\) => \{\s*document\.getElementById\('boot-skeleton'\)\?\.remove\(\)/)
  })
})
