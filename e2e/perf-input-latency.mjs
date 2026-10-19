// Measures how long the editor takes to answer input: a keystroke in the PLC editor, a click in the
// scene tree or on a part in the 3D view, typing in the command palette. A measurement, not a gate: it prints numbers and exits 0.
//
// Each arm records, per input event, the time from the event's timestamp to the end of the next frame
// (a rAF, then a message-channel task after it). That includes up to one display refresh of waiting,
// so the `idle` arm takes the same reading at arbitrary moments with no input: its median is the floor
// the other arms sit on. It stops when the main thread is done with the frame. The browser's own Event
// Timing duration (the measure behind INP) runs on until the frame is presented, so it reads higher; it
// is reported beside it, along with long animation frames (50 ms and up).
//
// The two typing arms differ only in whether the Problems panel is mounted. Each recheck of that panel
// compiles the whole program and re-walks the scene (ProblemsPanel.tsx collectProblems), so the gap
// between the arms is what it costs while someone types. A second pass takes CPU profiles of every arm
// and splits each input's main-thread time by where the code came from. React is
// bundled into the `app` chunk with the editor, so that split needs source maps: build with
// `npx vite build --sourcemap hidden && node scripts/optimize-assets.mjs` first (hidden maps are written
// beside the chunks and never referenced by them), and rebuild normally afterwards. Without maps the
// split is by chunk only.
//
// Runs against dist/ through the real host config, headed on the machine's GPU: React's development
// build inflates render cost several times over, and a headless window throttles its frames. Rounds
// alternate the arm order so drift does not favour one arm. Check the conditions line before trusting
// a number.
// Run: npm run build && node e2e/perf-input-latency.mjs   (OIP_ROUNDS=<n>, default 3; OIP_BACKEND=webgl|webgpu;
// OIP_FUNCTIONS=1 adds a per-function table)
/* global process, console, window, document, localStorage, performance, requestAnimationFrame, MessageChannel, PerformanceObserver, addEventListener, setTimeout */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { serveDist, distIsBuilt, DIST } from './_edge-server.mjs'
import { FLOATING_PLC_LAYOUT, showPlcEditor } from './_plc.mjs'
import { acquireLease } from './_lease.mjs'
import { begin as loadBegin, end as loadEnd, formatLoad, looksContended } from './_load.mjs'

const ROUNDS = Math.max(1, Number(process.env.OIP_ROUNDS ?? 3))
// OIP_BACKEND=webgl|webgpu forces a renderer (the app's own URL switches); unset, the app picks
const BACKEND_FLAG = { webgl: '&nowebgpu', webgpu: '&webgpu' }[process.env.OIP_BACKEND ?? ''] ?? ''
// about ten characters a second, a quick typist; continuous typing never pauses long enough for the
// editor's 250 ms lint debounce, so this measures the per-keystroke path alone
const KEY_GAP_MS = 100
const TYPED = '(* the quick brown fox jumps over the lazy dog *)'
const IDLE_SAMPLES = 40

if (!distIsBuilt()) {
  console.log('SKIP  dist/ is not built - run `npm run build` first')
  process.exit(0)
}

const releaseLease = await acquireLease({ label: 'perf-input-latency' })
const { port, close } = await serveDist()
const browser = await chromium.launch({
  headless: false,
  // keep an unfocused headed window rendering at full rate (same flags as verify-interaction-budget.mjs)
  args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
})

/** installed before the app loads: the per-event readings and the browser's timing entries */
const INSTRUMENT = (layout) => {
  try {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
    // the PLC editor floats so it and the Problems panel can be on screen together
    localStorage.setItem('oip-web/dock-layout', layout)
  } catch {
    /* private mode */
  }
  const lat = { arm: null, windows: [], paints: [], events: [], frames: [] }
  const paint = (t0, arm) => {
    if (!arm) return
    requestAnimationFrame(() => {
      const ch = new MessageChannel()
      ch.port1.onmessage = () => lat.paints.push({ arm, ms: performance.now() - t0 })
      ch.port2.postMessage(0)
    })
  }
  lat.begin = (arm) => {
    lat.arm = arm
    lat.windows.push({ arm, from: performance.now(), to: Infinity })
  }
  lat.end = () => {
    const w = lat.windows[lat.windows.length - 1]
    if (w) w.to = performance.now()
    lat.arm = null
  }
  lat.tick = () => paint(performance.now(), lat.arm)
  addEventListener('keydown', (e) => paint(e.timeStamp, lat.arm), true)
  addEventListener('pointerdown', (e) => paint(e.timeStamp, lat.arm), true)
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === 'keydown' || e.name === 'pointerdown') lat.events.push({ name: e.name, at: e.startTime, ms: e.duration })
    }).observe({ type: 'event', durationThreshold: 16, buffered: true })
  } catch {
    /* no Event Timing */
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const top = [...(e.scripts ?? [])].sort((a, b) => b.duration - a.duration)[0]
        lat.frames.push({ at: e.startTime, ms: e.duration, top: top ? `${String(top.sourceURL ?? '').split('/').pop()} ${top.invoker}` : '' })
      }
    }).observe({ type: 'long-animation-frame', buffered: true })
  } catch {
    /* no long-animation-frame entries */
  }
  window.__lat = lat
}

