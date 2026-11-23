// The run log (`?runlog`, src/editor/runLog.ts): what a run did on a device, as text to paste. It is how a phone,
// which has no console to open, reports a run that goes wrong on it alone.
//
// It is off unless the URL asks for it, so nothing else notices when it stops recording. This runs the demo with it
// on and holds what a reader of a log relies on:
//   1. the overlay is there before Play, and the log has the messages that start the run
//   2. the program's input and output changes are in it, in sim time
//   3. the timers are read from the variable table, and one that runs reads a whole number of scans
//   4. cargo that moved is listed
//   5. Stop and copy ends the recording, leaves the run going and gives text that parses
// Then the same run with ?plcengine=walker: the program scans on the sim worker and the cell does the same things.
//
// Run: node e2e/verify-runlog.mjs
/* global process, console, window, localStorage, document */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port: PORT, vite } = await startServer()

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

/** Play the demo at 4x until `simSec` of sim time, then Stop and copy: the log, and what the page showed. */
async function record(browser, query, simSec) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(`http://localhost:${PORT}/app/?scene=demo&runlog${query}`)
    await page.waitForFunction(() => !!window.__oip?.controller && window.__oip.assetsBusy?.() === false, null, { timeout: 240000, polling: 250 })
    const shownBeforePlay = await page.waitForSelector('.run-log-overlay', { timeout: 30000 }).then(() => true, () => false)
    await page.evaluate(() => {
      window.__oip.controller.setTimeScale(4)
      window.__oip.controller.run()
    })
    // (sim time is the run's own: a busy machine makes this take longer, never read differently)
    await page.waitForFunction((t) => (window.__oip.controller.lastFrame?.simTime ?? 0) >= t, simSec, { timeout: 180000, polling: 250 })
    const onTop = await page.evaluate(() => {
      const r = document.querySelector('.run-log-overlay button').getBoundingClientRect()
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.run-log-overlay') !== null
    })
    await page.evaluate(() => document.querySelector('.run-log-overlay button').click())
    await page.waitForSelector('.run-log-overlay textarea', { timeout: 15000 })
    const text = await page.inputValue('.run-log-overlay textarea')
    await page.waitForTimeout(500)
    const after = await page.evaluate(() => ({
      running: window.__oip.store.getState().running,
      taps: window.__oip.sim.frameTap === null && window.__oip.sim.postTap === null,
      thread: window.__oip.sim.stepStats?.plcThread === true,
      buttons: [...document.querySelectorAll('.run-log-overlay button')].map((b) => b.textContent),
    }))
    return { text, shownBeforePlay, onTop, after, errors }
  } finally {
    await page.close()
  }
}

const first = (log, key, value) => log.changes.find((c) => c[1] === key && c[2] === value)?.[0]

const browser = await chromium.launch({ headless: true })
try {
  const typed = await record(browser, '', 30)
  let log = null
  try {
    log = JSON.parse(typed.text)
  } catch { /* checked below */ }
  check('the overlay is there before Play, above the app', typed.shownBeforePlay && typed.onTop)
  check('Stop and copy gives text that parses', log !== null && log.version === 1, `${Math.round(typed.text.length / 1024)} KB`)
  if (log) {
    const types = log.messages.map((m) => m[2])
    check('the log has the messages that start the run', ['start', 'runProgram', 'beginStepping'].every((t) => types.includes(t)), types.join(' '))
    check('...and the speed change the page asked for', types.filter((t) => t === 'setTimeScale').length >= 1)
    check('the program was attached through the run', log.seconds.length >= 30 && log.seconds.every((s) => s.plc === true), `${log.seconds.length} seconds`)
    const cases = log.changes.filter((c) => c[1] === 'o:Cases')
    check('the case count climbs in sim time', cases.length >= 6 && cases.every((c, i) => i === 0 || (c[2] === cases[i - 1][2] + 1 && c[0] > cases[i - 1][0])), cases.map((c) => `${c[2]}@${(c[0] / 1000).toFixed(1)}`).join(' '))
    check('the first row shifts about ten seconds in', Math.abs((first(log, 'o:Shift', true) ?? 0) - 9500) < 400, `Shift at ${first(log, 'o:Shift', true)} ms`)
    const names = [...new Set(log.timers.map((t) => t[1]))]
    check('the timers are read from the variable table', ['Main.RowPacked', 'Main.ShiftPulse', 'Main.BlinkOn'].every((n) => names.includes(n)), names.join(' '))
    // a demo scan is 10 ms, and a timer short of its preset has run a whole number of them: a reading between
    // two is a timer working from a clock that is not the scan's
    const odd = log.timers.filter((t) => typeof t[2] !== 'number' || Math.abs(t[2] / 10 - Math.round(t[2] / 10)) > 1e-9)
    check('every timer reading is a whole number of scans', log.timers.length > 50 && odd.length === 0, `${log.timers.length} readings${odd.length ? `, first odd ${JSON.stringify(odd[0])}` : ''}`)
    const blinks = log.timers.filter((t) => t[1] === 'Main.BlinkOn' && t[3] === true)
    check('the lamp timer keeps firing to the end of the run', blinks.length > 10 && blinks[blinks.length - 1][0] > 25000, `${blinks.length} times, last at ${blinks[blinks.length - 1]?.[0]} ms`)
    check('cargo that moved is listed', log.seconds.filter((s) => s.moved.length > 0 && s.moved.length % 4 === 0).length >= 20)
    check('what the page was is last, where a cut paste keeps it', Object.keys(log).at(-1) === 'about' && typeof log.about.build === 'string' && log.about.page.includes('runlog'), log.about.build)
    check('nothing ran out of room', log.truncated === false)
  }
  check('the recording ends at the press and the run goes on', typed.after.running === true && typed.after.taps, JSON.stringify(typed.after))
  check('Copy is offered', typed.after.buttons.includes('Copy'), typed.after.buttons.join(', '))
  check('no page errors', typed.errors.length === 0, typed.errors.slice(0, 3).join(' | '))

  const walker = await record(browser, '&plcengine=walker', 30)
  let wlog = null
  try {
    wlog = JSON.parse(walker.text)
  } catch { /* checked below */ }
  check('walker: the program scans on the sim worker', wlog !== null && walker.after.thread === false && typed.after.thread === true, `typed on its own worker ${typed.after.thread}, walker ${walker.after.thread}`)
  if (log && wlog) {
    // (signals that hold their value: a frame can miss one that lasts a single step)
    const near = (key, value) => Math.abs((first(log, key, value) ?? -1e9) - (first(wlog, key, value) ?? 1e9)) <= 100
    check('walker: the cell does the same things at the same times', near('o:Shift', true) && near('i:LayerReady', true) && near('o:ArmCmd', 1), `Shift ${first(log, 'o:Shift', true)}/${first(wlog, 'o:Shift', true)}, LayerReady ${first(log, 'i:LayerReady', true)}/${first(wlog, 'i:LayerReady', true)}, ArmCmd ${first(log, 'o:ArmCmd', 1)}/${first(wlog, 'o:ArmCmd', 1)}`)
    const count = (l) => l.changes.filter((c) => c[1] === 'o:Cases').length
    check('walker: and counts the same cases', count(log) === count(wlog), `${count(log)} and ${count(wlog)}`)
  }
  check('walker: no page errors', walker.errors.length === 0, walker.errors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
  vite?.kill()
}
console.log(failures === 0 ? '\nverify-runlog: all checks passed' : `\nverify-runlog: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
