// Verifies in the running app that the shipped "Floor Marking" (oip.floor-marking) carries the declarative
// `edges` snap kind, i.e. the app's own bundle loader (bundledExamples → buildPackage → registerPackage) baked
// snap.tile into the live package the editor snaps against. This is the app-level companion to the deterministic
// src/sim/floorMarkingSnap.test.ts (which checks two real markings tile edge-to-edge identically to the built-in):
// the unit test checks the snap math on the real package; this checks the running editor loaded it with the snap
// wired. (A catalog drag-place is not used: SDK-specific cards register on a late async pass the drag harness
// can't reliably wait on (see the note in verify-sdk-sensor-snap.mjs); the built-in marking snaps via a
// different, type-keyed path, so it can't substitute here.)
// Run: node e2e/verify-sdk-marking-snap.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && !benign(m.text()) && errors.push(m.text()))

  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
    await page.waitForTimeout(3500) // let the bundled SDK part packages finish registering

    // Pull the live package the editor holds for the shipped SDK marking, and its declared snap block.
    const snap = await page.evaluate(() => {
      const pkgs = window.__oip.store.getState().bundledPackages ?? []
      const p = pkgs.find((x) => x.id === 'oip.floor-marking')
      return p ? { found: true, snap: p.snap ?? null } : { found: false }
    })

    check('the shipped SDK marking is registered in the running app', snap.found)
    check('the app-loaded package carries a declarative tile snap', !!snap.snap?.tile, `snap=${JSON.stringify(snap.snap)}`)
    check('tile.group tiles with other floor markings', snap.snap?.tile?.group === 'floorMarking', `group=${snap.snap?.tile?.group}`)
    check('tile names the length/width rectangle params', snap.snap?.tile?.lengthParam === 'length' && snap.snap?.tile?.widthParam === 'width')
    check('tile.cornerFlush matches the built-in overhang behaviour', snap.snap?.tile?.cornerFlush === true)
    check('no runtime/console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('verify crashed:', err)
  process.exit(2)
})