const begin = (page, arm) => page.evaluate((a) => window.__lat.begin(a), arm)
const end = (page) => page.evaluate(() => window.__lat.end())

async function showProblems(page, on) {
  // a background dock tab is unmounted, so bringing Parts forward takes the Problems panel out of the page
  await page.evaluate((p) => window.__oip.store.revealPanel(p ? 'problems' : 'catalog'), on)
  await page.waitForFunction((p) => !!document.querySelector('.problems-panel') === p, on, { timeout: 10000 })
}

/** the line the typing arms type into, added before and taken out after, so every round types into the same program */
async function openLine(page, problems) {
  await showProblems(page, problems)
  await page.locator('.cm-content').first().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
}
async function closeLine(page) {
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(800)
}

async function typeText(page) {
  await page.keyboard.type(TYPED, { delay: KEY_GAP_MS })
  await page.waitForTimeout(600)
  return TYPED.length
}

async function idle(page) {
  await page.evaluate(async ({ n, gap }) => {
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setTimeout(r, gap))
      window.__lat.tick()
    }
  }, { n: IDLE_SAMPLES, gap: KEY_GAP_MS })
  await page.waitForTimeout(300)
  return IDLE_SAMPLES
}

const PALETTE_OPENS = 5
async function openPalette(page) {
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette-input').waitFor({ state: 'visible', timeout: 10000 })
}
async function closePalette(page) {
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.palette'), null, { timeout: 10000 })
}

async function paletteOpens(page) {
  for (let i = 0; i < PALETTE_OPENS; i++) {
    await openPalette(page)
    await page.waitForTimeout(400)
    await closePalette(page)
    await page.waitForTimeout(400)
  }
  return PALETTE_OPENS
}

async function paletteTyping(page) {
  await page.keyboard.type('conveyor', { delay: KEY_GAP_MS })
  await page.waitForTimeout(400)
  return 'conveyor'.length
}

async function treeClicks(page) {
  // rows whose centre is not under the floating PLC window, so the click lands on the row
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.tree-row')]
      .map((el) => {
        const b = el.getBoundingClientRect()
        const x = b.left + Math.min(60, b.width / 2)
        const y = b.top + b.height / 2
        return { x, y, hit: b.height > 0 && el.contains(document.elementFromPoint(x, y)) }
      })
      .filter((r) => r.hit)
      .slice(0, 10),
  )
  if (rows.length < 2) throw new Error('tree: fewer than two clickable rows')
  for (const r of rows) {
    await page.mouse.click(r.x, r.y)
    await page.waitForTimeout(400)
  }
  return rows.length
}

/** per viewport-click run, how many clicks changed the selection (printed with the results) */
const viewportHits = []

async function viewportClicks(page) {
  // up to ten parts of different kinds whose bounds centre projects onto the canvas itself, not under a panel (a part's
  // origin is often a floor point or under a neighbour). The building and groups are left out: they cover the others.
  const targets = await page.evaluate(() => {
    const view = window.__oip.view
    const canvas = view.renderer.domElement
    const seen = new Set()
    const out = []
    for (const p of window.__oip.store.getState().scene.parts) {
      const kind = p.type === 'part' ? p.packageId : p.type
      if (kind === 'building' || kind === 'annotation' || kind === 'group' || seen.has(kind)) continue
      const entry = view.entries.get(p.id)
      if (!entry) continue
      const box = view.boundsOf(entry)
      if (box.isEmpty()) continue
      const c = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 }
      const s = view.worldToScreen(c.x, c.y, c.z)
      if (!s.visible || document.elementFromPoint(s.x, s.y) !== canvas) continue
      seen.add(kind)
      out.push({ id: p.id, x: s.x, y: s.y })
      if (out.length === 10) break
    }
    return out
  })
  if (targets.length < 2) throw new Error('viewport: fewer than two parts on screen to click')
  // a click on a part mounted on another selects its host, so the count is of clicks that changed the selection
  const selection = () => page.evaluate(() => window.__oip.store.getState().selectedIds.join(','))
  let hits = 0
  let before = await selection()
  for (const t of targets) {
    await page.mouse.click(t.x, t.y)
    await page.waitForTimeout(400)
    const after = await selection()
    if (after !== '' && after !== before) hits++
    before = after
  }
  viewportHits.push(`${hits}/${targets.length}`)
  return targets.length
}

