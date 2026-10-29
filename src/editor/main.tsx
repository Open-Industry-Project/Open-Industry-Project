// First: part code (geometry, idle Use) runs in this realm, so it locks down before anything else runs
// (core/lockdownBoot.ts, docs/part-sandbox.md)
import '../core/lockdownBoot'
import { createRoot } from 'react-dom/client'
import { blankScene, setNextIdSuffix } from '../core/scene/scene'
import { DEFAULT_SIM_HZ } from '../core/types'
import type { SceneJSON, SimRate } from '../core/types'
import type { Controller } from '../core/controller'
import type { DemoSeed } from '../collab/demoRoom'
import {
  getLocalActorName,
  initCollabSession,
  isLocalDragging,
  remoteDragPoses,
  setCollabContext,
  setLocalRunning,
  setLocalSelection,
  setRoomCodeGate,
  subscribePeers,
} from '../collab/session'
import { consumeSeedMark, resolveRoom, type ResolvedRoom } from '../collab/rooms'
import { SimClient } from '../sim/client'
import { getPartThumbnails, renderPackageThumbnails } from '../render/viewport/thumbnails'
import { getPackage, registerPackage } from '../core/parts/partRegistry'
import type { PackageManifest } from '../core/parts/partPackage'
import { partSandboxActive } from '../core/parts/partSandbox'
import { DESKTOP_SHELL } from './desktop/desktopMenuBridge'
import { prefetchSceneAssets } from './prefetchSceneAssets'
import { prefetchThumbnails } from '../render/prefetch'
import { bundledBehaviors, bundledThumbnailIds, loadBundledExamples, registerBundledPackages } from './parts/bundledExamples'
import { speculativeFetches } from '../render/gltf'
import { App } from './App'
import { AppCrashBoundary } from './components/CrashDialog'
import { createPlcDemoScene, DEMO_CONTROLLER, DEMO_PROGRAM } from './demo/demoScenes'
import { DEFAULT_SCAN_MS } from './program/stProgram'
import { importSceneText, loadSceneText, sceneFileText } from './project/sceneFile'
import { PROJECT_KEY, loadStoredProject, noteWorkingCopyWrite, onWorkingCopySuperseded, parkSplitOff, unopenedProject } from './project/projectFile'
import { startSplitFiling } from './project/projectSplit'
import { currentDocumentId, onCurrentDocumentChange, supportsDocumentLibrary, syncCurrentDocument, writeDocument } from './project/documentStore'
import { EditorStore } from './store/store'
import { initKeymapPrefs } from './keymapPrefs'
import { initNavPrefs } from './navigationPrefs'
import { initLanguage } from './autoTranslate'
import { followAppearance } from './appearance'
import { isFreshNavigation, isPhoneViewport, phoneOpensDemo } from './demo/phoneDemo'
import './styles.css'

// iOS reports "launched from the home screen" only through this non-standard flag - the
// display-mode media query is the Android/Chrome route - and styles.css needs the signal in
// CSS to pin #root to the screen instead of trusting a height unit (see the .standalone rules there). Stamped
// at module scope so it is applied before the first paint, not a frame into it.
if ((navigator as Navigator & { standalone?: boolean }).standalone) {
  document.documentElement.classList.add('standalone')
}

// Light / dark / follow the OS (appearance.ts). app/index.html already stamped the stored choice
// before the boot skeleton painted; this keeps it current from here on.
followAppearance(document)

/**
 * The user's persisted solo document (the project autosave's active scene and the program bound to
 * it), or a default building. Read as one unit, because that is what a room seed has to carry: a seed
 * that took its program from anywhere else could produce a room with a layout and no logic.
 */
function soloDocOrDefault(): { scene: SceneJSON; stProgram: string; stScanMs: number; controller: Controller | null; stDialect?: string; simHz: SimRate; library: Set<string> } {
  const loaded = loadStoredProject()
  return {
    scene: loaded?.scene ?? blankScene(),
    stProgram: loaded?.stProgram ?? '',
    stScanMs: loaded?.stScanMs ?? DEFAULT_SCAN_MS,
    controller: loaded?.controller ?? null,
    ...(loaded?.stDialect !== undefined ? { stDialect: loaded.stDialect } : {}),
    simHz: loaded?.simHz ?? DEFAULT_SIM_HZ,
    // the parts this user authored or forked: they seed a room as edits, not snapshots (schema.editedPackageIds)
    library: new Set((loaded?.library ?? []).map((p) => p.id)),
  }
}

