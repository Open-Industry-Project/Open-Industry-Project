// Verify live share (docs/live-share.md): an editor streams its run, and the room's other connections draw it
// without running anything of their own.
//
// Against a real collab server (server/liveRelay.mjs relays the stream) and the demo line, it asserts:
//   - the Live switch in a solo tab makes the room and enters it in place: no reload, the popover stays open on the
//     links, Can view copies the view link, and nothing done in the room is written over the solo project
//   - a view-link tab follows the editor's run: it draws its cargo and the cargo moves, while its own store stays
//     stopped (no worker, no program) and nothing reaches the document
//   - a second editor joining mid-run is offered the run, not taken over, and once it accepts starts from the
//     server's snapshot at the same point in the run
//   - the viewer's own Play replaces the shared run, and Stop goes back to following it
//   - the editor's Stop ends the run for everyone
//
// Run: node e2e/verify-live-share.mjs [--headed]
/* global process, console, window, document, localStorage, location, navigator, URL, setTimeout, clearTimeout */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'
import { docNameFor } from './_collabRoom.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const collabPort = await freePort()
const dbPath = join(tmpdir(), `oip-collab-live-${collabPort}.sqlite`)
process.env.VITE_COLLAB_URL = `ws://localhost:${collabPort}`
const collab = spawn('node', ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(collabPort), DB_PATH: dbPath },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let collabLog = ''
collab.stderr.on('data', (d) => (collabLog += String(d)))
collab.stdout.on('data', (d) => (collabLog += String(d)))
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('collab server did not start')), 15000)
  collab.stdout.on('data', (d) => {
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
})

const { url: APP_URL } = await startServer({ isolated: true })

const waitForApp = async (page, timeout = 90000) => {
  try {
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), undefined, { timeout, polling: 500 })
  } catch (err) {
    const seen = await page
      .evaluate(() => ({ hook: Object.keys(window.__oip ?? {}), loading: document.body.className, text: document.body.innerText.slice(0, 300) }))
      .catch((e) => String(e))
    console.log('[stalled tab]', JSON.stringify(seen))
    throw err
  }
}

const joinRoom = async (page, url, bootTimeout) => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(page, bootTimeout)
  await page.waitForSelector('.collab-status.connected', { timeout: 30000 })
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 20, undefined, { timeout: 30000 })
}

/** what a tab is drawing: run state, and the cargo it last drew by id */
const drawn = (page) =>
  page.evaluate(() => {
    const ec = window.__oip.controller
    const s = window.__oip.store.getState()
    const f = ec.lastFrame
    const at = {}
    if (f) for (let i = 0; i < f.count; i++) at[f.ids[i]] = [f.positions[i * 3], f.positions[i * 3 + 1], f.positions[i * 3 + 2]]
    return { running: s.running, following: s.liveFollowing, count: f?.count ?? 0, simTime: f?.simTime ?? 0, at }
  })

/** the largest distance any body moved between two reads (m) */
const moved = (a, b) => {
  let most = 0
  for (const [id, p] of Object.entries(b.at)) {
    const q = a.at[id]
    if (q) most = Math.max(most, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))
  }
  return most
}

const browser = await chromium.launch({ headless: !HEADED })
const browsers = [browser]
const contexts = []
const newPage = async (own = false) => {
  // `own`: a browser process of its own. Tabs of one browser share its GPU process, and with two of them drawing a
  // run every frame a third one's renderer start was measured at ~70 s on this box.
  let b = browser
  if (own) browsers.push((b = await chromium.launch({ headless: !HEADED })))
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } })
  contexts.push(ctx)
  await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const page = await ctx.newPage()
  page.on('dialog', (d) => void d.accept())
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' || /unavailable|Uncaught|rejection/i.test(m.text())) console.log(`[console ${m.type()}] ${m.text().slice(0, 600)}`)
  })
  return page
}