/**
 * Each arm: `prepare` and `cleanup` run outside the measured window, `act` inside it and returns how
 * many inputs it made (what the profile divides by). `short` heads the profile table's column.
 */
const ARMS = [
  { name: 'idle', short: 'idle', act: idle },
  { name: 'type, Problems open', short: 'type+Probs', prepare: (page) => openLine(page, true), act: typeText, cleanup: closeLine },
  { name: 'type, Problems closed', short: 'type', prepare: (page) => openLine(page, false), act: typeText, cleanup: closeLine },
  { name: 'palette open', short: 'pal open', act: paletteOpens },
  { name: 'palette typing', short: 'pal type', prepare: openPalette, act: paletteTyping, cleanup: closePalette },
  { name: 'tree-click', short: 'tree', act: treeClicks, cleanup: (page) => page.keyboard.press('Escape') },
  { name: 'viewport-click', short: 'viewport', act: viewportClicks, cleanup: (page) => page.keyboard.press('Escape') },
]

/** one measured run of an arm: the latency readings land in window.__lat under its name */
async function runArm(page, arm) {
  await arm.prepare?.(page)
  await begin(page, arm.name)
  await arm.act(page)
  await end(page)
  await arm.cleanup?.(page)
}

const quantile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN)
const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : '-')

// a transitive dependency (vite, babel), so loaded only if present
const traceMapping = await import('@jridgewell/trace-mapping').catch(() => null)
const maps = new Map()
/** the source map written beside a dist chunk, or null */
function mapFor(file) {
  if (!traceMapping) return null
  if (!maps.has(file)) {
    const path = join(DIST, 'assets', `${file}.map`)
    maps.set(file, existsSync(path) ? new traceMapping.TraceMap(readFileSync(path, 'utf8')) : null)
  }
  return maps.get(file)
}

/** `node_modules/@codemirror/view/dist/index.js` -> `@codemirror/view`, `../src/plc/lexer.ts` -> `src/plc/lexer.ts` */
function sourceName(source) {
  const nm = source.lastIndexOf('node_modules/')
  if (nm >= 0) {
    const parts = source.slice(nm + 'node_modules/'.length).split('/')
    return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
  }
  const src = source.indexOf('src/')
  return src >= 0 ? source.slice(src) : source
}

/** the area a source belongs to, for the summary table */
function areaOf(name) {
  if (/^(react|react-dom|scheduler)$/.test(name)) return 'React (library)'
  if (name.startsWith('@codemirror/') || name.startsWith('@lezer/')) return 'CodeMirror'
  if (name === 'three') return 'three'
  if (name.startsWith('src/editor/components/')) return 'src/editor/components (React components)'
  if (name.startsWith('src/')) return name.split('/').slice(0, 2).join('/')
  if (name.startsWith('(')) return name
  return 'other libraries'
}

/**
 * Self time per source, in ms, from a V8 CPU profile. A frame's position is where its function starts,
 * so a function is charged to the file it is defined in. Frames with no script are V8's own buckets:
 * (program) is the browser's work outside JS (style, layout, paint, GPU submits).
 */
function sourceTimes(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const named = new Map()
  const nameOf = (node) => {
    if (named.has(node.id)) return named.get(node.id)
    const cf = node.callFrame
    const file = cf.url ? cf.url.split('/').pop().split('?')[0] : ''
    let name
    // the function, as `file:line name` from the map's original position and name
    let fn
    if (!file) name = fn = cf.functionName.startsWith('(') ? cf.functionName : '(native)'
    else {
      const pos = mapFor(file) && traceMapping.originalPositionFor(mapFor(file), { line: cf.lineNumber + 1, column: Math.max(0, cf.columnNumber) })
      // without a map: the chunk, `app-eDoUcBhI.js` -> `chunk app`
      name = pos?.source ? sourceName(pos.source) : `chunk ${file.replace(/-[A-Za-z0-9_-]{8}\.(m?js)$/, '').replace(/\.(m?js)$/, '')}`
      fn = pos?.source ? `${name.split('/').pop()}:${pos.line} ${pos.name ?? cf.functionName}` : `${name} ${cf.functionName}`
    }
    named.set(node.id, { name, fn })
    return named.get(node.id)
  }
  const sources = new Map()
  const functions = new Map()
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i])
    if (!node) continue
    const { name, fn } = nameOf(node)
    const ms = (profile.timeDeltas[i + 1] ?? 0) / 1000
    sources.set(name, (sources.get(name) ?? 0) + ms)
    functions.set(fn, (functions.get(fn) ?? 0) + ms)
  }
  sources.delete('(idle)')
  functions.delete('(idle)')
  return { sources, functions, wallMs: (profile.endTime - profile.startTime) / 1000 }
}