/**
 * The demo as a room holds it (collab/demoRoom.ts): the same scene and program the solo `?scene=demo` boot opens.
 * Built with no room id suffix, because every client has to build the same demo to tell whether a room holds it,
 * and room mode suffixes minted ids with this client's id (setNextIdSuffix), which is put back as `roomSuffix`.
 */
function demoSeed(roomSuffix: string): DemoSeed {
  setNextIdSuffix('')
  try {
    return { scene: createPlcDemoScene(), stProgram: DEMO_PROGRAM, stScanMs: DEFAULT_SCAN_MS, controller: DEMO_CONTROLLER, simHz: DEFAULT_SIM_HZ }
  } finally {
    setNextIdSuffix(roomSuffix)
  }
}

// the user's rebindings, before anything can listen for a key (editor/keymapPrefs.ts)
initKeymapPrefs()
// the camera's mouse style (middle orbits or pans), before the view reads it (editor/navigationPrefs.ts)
initNavPrefs()
// the browser's language, before anything renders a string (editor/autoTranslate.ts)
initLanguage()

const store = new EditorStore()
const sim = new SimClient()
// a gesture's autosave trails it by a moment (store.deferPersist): flush it before the page can go away.
// `hidden` covers a mobile tab the OS may kill without a pagehide.
addEventListener('pagehide', () => store.flushPersist())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') store.flushPersist()
})

/**
 * Park an older multi-scene working copy's other scenes (projectFile.parkSplitOff) before the boot saves over it. If
 * they cannot be parked, nothing may be saved: the session goes read-only rather than lose them.
 */
function keepSplitOff(splitOff: readonly import('../core/project/project').ProjectJSON[] | undefined): void {
  if (!splitOff || splitOff.length === 0) return
  const parked = parkSplitOff(splitOff)
  if (parked.ok) return
  store.setReadOnly(true)
  store.showSaveNotice('Opened read-only', `This project holds several scenes, and they could not be kept apart for filing: ${parked.message}`)
}

/** the solo (no-room) boot path: demo / autosave / default */
function bootSolo(): void {
  // This build's own parts, before any saved document is loaded: that document's snapshot of a built-in part must
  // lose to the part itself, and it only does once the id is registered (registerBundledPackages).
  registerBundledPackages()
  // The project autosave: its scene, ST program and part library, with a
  // one-time migration from the legacy single-scene keys baked in. Returns null only on a first-ever visit.
  const saved = loadStoredProject()
  let demo = new URLSearchParams(location.search).get('scene') === 'demo'
  let phoneDemo = false
  // A phone can't author, so an empty scene is a dead end there: it gets the demo instead, through the same
  // boot as the landing CTA. The param goes in the address bar so everything after treats it as that boot
  // (a reload keeps the demo, opening a project clears it, an edit forks it). Rules: phoneDemo.ts.
  if (!demo && phoneOpensDemo({ phone: isPhoneViewport(), freshNavigation: isFreshNavigation(), stored: saved, unopened: unopenedProject() !== null })) {
    const url = new URL(location.href)
    url.searchParams.set('scene', 'demo')
    history.replaceState(history.state, '', url.pathname + url.search + url.hash)
    demo = true
    phoneDemo = true
  }
  // The landing page's "See it run" CTA links to /app/?scene=demo: open straight into the
  // ready-made PLC sortation demo (scene + paired program) so a first-time visitor sees
  // a working line, not an empty warehouse. persist:false keeps it from overwriting a
  // returning user's saved autosave.
  if (demo) {
    // Adopt a returning user's project first, ownership only: no scene switch, no tab UI, nothing they
    // can see (adoptOnly, store.loadProject). Then the demo's first persisting edit is saved as a
    // new scene beside their work (store.stashDemoSession) instead of assembling a one-scene project over
    // PROJECT_KEY, which would destroy their other scenes, its program, and the project name. Their
    // library is not made live: it holds a copy of every part their project uses, and the demo runs this
    // build's parts (store.enterDemoSession).
    store.setUnopenedProject(unopenedProject())
    keepSplitOff(saved?.splitOff)
    if (saved) store.loadProject(saved.project, { adoptOnly: true })
    else store.restoreUserPackages() // no project doc: the legacy authored-parts key is all there is
    // The same ephemeral demo view the in-app Demo action opens (store.enterDemoSession): loaded
    // persist:false on both halves, so opening on the demo never overwrites a returning user's saved
    // scene or program, and it occupies no scene slot. The demo is rebuilt from source on every visit to
    // this URL, so it always matches the running build; the first persisting edit forks it into the
    // user's own named scene and retires the ?scene=demo param (store.stashDemoSession), so a later
    // reload opens that work rather than the demo over the top of it.
    //
    // bank:false: this visit opens on the demo, so there is no scene of theirs on screen to bank.
    store.enterDemoSession(createPlcDemoScene(), DEMO_PROGRAM, { bank: false, controller: DEMO_CONTROLLER })
    // nobody asked for it, and a phone hides the Example badge that would say what this is
    if (phoneDemo) store.showSaveNotice('Showing the example', 'Phones can view and run a line, not build one, so this opened on the built-in example. Your projects are in the Project menu.')
    return
  }
  // A stored project that could not be opened is published before anything below tries to save: those saves
  // are refused (projectFile.saveStoredProject), and the banner has to say why and offer the way out.
  store.setUnopenedProject(unopenedProject())
  if (saved) {
    // An older multi-scene working copy: its other scenes are parked before anything below saves over it
    // (projectSplit.ts files them once the app is up)
    keepSplitOff(saved.splitOff)
    // Adopt the project: loads its scene live and seeds the library.
    store.loadProject(saved.project)
    // Lock in the legacy→project migration / refresh the doc now that the project is in state. (Refused
    // while an unopened project holds the working copy - this write would otherwise replace it.)
    store.persistProject()
  } else {
    store.loadScene(blankScene())
    store.restoreUserPackages()
  }
}

