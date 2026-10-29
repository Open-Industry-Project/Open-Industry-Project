import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PresenceStack } from './PresenceStack'
import { DEMO_SCENE_NAME } from '../demo/demoScenes'
import { liveChannel, markGoLive } from '../live/liveChannel'
import type { MouseEvent, ReactElement } from 'react'
import { getCollabSnapshot, subscribeCollab } from '../../collab/session'
import { docNameForSecret, EDIT_PREFIX, markRoomForSeed, mintEditSecret, type SeedKind } from '../../collab/rooms'
import { enterRoomInPlace } from '../roomEntry'
import { mintOwnerToken, noteSharedProject, ownSharedProject, stopSharing } from '../project/sharedProject'
import { currentDocumentId } from '../project/documentStore'
import { collabUrl, onOtherCollabServer, SERVER_PARAM, shareableLink } from '../../collab/collabServer'
import { keymapRev, subscribeKeymap } from '../../core/keymap'
import { commandChord, commandEnabled, getCommand, runCommand, SIM_SPEEDS } from '../commands'
import { DESKTOP_MAC, DESKTOP_SHELL, getOipMenuApi } from '../desktop/desktopMenuBridge'
import { keyHint, withKey } from '../keyHint'
import type { EditorController } from '../controller'
import type { EditorState, EditorStore } from '../store/store'
import { ForcesStatus } from './plc/ForcesStatus'
import { PlcLinkStatus } from './plc/PlcLinkStatus'
import { ProjectMenu } from './ProjectMenu'
import { focusFirstMenuItem, fromKeyboard, menuKeys, useDismiss } from './popover'
import {
  ChevronIcon,
  DistractionFreeIcon,
  ExternalLinkIcon,
  EyeIcon,
  GitHubIcon,
  HelpIcon,
  OverflowIcon,
  PauseIcon,
  PencilIcon,
  PilotIcon,
  PlayIcon,
  SettingsIcon,
  BroadcastIcon,
  ShareIcon,
  StopIcon,
  VRIcon,
} from './toolbarIcons'
import { defineMessages, t, type MessageId } from '../../core/i18n'

const M = defineMessages('toolbar', {
  menuTitle: 'Menu (Alt)',
  menu: 'Menu',
  withChord: '{label} ({chord})',
  pausedHint: 'Already running (paused). Use Pause to resume',
  runningHint: 'Running. Use Stop to end the run',
  runPart: 'Run this part on its own',
  startSimTitle: 'Start Simulation',
  startSim: 'Start Simulation',
  resumeSimTitle: 'Resume Simulation (currently paused)',
  pauseSimTitle: 'Pause Simulation',
  resumeSim: 'Resume Simulation',
  pauseSim: 'Pause Simulation',
  stopSimTitle: 'Stop Simulation',
  stopSim: 'Stop Simulation',
  speedShortTitle:
    "Simulation Speed: {requested}× requested, ~{actual}× actual. This machine can't step the world any faster, so the sim advances slower than {requested}× real time (its own timing stays exact).",
  speedTitle: 'Simulation Speed: click to cycle 0.5×, 1×, 2×, 4×, 8× (Shift+click to step back)',
  speedPlcClockTitle:
    'Simulation Speed: {speed}×. The external PLC runs in real time, so away from 1× its timers and reaction times no longer match the simulation and the line can behave differently. Click to cycle (Shift+click to step back)',
  speedShortAria: 'Simulation is advancing at about {rate} times real time. Why?',
  speedNote: 'Simulation speed',
  runningAt: 'Running at ~{rate}× real time',
  runningAtRequested: 'Running at ~{rate}× real time ({requested}× requested)',
  deviceSlow: 'This device cannot step the world any faster, so the simulation advances slower than the clock on the wall.',
  timingExact: 'Its own timing stays exact: a 2 s timer is still 2 s of simulated time, it just takes longer to watch.',
  readOnlyTitle: 'You opened a read-only link. Watch and run the simulation, but editing is disabled',
  viewOnly: 'View only',
  liveBadge: 'Live',
  liveWatched: { one: 'Live · {count} watching', other: 'Live · {count} watching' },
  liveRunningTitle: 'Your run is streaming to everyone here as it happens. Live is switched on and off in Share.',
  liveIdleTitle: 'Your next run streams to everyone here. Live is switched on and off in Share.',
  waiting: '{name} is live · waiting for a run',
  joining: "Joining {name}'s run",
  waitingTitle: "{name} shares their runs live. The next one shows here as it happens.",
  watchShort: 'Watch',
  watching: 'Watching {name}',
  watchingTitle: "You are watching {name}'s run as it happens. Start Simulation runs your own copy instead.",
  stopWatching: 'Stop watching',
  offerWatch: '{name} is live · Watch',
  offerWatchTitle: "{name}'s runs stream to everyone here as they happen. Watch to see this one.",
  someone: 'Someone',
  runOwnCopy: 'Run my own copy (stops watching the live run)',
  liveSwitch: 'Live',
  liveSwitchSub: 'Stream your runs to everyone with a link',
  liveSwitchTitle: "Everyone with a link watches your runs as they happen. Editors' changes show in the stream.",
  liveOffStillShared: 'Live is off. The project stays shared.',
  stopSharing: 'Stop sharing',
  stopSharingSub: 'Work on {name} alone again. Links you gave out stop working.',
  stopSharingDemoSub: 'Back to the example on your own. Links you gave out stop working.',
  stopSharingRunning: 'Stop the simulation first',
  streamEnded: '{name} stopped streaming',
  liveTaken: '{name} is live',
  liveTakenSub: 'One person is live at a time',
  moreActions: 'More actions',
  speedItem: 'Speed: {speed}×',
  speedItemShort: 'Speed: {speed}× (~{actual}× actual)',
  shareLive: 'Share this project',
  startShare: 'Share this project',
  startLive: 'Share this project',
  share: 'Share',
  canEdit: 'Can edit',
  canEditSub: 'Anyone with the link can build and run',
  copy: 'Copy',
  canView: 'Can view',
  canViewSub: 'Anyone with the link can watch, not edit',
  viewLinkCopied: 'View link copied',
  liveNow: "You're live. Copy a link above to invite people.",
  sharedNow: 'This project is now shared: people you invite edit it with you.',
  undoStartsOver: 'Sharing starts a new undo history. Changes made before it cannot be undone.',
  linkCopiedShared: 'Link copied. This project is now shared.',
  startingRoom: 'Sharing…',
  inviteLinkCopied: 'Invite link copied',
  copyFailed: 'Copy failed',
  pilotTitle: '{label}: first-person walk-around; {exit} to exit',
  pilotMode: 'Pilot Mode',
  vrTitle:
    'VR Mode: walk the factory in a headset. Left stick walks, right stick turns, trigger uses; exit from the headset menu or click again',
  vrMode: 'VR Mode',
  distractionFreeTitle: '{label}: Shift+Click also toggles browser fullscreen',
  distractionFree: 'Distraction Free Mode',
  settings: 'Settings',
  helpTitle: 'Help: keyboard shortcuts, the tutorial, and the project on GitHub',
  help: 'Help',
  tutorialTitle: 'Opens in a project of its own. The one you are in is kept',
  openDesktopRoom: 'Opens this shared project in the desktop app',
  openDesktopCopy: 'Opens a copy of this project in the desktop app; this browser keeps its own',
  github: 'Open Industry Project on GitHub',
})

