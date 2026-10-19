// Orbit probe for render bundles (production code, no monkeypatches): shots before/after an
// aggressive orbit + zoom, plus partsGroup.version and drawCalls during the motion.
// Success = pixels track the camera, version ~stable (replay, no per-frame re-records),
// draws stay low while orbiting.
/* global process, console, window */
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'
import { cleanShot } from '../_shot.mjs'

const { port, vite } = await startServer()

async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--disable-features=CalculateNativeWinOcclusion'] })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('PAGE ERR:', m.text().slice(0, 200))
  })
  try {
    await page.goto(`http://localhost:${port}/app/?scene=demo&webgpu`)
    await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 30000 })
    await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 45000 })
    await page.waitForTimeout(2500)

    const before = await page.evaluate(() => ({
      version: window.__oip.view.partsGroup.version,
      visible: window.__oip.view.partsGroup.children.filter((c) => c.visible).length,
    }))
    await cleanShot(page, 'e2e/shots/bundle-cam-A.png', { deselect: false })

    // aggressive orbit: ~180° both directions + zoom
    await page.mouse.move(800, 475)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(1500, 600, { steps: 30 })
    await page.mouse.move(300, 350, { steps: 40 })
    await page.mouse.up({ button: 'right' })
    const during = await page.evaluate(() => ({
      version: window.__oip.view.partsGroup.version,
      draws: window.__oip.view.getStats().drawCalls,
    }))
    await page.waitForTimeout(300)
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(1200)

    const after = await page.evaluate(() => ({
      version: window.__oip.view.partsGroup.version,
      draws: window.__oip.view.getStats().drawCalls,
    }))
    await cleanShot(page, 'e2e/shots/bundle-cam-B.png', { deselect: false })
    console.log(`pre-orbit:  version=${before.version} visibleChildren=${before.visible}`)
    console.log(`mid-orbit:  version=${during.version} draws=${during.draws}`)
    console.log(`post-orbit: version=${after.version} draws=${after.draws}`)
    console.log('shots: bundle-cam-A.png / bundle-cam-B.png')
  } finally {
    await browser.close()
    vite.kill()
  }
}

main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(1)
})
