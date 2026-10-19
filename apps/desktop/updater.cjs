// Updates for an installed app: electron-updater against the release bucket (package.json `build.publish`,
// Cloudflare R2 at downloads.openindustryproject.org/desktop/, written by scripts/desktop-release.mjs).
//
// Quiet by design, the same rule as the web's UpdatePrompt: nothing ever restarts on its own. A launch checks
// once (after the window is up, so it never competes with the first frame) and then every few hours. A new
// version downloads in the background. Once it is fully downloaded and its signature checked against the
// publisher in the build's app-update.yml, the page shows a notice with a Restart button (DesktopUpdateToast);
// otherwise it installs on the next quit. Help > Check for Updates... runs the same check and reports the result.
//
// The notice is the page's, never a dialog. A window-modal dialog that waits for an answer also blocks the window
// it belongs to. Measured: the app then ignored being closed (the taskbar's Close, a shutdown) for two minutes,
// where the same app with no dialog up quits in a second. Dialogs are kept for checks the user asked for.
//
// An unpackaged shell never checks: it has no app-update.yml, and it is not an installation to update.

const UPDATE_DELAY_MS = 15 * 1000
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Wire the updater. `getWindow()` is the app window dialogs belong to (or null). Returns
 * { checkInteractive(win) } for the menu item; a no-op object when not packaged.
 */
function setupUpdater({ app, dialog, getWindow, notifyReady }) {
  const say = (win, opts) => {
    const parent = win && !win.isDestroyed() ? win : getWindow()
    return parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts)
  }
  if (!app.isPackaged) {
    return {
      readyVersion: () => null,
      install: () => {},
      checkInteractive: (win) =>
        say(win, {
          type: 'info',
          title: 'Check for Updates',
          message: 'Updates are checked only in an installed app.',
          detail: 'This is the development shell; it runs whatever the repo holds.',
          buttons: ['OK'],
        }),
    }
  }

  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = { info: (m) => console.log('[update]', m), warn: (m) => console.warn('[update]', m), error: (m) => console.error('[update]', m), debug: () => {} }

  // the version downloaded and waiting to install, announced to the page once per version
  let prompted = null
  autoUpdater.on('update-downloaded', (info) => {
    if (prompted === info.version) return
    prompted = info.version
    notifyReady(info.version)
  })
  // Silent, and relaunch after: quitAndInstall() with no arguments runs the installer's full wizard (install for
  // me or for everyone, the folder ...) in the middle of an update. The installer is one-click per-user anyway
  // (package.json `nsis`), so there is nothing to ask. Install-on-quit is silent by default.
  const install = () => setImmediate(() => autoUpdater.quitAndInstall(true, true))

  const quietCheck = () => autoUpdater.checkForUpdates().catch((e) => console.warn('[update] check failed:', e?.message ?? e))
  setTimeout(quietCheck, UPDATE_DELAY_MS)
  setInterval(quietCheck, UPDATE_INTERVAL_MS)

  return {
    readyVersion: () => prompted,
    install,
    async checkInteractive(win) {
      try {
        const result = await autoUpdater.checkForUpdates()
        const latest = result?.updateInfo?.version
        if (!result || !result.isUpdateAvailable) {
          await say(win, { type: 'info', title: 'Check for Updates', message: "You're up to date.", detail: `Version ${app.getVersion()} is the latest.`, buttons: ['OK'] })
        } else if (prompted === latest) {
          // already downloaded and put off with Later: offer the restart again, since that is what was asked for
          const { response } = await say(win, {
            type: 'info',
            title: 'Update Ready',
            message: `Version ${latest} of Open Industry Project is ready.`,
            detail: 'Restart now to update, or it installs the next time you quit the app.',
            buttons: ['Restart Now', 'Later'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          })
          if (response === 0) install()
        } else {
          await say(win, {
            type: 'info',
            title: 'Check for Updates',
            message: `Version ${latest} is available.`,
            detail: "It is downloading now; a notice in the app offers the restart when it's ready.",
            buttons: ['OK'],
          })
        }
      } catch (e) {
        await say(win, { type: 'error', title: 'Check for Updates', message: 'Could not check for updates.', detail: String(e?.message ?? e), buttons: ['OK'] })
      }
    },
  }
}

module.exports = { setupUpdater }