try {
  // ── the editor: seeds the room with the demo, shares, runs, and starts the line ──
  // Go live from the untouched demo, as a user would: the Live switch makes the room (seeded with the demo) and enters
  // it in place, already live
  const editor = await newPage()
  await editor.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await editor.goto(`${APP_URL}?scene=demo`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(editor)
  await editor.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 20, undefined, { timeout: 30000 })
  await editor.locator('button.share-button').click()
  const soloProject = await editor.evaluate(() => {
    window.__noReload = true // a reload would drop it
    return localStorage.getItem('oip-web/project')
  })
  await editor.locator('[data-testid=share-live-switch]').click()
  await editor.waitForFunction(() => window.__oip.store.getState().collab && window.__oip.store.getState().liveSharing, undefined, { timeout: 30000 })
  await editor.waitForSelector('.collab-status.connected', { timeout: 30000 })
  check('the Live switch entered the room in place: no reload', await editor.evaluate(() => window.__noReload === true && new URL(location.href).searchParams.has('room')))
  const ROOM = new URL(editor.url()).searchParams.get('room')
  const VIEW_URL = `${APP_URL}?room=${docNameFor(ROOM)}&view=1`
  check('the popover stayed open on the links, saying it is live', (await editor.locator('.share-popover').isVisible()) && /You're live/.test(await editor.locator('.share-popover-status').innerText().catch(() => '')))
  check('the switch shows live in the Share popover', (await editor.locator('[data-testid=share-live-switch]').getAttribute('aria-checked')) === 'true')
  await editor.locator('button.share-option', { hasText: 'Can view' }).click()
  const copied = await editor.evaluate(() => navigator.clipboard.readText()).catch(() => '')
  check('Can view copies the view link', new URL(copied || 'about:blank').searchParams.get('room') === docNameFor(ROOM), copied)
  await editor.waitForTimeout(800) // the popover closes itself after a copy
  check('the editor says it is live beside Play', (await editor.evaluate(() => window.__oip.store.getState().liveSharing)) && /^live$/i.test(await editor.locator('[data-testid=live-chip]').innerText()))
  await editor.locator('[data-testid=live-chip]').click()
  check('the Live badge opens Share, where the switch is, and does not stop the stream', (await editor.locator('.share-popover').isVisible()) && (await editor.evaluate(() => window.__oip.store.getState().liveSharing)))
  await editor.keyboard.press('Escape')
  const viewer = await newPage()
  await joinRoom(viewer, VIEW_URL)
  const viewerDoc0 = await viewer.evaluate(() => JSON.stringify(window.__oip.store.getState().scene))
  const programs = [await editor.evaluate(() => window.__oip.store.getState().stProgram), await viewer.evaluate(() => window.__oip.store.getState().stProgram)]
  check("the room holds the editor's program, seeded in place", programs[0].length > 100 && programs[0] === programs[1], `${programs[0].length} / ${programs[1].length} chars`)
  await viewer.waitForSelector('[data-testid=live-chip]', { timeout: 15000 }).catch(() => {})
  const waitingText = await viewer.locator('[data-testid=live-chip]').innerText().catch(() => '')
  check('before the first run, a viewer is told someone is live and a run is coming', /is live · waiting for a run$/.test(waitingText), waitingText)

  await editor.evaluate(() => window.__oip.controller.run())
  await editor.waitForFunction(() => (window.__oip.controller.lastFrame?.count ?? 0) > 0, undefined, { timeout: 60000 })
  await editor.evaluate(() => {
    const start = window.__oip.store.getState().scene.parts.find((p) => p.name === 'Start')
    if (start) window.__oip.controller.sim.usePart(start.id)
  })

  // ── the view-link tab follows it ──
  await viewer.waitForFunction(() => window.__oip.store.getState().liveFollowing, undefined, { timeout: 20000 }).catch(() => {})
  const v0 = await drawn(viewer)
  check('the view-link tab follows the shared run', v0.following, JSON.stringify({ following: v0.following, count: v0.count }))
  check("the viewer runs nothing of its own (its store stays stopped)", !v0.running)
  await viewer.waitForTimeout(4000)
  const v1 = await drawn(viewer)
  const e1 = await drawn(editor)
  check('the viewer draws the run\'s cargo', v1.count > 50 && Math.abs(v1.count - e1.count) < 20, `viewer ${v1.count}, editor ${e1.count}`)
  check('the cargo the viewer draws moves', moved(v0, v1) > 0.2, `${moved(v0, v1).toFixed(2)} m`)
  check('the viewer plays close behind the editor', e1.simTime - v1.simTime < 1.5 && v1.simTime > 0, `editor ${e1.simTime.toFixed(2)} s, viewer ${v1.simTime.toFixed(2)} s`)
  check('the chip says whose run the viewer is watching', /^Watching \S/.test(await viewer.locator('[data-testid=live-chip]').innerText()))
  const counters = await viewer.evaluate(() => window.__oip.controller.plcGlobalTags)
  const editorCases = await editor.evaluate(() => window.__oip.controller.plcGlobalTags?.['Main.Cases'] ?? window.__oip.controller.plcGlobalTags?.Cases)
  const viewerCases = counters?.['Main.Cases'] ?? counters?.Cases
  check("the viewer reads the sharer's PLC variables, so a counter on a note is not blank", typeof viewerCases === 'number' && Math.abs(viewerCases - editorCases) <= 2, `viewer ${viewerCases}, editor ${editorCases}`)
  const sharerChip = await editor.locator('[data-testid=live-chip]').innerText()
  check('the sharer sees how many are watching', /^Live · 1 watching$/i.test(sharerChip), sharerChip)
  // who is here, by name (PresenceStack): the sharer reads as live, not as someone running their own copy
  await viewer.locator('[data-testid=presence]').click()
  const people = await viewer.locator('[data-testid=people-list]').innerText().catch(() => '')
  check('the presence list names the sharer as live', /live/.test(people) && !/running their own copy/.test(people), people.replace(/\n/g, ' | '))
  await viewer.keyboard.press('Escape')
  const viewerMenu = await viewer.locator('.project-menu').first().innerText().catch(() => '')
  check('the viewer sees what it is in by name, not as a room', viewerMenu.trim() === 'Palletizing demo', viewerMenu)

  // ── a second editor joining mid-run is offered the run, and starts from the snapshot once it accepts ──
  await editor.waitForTimeout(3000)
  const late = await newPage(true)
  await joinRoom(late, `${APP_URL}?room=${ROOM}`, 180000)
  await late.waitForSelector('[data-testid=live-chip]', { timeout: 20000 }).catch(() => {})
  await late.waitForTimeout(1500)
  const offered = await late.locator('[data-testid=live-chip]').innerText().catch(() => '')
  check('an editor is offered the live run, not taken over by it', !(await drawn(late)).following && /is live · Watch$/.test(offered), offered)
  await late.locator('[data-testid=live-chip]').click()
  await late.waitForFunction(() => window.__oip.store.getState().liveFollowing, undefined, { timeout: 20000 }).catch(() => {})
  await late.waitForTimeout(1500)
  const l = await drawn(late)
  const e2 = await drawn(editor)
  check('after Watch, the editor follows the run at once', l.following && l.count > 50 && Math.abs(l.count - e2.count) < 20, `late ${l.count}, editor ${e2.count}`)
  check('the late editor is at the same point in the run', e2.simTime - l.simTime < 1.5, `editor ${e2.simTime.toFixed(2)} s, late ${l.simTime.toFixed(2)} s`)
  await late.locator('button.share-button').click()
  const sw = late.locator('[data-testid=share-live-switch]')
  const taken = await sw.innerText().catch(() => '')
  check('the second editor is told who is live, and cannot go live over them', /is live/.test(taken) && (await sw.isDisabled()), taken.split(String.fromCharCode(10))[0])
  await late.locator('button.share-button').click()
  await late.locator('.live-chip-stop').click()
  check('Stop watching takes the editor back to the design', !(await drawn(late)).following)

  // ── the viewer's own Play replaces the shared run; Stop goes back to following ──
  await viewer.evaluate(() => window.__oip.controller.run())
  await viewer.waitForFunction(() => window.__oip.store.getState().running, undefined, { timeout: 20000 })
  const own = await drawn(viewer)
  check("the viewer's Play runs its own copy and stops following", own.running && !own.following)
  await viewer.waitForTimeout(1500)
  await viewer.evaluate(() => window.__oip.controller.stop())
  await viewer.waitForFunction(() => window.__oip.store.getState().liveFollowing, undefined, { timeout: 10000 }).catch(() => {})
  check("after the viewer's Stop it follows the shared run again", (await drawn(viewer)).following)

  // ── the editor's Stop ends it for everyone ──
  await editor.evaluate(() => window.__oip.controller.stop())
  await viewer.waitForFunction(() => !window.__oip.store.getState().liveFollowing, undefined, { timeout: 10000 }).catch(() => {})
  check('Stop on the editor ends the run for every viewer', !(await drawn(viewer)).following)
  check('the view is back to the design after the run (no cargo drawn from it)', (await viewer.evaluate(() => window.__oip.controller.lastFrame)) === null)
  const viewerDoc1 = await viewer.evaluate(() => JSON.stringify(window.__oip.store.getState().scene))
  check("the shared run never reached the viewer's document", viewerDoc0 === viewerDoc1)
  check('the server refused nothing', !/\[live\] refused/.test(collabLog), collabLog.match(/\[live\].*/)?.[0] ?? '')
  // switching Live off ends the stream for everyone, and a viewer is told rather than left with a design
  await editor.evaluate(() => window.__oip.store.setState({ liveSharing: false }))
  await viewer.waitForSelector('.live-chip.ended', { timeout: 10000 }).catch(() => {})
  const ended = await viewer.locator('[data-testid=live-chip]').innerText().catch(() => '')
  check('a viewer is told when the stream ends', /stopped streaming$/.test(ended), ended)
  // an edit in the room goes to the room, never to the solo project the tab came from
  await editor.evaluate(() => {
    const st = window.__oip.store
    const s = st.getState().scene
    st.commit('Add part', { ...s, parts: [...s.parts, { id: 'room_only', type: 'group', position: [0, 0.75, 0], rotationY: 0, params: {} }] })
  })
  await editor.waitForTimeout(1500)
  check('nothing done in the room was written over the solo project', (await editor.evaluate(() => localStorage.getItem('oip-web/project'))) === soloProject)
  check('...and the edit reached the room', await viewer.evaluate(() => window.__oip.store.getState().scene.parts.some((p) => p.id === 'room_only')))
  // the shared demo is owned by whoever shared it: they can stop sharing it, which closes it for everyone
  await editor.locator('button.share-button').click()
  await editor.locator('[data-testid=share-stop-sharing]').click()
  await editor.waitForFunction(() => !new URL(location.href).searchParams.has('room'), undefined, { timeout: 30000 }).catch(() => {})
  await waitForApp(editor)
  check('Stop sharing the demo goes back to the demo on one\'s own', await editor.evaluate(() => !window.__oip.store.getState().collab && new URL(location.href).searchParams.get('scene') === 'demo'))
  await viewer.waitForFunction(() => !new URL(location.href).searchParams.has('room'), undefined, { timeout: 30000 }).catch(() => {})
  await waitForApp(viewer)
  check('...and the viewer is sent back, told it was closed', /shared project was closed/.test(await viewer.evaluate(() => document.body.innerText)))
} catch (err) {
  failures++
  console.log(`FAIL  ${err.stack ?? err}`)
} finally {
  for (const c of contexts) await c.close().catch(() => {})
  for (const b of browsers) await b.close().catch(() => {})
  collab.kill()
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
