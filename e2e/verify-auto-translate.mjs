// Proves the editor's translation by the browser (src/editor/autoTranslate.ts) end to end, with a fake Translator,
// since headless Chromium has no on-device model:
//
//   node e2e/verify-auto-translate.mjs
//
// A German browser is asked once, the click downloads and translates, and a reload shows the toolbar translated.
// What a program or file matches stays as written: part names in the scene tree and the program text. Choosing
// English in Settings turns it off for the next load. The fake wraps every message in «», so English that leaked
// through and identifiers that were wrongly translated both show.
/* global process, console, window, document, localStorage, EventTarget, Event, URL */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

let failed = false
const check = (label, ok, detail = '') => {
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`)
}

/** Installed before the app's scripts. The model counts as downloaded once a click created a translator. */
function fakeTranslator() {
  const downloaded = () => localStorage.getItem('e2e/translator-downloaded') === '1'
  const sent = []
  Object.defineProperty(window, '__translatorSent', { value: sent })
  Object.defineProperty(window, 'Translator', {
    value: {
      availability: async ({ targetLanguage }) => (targetLanguage.startsWith('de') ? (downloaded() ? 'available' : 'downloadable') : 'unavailable'),
      create: async ({ monitor }) => {
        if (!downloaded()) {
          const target = new EventTarget()
          monitor?.(target)
          const progress = new Event('downloadprogress')
          Object.defineProperty(progress, 'loaded', { value: 1 })
          target.dispatchEvent(progress)
          localStorage.setItem('e2e/translator-downloaded', '1')
        }
        return {
          translate: async (s) => {
            sent.push(s)
            return `«${s}»`
          },
        }
      },
    },
  })
}

const { url, vite } = await startServer()
const browser = await chromium.launch()
const errors = []
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'de-DE' })
  await ctx.addInitScript(fakeTranslator)
  // the boot skeleton's tabs as parsing ends, before the deferred app scripts run and replace the skeleton
  await ctx.addInitScript(() => {
    document.addEventListener('readystatechange', () => {
      if (document.readyState !== 'interactive') return
      Object.defineProperty(window, '__skeletonTabs', { value: [...document.querySelectorAll('#boot-skeleton .bs-tab')].map((s) => s.textContent) })
    })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  const demo = new URL('?scene=demo', url).href
  const ready = () => !!(window.__oip?.store && window.__oip.store.getState().scene.parts.length > 0)

  // 1. first visit: English, and the question
  await page.goto(demo)
  await page.waitForFunction(ready, null, { timeout: 60000 })
  const accept = page.getByTestId('translate-accept')
  await accept.waitFor({ timeout: 20000 })
  check('a German browser is asked once', true, await page.getByTestId('translate-toast').innerText())
  check('the page is English until then', (await page.locator('button[aria-label="Settings"]').count()) === 1)

  // 2. the click downloads and translates; the toast offers a reload
  await accept.click()
  await page.getByTestId('translate-reload').waitFor({ timeout: 120000 })
  const sent = await page.evaluate(() => window.__translatorSent)
  check('the messages went to the translator', sent.length > 300, `${sent.length} sent`)
  check('…with numbered placeholders, not names', !sent.some((s) => /\{[A-Za-z]\w*\}/.test(s)))

  // 3. after a reload the first render is translated, and identifiers are not
  await page.reload()
  await page.waitForFunction(ready, null, { timeout: 60000 })
  check('the toolbar renders translated', (await page.locator('button[aria-label="«Settings»"]').count()) === 1)
  const tabs = await page.evaluate(() => ({
    skeleton: window.__skeletonTabs ?? [],
    app: [...document.querySelectorAll('.dock-slot-tab')].map((e) => e.textContent.trim()).filter(Boolean),
  }))
  check('the dock tabs render translated', tabs.app.includes('«Parts»') && tabs.app.includes('«Scene»'), tabs.app.join(' / '))
  check('…and so does the boot skeleton, before the app runs', tabs.skeleton.length > 0 && tabs.skeleton.every((s) => s.startsWith('«')), tabs.skeleton.join(' / '))
  check('the page says its language', (await page.evaluate(() => document.documentElement.lang)) === 'de-DE')
  check('…and still opts out of page translation', (await page.evaluate(() => document.documentElement.getAttribute('translate'))) === 'no')
  const kept = await page.evaluate(() => {
    const names = window.__oip.store.getState().scene.parts.map((p) => p.name).filter(Boolean)
    const tree = document.querySelector('.scene-tree')?.textContent ?? ''
    return { names: names.length, shown: names.filter((n) => tree.includes(n)).length, wrapped: names.filter((n) => tree.includes(`«${n}`)).length }
  })
  check('part names in the scene tree stay as written', kept.shown > 0 && kept.wrapped === 0, `${kept.shown} of ${kept.names} shown, ${kept.wrapped} translated`)
  const program = await page.evaluate(() => window.__oip.store.getState().stProgram)
  check('the program text is untouched', program.length > 0 && !program.includes('«'))
  check('no question on a visit with the model on hand', (await page.getByTestId('translate-accept').count()) === 0)

  // 4. English in Settings sticks for the next load
  await page.locator('button[aria-label="«Settings»"]').click()
  const select = page.getByTestId('setting-language')
  await select.waitFor({ timeout: 10000 })
  check('Settings offers the browser language by its own name', (await select.locator('option[value="auto"]').innerText()).includes('Deutsch'))
  await select.selectOption('en')
  await page.reload()
  await page.waitForFunction(ready, null, { timeout: 60000 })
  check('English chosen: the next load is English', (await page.locator('button[aria-label="Settings"]').count()) === 1)

  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  vite.kill()
}
if (failed) {
  console.log('FAIL')
  process.exit(1)
}
console.log('PASS')