/**
 * Keep the document library in sync with the working copy (editor/project/documentStore.ts).
 *
 * The library makes more than one project possible, but it must never get between an edit and the
 * autosave: `oip-web/project` is written synchronously on every commit, and this is a trailing,
 * best-effort copy of that into IndexedDB. Same shape as App’s dock-size persistence, for the same
 * reason: a full project serialize per keystroke is too expensive.
 *
 * The first sync is also the migration: a browser that predates the library has a working copy and
 * no records, so this files it as document #1 under the name it already had. It runs at boot rather
 * than on the first edit, so a returning user who opens the projects list to look sees their work in it.
 *
 * Three exclusions. Two are the ones the rename has: during the ?scene=demo preview nothing of the
 * user’s is on screen and snapshotProject() would mint a project out of a view that is
 * in no slot; in a room the collab doc is the document. The third is a stored project this session
 * could not open (projectFile.unopenedProject): what is on screen is a fallback, not that document, so
 * nothing is filed until it is discarded, and then as a new document, because the discard cuts the
 * pointer loose and the unopened one keeps its record.
 */
function trackDocumentLibrary(): void {
  if (!supportsDocumentLibrary()) return
  let timer: ReturnType<typeof setTimeout> | null = null
  // what a sync has to notice: the pieces a project document is made of, by reference, plus the
  // unopened flag whose clearing lets syncing start. The store notifies on every selection and
  // hover too, and re-serializing the project for those would be wasted work.
  const docState = () => {
    const s = store.getState()
    return [s.scene, s.stProgram, s.userPackages, s.projectName, s.unopenedProject] as const
  }
  let last = docState()
  // The row this session writes to, captured once. Not re-read per sync: an adoption (a .oip import,
  // a desktop folder open) clears the pointer on its way out so the incoming project is
  // filed as a new document (projectFile.forgetCurrentDocument), and the pagehide flush that follows
  // has to write to the document being left rather than mint a second copy of it. It moves only when the
  // document changes without a reload (a linked folder: documentStore.adoptDocumentInPlace). And it is
  // never captured for an unopened project: that record is not this session's to write.
  let docId = unopenedProject() !== null ? null : currentDocumentId()
  onCurrentDocumentChange((id) => {
    docId = id
  })
  const sync = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    const s = store.getState()
    if (s.collab || s.demoSession || s.readOnly || s.unopenedProject) return
    const project = store.snapshotProject()
    if (docId !== null) void writeDocument(docId, project)
    // no pointer yet: mint one and remember it (a first-ever visit, the boot after an adoption, or a
    // discarded unopened project). Only if nothing moved it meanwhile: an in-place adoption can complete
    // while this write is in flight, and its id is the one that must stick.
    else
      void syncCurrentDocument(project).then((id) => {
        if (docId === null) docId = id
      })
  }
  sync() // boot: file document #1 if this browser has never had a record
  store.subscribe(() => {
    const now = docState()
    if (now.every((v, i) => v === last[i])) return
    last = now
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(sync, 2000)
  })
  // A tab that goes away must not lose the library's last two seconds. pagehide covers the bfcache
  // and the close; visibilitychange covers a phone being backgrounded, which may never fire pagehide.
  addEventListener('pagehide', sync)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sync()
  })
}

