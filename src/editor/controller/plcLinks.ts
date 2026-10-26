// The EditorController's (../controller.ts) links to PLCs outside the app: an external PLC
// over Modbus / S7 / OPC UA / EtherNet/IP / ADS, its tag browse, and the simulated PLC's OPC UA server.
// The link's module, session, status, tag list and the server are this area's own state (PlcLinkState, held by
// the controller); the attached program's state (ProgramState) is passed where a link reads or hands back
// ownership, and the store, sim and the injected hosts come in as narrow dependencies (PlcLinkDeps).

import { controllerFor, LocalPlcLink, runnableSource } from '../../plc'
// deep import: the wiring check is a checker, not part of the runtime PLC surface the barrel exposes
import { checkWiring } from '../../plc/wiring'
// the link's sessions are loaded on use (loadExternalPlc): only what the first frame shows is static
import { EXTERNAL_PLC_OFF, flattenFrameTags } from '../links/externalPlcStatus'
import type { ExternalPlcLink, ExternalPlcStatus, PlcTagList } from '../links/externalPlcStatus'
import { OpcUaServerSession, publishedVariables } from '../links/opcUaServer'
import type { PublishedProgram } from '../links/opcUaServer'
import type { ExternalPlcSettings } from '../store/storePrefs'
import type { EditorStore } from '../store/store'
import { NO_PROGRAM, setDriven, setProgramStatus } from './program'
import type { ProgramState } from './program'
import type { EditorController } from '../controller'

export type ExternalPlcModule = typeof import('../links/externalPlc')

/** The links to PLCs outside the app: the external-PLC link's module and session, its tag browse, and the OPC UA server. */
export class PlcLinkState {
  // the external-PLC link's module, loaded on first use (loadExternalPlc) and warmed at startup when a link is on
  externalPlc: ExternalPlcModule | null = null
  externalPlcLoad: Promise<ExternalPlcModule> | null = null
  // the external-PLC link of the current run (editor/links/externalPlc.ts), and who watches its status
  externalSession: ExternalPlcLink | null = null
  externalStatus: ExternalPlcStatus = EXTERNAL_PLC_OFF
  readonly watchers = new Set<() => void>()
  // the PLC's tag names for the Inspector's tag picker: a run's last browse, kept after Stop, or a read while stopped
  plcTags: PlcTagList | null = null
  // the simulated PLC's OPC UA server (editor/links/opcUaServer.ts): up for as long as it is switched on, across runs
  uaServer: OpcUaServerSession | null = null
  uaServerSettings: ExternalPlcSettings | null = null
}

/** what the links read: the document's link settings (store), the worker (sim), the latest frame and program watch,
 *  which Play this is, the hosts the shell (or a test) hands in, and the speed control Play with an external PLC resets to 1x */
export type PlcLinkDeps = Pick<
  EditorController,
  'store' | 'sim' | 'lastFrame' | 'plcWatch' | 'runSerial' | 'plcIoHost' | 'opcUaHost' | 'eipHost' | 'adsHost' | 'opcUaServerHost' | 'setTimeScale'
>

/** Tell whoever watches the links (the toolbar's link status, Controller Properties) that something changed. */
export function notifyExternal(l: PlcLinkState): void {
  for (const cb of l.watchers) cb()
}

/** The external-PLC link's sessions (editor/links/externalPlc.ts), out of the first frame because only a desktop run
 *  with a link uses them. One load, kept; a failed one is forgotten so the next use tries again. */
export function loadExternalPlc(l: PlcLinkState): Promise<ExternalPlcModule> {
  l.externalPlcLoad ??= import('../links/externalPlc').then(
    (m) => (l.externalPlc = m),
    (e: unknown) => {
      l.externalPlcLoad = null
      throw e
    },
  )
  return l.externalPlcLoad
}

/**
 * Attach this run's external PLC, now if the link's module is loaded (it is warmed at startup), else once it is.
 * The world stays held until then, as for any attach: true means the release is the load's to make, which it makes
 * whatever happens, and only for the run that asked (Stop and Play again while it loads start a world of their own).
 */
