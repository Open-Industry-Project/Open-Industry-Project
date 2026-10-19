// Verify the agent review in the real editor (docs/agent-tools.md, "Working beside a person"): an agent's first edit
// raises the chip, Review lists the part it placed and Show selects it, get_context reports the person's selection,
// Revert is withheld while a person's edit sits among the agent's steps, and Revert then takes the whole run back and
// tells the agent through get_context. The desktop shell's bridge (preload.cjs window.oipAgent) is stood in for by a
// page script, so the tools and the UI are the app's own and no Electron is needed; verify-agent-mcp-electron.mjs
// covers the transport. Run: node e2e/verify-agent-review.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const SHOTS = process.env.OIP_SHOTS_DIR

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// the bridge preload.cjs exposes, reduced to what desktopAgent.ts uses: the page announces its tools and answers calls
function fakeAgentBridge() {
  const bridge = { tools: null, onCall: null, replies: new Map(), next: 1 }
  window.__agentBridge = bridge
  window.oipAgent = {
    serve: (tools) => (bridge.tools = tools),
    onCall: (cb) => ((bridge.onCall = cb), () => (bridge.onCall = null)),
    reply: (id, r) => bridge.replies.get(id)?.(r),
  }
  window.__agentCall = (name, args) =>
    new Promise((resolve) => {
      const id = bridge.next++
      bridge.replies.set(id, (r) => resolve(r.ok ? { ok: true, value: JSON.parse(r.text) } : r))
      bridge.onCall({ id, name, args })
    })
}

const call = (page, name, args = {}) => page.evaluate(([n, a]) => window.__agentCall(n, a), [name, args])

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  page.on('dialog', (d) => void d.accept())
  await page.addInitScript(fakeAgentBridge)
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!window.__oip?.store)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.controller && window.__agentBridge?.tools))
    await page.evaluate(() => window.__oip.store.loadScene({ version: window.__oip.store.getState().scene.version, parts: [] }))

    const names = await page.evaluate(() => window.__agentBridge.tools.map((t) => t.name))
    check('the editor serves get_context', names.includes('get_context'))

    await call(page, 'get_scene')
    check('a read raises no chip', (await page.locator('[data-testid="agent-activity"]').count()) === 0)

    const placed = await call(page, 'add_part', { package: 'oip.belt-conveyor', position: [0, 0.8, 0], name: 'Agent belt' })
    check('the agent places a belt', placed.ok, JSON.stringify(placed))
    const id = placed.value?.id
    const steps = page.locator('[data-testid="agent-activity-steps"]')
    await steps.waitFor({ timeout: 10000 })
    check('the chip counts the edit', (await steps.textContent()) === 'The agent made 1 edit', await steps.textContent())

    await page.evaluate((pid) => window.__oip.store.select(pid), id)
    const ctx = await call(page, 'get_context')
    check('get_context reports the selection', ctx.value?.selection?.[0]?.id === id, JSON.stringify(ctx.value?.selection))
    check('get_context reports the open review', ctx.value?.review?.changes?.parts?.[0]?.change === 'added', JSON.stringify(ctx.value?.review))
    // placing a built-in makes the project's untouched copy of it; that is the placement, not a definition edit
    check('the review leaves the untouched built-in copy out', ctx.value?.review?.changes?.library?.added?.length === 0, JSON.stringify(ctx.value?.review?.changes?.library))

    await page.evaluate(() => window.__oip.store.select(null))
    await page.click('[data-testid="agent-review"]')
    const row = page.locator(`[data-testid="agent-review-part"][data-part-id="${id}"]`)
    await row.waitFor({ timeout: 5000 })
    check('Review lists the placed part as added', (await row.getAttribute('data-change')) === 'added')
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/agent-review-dialog.png` })
    await row.locator('button', { hasText: 'Show' }).click()
    check('Show selects the part', (await page.evaluate(() => window.__oip.store.getState().selectedIds)).join() === id)
    await page.click('[data-testid="agent-review-dialog"] .author-close')

    // a person's edit among the agent's steps: Revert would take it too, so it is withheld
    await page.evaluate((pid) => {
      const store = window.__oip.store
      const scene = store.getState().scene
      store.commit('Move part', { ...scene, parts: scene.parts.map((p) => (p.id === pid ? { ...p, position: [2, 0.8, 0] } : p)) })
    }, id)
    await call(page, 'update_part', { id, name: 'Agent belt 2' })
    const revert = page.locator('[data-testid="agent-revert"]')
    const why = await revert.getAttribute('title')
    // the agent's rename rides its own step, so the one edit counted is the person's move
    check("Revert is withheld over a person's edit, and counts only theirs", (await revert.isDisabled()) && /^You made an edit after/.test(why ?? ''), why)
    check("the chip counts the agent's edits, not the person's", (await steps.textContent()) === 'The agent made 2 edits', await steps.textContent())
    // in the viewport's corner: floating over the window, it covered the Parts dock's cards
    check('the chip sits inside the viewport', await page.evaluate(() => !!document.querySelector('.viewport [data-testid="agent-activity"]')))
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/agent-review-chip.png` })

    // the person takes back their own move by undoing to it: the agent's later step goes first, then the move
    await page.evaluate(() => {
      window.__oip.store.undo()
      window.__oip.store.undo()
    })
    await page.waitForFunction(() => !document.querySelector('[data-testid="agent-revert"]')?.disabled)
    check('Revert is offered again once only agent steps remain', !(await revert.isDisabled()))

    await revert.click()
    await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length === 0, null, { timeout: 5000 }).catch(() => {})
    check('Revert takes the run back', (await page.evaluate(() => window.__oip.store.getState().scene.parts.length)) === 0)
    check('the chip clears', (await page.locator('[data-testid="agent-activity-steps"]').count()) === 0)
    const after = await call(page, 'get_context')
    check('the agent is told its edits were reverted', after.value?.lastAnswer?.kind === 'reverted' && after.value?.review === null, JSON.stringify(after.value?.lastAnswer))
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  vite.kill()
  process.exit(1)
})