/**
 * Every tab of the app on this origin shares one working copy, and a save writes the whole document, so two
 * tabs editing at once would erase each other's work in silence. Once another tab writes something other
 * than what this one last saw, this tab yields: it stops saving (projectFile refuses from then on) and goes
 * view-only, with a banner whose Reload makes it the tab holding the latest copy. The same yield fires when a
 * save finds the other tab's write before its storage event has arrived.
 *
 * Solo only: in a room the collab doc is the document and this tab never writes the working copy.
 */
function watchOtherTabs(): void {
  onWorkingCopySuperseded(() => store.yieldToOtherTab())
  addEventListener('storage', (e) => {
    if (e.storageArea !== localStorage) return
    // key null is another tab's localStorage.clear(): the working copy is gone from under this one too
    if (e.key === PROJECT_KEY || e.key === null) noteWorkingCopyWrite(e.key === null ? null : e.newValue)
  })
}

/**
 * The collaborative (room) boot path. Connects the Y.Doc + IndexedDB + Hocuspocus, seeds an
 * empty room from the user's current scene (so Share carries their work), syncs the store
 * from the doc, then wires the two-way bridge. Awaits first sync so we don't flash an empty
 * scene before remote state arrives.
 */
async function bootRoom(resolved: ResolvedRoom): Promise<void> {
  // `resolved` is the ?room= value classified (rooms.ts resolveRoom) into the server doc name +
  // auth token; view-ness follows from whether we hold the edit secret, so the server enforces it too.
  const { room } = resolved
  store.setCollabMode(true)
  // view-only: authoring is disabled and the bridge never writes to the doc
  if (resolved.view) store.setReadOnly(true)
  // load the collaboration stack (yjs + hocuspocus + y-indexeddb + y-codemirror) only for
  // rooms, so the solo bundle stays lean
  const [{ connectRoom, seedIfEmpty, collabUrl }, schema, { CollabBridge }, { createStCollabExtension }, trust, demoRoom, wasShipped, roomAssets] = await Promise.all([
    import('../collab/provider'),
    import('../collab/schema'),
    import('../collab/bridge'),
    import('../collab/stBinding'),
    import('../collab/codeTrust'),
    import('../collab/demoRoom'),
    import('./parts/shippedBehaviors').then((m) => m.loadShippedBehaviors()),
    import('../collab/roomAssets'),
  ])
  // a part's embedded models live in the collab server's asset store by hash (collab/roomAssets.ts), which an editor
  // may add to. Set before anything seeds or reads the room's packages: a read starts fetching the hashes it names.
  roomAssets.configureRoomAssets({ base: roomAssets.assetBaseFor(collabUrl()), room: resolved.docName, token: resolved.view ? null : resolved.token })
  const { ydoc, provider, whenSynced, serverSynced } = connectRoom(resolved)
  // room-unique part ids so two clients minting from the same count don't collide
  const idSuffix = '~' + ydoc.clientID.toString(36)
  setNextIdSuffix(idSuffix)
  initCollabSession(room, provider)
  await whenSynced
  // An empty room is seeded from the creator's current scene + PLC program (Share's
  // payload) - but only by the tab that minted the room, so opening a mistyped or stale
  // link can't upload this browser's private solo scene into a foreign room id. A viewer
  // never seeds.
  const mintedHere = consumeSeedMark(room)
  let seededCode: string[] = []
  if (!resolved.view && (mintedHere === 'demo' || demoRoom.isDemoRoom(ydoc))) {
    // Shared from the untouched demo: the room holds the demo until someone edits it, so an editor on a build with a
    // newer demo brings it up to date (collab/demoRoom.ts). Its packages are this app's own, so no code to note.
    demoRoom.syncDemoRoom(ydoc, demoSeed(idSuffix), {
      minted: mintedHere === 'demo',
      serverSynced: serverSynced(),
      ...(__BUILD_TIME__ > 0 ? { build: __BUILD_TIME__ } : {}),
    })
  } else if (!resolved.view && mintedHere === 'scene') {
    // scene and program from the same document, so a shared room can't get the layout without
    // the logic (see soloDocOrDefault)
    const solo = soloDocOrDefault()
    if (seedIfEmpty(ydoc, solo.scene, solo.stProgram, solo.stScanMs, solo.simHz, solo.controller, solo.stDialect, solo.library))
      seededCode = (solo.scene.packages ?? []).map((p) => p.behavior)
  }
  // Whose part code may run here (collab/codeTrust.ts): this app's own parts, in this build or any earlier one (a
  // room keeps a snapshot of the built-ins it places, shippedBehaviors.ts), and code this browser wrote itself,
  // whether just now (the seed, a part authored in the room) or on an earlier visit (remembered by fingerprint).
  // The rest of the room's code: where the realm is locked down it runs in the part sandbox (docs/part-sandbox.md),
  // on the desktop too, whose main process also limits what an escape could reach (folder grants, endpoint consent).
  // Where lockdown failed it waits until the user allows the room (RoomCodePrompt), which this browser then remembers.
  const shipped = bundledBehaviors()
  const shippedCode = new Set(shipped.values())
  const sandboxed = partSandboxActive()
  // Safe open: the room's foreign code is held this time even where it would run - asked for with `?nocode`, or
  // because the last open of this room never finished (it froze or crashed the page; codeTrust.ts recovery). The
  // sandbox confines part code but cannot stop it spinning, so this is how a room with a hostile part stays openable.
  const safe: 'link' | 'recovered' | null = new URLSearchParams(location.search).has('nocode')
    ? 'link'
    : sandboxed && trust.roomOpenDidNotFinish(resolved.docName)
      ? 'recovered'
      : null
  const runsByDefault = sandboxed || trust.isRoomCodeTrusted(resolved.docName)
  const gate = new trust.PackageGate(
    { isFirstParty: (src) => shippedCode.has(src) || wasShipped(src), sourceFor: (id) => shipped.get(id) },
    safe ? false : runsByDefault,
    (src) => void trust.rememberOwnCode(src),
  )
  for (const src of seededCode) gate.noteOwn(src)
  for (const src of await trust.ownCodeAmong(schema.readPackages(ydoc).map((p) => p.behavior))) gate.noteOwn(src)
  // From the moment foreign code may run until the page has shown it survives: a normal leave (pagehide) or 30 s of
  // staying responsive clears the mark. A frozen tab that gets closed, or a crash, fires neither, so the mark stays
  // and the next open is a safe one. Armed only when there is someone else's code to run.
  const armRecovery = (): void => {
    if (!sandboxed || gate.getForeign().length === 0) return
    trust.markRoomOpening(resolved.docName, Date.now())
    const finished = (): void => trust.roomOpenFinished(resolved.docName)
    window.addEventListener('pagehide', finished, { once: true })
    window.setTimeout(finished, 30000)
  }
  // armed whenever someone else's code is about to run: at the first review, when a peer adds more mid-session, or
  // when the user allows a held room (the gate notifies on each of those)
  let foreignArmed = 0
  gate.subscribe(() => {
    const n = gate.getForeign().length
    if (gate.trusted && n > foreignArmed) armRecovery()
    foreignArmed = gate.trusted ? Math.max(foreignArmed, n) : foreignArmed
  })
  const unsubRemember = gate.subscribe(() => {
    if (!gate.trusted) return
    // a sandboxed room runs its code on every normal open, so only an unsandboxed yes needs remembering
    if (!sandboxed) trust.rememberRoomCodeTrust(resolved.docName)
    unsubRemember()
  })
  setRoomCodeGate(gate, { sandboxed, docName: resolved.docName, safe })
  // register the room's custom-part packages before materializing the scene, so custom parts resolve on the
  // first paint; the bridge keeps them in sync thereafter. Both go through the gate: the scene embeds the
  // packages too, and the sim runs an embedded copy when the registry lacks the id.
  // This build's own parts go first: the room holds a snapshot of every built-in part it places, and only a
  // client that already knows which ids it ships can tell that snapshot (ignored) from a fork (store
  // applyRemotePackages). The viewport's later call is a no-op re-register.
  loadBundledExamples(store)
  // (the review notifies the gate's listeners, which arm the recovery mark before any of this code can run)
  store.applyRemotePackages(gate.review(schema.readPackages(ydoc)), schema.editedPackageIds(ydoc))
  store.applyRemote(gate.admitScene(schema.docToScene(ydoc)))
  // start the room scene's asset downloads now, not when the view mounts (see prefetchSceneAssets)
  prefetchSceneAssets(store.getState().scene)
  // the bridge also renders peers' live drags (over awareness, off the doc) via this presence source;
  // getLocalActorName stamps this client's display name onto its shared edit-feed entries
  // and this build's stamp: an editor claims the room for it, and yields (view-only) to a newer build's claim
  new CollabBridge(store, ydoc, { subscribe: subscribePeers, remoteDragPoses, isLocalDragging }, resolved.view, getLocalActorName, gate, __BUILD_TIME__ > 0 ? __BUILD_TIME__ : undefined)
  // expose the shared ST program (Y.Text) + its CodeMirror binding to the editor panel
  const ytext = ydoc.getText(schema.ST_PROGRAM_TEXT)
  setCollabContext({ ytext, stExtension: createStCollabExtension(ytext, provider.awareness) })
  // broadcast this client's selection + run state for presence ("who's editing what",
  // and who's running a private preview)
  store.subscribe(() => {
    setLocalSelection(store.getState().selectedIds)
    setLocalRunning(store.getState().running)
  })
}