/** a command's label, through the seam (commands.ts) */
const commandLabel = (id: string): string => getCommand(id)?.label ?? id

// Windows/Linux desktop only: the shell hides the OS menu bar to save a row of height (main.cjs TITLE_BAR), so
// the toolbar's mark is the pointer path to the menu - it pops the real native Menu, not a copy of it.
// macOS never gets one: its menu lives in the screen's menu bar, where the OS owns the whole interaction.
function openAppMenu(e: MouseEvent<HTMLButtonElement>) {
  const r = e.currentTarget.getBoundingClientRect()
  getOipMenuApi()?.showAppMenu?.(Math.round(r.left), Math.round(r.bottom))
}

// The file and scene actions are not in this row: they are the project menu's (ProjectMenu.tsx), behind the
// project's name - and the scene's, once there is one to choose - at the left.

/** `label (chord)` for a transport button: F5 and friends in the desktop app, the app's own chord in the browser */
function withCommandKey(label: string, id: string): string {
  const cmd = getCommand(id)
  const chord = cmd ? commandChord(cmd) : ''
  return chord ? t(M.withChord, { label, chord }) : label
}

const GITHUB_URL = 'https://github.com/Open-Industry-Project/Open-Industry-Project'

interface ToolbarProps {
  store: EditorStore
  state: EditorState
  controller: EditorController | null
}

