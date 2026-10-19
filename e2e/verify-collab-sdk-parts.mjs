// End-to-end check: a real scene survives a collab room.
//
// Every piece of equipment (conveyor, sensor, robot) is an SDK part: `type: 'part'` plus a
// `packageId`, with params driven by that package's schema rather than PART_DEFS. A collab schema
// that writes only the built-in scalar fields and walks `PART_DEFS['part'].params` (empty by design)
// materializes every part in a room with no package and no params: the "all my parts turned into
// white blocks" symptom. It hits the room creator too, because the room boot re-reads its own freshly
// seeded doc through docToScene before the first paint.
//
// The other collab tests (unit + e2e) use `group`/`building` fixtures, which need no package, so
// none of them covers this path. This one loads the actual PLC demo, persists it
// as the solo scene, then opens a room against it and asserts the parts come back whole - on
// the creator AND on a joiner.
//
// Run: node e2e/verify-collab-sdk-parts.mjs [--headed]
/* global process, console, setTimeout */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'
import { editSecret, markSeeder } from './_collabRoom.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// --- collab server on a free port; the client picks it up via VITE_COLLAB_URL ---
const collabPort = await freePort()
const dbPath = join(tmpdir(), `oip-collab-sdk-${collabPort}.sqlite`)
process.env.VITE_COLLAB_URL = `ws://localhost:${collabPort}`
const collab = spawn('node', ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(collabPort), DB_PATH: dbPath },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
collab.stderr.on('data', (d) => process.stderr.write(`[collab] ${d}`))
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('collab server did not start')), 15000)
  collab.stdout.on('data', (d) => {
    process.stdout.write(`[collab] ${d}`)
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
})

// --- dev server (inherits VITE_COLLAB_URL) ---
// isolated: this script sets VITE_COLLAB_URL above, and a shared server was started without it -
// attaching would silently point the app at the default ws://localhost:1234 and time out
const { url: APP_URL, vite } = await startServer({ isolated: true })
const ROOM = editSecret(`verify-sdk-parts-${collabPort}`)

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip && window.__oip.store), { timeout: 20000 })
const waitForSdkParts = (page, min) =>
  page.waitForFunction(
    (min) => window.__oip.store.getState().scene.parts.filter((p) => p.type === 'part').length >= min,
    min,
    { timeout: 20000 },
  )

/**
 * Identity + authored values of every SDK part in the live scene. `packageId` is what resolves
 * geometry/behavior; params are the per-placement values. Param keys are sorted so a pure key-order
 * difference between the two materialization paths doesn't read as data loss.
 */
const fingerprint = (page) =>
  page.evaluate(() => {
    const canon = (o) =>
      JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))))
    const s = window.__oip.store.getState().scene
    return {
      parts: s.parts.length,
      sdk: s.parts
        .filter((p) => p.type === 'part')
        .map((p) => ({ id: p.id, pkg: p.packageId ?? null, params: canon(p.params) })),
    }
  })

const browser = await chromium.launch({ headless: !HEADED })
try {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  for (const ctx of [ctxA, ctxB]) await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  for (const [tag, p] of [['A', a], ['B', b]]) {
    p.on('console', (m) => m.type() === 'error' && console.log(`[${tag} console.error] ${m.text()}`))
    p.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}`))
  }

  // --- A, solo: load the real demo and persist it, so the room seeds from a scene full of SDK parts
  await a.goto(`${APP_URL}?scene=demo`)
  await waitForApp(a)
  await waitForSdkParts(a, 5)
  await a.evaluate(() => window.__oip.store.persistProject())
  const solo = await fingerprint(a)
  check('demo scene is made of SDK parts', solo.sdk.length >= 5, `${solo.sdk.length} of ${solo.parts} parts`)
  check(
    'every solo SDK part has a package + params',
    solo.sdk.every((p) => p.pkg && p.params !== '{}'),
  )

  // --- A opens a room: seeds the doc from that scene, then re-materializes its own view from it
  await markSeeder(a, ROOM)
  await a.goto(`${APP_URL}?room=${ROOM}`)
  await waitForApp(a)
  await waitForSdkParts(a, solo.sdk.length)
  const roomA = await fingerprint(a)
  const lostPkg = roomA.sdk.filter((p) => !p.pkg)
  check(
    'the room creator keeps every part resolvable (packageId survives the doc)',
    lostPkg.length === 0,
    `${lostPkg.length} of ${roomA.sdk.length} lost their package`,
  )
  check(
    'the room creator keeps the authored params',
    JSON.stringify(roomA.sdk) === JSON.stringify(solo.sdk),
    'solo vs room fingerprints differ',
  )

  // --- B joins the same room cold (no local scene): the doc is its only source of truth
  await b.goto(`${APP_URL}?room=${ROOM}`)
  await waitForApp(b)
  await waitForSdkParts(b, solo.sdk.length)
  const roomB = await fingerprint(b)
  check(
    'a joiner materializes the same parts, packages and params',
    JSON.stringify(roomB.sdk) === JSON.stringify(solo.sdk),
    `${roomB.sdk.length} SDK parts vs ${solo.sdk.length}`,
  )
  check(
    'the joiner can resolve every package it received',
    await b.evaluate(
      () =>
        window.__oip.store
          .getState()
          .scene.parts.filter((p) => p.type === 'part')
          .every((p) => !!window.__oip.getPackage(p.packageId)),
    ),
  )

  // --- a live edit still round-trips with the part intact (the incremental diff path, not the seed)
  const target = roomA.sdk[0].id
  await a.evaluate((id) => {
    const st = window.__oip.store
    const s = st.getState().scene
    st.commit('Move part', {
      ...s,
      parts: s.parts.map((p) => (p.id === id ? { ...p, position: [p.position[0] + 3, p.position[1], p.position[2]] } : p)),
    })
  }, target)
  const landed = await b
    .waitForFunction(
      ({ id, params }) => {
        const p = window.__oip.store.getState().scene.parts.find((q) => q.id === id)
        if (!p) return false
        const canon = (o) =>
          JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))))
        return p.position[0] !== undefined && canon(p.params) === params && !!p.packageId
      },
      { id: target, params: roomA.sdk[0].params },
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false)
  check("a peer's edit arrives without stripping the part's package or params", landed)
} finally {
  await browser.close()
  vite.kill()
  collab.kill()
}
process.exit(failures ? 1 : 0)