function mount(): void {
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('hook')) {
    const hook = (window.__oip ??= {})
    // getPartThumbnails + getBundledThumbnails are exposed for the offline thumbnail generator (npm run
    // thumbnails): the first bakes the built-in cards, the second the first-party bundled custom-part cards
    // (rendered through the same offscreen factory, keyed by package id). Bundled packages are loaded +
    // registered in the viewport effect (loadBundledExamples), so the generator waits for them before calling.
    const getBundledThumbnails = async (): Promise<[string, string][]> =>
      [...(await renderPackageThumbnails(store.getState().bundledPackages)).entries()]
    // ...and getSourceThumbnails renders part sources that are no built-in (a first-party library's, libraries/<lib>/<part>:
    // npm run thumbnails -- --libraries). Built here, so the generator needs no second bake.
    const getSourceThumbnails = async (sources: { manifest: PackageManifest; behavior: string }[]): Promise<[string, string][]> => {
      const { buildPackage } = await import('../sim/buildPackage')
      const pkgs = sources.map((x) => buildPackage(x.manifest, x.behavior))
      for (const p of pkgs) registerPackage(p)
      return [...(await renderPackageThumbnails(pkgs)).entries()]
    }
    // sceneFileText / importSceneText are the scene-file writer and Import Project's scene-file path, exposed so a gate
    // can prove the round trip end to end (a scene file re-opens and runs) without driving a file dialog;
    // loadSceneText is the fixture loader (it replaces the active scene, which no UI surface does)
    Object.assign(hook, {
      store,
      sim,
      getPartThumbnails,
      getBundledThumbnails,
      getSourceThumbnails,
      getPackage,
      registerPackage,
      speculativeFetches,
      sceneFileText: () => sceneFileText(store.getState()),
      // the controller is read at call time: App publishes it on the hook once the viewport mounts
      importSceneText: (text: string, fileName: string) => importSceneText(store, text, fileName, hook.controller),
      loadSceneText: (text: string) => loadSceneText(store, text),
    })
  }

  // Wrapped so a render/lifecycle throw shows the crash dialog (components/CrashDialog.tsx)
  // instead of unmounting the editor to a blank page with the document still only in localStorage.
  createRoot(document.getElementById('root')!).render(
    <AppCrashBoundary store={store}>
      <App store={store} sim={sim} />
    </AppCrashBoundary>,
  )

  // The sim worker (Jolt, ~3.5 MB) is spawned lazily so it doesn't compete with the
  // building/viewport on first load. Prewarm it once the page is idle, so the first
  // Play is still instant.
  const prewarm = (): void => sim.prewarm()
  if ('requestIdleCallback' in window) requestIdleCallback(prewarm, { timeout: 3000 })
  else setTimeout(prewarm, 2000)

  // Warm the catalog thumbnails (~80 KB total) on a short idle so switching the
  // Parts tabs is instant; otherwise each tab's <img> fetches only on first click
  // (inactive-tab cards aren't mounted). Cheap and visible, so it runs before the
  // heavier model warm.
  //
  // The bundled packages are the catalog, so their ids go in explicitly: PART_DEFS on its own
  // holds only `building` (see prefetchThumbnails). Manifests, not built packages: these are the
  // eager-globbed rig.json objects, available here at mount, whereas the built+registered packages
  // only exist after App's viewport effect runs loadBundledExamples, too late to warm anything.
  const warmThumbs = (): void => prefetchThumbnails(bundledThumbnailIds())
  if ('requestIdleCallback' in window) requestIdleCallback(warmThumbs, { timeout: 2000 })
  else setTimeout(warmThumbs, 1000)

  // The heavy part-model warm is a registry-derived sweep of the whole catalog through warmPart
  // (App.tsx → controller.warmCatalog), started after the view mounts and the scene paints. It is derived
  // from the registry because a hand-maintained list drifts and skips parts. Nothing to schedule here; the
  // thumbnail warm above runs here because it needs no view/controller.
}

