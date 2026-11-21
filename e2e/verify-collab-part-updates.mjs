// Part updates in a shared project (docs/part-sources.md "Rooms"): a room holds one set of parts, so an update one
// person takes is everyone's, and the prompt says truthfully which parts the room changed.
//
// A solo project is planted holding older copies of two built-ins: the Belt Conveyor untouched since, the Roller
// Conveyor also changed in the project. Its tab shares it as a room and a second person joins. Then:
//   - both are asked, and both still run the room's copies;
//   - Update all names only the Roller Conveyor as changed here. The Belt Conveyor declares an empty materials list,
//     which a room once dropped, so every such part read as edited;
//   - after one person's Update all, the other runs the app's versions and is no longer asked, without doing
//     anything, and so does someone who joins later.
//
// Run: node e2e/verify-collab-part-updates.mjs [--headed]
/* global process, console, setTimeout, window, document, localStorage */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'
import { editSecret, markSeeder } from './_collabRoom.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}

// --- collab server on a free port; the client picks it up via VITE_COLLAB_URL ---
const collabPort = await freePort()
process.env.VITE_COLLAB_URL = `ws://localhost:${collabPort}`
const collab = spawn('node', ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(collabPort), DB_PATH: join(tmpdir(), `oip-collab-part-updates-${collabPort}.sqlite`) },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
collab.stderr.on('data', (d) => process.stderr.write(`[collab] ${d}`))
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('collab server did not start')), 15000)
  collab.stdout.on('data', (d) => {
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
})
// isolated: VITE_COLLAB_URL is read by the dev server's config, so a shared server would point at the wrong room server
const { url: APP_URL, vite } = await startServer({ isolated: true })
const ROOM = editSecret(`verify-part-updates-${collabPort}`)

const OLD = '\n// as an older build shipped it\n'
const MINE = '\n// and changed in this project\n'
const BELT = 'oip.belt-conveyor'
const ROLLERS = 'oip.roller-conveyor'
const NOTICE = '[data-testid="part-updates-notice"]'
const booted = (p) => p.waitForFunction(() => window.__oip?.controller && window.__oip.store.getState().bundledPackages.length > 2, null, { timeout: 180000 })
const inRoom = (p) => p.waitForFunction(() => !!window.__oip.store.getState().collab && window.__oip.store.getState().scene.parts.length >= 2, null, { timeout: 60000 })
/** does this client run the app's version of each part, and is it asked? */
const stateOf = (p) =>
  p.evaluate(
    ([ids, sel]) => {
      const s = window.__oip.store.getState()
      const runsApp = ids.every((id) => (window.__oip.getPackage(id)?.behavior ?? '') === (s.bundledPackages.find((x) => x.id === id)?.behavior ?? null))
      const runsRoom = ids.every((id) => (window.__oip.getPackage(id)?.behavior ?? '') !== (s.bundledPackages.find((x) => x.id === id)?.behavior ?? null))
      return { runsApp, runsRoom, asked: !!document.querySelector(sel) }
    },
    [[BELT, ROLLERS], NOTICE],
  )
