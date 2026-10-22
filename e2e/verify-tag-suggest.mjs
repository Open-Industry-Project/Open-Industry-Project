// Verify a tag field's suggestions (src/editor/components/inspector/tagField.tsx): the scene's tags, the program's
// (of the field's type only), and, when the external link is OPC UA, the PLC's. The PLC's tags are read on request
// while stopped, listed only once something is typed, and picked by click or keyboard into the param. A tag the
// PLC does not hold gets a "not on PLC" chip. The PLC is a fake OPC UA host handed to the controller
// (controller.opcUaHost is public for this): this tests the field, not the wire, which verify-external-plc-electron covers.
// Run: node e2e/verify-tag-suggest.mjs [--headed]
/* global process, console, window, localStorage, document */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const PROGRAM = `VAR
  Start : BOOL;
  Speed : REAL;
END_VAR
`

const TWO_LINES = `PROGRAM Line
VAR
  Run : BOOL;
  Speed : REAL;
END_VAR
END_PROGRAM
CONFIGURATION Cell
  RESOURCE Cpu ON PLC
    TASK Fast (INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM Line1 WITH Fast : Line;
    PROGRAM Line2 WITH Fast : Line;
  END_RESOURCE
END_CONFIGURATION
`

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const ready = () => page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), { timeout: 30000 })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await ready()
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await ready()

    const built = await page.evaluate((src) => {
      const { store, getPackage } = window.__oip
      const belt = getPackage('oip.belt-conveyor')
      if (!belt) return { ok: false, why: 'belt package not registered' }
      store.loadScene({
        version: 4,
        packages: [belt],
        parts: [
          { id: 'b1', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, 0], rotationY: 0, params: { enableComms: true, runTag: 'Motor' } },
          { id: 'b2', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, 3], rotationY: 0, params: { enableComms: true, runTag: '' } },
        ],
      })
      store.loadStProgram(src, { persist: false })
      store.select('b2')
      return { ok: true }
    }, PROGRAM)
    check('scene with two belts and a program', built.ok, built.why ?? '')

    const field = page.locator('label.field', { has: page.locator('.field-label', { hasText: /^Run tag/i }) }).locator('input[data-testid="tag-field"]')
    await field.waitFor({ timeout: 30000 })
    const list = page.getByTestId('tag-suggest')
    const names = (section) => list.getByTestId(`tag-suggest-${section}`).getByTestId('tag-suggest-item').allTextContents()

    // ---- scene + program, no PLC section while the link is not OPC UA
    await field.click()
    await list.waitFor({ timeout: 5000 })
    await page.waitForFunction(() => !!document.querySelector('[data-testid="tag-suggest-program"]'), { timeout: 10000 }).catch(() => {})
    const scene = await names('scene')
    const program = await names('program')
    check('the scene section offers the tag another belt uses', scene.some((t) => t.startsWith('Motor')), JSON.stringify(scene))
    check('the program section offers its BOOL, not its REAL', program.some((t) => t.startsWith('Start')) && !program.some((t) => t.startsWith('Speed')), JSON.stringify(program))
    check('no PLC section while the link is not OPC UA', (await list.getByTestId('tag-suggest-plc').count()) === 0)
    await page.keyboard.press('Escape')
    check('Escape closes the list', (await list.count()) === 0)
    await page.keyboard.press('Escape')

    // ---- a fake OPC UA PLC: a tree nested a few folders deep, with two Motor1s, an array and a structure
    await page.evaluate(() => {
      const { store, controller } = window.__oip
      const base = ['DeviceSet', 'Example Soft PLC', 'Resources', 'App', 'Programs']
      const v = (...p) => ({ path: [...base, ...p], nodeId: `ns=4;s=${p.join('.')}` })
      window.__fakeUa = { connects: 0, closes: 0 }
      controller.opcUaHost = {
        connect: async () => {
          window.__fakeUa.connects++
          return { error: '' }
        },
        browse: async () => ({
          error: '',
          truncated: false,
          variables: [v('Main', 'Motor3'), v('Line2', 'Motor1'), v('Line3', 'Motor1'), v('Main', 'PhotoEye_1'), v('Main', 'Lanes', '[0]'), v('Main', 'Drive'), v('Main', 'Drive', 'Run')],
        }),
        describe: async () => ({ error: '', nodes: [] }),
        exchange: async () => ({ error: '' }),
        close: async () => {
          window.__fakeUa.closes++
        },
        onClosed: () => () => {},
      }
      store.setExternalPlc({ mode: 'opcua', opcUaEndpoint: 'opc.tcp://fake-plc:4840' })
    })

    await field.click()
    await list.waitFor({ timeout: 5000 })
    const read = list.getByTestId('tag-suggest-plc').getByTestId('tag-suggest-action')
    check('the PLC section offers to read its tags', (await read.textContent())?.includes('Read the PLC') === true, (await read.textContent()) ?? '')
    await read.click()
    await page.waitForFunction(() => /On the PLC \(\d+ tags?\)/.test(document.querySelector('[data-testid="tag-suggest-plc"]')?.textContent ?? ''), { timeout: 5000 }).catch(() => {})
    const plcText = (await list.getByTestId('tag-suggest-plc').textContent()) ?? ''
    // Motor3, Line2.Motor1, Line3.Motor1, PhotoEye_1, Drive.Run: the array element and the structure are left out
    check('the PLC\'s bindable tags were read', /On the PLC \(5 tags\)/.test(plcText), plcText.slice(0, 120))
    check('nothing typed: the PLC\'s tags are not listed yet', (await names('plc')).length === 0)
    const fake = await page.evaluate(() => window.__fakeUa)
    check('the read connected once and let go', fake.connects === 1 && fake.closes === 1, JSON.stringify(fake))

    await page.keyboard.type('motor1')
    const plc = await names('plc')
    check('typing lists the PLC\'s matches, each by a name that tells it apart', JSON.stringify(plc) === JSON.stringify(['Line2.Motor1', 'Line3.Motor1']), JSON.stringify(plc))
    await list.getByTestId('tag-suggest-item').filter({ hasText: 'Line3.Motor1' }).click()
    let tag = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'b2').params.runTag)
    check('a click writes the picked name into the param', tag === 'Line3.Motor1', tag)
    check('and closes the list', (await list.count()) === 0)

    // keyboard: arrow to a match and Enter
    await field.click()
    await field.fill('')
    await page.keyboard.type('motor3')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    tag = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'b2').params.runTag)
    check('ArrowDown + Enter picks the first match', tag === 'Motor3', tag)

    // ---- a tag the PLC does not hold
    await field.click()
    await field.fill('PhotoEye1')
    // Enter with no suggestion highlighted takes the text as typed (Escape would cancel the edit, as in any field)
    await page.keyboard.press('Enter')
    tag = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'b2').params.runTag)
    check('a typed name is still taken as typed', tag === 'PhotoEye1', tag)
    const badge = page.getByTestId('tag-plc-badge')
    await badge.waitFor({ timeout: 3000 }).catch(() => {})
    const badgeText = (await badge.count()) ? await badge.textContent() : null
    const badgeTitle = (await badge.count()) ? await badge.getAttribute('title') : null
    check('it carries a "not on PLC" chip', badgeText === 'not on PLC', String(badgeText))
    check('naming the closest tag', /Closest: PhotoEye_1/.test(badgeTitle ?? ''), String(badgeTitle))

    // the other belt's tag is bound to a name the PLC does not hold either; back in serve mode there is no chip at all
    await page.evaluate(() => window.__oip.store.setExternalPlc({ mode: 'serve' }))
    await page.waitForTimeout(200)
    check('no PLC chip once the link is not OPC UA', (await badge.count()) === 0)

    // ---- two instances of one program: each instance's variables, by the qualified names wiring binds
    await page.evaluate((src) => window.__oip.store.loadStProgram(src, { persist: false }), TWO_LINES)
    await field.click()
    await list.waitFor({ timeout: 5000 })
    await page.waitForFunction(() => /Line2\.Run/.test(document.querySelector('[data-testid="tag-suggest-program"]')?.textContent ?? ''), { timeout: 10000 }).catch(() => {})
    const instances = await names('program')
    check("two instances: the program section offers each one's BOOL", instances.some((t) => t.startsWith('Line1.Run')) && instances.some((t) => t.startsWith('Line2.Run')) && !instances.some((t) => t.includes('Speed')), JSON.stringify(instances))
    await page.keyboard.press('Escape')
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  vite.kill()
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