export function Toolbar({ store, state, controller }: ToolbarProps) {
  const [shareLabel, setShareLabel] = useState<MessageId | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  // entering a room in place holds the editor read-only for a moment (main.tsx registerRoomEntry), which is not view-only
  const [entering, setEntering] = useState(false)
  const shareRef = useRef<HTMLDivElement>(null)
  const shareButtonRef = useRef<HTMLButtonElement>(null)
  // WebXR walkthrough: the button only renders when an immersive-vr runtime exists
  // (a headset browser, or an emulated device via IWER / the Immersive Web Emulator)
  const [vrSupported, setVrSupported] = useState(false)
  const [vrActive, setVrActive] = useState(false)
  useEffect(() => {
    let stale = false
    void controller?.vrSupported().then((ok) => {
      if (!stale) setVrSupported(ok)
    })
    return () => {
      stale = true
    }
  }, [controller])
  // the "⋯" overflow: the file actions once the row is too narrow for them (and, on a phone, sim speed)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuListRef = useRef<HTMLDivElement>(null)
  // Help: the keyboard reference, the tour and the project's home, behind one button. They were three
  // icon buttons in the same chrome as the mode toggles beside them, so the link that LEAVES the app
  // looked exactly like one more toggle, and together they cost the row ~80px it measurably lacks.
  const [helpOpen, setHelpOpen] = useState(false)
  const helpRef = useRef<HTMLDivElement>(null)
  const helpButtonRef = useRef<HTMLButtonElement>(null)
  const helpListRef = useRef<HTMLDivElement>(null)
  // phone-only: the shortfall badge's explanation panel (the badge itself lives in .toolbar-run)
  const [speedNoteOpen, setSpeedNoteOpen] = useState(false)
  const speedNoteRef = useRef<HTMLDivElement>(null)
  const collab = useSyncExternalStore(subscribeCollab, getCollabSnapshot)
  // the tooltips below print chords from the ACTIVE keymap, so a rebinding in Settings has to re-render them
  useSyncExternalStore(subscribeKeymap, keymapRev)

  const closeShare = () => {
    setShareOpen(false)
    setShareLabel(null)
  }
  const closeMenu = () => setMenuOpen(false)
  const closeHelp = () => setHelpOpen(false)
  useDismiss(shareRef, closeShare, { active: shareOpen, trigger: shareButtonRef })
  useDismiss(menuRef, closeMenu, { active: menuOpen, trigger: menuButtonRef })
  useDismiss(helpRef, closeHelp, { active: helpOpen, trigger: helpButtonRef })
  useDismiss(speedNoteRef, () => setSpeedNoteOpen(false), { active: speedNoteOpen })

  // A menu opened from the KEYBOARD is the one the arrow keys then drive, so focus moves into it. Opened by
  // a click or a tap it stays where it was (popover.ts fromKeyboard).
  const menuByKey = useRef(false)
  const helpByKey = useRef(false)
  useEffect(() => {
    if (menuOpen && menuByKey.current) focusFirstMenuItem(menuListRef.current)
  }, [menuOpen])
  useEffect(() => {
    if (helpOpen && helpByKey.current) focusFirstMenuItem(helpListRef.current)
  }, [helpOpen])

  // This tab's room link. A solo tab mints a room, and its document seeds it: the untouched demo goes in as THE demo,
  // which stays current until someone edits it (collab/demoRoom.ts), with nothing flushed (an autosave would fork the
  // demo into the user's own scenes for no reason of theirs); anything else is flushed first, so the seed is what is on
  // screen.
  const roomLink = (): { url: URL; room: string; mint: SeedKind | null } => {
    const url = new URL(location.href)
    let room = url.searchParams.get('room')
    let mint: SeedKind | null = null
    if (!room) {
      room = mintEditSecret()
      url.searchParams.set('room', room)
      mint = store.getState().demoSession ? 'demo' : 'scene'
      if (mint === 'scene') store.flushAutosave()
    }
    // a room on a server other than the build's: the link has to say which (collab/provider.ts collabUrl)
    if (onOtherCollabServer()) url.searchParams.set(SERVER_PARAM, collabUrl())
    return { url, room, mint }
  }

  // Take this solo tab into the room it just minted: in place, with no reload (editor/roomEntry.ts). Where this surface
  // cannot, it reloads into the room, leaving the seed mark the room boot reads (rooms.ts: only the minting tab seeds).
  // True when it entered in place.
  const enterRoom = async (url: URL, room: string, mint: SeedKind, live = false): Promise<boolean> => {
    // a project of the user's own, shared, stays their project (project/sharedProject.ts)
    // ...and the demo, shared, is owned by whoever shared it, though it is no project of theirs (sharedProject.ts `demo`)
    const server = onOtherCollabServer() ? collabUrl() : null
    if (mint === 'scene') noteSharedProject({ docId: currentDocumentId(), room, project: store.getState().projectName, server, ownerToken: mintOwnerToken() })
    else noteSharedProject({ docId: null, room, project: DEMO_SCENE_NAME, server, ownerToken: mintOwnerToken(), demo: true })
    setEntering(true)
    const inPlace = await enterRoomInPlace(url.toString(), mint).finally(() => setEntering(false))
    if (inPlace) return true
    // the room boot after the reload reads the intent (live/liveChannel.ts markGoLive)
    if (live) markGoLive()
    markRoomForSeed(room, mint)
    location.assign(url.toString())
    return false
  }

  // Copy an invite link from the Share popover. 'edit' = the room's edit secret
  // (?room=e-…); 'view' = the derived doc name (?room=r-…), which holds no secret, so the
  // server refuses writes from it, so view-only is enforced there, not only in the UI (rooms.ts
  // has the scheme). A solo tab enters the room it mints (enterRoom), and the seeded room is what makes a view link
  // resolve to a populated scene rather than an empty one. (`&view=1` on a view link only labels it:
  // the r- doc name alone is what makes it view-only.)
  const copyShareLink = async (mode: 'edit' | 'view') => {
    const { url, room, mint } = roomLink()
    // the host's own tab always lands in edit mode; only the copied link is demoted
    const linkToCopy = new URL(url.toString())
    if (mode === 'view') {
      if (room.startsWith(EDIT_PREFIX)) linkToCopy.searchParams.set('room', await docNameForSecret(room))
      linkToCopy.searchParams.set('view', '1')
    }
    try {
      await navigator.clipboard?.writeText(shareableLink(linkToCopy).toString())
      setShareLabel(mint === 'scene' ? M.linkCopiedShared : mode === 'view' ? M.viewLinkCopied : M.inviteLinkCopied)
    } catch {
      setShareLabel(M.copyFailed)
    }
    setTimeout(() => setShareLabel(null), 2000)
    // the link is on the clipboard first, while the click still counts as the gesture a clipboard write needs
    if (mint && !(await enterRoom(url, room, mint))) return
    setTimeout(() => setShareOpen(false), 600)
  }

  // The Live switch: stream this client's runs, or stop. It only switches; the links above are how people get in. A
  // solo tab first enters a room of its own, in place, and the popover stays open on the links. Where that takes a
  // reload, the intent rides across it (live/liveChannel.ts markGoLive).
  const toggleLive = async () => {
    const { liveSharing } = store.getState()
    if (liveSharing || collab.room) {
      store.setState({ liveSharing: !liveSharing })
      // off, in a project of the user's own: it stays shared, which is a separate thing (Stop sharing)
      setShareLabel(liveSharing && ownSharedProject() ? M.liveOffStillShared : null)
      return
    }
    const { url, room, mint } = roomLink()
    if (!mint) return
    setShareLabel(M.startingRoom)
    if (!(await enterRoom(url, room, mint, true))) return
    // only now: the room's document has synced and its bridge is up (main.tsx registerRoomEntry)
    store.setState({ liveSharing: true })
    // stays while the popover is open: it names the next step, and says what going live did to the project
    setShareLabel(mint === 'scene' ? M.sharedNow : M.liveNow)
  }

  const stopSharingProject = async () => {
    const shared = ownSharedProject()
    const error = shared ? await stopSharing(store, shared) : null
    if (error !== null) alert(error)
  }

  // The CYCLE over the shared ladder (SIM_SPEEDS in editor/commands.ts, which also exposes each rung
  // as its own command for the menu and the palette). Click walks up and wraps 8x back to 0.5x;
  // Shift walks it back down, which is what keeps five rungs usable from one 40px control.
  const cycleSpeed = (e?: { shiftKey: boolean }) => {
    const i = SIM_SPEEDS.indexOf(state.timeScale as (typeof SIM_SPEEDS)[number])
    const next = (i + (e?.shiftKey ? SIM_SPEEDS.length - 1 : 1)) % SIM_SPEEDS.length
    controller?.setTimeScale(SIM_SPEEDS[next] ?? 1)
  }

  // The worker sheds backlog when it can't hold the requested speed, so the button's number can
  // overstate what is happening; state.speedActual is the measured rate when it does (null when
  // it's keeping up). Sim results stay exact either way - only wall-clock progress falls short.
  const speedShort = state.speedActual !== null
  // A real PLC scans on its own clock, so off 1x its timers and reactions drift from the sim's. Allowed (filling a
  // buffer fast, watching a handoff slowly), but flagged; Play itself resets to 1x (plcLinks.ts attachExternalPlc).
  const plcClock = state.running && state.timeScale !== 1 && state.externalPlc.enabled && (controller?.externalPlcAvailable ?? false)
  const speedTitle = plcClock
    ? t(M.speedPlcClockTitle, { speed: state.timeScale })
    : speedShort
      ? t(M.speedShortTitle, { requested: state.timeScale, actual: state.speedActual ?? 0 })
      : t(M.speedTitle)

  // A shortfall that clears unmounts the badge; reopening later should start closed rather than
  // restoring a panel the user dismissed by the machine catching up.
  useEffect(() => {
    if (!speedShort) setSpeedNoteOpen(false)
  }, [speedShort])

  const shortcutsKey = keyHint('ui.shortcuts')
  const paletteKey = keyHint('ui.commands')
  const tutorialCmd = getCommand('help.tutorial')

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        {/* The mark alone, no wordmark: the tab already names the app ("<project> - Open Industry Project",
            App.tsx), and a bold app name beside the bold project name read as two titles competing for the
            corner. Narrow windows, phones and the desktop shell never had the wordmark either, so this
            makes every surface match. The desktop shell hid the OS title bar to win back a row, so there
            the mark doubles as the menu button, the way a Windows app with no menu bar puts its
            icon top-left; macOS keeps its screen menu bar, so it shows nothing at all. The img is
            decorative. oip-icon.svg is the mark as true vector; the old oip-mark.svg was a TRACED 16px
            bitmap, so at the 24px this renders at it was an upscale of a blurry downscale. */}
        {!DESKTOP_SHELL && <img className="toolbar-logo" src="/oip-icon.svg" alt="" aria-hidden="true" />}
        {/* The caret is the project menu's own: a bare mark read as branding, and people did not find the
            menu behind it. Menu names in the row were measured instead: the six take 300px
            and only fit at 1520px and up, a width most laptops never reach at their usual display scaling. */}
        {DESKTOP_SHELL && !DESKTOP_MAC && (
          <button
            type="button"
            className="toolbar-menu-btn"
            data-tutorial="app-menu"
            title={t(M.menuTitle)}
            aria-label={t(M.menu)}
            aria-haspopup="menu"
            onClick={openAppMenu}
          >
            <img className="toolbar-logo" src="/oip-icon.svg" alt="" aria-hidden="true" />
            <ChevronIcon dir="down" size={12} />
          </button>
        )}
        <ProjectMenu state={state} />
      </div>
      <div className="toolbar-run">
        <LiveControl collab={collab} store={store} state={state} openShare={() => setShareOpen(true)} />
        <div className="run-transport segmented" role="group">
          <button
            className={`run-button play${state.running ? ' running' : ''}${state.liveFollowing ? ' watching' : ''}`}
            data-tutorial="play"
            // Paused is the case worth naming: the run is still going, so this stays disabled, and the
            // instinct is to reach HERE to resume rather than back to Pause. Say where the resume is
            // instead of leaving a dead button offering to "Start Simulation".
            title={
              state.paused
                ? t(M.pausedHint)
                : state.running
                  ? t(M.runningHint)
                  : state.liveFollowing
                  ? t(M.runOwnCopy)
                  : state.focusedPartId !== null
                  ? t(M.runPart)
                  : withCommandKey(t(M.startSimTitle), 'sim.run')
            }
            aria-label={t(M.startSim)}
            disabled={!controller || state.running}
            onClick={() => controller?.run()}
          >
            <PlayIcon />
          </button>
          <button
            className={`run-button pause${state.paused ? ' active' : ''}`}
            // This button IS the resume, because Play stays disabled for the whole run. So while
            // paused it has to SAY so: a fixed
            // "Toggle Pause" left the highlight as the only clue the run was held, and left a
            // screen reader with none at all - hence aria-pressed, which the two toggles beside
            // it in this row already carry.
            title={withCommandKey(t(state.paused ? M.resumeSimTitle : M.pauseSimTitle), 'sim.pause')}
            aria-label={t(state.paused ? M.resumeSim : M.pauseSim)}
            aria-pressed={state.paused}
            disabled={!controller || !state.running}
            onClick={() => controller?.togglePause()}
          >
            <PauseIcon />
          </button>
          <button
            className="run-button stop"
            data-tutorial="stop"
            title={withCommandKey(t(M.stopSimTitle), 'sim.stop')}
            aria-label={t(M.stopSim)}
            disabled={!controller || !state.running}
            onClick={() => controller?.stop()}
          >
            <StopIcon />
          </button>
        </div>
        <button
          className={`run-button speed${state.timeScale !== 1 ? ' boosted' : ''}${speedShort ? ' short' : ''}${plcClock ? ' plc-clock' : ''}`}
          data-testid="sim-speed"
          title={speedTitle}
          disabled={!controller}
          onClick={cycleSpeed}
        >
          {state.timeScale}×{speedShort && <span className="speed-actual">~{state.speedActual}×</span>}
        </button>
        {/* Phone twin of that button's shortfall readout. On a phone the speed button is dropped
            from the bar (CSS) and a `title` is unreachable by touch, so the device MOST likely to
            fall short of real time was the one saying nothing about it. Tapping opens the reason as
            TEXT. What it must convey: nothing is wrong with the run - physics and the interleaved
            PLC scan shed backlog TOGETHER (sim/worker.ts, sim/plcHost.ts), so sim time and every
            timer on it stay exact; it is wall-clock progress that falls short. Hidden on desktop
            and tablet (CSS), where the button carries the same reading. */}
        {speedShort && (
          <div className="speed-short-badge" ref={speedNoteRef}>
            <button
              type="button"
              className={`speed-short-button${speedNoteOpen ? ' active' : ''}`}
              aria-haspopup="dialog"
              aria-expanded={speedNoteOpen}
              aria-label={t(M.speedShortAria, { rate: state.speedActual ?? 0 })}
              onClick={() => setSpeedNoteOpen((v) => !v)}
            >
              ⚠ <span className="speed-short-rate">~{state.speedActual}×</span>
            </button>
            {speedNoteOpen && (
              <div className="speed-short-note" role="dialog" aria-label={t(M.speedNote)}>
                <strong>
                  {state.timeScale !== 1
                    ? t(M.runningAtRequested, { rate: state.speedActual ?? 0, requested: state.timeScale })
                    : t(M.runningAt, { rate: state.speedActual ?? 0 })}
                </strong>
                <span>{t(M.deviceSlow)}</span>
                <span>{t(M.timingExact)}</span>
              </div>
            )}
          </div>
        )}
        {/* while Play hands the scene to an external PLC: the link's state, where a vendor tool shows it is online */}
        {controller && <PlcLinkStatus state={state} controller={controller} />}
        {/* while the running program has forced variables: how many, and the way to release them */}
        {controller && <ForcesStatus controller={controller} state={state} />}
      </div>
      <div className="toolbar-right">
        <PresenceStack state={state} />
        {state.readOnly && !entering && (
          <span className="collab-viewonly" title={t(M.readOnlyTitle)}>
            {t(M.viewOnly)}
          </span>
        )}
        {/* The overflow: a phone's sim speed, which it drops from the bar (CSS shows this only there). The file
            actions are the project menu's on every layout, phones included. */}
        <div className="toolbar-overflow" ref={menuRef}>
          <button
            ref={menuButtonRef}
            className={`overflow-button${menuOpen ? ' active' : ''}`}
            title={t(M.moreActions)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t(M.moreActions)}
            onClick={(e) => {
              menuByKey.current = fromKeyboard(e)
              setMenuOpen((v) => !v)
            }}
          >
            <OverflowIcon />
          </button>
          {menuOpen && (
            <div className="overflow-popover" role="menu" aria-label={t(M.moreActions)} ref={menuListRef} onKeyDown={menuKeys(closeMenu)}>
              {/* phone-only (CSS): the speed button is dropped from the bar there. This
                  leaves the menu open so repeated taps cycle 0.5× → 1× → 2× → 4× → 8×. */}
              <button
                className="overflow-item overflow-speed"
                role="menuitem"
                title={speedTitle}
                disabled={!controller}
                onClick={cycleSpeed}
              >
                {speedShort
                  ? t(M.speedItemShort, { speed: state.timeScale, actual: state.speedActual ?? 0 })
                  : t(M.speedItem, { speed: state.timeScale })}
              </button>
            </div>
          )}
        </div>
        {!state.readOnly && (
          <div className="share-wrap" ref={shareRef}>
            <button
              ref={shareButtonRef}
              className={`share-button${shareOpen ? ' active' : ''}`}
              title={t(collab.room ? M.shareLive : M.startShare)}
              aria-haspopup="dialog"
              aria-expanded={shareOpen}
              onClick={() => setShareOpen((v) => !v)}
            >
              <ShareIcon />
              {/* label drops on a phone (CSS) - the glyph carries it there */}
              <span className="share-label">{t(M.share)}</span>
            </button>
            {/* A dialog, not a menu: it holds a text field and a status line, and a role="menu" promises
                arrow-key item navigation that a name field cannot take part in. */}
            {shareOpen && (
              <div
                className="share-popover"
                role="dialog"
                aria-label={t(collab.room ? M.shareLive : M.startLive)}
              >
                <div className="share-popover-head">{t(collab.room ? M.shareLive : M.startLive)}</div>
                <button className="share-option" onClick={() => void copyShareLink('edit')}>
                  <span className="share-option-icon">
                    <PencilIcon />
                  </span>
                  <span className="share-option-text">
                    <span className="share-option-label">{t(M.canEdit)}</span>
                    <span className="share-option-sub">{t(M.canEditSub)}</span>
                  </span>
                  <span className="share-option-copy">{t(M.copy)}</span>
                </button>
                <button className="share-option" onClick={() => void copyShareLink('view')}>
                  <span className="share-option-icon">
                    <EyeIcon />
                  </span>
                  <span className="share-option-text">
                    <span className="share-option-label">{t(M.canView)}</span>
                    <span className="share-option-sub">{t(M.canViewSub)}</span>
                  </span>
                  <span className="share-option-copy">{t(M.copy)}</span>
                </button>
                {/* Who gets in is the links above; whether runs stream to them is this switch. Taken while someone
                    else in the room is live: one person is live at a time. */}
                {(() => {
                  const taken = collab.liveBy !== null && !state.liveSharing
                  return (
                    <button
                      className={`share-option share-live${state.liveSharing ? ' on' : ''}${taken ? ' share-option-off' : ''}`}
                      role="switch"
                      aria-checked={state.liveSharing}
                      disabled={taken}
                      data-testid="share-live-switch"
                      title={taken ? undefined : t(M.liveSwitchTitle)}
                      onClick={() => void toggleLive()}
                    >
                      <span className="share-option-icon">
                        <BroadcastIcon />
                      </span>
                      <span className="share-option-text">
                        <span className="share-option-label">{taken ? t(M.liveTaken, { name: collab.liveBy ?? t(M.someone) }) : t(M.liveSwitch)}</span>
                        <span className="share-option-sub">{t(taken ? M.liveTakenSub : M.liveSwitchSub)}</span>
                      </span>
                      <span className="share-switch" aria-hidden="true" />
                    </button>
                  )
                })()}
                {collab.room && ownSharedProject() && (
                  <button className="share-option share-back" data-testid="share-stop-sharing" disabled={state.running} onClick={() => void stopSharingProject()}>
                    <span className="share-option-text">
                      <span className="share-option-label">{t(M.stopSharing)}</span>
                      <span className="share-option-sub">
                        {state.running ? t(M.stopSharingRunning) : ownSharedProject()!.demo ? t(M.stopSharingDemoSub) : t(M.stopSharingSub, { name: ownSharedProject()!.project })}
                      </span>
                    </span>
                  </button>
                )}
                {/* a shared project's undo is the room's, kept per person (collab/bridge.ts), so it starts empty */}
                {!collab.room && !shareLabel && store.canUndo && <div className="share-popover-note">{t(M.undoStartsOver)}</div>}
                {shareLabel && (
                  <div className="share-popover-status" role="status">
                    {t(shareLabel)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* No separator after Share: a labelled text button already reads apart from the icon toggles,
            and a rule between every pair of kinds left two rules among four controls. The one rule left
            sets the app's own controls (settings, help) apart from the view toggles. */}
        <button
          className={`icon-toggle${state.mode === 'pilot' ? ' active' : ''}`}
          title={t(M.pilotTitle, {
            label: withKey(commandLabel('sim.pilot'), 'pilot.enter'),
            exit: keyHint('pilot.exit') ?? 'Esc', // i18n-ok: key name
          })}
          aria-label={t(M.pilotMode)}
          aria-pressed={state.mode === 'pilot'}
          onClick={() => (state.mode === 'pilot' ? store.exitPilot() : store.enterPilot())}
        >
          <PilotIcon />
        </button>
        {vrSupported && (
          <button
            data-vr-button
            className={`icon-toggle${vrActive ? ' active' : ''}`}
            title={t(M.vrTitle)}
            aria-label={t(M.vrMode)}
            aria-pressed={vrActive}
            onClick={() => (vrActive ? controller?.exitVR() : void controller?.enterVR(setVrActive))}
          >
            <VRIcon />
          </button>
        )}
        <button
          className={`icon-toggle${state.distractionFree ? ' active' : ''}`}
          title={t(M.distractionFreeTitle, { label: withKey(commandLabel('view.distractionFree'), 'view.distractionFree') })}
          aria-label={t(M.distractionFree)}
          aria-pressed={state.distractionFree}
          onClick={(e) => {
            const entering = !state.distractionFree
            store.toggleDistractionFree()
            // Shift gates *entering* fullscreen; leaving distraction-free always
            // drops fullscreen so any click-out (with or without Shift) undoes it.
            if (entering) {
              if (e.shiftKey) void document.documentElement.requestFullscreen?.()?.catch(() => {})
            } else if (document.fullscreenElement) {
              void document.exitFullscreen().catch(() => {})
            }
          }}
        >
          <DistractionFreeIcon />
        </button>
        <span className="toolbar-sep" aria-hidden="true" />
        {/* Settings has a button of its own, since Help is not where anyone looks for preferences. Hidden on
            the mobile layout (CSS) with the other icon buttons. */}
        <button
          className="icon-toggle settings-button"
          title={withCommandKey(t(M.settings), 'view.settings')}
          aria-label={t(M.settings)}
          onClick={() => runCommand('view.settings')}
        >
          <SettingsIcon />
        </button>
        {/* Help. The tour's "shortcuts" step points HERE (data-tutorial), since this is where the
            reference now lives. Hidden on the mobile layout (CSS) with the other icon buttons: the tour
            is desktop-only, and a phone has no keyboard to look up. Every entry but the GitHub link is a
            command, so the enablement is the registry's, same as the native menus and the palette. */}
        <div className="help-wrap" ref={helpRef}>
          <button
            ref={helpButtonRef}
            className={`icon-toggle help-button${helpOpen ? ' active' : ''}`}
            data-tutorial="shortcuts"
            title={t(M.helpTitle)}
            aria-label={t(M.help)}
            aria-haspopup="menu"
            aria-expanded={helpOpen}
            onClick={(e) => {
              helpByKey.current = fromKeyboard(e)
              setHelpOpen((v) => !v)
            }}
          >
            <HelpIcon />
          </button>
          {helpOpen && (
            <div className="help-popover" role="menu" aria-label={t(M.help)} ref={helpListRef} onKeyDown={menuKeys(closeHelp)}>
              {/* The web has no menu bar, so without this row the palette is reachable only by its chord.
                  The chord badge teaches it. */}
              <button
                className="help-item"
                role="menuitem"
                onClick={() => {
                  closeHelp()
                  runCommand('view.commandPalette')
                }}
              >
                <span className="help-item-label">{getCommand('view.commandPalette')?.label}</span>
                {paletteKey && <kbd className="help-item-key">{paletteKey}</kbd>}
              </button>
              <button
                className="help-item"
                role="menuitem"
                onClick={() => {
                  closeHelp()
                  runCommand('help.shortcuts')
                }}
              >
                <span className="help-item-label">{getCommand('help.shortcuts')?.label}</span>
                {shortcutsKey && <kbd className="help-item-key">{shortcutsKey}</kbd>}
              </button>
              {/* the tour builds and tags parts, so a view link - which cannot edit - leaves it out */}
              {!state.readOnly && tutorialCmd && (
                <button
                  className="help-item"
                  role="menuitem"
                  disabled={!commandEnabled('help.tutorial')}
                  title={t(M.tutorialTitle)}
                  onClick={() => {
                    closeHelp()
                    runCommand('help.tutorial')
                  }}
                >
                  <span className="help-item-label">{tutorialCmd.label}</span>
                </button>
              )}
              {/* the browser's way into the installed app (desktopLink.ts); in a room it opens that room */}
              {!DESKTOP_SHELL && (
                <button
                  className="help-item"
                  role="menuitem"
                  data-testid="help-open-desktop"
                  title={t(state.collab ? M.openDesktopRoom : M.openDesktopCopy)}
                  onClick={() => {
                    closeHelp()
                    runCommand('help.openInDesktop')
                  }}
                >
                  <span className="help-item-label">{getCommand('help.openInDesktop')?.label}</span>
                </button>
              )}
              <div className="help-sep" role="separator" />
              {/* Names a destination, not a surface: this row renders in the desktop app too, where "the
                  desktop version" read as a link to the thing you are already running. */}
              <a
                className="help-item"
                role="menuitem"
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={closeHelp}
              >
                <GitHubIcon />
                <span className="help-item-label">{t(M.github)}</span>
                <ExternalLinkIcon />
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Live share beside the transport (docs/live-share.md): the Live badge while this client is live, a status whose click
 * opens Share, where the Live switch is (one place turns it on and off, so a click here cannot end a stream by surprise),
 * whose run a follower is watching, a viewer waiting for the next run, or an editor's offer to watch. On a phone each
 * chip shrinks to its dot and a word (styles/mobile.css).
 */
function LiveControl({ collab, store, state, openShare }: { collab: ReturnType<typeof getCollabSnapshot>; store: EditorStore; state: EditorState; openShare: () => void }): ReactElement | null {
  const name = collab.liveBy ?? t(M.someone)
  // A stream that ends says so for a moment, rather than the chip just vanishing and the view going back to the design.
  const [ended, setEnded] = useState<string | null>(null)
  const lastLive = useRef<string | null>(null)
  useEffect(() => {
    const was = lastLive.current
    lastLive.current = collab.liveBy
    if (collab.liveBy || !was || state.liveSharing) return
    setEnded(was)
    const timer = setTimeout(() => setEnded(null), 5000)
    return () => clearTimeout(timer)
  }, [collab.liveBy, state.liveSharing])
  const label = (full: string, short: string): ReactElement => (
    <>
      <span className="live-chip-full">{full}</span>
      {short && <span className="live-chip-short">{short}</span>}
    </>
  )
  const stopWatching = !state.readOnly && (
    <button
      className="live-chip-stop"
      aria-label={t(M.stopWatching)}
      title={t(M.stopWatching)}
      onClick={() => {
        store.setState({ liveWatch: false })
        liveChannel.in?.end()
      }}
    >
      ×
    </button>
  )
  if (state.liveSharing) {
    const full = state.running && collab.watchers > 0 ? t(M.liveWatched, { count: collab.watchers }) : t(M.liveBadge)
    return (
      <button className={`live-chip on${state.running ? '' : ' idle'}`} data-testid="live-chip" title={t(state.running ? M.liveRunningTitle : M.liveIdleTitle)} onClick={openShare}>
        {label(full, t(M.liveBadge))}
      </button>
    )
  }
  if (state.liveFollowing) {
    return (
      <span className="live-chip watching" data-testid="live-chip" title={t(M.watchingTitle, { name })}>
        {label(t(M.watching, { name }), '')}
        {stopWatching}
      </span>
    )
  }
  if (ended && !collab.liveBy && !state.running) {
    return (
      <span className="live-chip ended" data-testid="live-chip">
        {label(t(M.streamEnded, { name: ended }), '')}
      </span>
    )
  }
  if (!collab.liveBy || state.running) return null
  // a view link, or an editor who said Watch: the run shows on its own when it comes
  if (state.readOnly || state.liveWatch) {
    return (
      <span className="live-chip waiting" data-testid="live-chip" title={t(M.waitingTitle, { name })}>
        {label(t(collab.liveRunning ? M.joining : M.waiting, { name }), '')}
        {stopWatching}
      </span>
    )
  }
  return (
    <button className="live-chip offer" data-testid="live-chip" title={t(M.offerWatchTitle, { name })} onClick={() => store.setState({ liveWatch: true })}>
      {label(t(M.offerWatch, { name }), t(M.watchShort))}
    </button>
  )
}
