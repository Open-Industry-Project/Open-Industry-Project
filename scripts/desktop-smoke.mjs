// Launch a PACKAGED desktop app and prove it boots: the window loads the bundled build over oip://app/, the page is
// cross-origin isolated (threaded Jolt needs SharedArrayBuffer), the preload's bridges are there, and the loading
// cover lifts on a rendered scene. Writes a screenshot.
//
//   node scripts/desktop-smoke.mjs <executable> [--out <dir>] [--software-gl] [--timeout <sec>]
//
// The executable is whatever a user would start: an .AppImage, an installed .deb's /opt/.../open-industry-project,
// or win-unpacked's .exe. Playwright's _electron cannot drive a packaged app (the fuses refuse --inspect, see
// docs/desktop-shell.md), but the fuses say nothing about Chromium's own --remote-debugging-port, so this
// attaches over CDP as a plain browser would and looks only at what the page shows.
//
// A launch that dies before the page is up is the failure this exists for (on Linux: no FUSE for an AppImage, a
// Chromium sandbox the OS refuses), so the app's own output is printed whenever it fails.
//
// --software-gl: a machine with no GPU (a CI runner) gets SwiftShader, which Chromium otherwise refuses for WebGL.
// Exit 0 = booted; 1 = did not.
/* global process, console, document, window, location, fetch, setTimeout */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const exe = args.find((a, i) => !a.startsWith('--') && !['--out', '--timeout'].includes(args[i - 1]))
if (!exe) {
  console.error('usage: node scripts/desktop-smoke.mjs <executable> [--out <dir>] [--software-gl] [--timeout <sec>]')
  process.exit(2)
}
const out = resolve(opt('--out') ?? '.')
const timeoutMs = Number(opt('--timeout') ?? 240) * 1000

const freePort = () =>
  new Promise((ok, no) => {
    const s = createServer()
    s.once('error', no)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })

const port = await freePort()
const profile = mkdtempSync(join(tmpdir(), 'oip-smoke-profile-'))
const launchArgs = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`]
if (args.includes('--software-gl')) launchArgs.push('--enable-unsafe-swiftshader')

let log = ''
// detached: an AppImage is a launcher that starts the app as a CHILD, so the whole group is what has to go
// OIP_TCADSDLL_PATH names a TcAdsDll that is not there, so the ADS check below never loads one or reaches a TwinCAT
// router, whatever the machine has installed (adsIo.cjs looks nowhere else when it is set)
const env = { ...process.env, OIP_TCADSDLL_PATH: join(profile, 'no-such-TcAdsDll.dll') }
const child = spawn(resolve(exe), launchArgs, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env })
child.stdout.on('data', (d) => (log += d))
child.stderr.on('data', (d) => (log += d))
let exited = null
child.on('exit', (code, signal) => (exited = { code, signal }))
child.on('error', (e) => (exited = { error: String(e) }))

const kill = () => {
  if (exited) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

const fail = (msg) => {
  console.error(`desktop smoke: FAIL - ${msg}`)
  if (exited) console.error(`  the app exited: ${JSON.stringify(exited)}`)
  if (log.trim()) console.error(`  the app's output:\n${log.trim().split('\n').slice(-40).map((l) => `    ${l}`).join('\n')}`)
  kill()
  process.exit(1)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const deadline = Date.now() + timeoutMs