const params = new URLSearchParams(location.search)

/**
 * ?xremu: install an emulated WebXR runtime + on-page headset/controller controls
 * (IWER + its DevUI) so the VR walkthrough can be driven with mouse/keyboard - no
 * headset, no browser extension, no vendor account. Must resolve before mount():
 * the toolbar's vrSupported() probe runs when it mounts, and IWER can only take
 * over navigator.xr before anything queries it. Dev-only: the DEV gate lets the
 * prod build drop the emulator chunks entirely (they'd otherwise end up in the PWA
 * precache for every user); E2E injects IWER itself via addInitScript instead.
 */
async function installXREmulator(): Promise<void> {
  if (!import.meta.env.DEV || !params.has('xremu')) return
  try {
    const [{ XRDevice, metaQuest3 }, { DevUI }] = await Promise.all([import('iwer'), import('@iwer/devui')])
    const device = new XRDevice(metaQuest3)
    // forceInstall: Chrome and Edge ship a native navigator.xr, which IWER otherwise steps aside for,
    // and ?xremu on a desktop with no headset then emulated nothing
    device.installRuntime({ forceInstall: true })
    // standing height before DevUI installs: its input layer snapshots the device pose
    // as the rig default and re-syncs it every frame, so a floor-level start sticks
    device.position.set(0, 1.7, 0)
    device.installDevUI(DevUI)
    // drivable from the console / E2E alongside the other dev hooks
    ;(window.__oip ??= {}).xrDevice = device
  } catch (err) {
    console.warn('[oip] WebXR emulator (?xremu) failed to load', err)
  }
}