export function startExternalPlc(l: PlcLinkState, p: ProgramState, ec: PlcLinkDeps): boolean {
  if (l.externalPlc) {
    attachExternalPlc(l, p, ec, l.externalPlc)
    return false
  }
  const serial = ec.runSerial
  const current = (): boolean => serial === ec.runSerial && ec.store.getState().running
  void loadExternalPlc(l)
    .then(
      (m) => {
        if (current()) attachExternalPlc(l, p, ec, m)
      },
      (e: unknown) => {
        if (current()) setProgramStatus(p, { ...NO_PROGRAM, warnings: [`The external PLC link could not load: ${e instanceof Error ? e.message : String(e)}`] })
      },
    )
    .catch((e: unknown) => console.error('[oip] external PLC attach failed', e))
    .finally(() => {
      if (current()) ec.sim.beginStepping()
    })
  return true
}

export function readPlcTags(l: PlcLinkState, ec: PlcLinkDeps): void {
  const host = ec.opcUaHost
  const endpoint = ec.store.getState().externalPlc.opcUaEndpoint
  if (!host || l.externalSession || l.plcTags?.state === 'reading') return
  const reading: PlcTagList = { endpoint, state: 'reading', names: [], variables: [], truncated: false, error: null }
  l.plcTags = reading
  notifyExternal(l)
  void loadExternalPlc(l)
    .then((m) => m.readOpcUaTagList(host, endpoint, () => l.externalSession === null))
    .then(
      (list) => {
        // a run that started meanwhile has taken the link over, and its browse is the one to keep
        if (l.plcTags === reading) l.plcTags = list
        notifyExternal(l)
      },
      (e: unknown) => {
        if (l.plcTags === reading) l.plcTags = { ...reading, state: 'failed', error: e instanceof Error ? e.message : String(e) }
        notifyExternal(l)
      },
    )
}

/** Keep what the run's OPC UA link browsed as the tag picker's list, once per browse. */
export function takeLinkBrowse(l: PlcLinkState): void {
  const s = l.externalSession
  // a run's session exists only once the module that made it has loaded
  const m = l.externalPlc
  if (!m || !(s instanceof m.ExternalPlcOpcUaSession) || !s.browsed) return
  if (l.plcTags?.state === 'ready' && l.plcTags.variables === s.browsed.variables) return
  l.plcTags = m.plcTagListOf(s.endpoint, s.browsed)
}

/**
 * Start, restart or stop the simulated PLC's OPC UA server to match its settings. Its own lifetime, not a
 * run's: a SCADA stays connected across Stop and Play, and sees the variables out of service in between.
 * Its status changes notify through {@link onExternalPlcStatus}, as the Controller Properties dialog reads both.
 */
export function syncOpcUaServer(l: PlcLinkState, p: ProgramState, ec: PlcLinkDeps): void {
  const settings = ec.store.getState().externalPlc
  const prev = l.uaServerSettings
  l.uaServerSettings = settings
  const host = ec.opcUaServerHost
  const want = host !== null && settings.uaServer
  const same = prev !== null && prev.uaServer === settings.uaServer && prev.uaServerPort === settings.uaServerPort && prev.uaServerNetwork === settings.uaServerNetwork
  if (same && (l.uaServer !== null) === want) return
  const old = l.uaServer
  l.uaServer = null
  const next = want
    ? new OpcUaServerSession(
        host,
        { port: settings.uaServerPort, network: settings.uaServerNetwork },
        (values) => {
          // a client's write reaches the program only while it runs here; the server refuses one otherwise
          if (p.plcAttached && ec.store.getState().running) ec.sim.writePlcVars(values)
        },
        () => notifyExternal(l),
      )
    : null
  l.uaServer = next
  // the old server lets go of the port before the new one asks for it
  void (old ? old.stop() : Promise.resolve()).then(() => {
    if (next === null || l.uaServer !== next) return notifyExternal(l)
    void next.start()
    if (p.uaProgram && p.plcAttached) publishToUaServer(l, ec.store, p.uaProgram)
    else publishDocumentProgram(l, ec.store)
    next.update(ec.plcWatch, p.plcAttached)
  })
  notifyExternal(l)
}

/** Publish a program's variables, with what the scene feeds read-only (editor/links/opcUaServer.ts publishedVariables). */
export function publishToUaServer(l: PlcLinkState, store: EditorStore, program: PublishedProgram): void {
  if (!l.uaServer) return
  const feeds = new Set(checkWiring(store.getState().scene.parts).tags.filter((t) => t.writers.length > 0).map((t) => t.name))
  l.uaServer.publish(publishedVariables(program, feeds))
}

/** While stopped, the server publishes the document's program as it compiles, so a SCADA can browse it before Play. */
export function publishDocumentProgram(l: PlcLinkState, store: EditorStore): void {
  const { stProgram, controller, stScanMs } = store.getState()
  try {
    publishToUaServer(l, store, new LocalPlcLink(runnableSource(stProgram, controllerFor(stProgram, controller, stScanMs))))
  } catch {
    // a program that does not compile publishes nothing new; Play reports why
  }
}