/** add one profile's times into a running total */
function addTimes(total, t) {
  if (!total) return { sources: new Map(t.sources), functions: new Map(t.functions), wallMs: t.wallMs, units: t.units }
  for (const key of ['sources', 'functions']) for (const [k, v] of t[key]) total[key].set(k, (total[key].get(k) ?? 0) + v)
  total.wallMs += t.wallMs
  total.units += t.units
  return total
}

const load = loadBegin()
// read after the try block, so held in an object (no-useless-assignment can't follow try/finally)
const run = { backend: '?' }
const results = new Map(ARMS.map((a) => [a.name, { roundP50: [] }]))
let profiles = null
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript(INSTRUMENT, FLOATING_PLC_LAYOUT)
  await page.goto(`http://localhost:${port}/app/?scene=demo&hook${BACKEND_FLAG}`)
  await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), null, { timeout: 90000 })
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, null, { timeout: 60000 })
  await page.waitForFunction(() => window.__oip.view.warming.size === 0 && window.__oip.view.warmQueue.size === 0, null, { timeout: 60000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000 }).catch(() => {})
  await showPlcEditor(page)
  // the catalog thumbnails and warm sweeps start at idle after the first paint; let them finish
  await page.waitForTimeout(5000)
  const facts = await page.evaluate(() => ({
    backend: window.__oip.view.renderer?.isWebGPURenderer ? 'webgpu' : 'webgl',
    parts: window.__oip.store.getState().scene.parts.length,
    programChars: window.__oip.store.getState().stProgram.length,
  }))
  run.backend = facts.backend
  console.log(`demo: ${facts.parts} parts, ${facts.programChars}-character program, ${facts.backend}, ${ROUNDS} rounds\n`)

  for (let r = 0; r < ROUNDS; r++) {
    const order = ARMS.map((_, i) => ARMS[(i + r) % ARMS.length])
    for (const arm of order) {
      const before = await page.evaluate(() => window.__lat.paints.length)
      await runArm(page, arm)
      const ms = await page.evaluate((from) => window.__lat.paints.slice(from).map((p) => p.ms), before)
      const sorted = ms.sort((a, b) => a - b)
      results.get(arm.name).roundP50.push(quantile(sorted, 0.5))
    }
  }

  // every reading, and the browser's entries assigned to the arm whose window they started in
  const raw = await page.evaluate(() => {
    const lat = window.__lat
    const armAt = (t) => lat.windows.find((w) => t >= w.from && t <= w.to)?.arm ?? null
    return {
      paints: lat.paints,
      events: lat.events.map((e) => ({ ...e, arm: armAt(e.at) })),
      frames: lat.frames.map((f) => ({ ...f, arm: armAt(f.at) })),
    }
  })
  for (const arm of ARMS) {
    const res = results.get(arm.name)
    const ms = raw.paints.filter((p) => p.arm === arm.name).map((p) => p.ms).sort((a, b) => a - b)
    // Event Timing reports only entries of 16 ms and up; the rest of the arm's inputs count as 0 here
    // and print as <16
    const reported = raw.events.filter((e) => e.arm === arm.name).map((e) => e.ms)
    const browserMs = arm.name === 'idle' ? [] : [...Array(Math.max(0, ms.length - reported.length)).fill(0), ...reported].sort((a, b) => a - b)
    const frames = raw.frames.filter((f) => f.arm === arm.name).sort((a, b) => b.ms - a.ms)
    Object.assign(res, {
      n: ms.length,
      p50: quantile(ms, 0.5),
      p95: quantile(ms, 0.95),
      max: ms[ms.length - 1],
      browser: browserMs.length ? [0.5, 0.95, 1].map((p) => quantile(browserMs, p)) : null,
      longFrames: frames.length,
      worstFrame: frames[0],
    })
  }

  // CPU profile pass: each round profiles an idle stretch, then every arm, in the latency rounds' rotating
  // order. Kept apart from those rounds, since the profiler slows the page.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  const profiled = async (fn) => {
    await cdp.send('Profiler.start')
    const units = await fn()
    const { profile } = await cdp.send('Profiler.stop')
    return { ...sourceTimes(profile), units }
  }
  profiles = new Map()
  const measured = ARMS.filter((a) => a.name !== 'idle')
  for (let r = 0; r < ROUNDS; r++) {
    profiles.set('idle', addTimes(profiles.get('idle'), await profiled(() => page.waitForTimeout(5000).then(() => 0))))
    for (const arm of measured.map((_, i) => measured[(i + r) % measured.length])) {
      await arm.prepare?.(page)
      profiles.set(arm.name, addTimes(profiles.get(arm.name), await profiled(() => arm.act(page))))
      await arm.cleanup?.(page)
    }
  }
} finally {
  await browser.close().catch(() => {})
  await close()
  releaseLease()
}
const stamp = loadEnd(load)