const xremu = installXREmulator()

function startSolo(): void {
  watchOtherTabs()
  bootSolo()
  trackDocumentLibrary()
  // an older multi-scene project's other scenes, parked by the boot: filed now (projectSplit.ts); the folder sync
  // waits for it (App.tsx)
  startSplitFiling(store)
  // The scene is in the store now; its parts' GLBs/textures need not wait for the renderer
  // handshake + React mount that emits them today (~2.6 s of idle link under WebGPU).
  prefetchSceneAssets(store.getState().scene)
  void xremu.then(mount)
}

const room = params.get('room')
if (room) {
  void resolveRoom(room).then((resolved) => {
    // gate render on first sync so we don't flash an empty scene before remote state loads
    if (resolved) return void Promise.all([bootRoom(resolved), xremu]).finally(mount)
    // Not a room link (an unprefixed id from before edit secrets, or a garbled one): open solo and
    // say so, with the room taken out of the address bar so Share and a reload treat this tab as solo.
    const url = new URL(location.href)
    url.searchParams.delete('room')
    url.searchParams.delete('view')
    history.replaceState(history.state, '', url)
    startSolo()
    store.showSaveNotice(
      'Room link not recognized',
      'This link does not name a shared room, so the editor opened on its own. Ask whoever sent it for a new link from Share.',
    )
  })
} else {
  startSolo()
  // the desktop app booted to take a browser's project (Open in Desktop App; desktopHandoff.ts asks before importing)
  const handoff = DESKTOP_SHELL ? params.get('handoff') : null
  if (handoff) void import('./desktop/desktopHandoff').then((m) => m.receiveDesktopHandoff(store, handoff))
}
