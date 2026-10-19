// Which pages the shell trusts, and what a page it doesn't trust may still do.
//
// The preload hands every page that loads in one of our windows the folder, socket and OPC UA bridges
// (preload.cjs), and `project:write` takes an absolute path. So the desktop app's security rests on
// "only our page ever talks to main". Three paths could break that:
//   - window.open / target=_blank: Electron's default opens any url in a new BrowserWindow that inherits
//     the opener's webPreferences, preload included (a plain external link in the toolbar would do it).
//   - navigation: a link or a script can move the app window itself to another origin, preload and all.
//   - IPC: main would answer whoever asks.
// Navigation and window.open admit only the app's own origin (and the app's popped-out panels, which
// are about:blank portal targets); an http(s) or mailto link goes to the OS browser instead. And every
// IPC handler is registered through `guardIpc`, which refuses a sender that isn't the top frame of a
// page on the app's origin. The IPC check is deliberately redundant: if a future change reopens one of the
// other two paths, it still holds.
//
// Pure (no electron import) so `node apps/desktop/shellTrust.test.cjs` can pin it.

// The app's own scheme when it serves the built app (distProtocol.cjs): oip://app/app/.
const APP_SCHEME = 'oip'
const APP_HOST = 'app'

/** The origin of `url`, or null for one that has none (about:blank, data:, garbage). */
function originOf(url) {
  try {
    const u = new URL(url)
    if (u.origin && u.origin !== 'null') return u.origin
    // WHATWG URL gives a non-web scheme an opaque origin, but Chromium gives a scheme registered
    // `standard` (ours) a real one, scheme://host - and that is the origin the page lives on.
    return u.protocol === `${APP_SCHEME}:` && u.host ? `${APP_SCHEME}://${u.host}` : null
  } catch {
    return null
  }
}

/** Whether `url` is a page of the app served from `appOrigin`. */
function isAppUrl(url, appOrigin) {
  return !!appOrigin && originOf(url) === appOrigin
}

/** A link the OS browser (or mail client) may open on the user's behalf. Nothing that runs locally. */
function isExternalLink(url) {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

/**
 * What to do with a window.open / target=_blank from one of our pages:
 *   'popout'   a panel popped out (components/PopoutWindow.tsx): an about:blank window named oip-popout-*
 *   'app'      another page of the app itself
 *   'external' hand it to the OS browser, open nothing here
 *   'deny'     anything else (file:, javascript:, a custom scheme ...)
 */
function openDisposition(url, frameName, appOrigin, popoutPrefix) {
  const blank = !url || url === 'about:blank'
  if (blank && typeof frameName === 'string' && frameName.startsWith(popoutPrefix)) return 'popout'
  if (isAppUrl(url, appOrigin)) return 'app'
  if (isExternalLink(url)) return 'external'
  return 'deny'
}

/**
 * What to do when a page tries to navigate its own window to `url`: stay ('allow') if it is the app,
 * hand it to the OS browser ('external'), or refuse ('deny').
 */
function navigateDisposition(url, appOrigin) {
  if (isAppUrl(url, appOrigin)) return 'allow'
  if (isExternalLink(url)) return 'external'
  return 'deny'
}

/**
 * Whether an IPC event came from the app: the TOP frame (never an iframe) of a page on the app's origin.
 * `senderFrame` is null when the frame has already navigated away or gone, which is refused too.
 */
function isTrustedSender(event, appOrigin) {
  const frame = event && event.senderFrame
  if (!frame || frame.parent) return false
  return isAppUrl(frame.url, appOrigin)
}

/**
 * `ipcMain`, with every handler behind `trusted(event)`. Registrars (plcIo.cjs, opcUaIo.cjs, ...) take
 * this in place of the real one and need no change of their own. A refused invoke rejects; a refused
 * send is dropped, and a refused sendSync answers null rather than hanging the sender.
 */
function guardIpc(ipcMain, trusted, onRefused = () => {}) {
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...args) => {
        if (trusted(event)) return listener(event, ...args)
        onRefused(channel, event)
        throw new Error(`${channel}: refused, the sender is not the app`)
      })
    },
    on(channel, listener) {
      ipcMain.on(channel, (event, ...args) => {
        if (trusted(event)) return listener(event, ...args)
        onRefused(channel, event)
        event.returnValue = null
      })
    },
  }
}

module.exports = { APP_HOST, APP_SCHEME, guardIpc, isAppUrl, isExternalLink, isTrustedSender, navigateDisposition, openDisposition, originOf }