console.log('input to next paint, ms (idle = the frame-wait floor, no input)')
console.log('                                  next paint                                 browser (Event Timing)')
console.log('arm                       n    p50    p95    max   p50 per round           p50    p95    max  frames>=50ms  worst frame')
for (const arm of ARMS) {
  const r = results.get(arm.name)
  const rounds = r.roundP50.map(fmt).join(' / ')
  const worst = r.worstFrame ? `${fmt(r.worstFrame.ms)} ms ${r.worstFrame.top}` : '-'
  const browser = (r.browser ?? [NaN, NaN, NaN]).map((v) => (v === 0 ? '<16' : fmt(v)).padStart(6)).join(' ')
  console.log(
    `${arm.name.padEnd(24)} ${String(r.n).padStart(3)} ${fmt(r.p50).padStart(6)} ${fmt(r.p95).padStart(6)} ${fmt(r.max).padStart(6)}   ${rounds.padEnd(20)} ${browser} ${String(r.longFrames).padStart(13)}  ${worst}`,
  )
}

if (profiles) {
  const idleTimes = profiles.get('idle')
  const measured = ARMS.filter((a) => a.name !== 'idle')
  // ms per input above the idle rate over the same wall time; small negatives are sampling noise
  const extraPerInput = (p, field, name) => ((p[field].get(name) ?? 0) - ((idleTimes[field].get(name) ?? 0) * p.wallMs) / idleTimes.wallMs) / p.units
  const rows = (keyOf, field = 'sources') => {
    const groups = new Map()
    for (const arm of measured) {
      const p = profiles.get(arm.name)
      for (const name of new Set([...p[field].keys(), ...idleTimes[field].keys()])) {
        const k = keyOf(name)
        const g = groups.get(k) ?? { k, v: Object.fromEntries(measured.map((a) => [a.name, 0])) }
        g.v[arm.name] += extraPerInput(p, field, name)
        groups.set(k, g)
      }
    }
    const peak = (g) => Math.max(...Object.values(g.v))
    return [...groups.values()].sort((a, b) => peak(b) - peak(a))
  }
  const line = (label, cells) => console.log(`${label.slice(0, 43).padEnd(44)}${cells.map((c) => c.padStart(11)).join('')}`)
  const print = (title, list, limit) => {
    console.log(`\n${title}`)
    line('', measured.map((a) => a.short))
    line('inputs profiled', measured.map((a) => String(profiles.get(a.name).units)))
    for (const x of list.slice(0, limit)) line(x.k, measured.map((a) => fmt(x.v[a.name])))
  }
  const areas = rows(areaOf)
  const mapped = [...idleTimes.sources.keys()].some((k) => k.startsWith('src/'))
  print(`main-thread time per input above idle, ms, by area${mapped ? '' : ' (no source maps, so by chunk)'}`, areas, 14)
  line('total', measured.map((a) => fmt(areas.reduce((s, x) => s + x.v[a.name], 0))))
  if (mapped) print('by source file', rows((n) => n), 25)
  // OIP_FUNCTIONS=1: one level further, the functions themselves
  if (mapped && process.env.OIP_FUNCTIONS) print('by function', rows((n) => n, 'functions'), 40)
}

// a click that lands on floor, or on what is already selected, is still a click but changes nothing: say how many did
if (viewportHits.length) console.log(`\nviewport clicks that changed the selection, per run: ${viewportHits.join(', ')}`)
console.log(`\nconditions: ${run.backend}, ${formatLoad(stamp) || 'load not sampled'}${looksContended(stamp) ? '  ⚠ CONTENDED: treat these as noise' : ''}`)