// 1. the debugging endpoint comes up only once the browser process is running
let browser
for (;;) {
  if (exited) fail('the app quit before its window came up')
  if (Date.now() > deadline) fail(`no debugging endpoint on port ${port} within ${timeoutMs / 1000} s`)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`)
    if (res.ok) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      break
    }
  } catch {
    /* not yet */
  }
  await sleep(250)
}

try {
  // 2. the app window: the bundled build, never a dev server or a web page
  let page
  while (!page) {
    if (exited) fail('the app quit before its window loaded the app')
    if (Date.now() > deadline) fail('no window loaded oip://app/')
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('oip://app/'))
    if (!page) await sleep(250)
  }
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  console.log(`  window: ${page.url()}`)

  await page.waitForSelector('.toolbar', { timeout: Math.max(1000, deadline - Date.now()) })
  const facts = await page.evaluate(() => ({
    isolated: window.crossOriginIsolated,
    platform: window.oipMenu?.platform ?? null,
    bridges: ['oipParts', 'oipProject', 'oipPlcIo', 'oipOpcUa', 'oipEip', 'oipAds', 'oipMenu'].filter((k) => !window[k]),
    origin: location.origin,
  }))
  console.log(`  platform ${facts.platform}, crossOriginIsolated ${facts.isolated}`)
  if (!facts.isolated) fail('the page is not cross-origin isolated, so threaded physics cannot start')
  if (!facts.platform) fail('the preload bridges are missing (window.oipMenu)')
  if (facts.bridges.length) fail(`preload bridges missing: ${facts.bridges.join(', ')}`)
  // EtherNet/IP's library is native code outside the asar (koffi's binding and libplctag, asarUnpack): only a packaged
  // build can show it loads. Opening a link loads both and checks the version, and sends nothing until a tag is asked for.
  const eip = await page.evaluate(async () => {
    const r = await window.oipEip.open({ gateway: '127.0.0.1', path: '1,0' })
    await window.oipEip.close()
    return r.error
  })
  if (eip) fail(`EtherNet/IP is unavailable in this build: ${eip}`)
  console.log('  EtherNet/IP: libplctag loads')
  // ADS: the DLL is the user's TwinCAT install, and this check never loads one (OIP_TCADSDLL_PATH above), so it shows
  // only that the channel is wired and adsIo.cjs answers from its own code: a malformed Net ID refused before any
  // loading, then the missing-DLL answer for a well-formed one. A missing handler or any other answer fails.
  const ads = await page.evaluate(async () => {
    try {
      const bad = await window.oipAds.open({ netId: '1.2.3', port: 851 })
      const missing = await window.oipAds.open({ netId: '', port: 851 })
      await window.oipAds.close()
      return { bad: bad.error ?? '', missing: missing.error ?? '' }
    } catch (e) {
      return { failed: `the call failed: ${String(e?.message ?? e)}` }
    }
  })
  if (ads.failed) fail(`ADS is broken in this build: ${ads.failed}`)
  if (!/is not an AMS Net ID/.test(ads.bad)) fail(`ADS does not check its arguments in this build: ${ads.bad || 'a malformed Net ID was accepted'}`)
  const adsMissing = process.platform === 'win32' ? /OIP_TCADSDLL_PATH names a file that is not there/ : /runs on Windows/
  if (!adsMissing.test(ads.missing)) fail(`ADS answered unexpectedly in this build: ${ads.missing || 'no error'}`)
  console.log('  ADS: wired (argument checks and the missing-DLL answer come from adsIo.cjs)')

  // 3. the scene: the loading cover lifts once the building and parts have rendered
  try {
    await page.waitForSelector('.viewport-cover.ready', { state: 'attached', timeout: Math.max(1000, deadline - Date.now()) })
  } catch {
    const status = await page.evaluate(() => document.querySelector('.viewport-cover-status')?.textContent ?? '(no cover)').catch(() => '?')
    fail(`the loading cover never lifted (it says: ${status})`)
  }
  const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length)
  if (!canvases) fail('no canvas on the page')
  mkdirSync(out, { recursive: true })
  const shot = join(out, `desktop-smoke-${process.platform}.png`)
  await page.screenshot({ path: shot })
  console.log(`  scene up, ${canvases} canvas(es); screenshot ${shot}`)
  if (errors.length) fail(`uncaught page errors:\n    ${errors.join('\n    ')}`)
  if (exited) fail('the app quit during the check')
  console.log('desktop smoke: PASS')
} finally {
  await browser?.close().catch(() => {})
  kill()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* a child still holding a file; it is a temp dir */
  }
}