const updated = (p) =>
  p.waitForFunction(
    ([ids, sel]) => {
      const s = window.__oip.store.getState()
      return !document.querySelector(sel) && ids.every((id) => (window.__oip.getPackage(id)?.behavior ?? '') === s.bundledPackages.find((x) => x.id === id)?.behavior)
    },
    [[BELT, ROLLERS], NOTICE],
    { timeout: 30000 },
  )

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
let harness = null
try {
  const questions = []
  const open = async (tag) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    const p = await ctx.newPage()
    p.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}`))
    p.on('dialog', (d) => {
      questions.push(d.message())
      void d.accept()
    })
    return p
  }

  // ── a solo project whose copies of two built-ins are older than this app's ──────────────────────
  const a = await open('A')
  // a fresh server transforms the whole module graph on the first load
  await a.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await booted(a)
  const planted = await a.evaluate(
    async ([old, mine, beltId, rollersId]) => {
      const { partFingerprint } = await import('/src/core/parts/partOrigin.ts')
      const { PROJECT_VERSION } = await import('/src/core/project/project.ts')
      const s = window.__oip.store.getState()
      const belt = s.bundledPackages.find((p) => p.id === beltId)
      const rollers = s.bundledPackages.find((p) => p.id === rollersId)
      if (!belt || !rollers) return 'the app has no belt or roller conveyor to plant'
      // the fix this gate guards is about a part with an empty materials list and nothing else heavy
      if (!Array.isArray(belt.materials) || belt.materials.length > 0 || belt.assets?.length) return 'the belt conveyor no longer has an empty materials list: plant another part'
      const olderBelt = { ...belt, behavior: belt.behavior + old }
      const beltCopy = { ...olderBelt, origin: { app: partFingerprint(olderBelt) } }
      const olderRollers = { ...rollers, behavior: rollers.behavior + old }
      const rollersCopy = { ...olderRollers, behavior: olderRollers.behavior + mine, origin: { app: partFingerprint(olderRollers) } }
      const at = (id, packageId, x) => ({ id, type: 'part', packageId, name: id, position: [x, 0, 0], rotationY: 0, params: {} })
      const doc = { version: PROJECT_VERSION, name: 'Room update probe', packages: [beltCopy, rollersCopy], stProgram: '', scene: { version: 4, parts: [at('belt', belt.id, 0), at('rollers', rollers.id, 4)] } }
      localStorage.setItem('oip-web/project', JSON.stringify(doc))
      return { belt: belt.name, rollers: rollers.name }
    },
    [OLD, MINE, BELT, ROLLERS],
  )
  if (typeof planted === 'string') throw new Error(planted)
  await a.reload()
  await booted(a)
  await a.locator(NOTICE).waitFor({ timeout: 30000 })

  // ── A shares it: the tab that minted the room seeds it from its solo document ───────────────────
  await markSeeder(a, ROOM)
  await a.goto(`${APP_URL}?room=${ROOM}`, { timeout: 180000 })
  await booted(a)
  await inRoom(a)
  await a.locator(NOTICE).waitFor({ timeout: 30000 })

  const b = await open('B')
  await b.goto(`${APP_URL}?room=${ROOM}`, { timeout: 180000 })
  await booted(b)
  await inRoom(b)
  await b.locator(NOTICE).waitFor({ timeout: 30000 }).catch(() => {})
  const b0 = await stateOf(b)
  check('the second person is asked too', b0.asked)
  check("...and still runs the room's copies", b0.runsRoom)

  // ── one person's Update all ────────────────────────────────────────────────────────────────────
  await a.locator('[data-testid="part-updates-all"]').click()
  await updated(a)
  const question = questions[0] ?? ''
  const changedHere = question.split('?')[1]?.split(/ (?:was|were) changed in this project/)[0] ?? ''
  check('Update all says everyone in the shared project gets the change', question.includes('Everyone in this shared project gets the change'), question)
  check('...and names the part the room changed', changedHere.includes(planted.rollers), question)
  check('...and not the one nobody touched', !changedHere.includes(planted.belt), question)
  await updated(b).catch(() => {})
  const b1 = await stateOf(b)
  check("the other person runs the app's versions without doing anything", b1.runsApp)
  check('...and is no longer asked', !b1.asked)

  // ── someone who joins later ────────────────────────────────────────────────────────────────────
  const c = await open('C')
  await c.goto(`${APP_URL}?room=${ROOM}`, { timeout: 180000 })
  await booted(c)
  await inRoom(c)
  await c.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })
  const c0 = await stateOf(c)
  check("a later joiner runs the app's versions and is not asked", c0.runsApp && !c0.asked, JSON.stringify(c0))
} catch (e) {
  // printed without a leading FAIL: the gate runner reports a script that broke on its own assumptions as HARNESS
  harness = e
  console.error('harness error:', e instanceof Error ? e.message : e)
} finally {
  await browser.close()
  vite.kill()
  collab.kill()
}
if (harness) process.exit(2)
console.log(failures ? `FAIL  verify-collab-part-updates (${failures})` : 'PASS  verify-collab-part-updates')
process.exit(failures ? 1 : 0)