/**
 * Play with an external PLC: carry the scene's I/O addresses over Modbus instead of running the program
 * in-process - serving them to a PLC that polls, or polling a PLC that serves, as Controller Properties
 * says. The PLC drives what it writes (ctx.tagDriven, as an attached program's outputs do), and the program
 * here is not attached, which the PLC panel says. The PLC keeps wall-clock time, so Play starts at 1x; another
 * speed is allowed afterwards, and the toolbar's speed button warns that the PLC's timing no longer matches.
 */
export function attachExternalPlc(l: PlcLinkState, p: ProgramState, ec: PlcLinkDeps, m: ExternalPlcModule): void {
  const host = ec.plcIoHost
  const s = ec.store.getState()
  if (!host) return
  if (s.timeScale !== 1) ec.setTimeScale(1)
  const onChange = (): void => {
    takeLinkBrowse(l)
    notifyExternal(l)
  }
  let session: ExternalPlcLink
  let points: number
  if (s.externalPlc.mode === 'ads') {
    if (!ec.adsHost) return
    const { points: named, problems } = m.deriveAdsPoints(s.scene.parts)
    session = m.adsLink(ec.adsHost, s.externalPlc.adsNetId, s.externalPlc.adsPort, named, problems, onChange)
    points = named.length
  } else if (s.externalPlc.mode === 'eip') {
    if (!ec.eipHost) return
    const { points: named, problems } = m.deriveEipPoints(s.scene.parts)
    session = new m.ExternalPlcEipSession(ec.eipHost, s.externalPlc.eipGateway, s.externalPlc.eipPath, named, problems, onChange)
    points = named.length
  } else if (s.externalPlc.mode === 'opcua') {
    if (!ec.opcUaHost) return
    const { points: named, problems } = m.deriveOpcUaPoints(s.scene.parts)
    session = new m.ExternalPlcOpcUaSession(ec.opcUaHost, s.externalPlc.opcUaEndpoint, named, problems, onChange)
    points = named.length
  } else if (s.externalPlc.mode === 's7') {
    const { io, problems } = m.deriveS7Io(s.scene.parts, s.externalPlc)
    session = m.s7Link(host, io, problems, onChange)
    points = io.points.length
  } else if (s.externalPlc.mode === 'poll') {
    const { io, problems } = m.deriveClientIo(s.scene.parts, s.externalPlc)
    session = new m.ExternalPlcClientSession(host, io, problems, onChange)
    points = io.points.length
  } else {
    const { io, problems } = m.deriveExternalIo(s.scene.parts, s.externalPlc)
    session = new m.ExternalPlcSession(host, io, problems, onChange)
    points = io.points.length
  }
  l.externalSession = session
  setDriven(p, ec.sim, session.driven)
  setProgramStatus(p, {
    ...NO_PROGRAM,
    warnings: [
      points > 0
        ? `An external PLC runs this project (Controller Properties), so the program here is not attached.`
        : s.externalPlc.mode === 'opcua' || s.externalPlc.mode === 'eip' || s.externalPlc.mode === 'ads'
          ? `An external PLC runs this project over ${s.externalPlc.mode === 'eip' ? 'EtherNet/IP' : s.externalPlc.mode === 'ads' ? 'ADS' : 'OPC UA'}, but no part has a PLC tag (the PLC's name for it, like ${s.externalPlc.mode === 'eip' ? 'Eye' : 'MAIN.Eye'}), so it has nothing to read or drive.`
          : 'An external PLC runs this project, but no part is wired to an I/O address (a PLC tag like %IX0.0), so it has nothing to read or drive.',
    ],
  })
  void session.start(flattenFrameTags(ec.lastFrame?.tags)).then(() => {
    // a port that would not open leaves nothing driving the devices: hand them back
    if (l.externalSession === session && session.status().state === 'failed') {
      setDriven(p, ec.sim, [])
    }
    notifyExternal(l)
  })
  notifyExternal(l)
}

/** Close the external-PLC link of this run, keeping its last status for the dock to show. */
export function detachExternalPlc(l: PlcLinkState): void {
  const session = l.externalSession
  if (!session) return
  l.externalSession = null
  l.externalStatus = { ...session.status(), state: 'off', masters: [] }
  void session.stop().then(() => notifyExternal(l))
}
