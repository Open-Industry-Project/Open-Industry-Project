// Which of a window's links a PLC call is for. A window runs one link per controller: link 0 is the default
// controller's, and each named controller (`Cell2::%IX0.0`, src/core/io/controllerTag.ts) has a number of its own
// (src/editor/links/linkHosts.ts). A call without `link` is link 0. plcIo.cjs, opcUaIo.cjs, eipIo.cjs and adsIo.cjs
// key their links by window and number through this, and opcUaServer.cjs each simulated controller's OPC UA server.

const MAX_LINKS = 32

/** The link number a call names: a whole number below {@link MAX_LINKS}, 0 when absent, null when malformed. */
function linkNo(opts) {
  const raw = opts?.link
  if (raw === undefined) return 0
  return Number.isInteger(raw) && raw >= 0 && raw < MAX_LINKS ? raw : null
}

/** The map key of a window's link `link`. */
function linkKey(senderId, link) {
  return `${senderId}:${link}`
}

/** The keys of every link a window holds in `map`. */
function windowKeys(map, senderId) {
  const prefix = `${senderId}:`
  return [...map.keys()].filter((k) => k.startsWith(prefix))
}

/**
 * Run `close(senderId)` once a window's page is gone: the window closed, or its page reloaded or went to another
 * page. A reload keeps the window, so without this the links and servers a page opened would hold their ports past
 * it, and the new page would never close the ones its project no longer has. An in-page hash change is not a
 * navigation here. `watched` keeps it to one hook per page.
 */
function onPageGone(sender, watched, close) {
  if (watched.has(sender.id)) return
  watched.add(sender.id)
  const id = sender.id
  const gone = () => {
    sender.removeListener('did-navigate', gone)
    sender.removeListener('destroyed', gone)
    watched.delete(id)
    close(id)
  }
  sender.once('destroyed', gone)
  sender.on('did-navigate', gone)
}

const BAD_LINK = 'not a link number (0-31)'

module.exports = { MAX_LINKS, linkNo, linkKey, windowKeys, onPageGone, BAD_LINK }
