// Boot check: load the app in a hidden Electron window and confirm it boots
// (title + a three.js <canvas> + a screenshot). Run: `electron smoke.cjs`. Writes smoke.json/.png.
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const path = require('node:path')

// headless CI box: no real GPU, so fall back to software WebGL (SwiftShader) so three.js still gets a
// context. A real desktop run uses the GPU and doesn't need these.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.commandLine.appendSwitch('no-sandbox')

// The editor lives at /app/ (site root is the marketing landing) - smoke-test the editor, not the landing.
const TARGET_URL = process.env.DESKTOP_URL || 'http://localhost:5173/app/'
const OUT = path.join(__dirname, 'smoke')

function done(status, code = 0) {
  try {
    writeFileSync(OUT + '.json', JSON.stringify(status, null, 2))
  } catch {}
  setTimeout(() => app.exit(code), 150)
}

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1600, height: 1000, show: false })
  win.removeMenu()
  let settled = false
  const finish = (s, code) => {
    if (settled) return
    settled = true
    done(s, code)
  }

  win.webContents.on('did-fail-load', (_e, errCode, desc, url) => finish({ ok: false, stage: 'load', errCode, desc, url }, 1))
  win.webContents.on('did-finish-load', () => {
    // give React + three.js time to boot and paint a frame (software GL + Jolt warmup is slow)
    const waitMs = Number(process.env.SMOKE_WAIT_MS || 6000)
    setTimeout(async () => {
      try {
        const title = await win.webContents.executeJavaScript('document.title')
        const canvases = await win.webContents.executeJavaScript('document.querySelectorAll("canvas").length')
        const gl = await win.webContents.executeJavaScript(
          '(() => { const c = document.querySelector("canvas"); if (!c) return null; const x = c.getContext("webgl2") || c.getContext("webgl"); return x ? "webgl-ok" : "no-context"; })()',
        )
        const img = await win.webContents.capturePage()
        writeFileSync(OUT + '.png', img.toPNG())
        const body = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 200)')
        finish({ ok: canvases > 0, title, canvases, gl, bodyText: body }, canvases > 0 ? 0 : 1)
      } catch (err) {
        finish({ ok: false, stage: 'inspect', error: String(err) }, 1)
      }
    }, waitMs)
  })

  win.loadURL(TARGET_URL)
})

// a hard timeout so this can never hang the harness
setTimeout(() => {
  try {
    writeFileSync(OUT + '.json', JSON.stringify({ ok: false, stage: 'timeout' }))
  } catch {}
  app.exit(2)
}, 40000)
