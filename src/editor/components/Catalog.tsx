import { partCreditText } from '../parts/partCredit'
import { useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, MouseEvent as ReactMouseEvent } from 'react'
import { versionedAssetUrl } from '../../core/assetVersions'
import { PART_DEFS } from '../../core/types'
import type { PartDef, PartType } from '../../core/types'
import type { PartPackage } from '../../core/parts/partPackage'
import { packageThumbFile } from '../../core/parts/partPackage'
import { getPackage } from '../../core/parts/partRegistry'
import { categoryOrder, isStandardCategory, packageCategory, sameCategory } from '../../core/parts/partCategory'
import type { ShelfStatus } from '../../core/parts/partShelf'
import type { EditorController } from '../controller'
import type { EditorState } from '../store/store'
import { downloadPart } from '../parts/partFile'
import { shippedAssetBytes, warmShippedAssets } from '../parts/shippedAssetCache'
import { preloadBehaviorEditor } from './behaviorEditorChunk'
import { ScriptIcon } from './toolbarIcons'
import { commandEnabledOn, runCommand, runCommandOn } from '../commands'
import { ExportIcon, ImportIcon, PartGlyph, PencilIcon, TrashIcon } from './toolbarIcons'
import { PartUpdatesNotice } from './PartUpdatesNotice'
import { UNLISTED_BUILT_INS, editedSinceCopied, sameAsBuiltIn } from '../../core/builtInVersion'
import { ContextMenu } from './inspector/menu'
import type { MenuItem } from './inspector/menu'
import { copyFromShelf, getShelfApi, statusInProject } from '../parts/partShelf'
import { useShelf } from '../parts/shelfListing'
import { reviewUpdate, usePartUpdates, type PartUpdate } from '../parts/partUpdates'
import { CatalogPlaceButton } from './CatalogPlaceButton'
import { getOipPartsApi } from '../desktop/desktopPartsBridge'
import { importPartsFolder } from '../parts/packageSource'
import { defineMessages, t, type MessageId } from '../../core/i18n'
import { importPartFiles, partFilesOf } from '../parts/importPartFiles'

const M = defineMessages('catalog', {
  title: 'Parts',
  viewOnly: 'View only: editing is disabled',
  viewOnlyLink: 'View only: editing is disabled on this link',
  partEditorInRoom: 'The Part Editor is unavailable in a shared room',
  newPartTitle: 'New blank part:a single box you can reshape, add nodes to, and script (the same portable format the built-ins use)',
  newPart: '＋ New part',
  importTitle: 'Import a shared part file (.oippart or .part.json) into this project',
  importTitleDesktop: 'Import shared part files, or a folder of parts, into this project',
  importFiles: 'Part files…',
  importFilesTitle: 'Import shared part files (.oippart or .part.json) into this project',
  importFolder: 'A folder of parts…',
  importFolderTitle: "Import every part in a folder, such as another project's parts folder, into this project",
  importPart: 'Import part',
  getPartsTitle: 'Get parts from the part libraries: containers, machines and more, added to this project',
  getParts: '⬇ Get parts',
  catEquipment: 'Equipment',
  catDevices: 'Devices',
  catProducts: 'Products',
  catStructure: 'Structure',
  placingTouch: 'Tap the viewport to place · tap the card again to finish',
  placingMouse: 'Click or drag to the viewport · Alt: no snap · Esc: done',
  search: 'Search parts',
  oneBuilding: 'One building per scene',
  buildFailed: 'Latest edit failed to build (showing last working version):\n{error}',
  credited: '{name} · {credit}',
  customPart: '{name} · custom part',
  buildError: 'build error',
  updateFromApp: 'The app has a newer “{name}” than this project. Click to see what changes.',
  updateFromLibrary: '“{library}” has a newer “{name}” than this project. Click to see what changes.',
  updateFromShelf: 'The shelf has a newer “{name}” than this project. Click to see what changes.',
  updateEditedToo: "This project changed its own copy too, and updating discards those changes.",
  editInPartEditor: 'Edit “{name}” in the Part Editor',
  download: 'Download “{name}” as a part file to share',
  editBehavior: 'Edit the behavior script of “{name}”',
  deleteInRoom: 'Deleting parts is unavailable in a shared room',
  openForEditing: 'This part is open for editing. Close it first',
  revertTitle: "Go back to the app's version of “{name}”",
  deleteTitle: 'Delete “{name}” from this project',
  stillUsed: "Can't delete “{name}”. It's still used by {users}.\nRemove those parts first.",
  revertConfirm: "Replace this project's “{name}” with the app's current version? Every placed copy changes.",
  revertConfirmLost: "Replace this project's “{name}” with the app's current version? This project's changes to it are discarded. Every placed copy changes.",
  deleteConfirm: "Delete the custom part “{name}”? This can't be undone.",
  noMatch: 'No parts match “{query}”.',
  shelfReadFailed: 'The parts shelf could not be read: {error}',
  shelfUnreadable: {
    one: '{count} part on the parts shelf could not be read, so it is not listed.',
    other: '{count} parts on the parts shelf could not be read, so they are not listed.',
  },
  showFolderTitle: 'Show the shelf folder',
  showFolder: 'Show folder',
  onShelf: 'Shelf',
  onShelfTitle: "“{name}” is on the shelf, and this project has the shelf's version.",
  notInProjectTitle: '“{name}” is on the shelf. Placing it copies it into this project.',
  shelfVersion: 'Shelf version',
  shelfVersionTitle: "The shelf keeps its own version of the app's “{name}”. This card places the app's. Click to use the shelf's in this project.",
  fromShelf: '{name} · from the shelf. Placing it copies it into this project.',
  update: 'Update',
  putOnShelf: 'Put on shelf',
  editedHereTitle: "This project has changed “{name}” since it came from the shelf. Click to put this project's version on the shelf.",
  renameOurs: 'Rename ours…',
  sameIdTitle:
    "This project has its own part with the same id as the shelf's “{name}”, and they are not the same part. Click to give this project's a new id, so both can be used.",
  putOwnTitle: 'Put “{name}” on the shelf, so other projects can place it',
  putUpToDate: '“{name}” is on the shelf as it is here',
  putSameId: "The shelf has a different part with this id. Rename this project's first.",
})

// Part libraries are reached through Get parts (components/GetPartsWindow.tsx), not a tab here: the dock shows what
// this project can place. The shelf's parts are placeable here, so they sit in their category tabs beside the rest.

// each standard tab's heading; a category a part names itself is shown as the part spells it
const CATEGORY_LABEL: Record<PartDef['category'], MessageId> = {
  Equipment: M.catEquipment,
  Devices: M.catDevices,
  Products: M.catProducts,
  Structure: M.catStructure,
}

function categoryLabel(category: string): string {
  return isStandardCategory(category) ? t(CATEGORY_LABEL[category]) : category
}

/**
 * What a card's shelf part is to this project. 'shelfVersion': the shelf keeps its own version of an app built-in that
 * the project uses unchanged, or not yet. The card still places the app's, since one person's "Put on shelf" must not
 * change what a built-in's card places in every project; the badge offers the shelf's.
 */
type CardShelfStatus = ShelfStatus | 'shelfVersion'

/**
 * The badge a card carries for what its shelf part is to this project, and what it says when hovered. A newer version
 * on the shelf is the card's "Update" badge, the same for every source (editor/parts/partUpdates.ts), so it has none.
 */
function shelfBadge(status: CardShelfStatus, name: string): { label: string; title: string; tone: 'quiet' | 'act' | 'warn' } | null {
  switch (status) {
    case 'shelfVersion':
      return { label: t(M.shelfVersion), title: t(M.shelfVersionTitle, { name }), tone: 'act' }
    case 'notInProject':
      return { label: t(M.onShelf), title: t(M.notInProjectTitle, { name }), tone: 'quiet' }
    case 'upToDate':
      return { label: t(M.onShelf), title: t(M.onShelfTitle, { name }), tone: 'quiet' }
    case 'updateAvailable':
    case 'changedInBoth':
      return null
    case 'editedHere':
      return { label: t(M.putOnShelf), title: t(M.editedHereTitle, { name }), tone: 'act' }
    case 'sameIdDifferentPart':
      return { label: t(M.renameOurs), title: t(M.sameIdTitle, { name }), tone: 'warn' }
  }
}

/** what a card's "Update" badge says when hovered: where the newer version is, and what taking it costs */
function updateTitle(u: PartUpdate): string {
  const name = u.name
  const where =
    u.source === 'app'
      ? t(M.updateFromApp, { name })
      : u.source === 'library'
        ? t(M.updateFromLibrary, { name, library: u.from ?? '' })
        : t(M.updateFromShelf, { name })
  return u.edited ? `${where} ${t(M.updateEditedToo)}` : where
}

// the shelf's buttons: loaded on the first one pressed, since the shelf is the desktop app's alone
const shelfActions = () => import('../parts/shelfActions')

// Tablets show the catalog but have no Alt/Esc/wheel - word the placing hint for touch.
// Evaluated once at startup; guarded for non-DOM test envs where matchMedia is absent.
const COARSE_POINTER =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false
const PLACING_HINT = COARSE_POINTER ? M.placingTouch : M.placingMouse

interface CatalogProps {
  state: EditorState
  /** drives placement: a card press is forwarded here so the ghost follows + the wheel rotates it */
  controller: EditorController | null
  /** runtime-rendered fallbacks, keyed by type; empty unless a static thumbnail is missing */
  thumbnails: Map<PartType, string>
  /** runtime-rendered custom-part thumbnails, keyed by package id (packages have no static asset) */
  packageThumbnails: Map<string, string>
  /** package ids whose offscreen thumbnail render is in-flight - shows a shimmer skeleton */
  pendingThumbnails: ReadonlySet<string>
  /** ask the app to render thumbnails in-browser (a static /thumbnails/*.webp failed to load) */
  onThumbnailMissing: () => void
  /** a bundled package's committed /thumbnails/pkg/*.webp failed to load - render that package in-browser */
  onPackageThumbnailMissing: (id: string) => void
}

function numberHint(def: PartDef): string {
  return def.params
    .filter((p) => p.kind === 'number')
    .map((p) => `${p.label.toLowerCase()} ${p.default}${p.unit ? ` ${p.unit}` : ''}`)
    .join(' · ')
}

export function Catalog({ state, controller, thumbnails, packageThumbnails, pendingThumbnails, onThumbnailMissing, onPackageThumbnailMissing }: CatalogProps) {
  const [category, setCategory] = useState('Equipment')
  // the parts shelf (docs/parts-shelf.md): null where the shell has none, the browser
  const shelf = useShelf()
  const shelfApi = getShelfApi()
  const [query, setQuery] = useState('')
  // a small menu: a card's right-click (Put on shelf), or Import part's two choices on the desktop
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  // the shelf part a placement was started from, while that placement lasts (see `pinned` below)
  const [placingFromShelf, setPlacingFromShelf] = useState<string | null>(null)
  // newer versions of this project's parts, from every source; a card offers the first of its own (partUpdates.ts)
  const updates = usePartUpdates(state)
  const updateById = new Map<string, PartUpdate>()
  for (const u of updates) if (!updateById.has(u.id)) updateById.set(u.id, u)
  const importRef = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const searching = q !== ''
  const store = controller?.store ?? null
  const editable = !state.readOnly && store !== null

  // import shared part files (.oippart, or the older .part.json) into the library (the file-level counterpart of the scene Load
  // button); reached from the header button (multi-select) and by dropping files anywhere on the dock
  const importFiles = async (files: File[]): Promise<void> => {
    if (!controller || state.readOnly || files.length === 0) return
    await importPartFiles(controller, files)
  }
  const onImportFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    void importFiles(files)
  }
  // drop-import affordance: depth-counted so enter/leave churn over child elements doesn't flicker it
  const dragDepth = useRef(0)
  const [dropping, setDropping] = useState(false)
  const dragHasFiles = (e: DragEvent<HTMLDivElement>): boolean => e.dataTransfer.types.includes('Files')

  // keyboard activation (Enter/Space fires a click with detail 0 and no pointer gesture): enter
  // click-to-place from the card's center, reusing the pointer click's exact toggle semantics
  const keyboardPlace = (e: ReactMouseEvent<HTMLButtonElement>, type: PartType, packageId?: string): void => {
    if (e.detail !== 0 || !controller) return
    const r = e.currentTarget.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    controller.beginCatalogPlace(type, cx, cy, packageId)
    controller.endCatalogPlace(cx, cy, false)
  }

  // custom-part packages become their own cards (each places a 'part' instance bound to its package id):
  // first-party bundled examples (always present) + any imported from a desktop parts folder. De-dupe
  // by id so a folder part can shadow a bundled one.
  // A library copy that is the app's current built-in (a project's untouched copy, docs/part-sources.md) shows as the
  // built-in: its committed thumbnail, its bare name, nothing to delete. Only the project's own versions shadow.
  const bundledById = new Map(state.bundledPackages.map((p) => [p.id, p]))
  const ownVersions = state.userPackages.filter((p) => !sameAsBuiltIn(p, bundledById.get(p.id)))
  // Shelf parts this project has no copy of are placed from the shelf, which copies them in at the press. One card per
  // id: a shelf part of a built-in's id is the built-in's card, which places the app's and offers the shelf's.
  const shelfParts = shelf?.listing?.parts ?? []
  const shelfById = new Map(shelfParts.map((p) => [p.id, p]))
  const userIds = new Set(state.userPackages.map((p) => p.id))
  // The shelf card a placement started from stays until the placement ends. Pressing it copies the part in, which
  // would otherwise swap it for the project's card mid-gesture, and the drag's pointer capture would go with it.
  const placingId = state.mode === 'placing' && state.placingType === 'part' ? state.placingPackageId : null
  if (placingFromShelf !== null && placingFromShelf !== placingId) setPlacingFromShelf(null)
  const pinned = placingFromShelf !== null && placingFromShelf === placingId ? placingFromShelf : null
  const fromShelf = shelfParts.filter((p) => (!userIds.has(p.id) || p.id === pinned) && !bundledById.has(p.id))
  const fromShelfIds = new Set(fromShelf.map((p) => p.id))
  // an unlisted built-in (core/parts/partCatalog UNLISTED_BUILT_INS) stays out unless the project changed its own version
  const customById = new Map(
    [...state.bundledPackages.filter((p) => !UNLISTED_BUILT_INS.has(p.id)), ...ownVersions].filter((p) => !fromShelfIds.has(p.id)).map((p) => [p.id, p]),
  )
  // Pristine first-party bundled packages (by object identity, so a user/folder copy that shadows a bundled
  // id, and takes precedence in customById, is excluded): only these have a committed /thumbnails/pkg/*.webp; every
  // other package renders its card in-browser. Identity, not id, because a shadow's content differs from the
  // baked image.
  const bundledSet = new Set(state.bundledPackages)

  const listedDefs = Object.values(PART_DEFS).filter((d) => !d.noCatalog)
  const listedCustom = [...customById.values()]
  // a tab per category something here names (the standard four first, then the rest alphabetically); none is empty
  const tabs = categoryOrder([...listedDefs.map((d) => d.category), ...listedCustom.map(packageCategory), ...fromShelf.map(packageCategory)])
  // the remembered tab can disappear (e.g. the last package in a category was removed) - fall back
  const activeCategory = tabs.find((c) => sameCategory(c, category)) ?? tabs[0] ?? 'Equipment'
  // search spans every category; otherwise the active tab decides what shows.
  // noCatalog types (the Group node, the generic 'part') are never placed directly from the palette.
  const matchesPackage = (pkg: PartPackage): boolean =>
    searching ? pkg.name.toLowerCase().includes(q) || pkg.id.toLowerCase().includes(q) : sameCategory(packageCategory(pkg), activeCategory)
  const defs = listedDefs.filter((def) =>
    searching ? def.label.toLowerCase().includes(q) || def.type.toLowerCase().includes(q) : def.category === activeCategory,
  )
  const customCards = listedCustom.filter(matchesPackage)
  const shelfCards = fromShelf.filter(matchesPackage)

  // a project part's "Put on shelf": the context menu's item, enabled where it would put something new on the shelf
  const putItem = (pkg: PartPackage, status: CardShelfStatus | null): MenuItem => ({
    label: t(M.putOnShelf),
    testid: 'shelf-put',
    disabled: !editable || status === 'upToDate' || status === 'sameIdDifferentPart',
    title: status === 'upToDate' ? t(M.putUpToDate, { name: pkg.name }) : status === 'sameIdDifferentPart' ? t(M.putSameId) : t(M.putOwnTitle, { name: pkg.name }),
    onClick: () => runCommandOn('part.putOnShelf', { packageId: pkg.id }),
  })
  const onShelfBadge = (pkg: PartPackage, status: CardShelfStatus): void => {
    if (!store) return
    const shelfPart = shelfById.get(pkg.id)
    if (status === 'editedHere') {
      const mine = state.userPackages.find((p) => p.id === pkg.id)
      if (mine) void shelfActions().then((a) => a.putPartOnShelf(store, mine))
    } else if (shelfPart && status === 'sameIdDifferentPart') void shelfActions().then((a) => a.renameOursForShelf(store, shelfPart))
    else if (shelfPart) void shelfActions().then((a) => a.updateFromShelf(store, shelfPart, status))
  }
  const badgeElement = (pkg: PartPackage, status: CardShelfStatus) => {
    const badge = shelfBadge(status, pkg.name)
    if (!badge) return null
    return badge.tone === 'quiet' ? (
      <span className={`catalog-card-badge is-${badge.tone}`} data-testid="shelf-badge" title={badge.title}>
        {badge.label}
      </span>
    ) : (
      <button
        className={`catalog-card-badge is-${badge.tone}`}
        data-testid={status === 'editedHere' ? 'shelf-put' : status === 'sameIdDifferentPart' ? 'shelf-rename' : 'shelf-use'}
        disabled={!editable}
        title={badge.title}
        onClick={() => onShelfBadge(pkg, status)}
      >
        {badge.label}
      </button>
    )
  }

  return (
    <div
      className={`dock catalog-dock${dropping ? ' drop-target' : ''}`}
      onDragEnter={(e) => {
        if (state.readOnly || !dragHasFiles(e)) return
        dragDepth.current++
        setDropping(true)
      }}
      onDragOver={(e) => {
        if (!state.readOnly && dragHasFiles(e)) e.preventDefault() // required to allow the drop
      }}
      onDragLeave={() => {
        if (dragDepth.current > 0 && --dragDepth.current === 0) setDropping(false)
      }}
      onDrop={(e) => {
        dragDepth.current = 0
        setDropping(false)
        if (state.readOnly || !dragHasFiles(e)) return
        e.preventDefault()
        void importFiles(partFilesOf(e.dataTransfer.files))
      }}
    >
      <div className="dock-header">
        <span className="dock-title">{t(M.title)}</span>
        <button
          className="catalog-author"
          // a new part opens in the Part Editor, which a room refuses (store.enterPackageEdit): in a room the click
          // would only add a part nobody can open
          disabled={state.readOnly || state.collab}
          title={
            state.readOnly
              ? t(M.viewOnly)
              : state.collab
                ? t(M.partEditorInRoom)
                : t(M.newPartTitle)
          }
          onClick={() => controller?.createBlankPart()}
        >
          {t(M.newPart)}
        </button>
        <button
          className="catalog-author"
          disabled={state.readOnly || !controller}
          data-testid="catalog-import"
          title={state.readOnly ? t(M.viewOnly) : getOipPartsApi() ? t(M.importTitleDesktop) : t(M.importTitle)}
          onClick={(e) => {
            // the desktop also imports a folder of parts (packageSource.ts), where a browser cannot read one
            if (!getOipPartsApi() || !store) {
              importRef.current?.click()
              return
            }
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({
              x: r.left,
              y: r.bottom,
              items: [
                { label: t(M.importFiles), title: t(M.importFilesTitle), testid: 'catalog-import-files', onClick: () => importRef.current?.click() },
                { label: t(M.importFolder), title: t(M.importFolderTitle), testid: 'catalog-import-folder', onClick: () => void importPartsFolder(store) },
              ],
            })
          }}
        >
          <ImportIcon size="1em" /> {t(M.importPart)}
        </button>
        {/* parts this project does not have yet, from the part libraries (commands.ts file.getParts) */}
        <button
          className="catalog-author"
          data-testid="catalog-get-parts"
          disabled={state.readOnly}
          title={state.readOnly ? t(M.viewOnly) : t(M.getPartsTitle)}
          onClick={() => runCommand('file.getParts')}
        >
          {t(M.getParts)}
        </button>
        <input ref={importRef} type="file" accept=".oippart,.json,application/json" multiple hidden onChange={onImportFile} />
        {/* the row scrolls sideways when the categories outgrow it; the wheel scrolls it, since its scrollbar is hidden */}
        <div
          className="catalog-tabs segmented"
          role="group"
          onWheel={(e) => {
            if (e.deltaY !== 0 && e.currentTarget.scrollWidth > e.currentTarget.clientWidth) e.currentTarget.scrollLeft += e.deltaY
          }}
        >
          {tabs.map((c) => (
            <button
              key={c}
              className={`catalog-tab${!searching && c === activeCategory ? ' active' : ''}`}
              data-tutorial={`catalog-${c}`}
              data-category={c}
              title={isStandardCategory(c) ? undefined : c}
              onClick={() => {
                setQuery('')
                setCategory(c)
              }}
            >
              {categoryLabel(c)}
            </button>
          ))}
        </div>
        {/* the hint ellipsizes when the row is short of room (.catalog-placing-hint), so each carries its text as a title */}
        {state.readOnly ? (
          <span className="catalog-placing-hint" title={t(M.viewOnlyLink)}>{t(M.viewOnlyLink)}</span>
        ) : (
          state.mode === 'placing' && (
            <span className="catalog-placing-hint" title={t(PLACING_HINT)}>
              {t(PLACING_HINT)}
            </span>
          )
        )}
        <input
          className="catalog-search"
          type="search"
          placeholder={t(M.search)}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Esc clears the search (falls back to the active tab) - some browsers do this natively
            // for type=search, most don't
            if (e.key === 'Escape' && query !== '') {
              e.stopPropagation()
              setQuery('')
            }
          }}
        />
      </div>
      {/* the app has newer versions of parts this project holds copies of: Update all / Review (docs/part-sources.md) */}
      <PartUpdatesNotice state={state} controller={controller} />
      <div className="catalog-strip">
        {/* a shelf part that could not be read is missing from its tab; say so where it would be */}
        {shelfApi && shelf && (shelf.error !== null || (shelf.listing?.problems.length ?? 0) > 0) && (
          <div className="catalog-shelf-bar" data-testid="shelf-problems">
            <span
              className="catalog-shelf-problems"
              title={shelf.listing?.problems.map((p) => `${p.dir}: ${p.message}`).join('\n') ?? ''}
            >
              {(() => {
                // the folder itself (an offline share, a lost permission) is not a part that failed
                const folderProblem = shelf.listing?.problems.find((p) => p.dir === shelf.listing?.root)
                if (shelf.error !== null) return t(M.shelfReadFailed, { error: shelf.error })
                if (folderProblem) return t(M.shelfReadFailed, { error: folderProblem.message })
                return t(M.shelfUnreadable, { count: shelf.listing?.problems.length ?? 0 })
              })()}
            </span>
            <button className="catalog-author" onClick={() => void shelfApi.reveal()} title={t(M.showFolderTitle)}>
              {t(M.showFolder)}
            </button>
          </div>
        )}
        {defs.map((def) => {
          const active = state.mode === 'placing' && state.placingType === def.type
          // a view-only link disables placement entirely (the card is inert, greyed out)
          const blocked =
            state.readOnly || (def.type === 'building' && state.scene.parts.some((p) => p.type === 'building'))
          // prefer a runtime-rendered fallback if one exists; otherwise the static asset
          const runtime = thumbnails.get(def.type)
          const thumbSrc = runtime ?? versionedAssetUrl(`/thumbnails/${def.type}.webp`)
          return (
            <button
              key={def.type}
              className={`catalog-card${active ? ' active' : ''}`}
              data-part-type={def.type}
              disabled={blocked}
              title={
                state.readOnly
                  ? t(M.viewOnly)
                  : blocked
                    ? t(M.oneBuilding)
                    : // i18n-ok: the part's own label and param readout, joined
                      `${def.label} · ${numberHint(def)}`
              }
              // pointer-based placement (not native HTML5 DnD): capture the pointer
              // so the card alone steers the gesture and forwards it to the controller.
              // A click enters click-to-place; a drag drops on release. The wheel
              // rotates the ghost throughout (wheel events aren't pointer-captured).
              // Keyboard activation (detail 0) goes through onClick instead.
              onClick={(e) => keyboardPlace(e, def.type)}
              // hover-preload: warm this part's assets before the click so
              // placement doesn't block on a cold GLB fetch/decode. Deduped per session in the view.
              onPointerEnter={() => {
                if (!blocked) controller?.warmCatalogPart(def.type, undefined, true)
              }}
              onPointerDown={(e) => {
                if (blocked || e.button !== 0 || !controller) return
                e.preventDefault()
                e.currentTarget.setPointerCapture(e.pointerId)
                controller.beginCatalogPlace(def.type, e.clientX, e.clientY)
              }}
              onPointerMove={(e) => controller?.catalogPlaceMove(e.clientX, e.clientY, e.altKey)}
              onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
                controller?.endCatalogPlace(e.clientX, e.clientY, e.altKey)
              }}
              onPointerCancel={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
                controller?.cancelCatalogPlace()
              }}
            >
              <span className="catalog-card-thumb">
                {def.glyph ? (
                  // a type with no 3-D form (an annotation): a glyph, and no image request at all - see
                  // PartDef.glyph. An <img> here would 404 and then photograph an empty transform.
                  <span className="catalog-card-glyph">{def.glyph}</span>
                ) : (
                  <img
                    src={thumbSrc}
                    alt=""
                    draggable={false}
                    // a missing static thumbnail (no runtime fallback yet) → render the set in-browser
                    onError={runtime ? undefined : onThumbnailMissing}
                  />
                )}
              </span>
              <span className="catalog-card-label">{def.label}</span>
            </button>
          )
        })}
        {customCards.map((pkg) => {
          const active = state.mode === 'placing' && state.placingType === 'part' && state.placingPackageId === pkg.id
          const blocked = state.readOnly
          // a failed save keeps the last-good package registered; flag the card so the author knows the
          // catalog is showing a stale version, not their latest edit
          const buildError = state.packageBuildErrors[pkg.id]
          // ✕ only on this project's own versions: an untouched copy of a built-in has nothing to delete. A version of
          // a built-in goes back to the app's version instead of vanishing.
          const ownCopy = ownVersions.find((p) => p.id === pkg.id)
          const userCopy = ownCopy !== undefined
          const shadowsBundled = userCopy && bundledById.has(pkg.id)
          const lost = ownCopy !== undefined && editedSinceCopied(ownCopy)
          const editingThis = state.packageEdit?.packageId === pkg.id
          const shelfPart = shelfById.get(pkg.id)
          const update = updateById.get(pkg.id)
          // a shelf version of a built-in the project uses unchanged, or not yet: offered, never placed in its stead
          const builtIn = bundledById.get(pkg.id)
          const plainBuiltIn = builtIn !== undefined && (ownCopy === undefined)
          const shelfStatus: CardShelfStatus | null = !shelfPart
            ? null
            : plainBuiltIn && !sameAsBuiltIn(shelfPart, builtIn)
              ? 'shelfVersion'
              : statusInProject(state, shelfPart)
          // only a part this project made or changed is worth putting on the shelf; a stock built-in is in every project
          const canShelve = shelf !== null && ownCopy !== undefined
          return (
            <div
              key={`pkg:${pkg.id}`}
              className={`catalog-card catalog-card-prefab catalog-card-custom${userCopy ? ' catalog-card-deletable' : ''}`}
              data-shelf-status={shelfStatus ?? (canShelve && shelf.listing ? 'notOnShelf' : undefined)}
              onContextMenu={(e) => {
                if (!canShelve) return
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, items: [putItem(ownCopy, shelfStatus)] })
              }}
            >
            <button
              className={`catalog-card-main${active ? ' active' : ''}${buildError ? ' has-build-error' : ''}`}
              data-part-type="part"
              data-package-id={pkg.id}
              disabled={blocked}
              title={
                state.readOnly
                  ? t(M.viewOnly)
                  : buildError
                    ? t(M.buildFailed, { error: buildError })
                    : // every catalog card except Building is a package now, so "custom part" is reserved for what
                      // the phrase actually means to a reader: a part they imported or authored - provenance
                      // nothing else on the card shows. A first-party package gets its bare name: the tooltip is
                      // still useful because the label ellipsizes, but its category is just the tab you are on.
                      // A library copy says who made it (editor/parts/partCredit.ts).
                      bundledSet.has(pkg) ? pkg.name : pkg.credit ? t(M.credited, { name: pkg.name, credit: partCreditText(pkg) }) : t(M.customPart, { name: pkg.name })
              }
              onClick={(e) => keyboardPlace(e, 'part', pkg.id)}
              // hover-preload the custom part's package assets (see built-in card above)
              onPointerEnter={() => {
                if (!blocked) controller?.warmCatalogPart('part', pkg.id, true)
              }}
              onPointerDown={(e) => {
                if (blocked || e.button !== 0 || !controller) return
                e.preventDefault()
                e.currentTarget.setPointerCapture(e.pointerId)
                controller.beginCatalogPlace('part', e.clientX, e.clientY, pkg.id)
              }}
              onPointerMove={(e) => controller?.catalogPlaceMove(e.clientX, e.clientY, e.altKey)}
              onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
                controller?.endCatalogPlace(e.clientX, e.clientY, e.altKey)
              }}
              onPointerCancel={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
                controller?.cancelCatalogPlace()
              }}
            >
              <span className="catalog-card-thumb">
                {(() => {
                  // author-supplied thumbnail wins; else the app's runtime-rendered one
                  const src = pkg.thumbnail ?? packageThumbnails.get(pkg.id)
                  if (src) return <img src={src} alt="" draggable={false} />
                  // a still-in-flight offscreen render (incl. one kicked off by a static miss below) shows a shimmer
                  if (pendingThumbnails.has(pkg.id)) return <span className="catalog-card-skeleton" aria-hidden="true" />
                  // pristine bundled examples ship a committed static thumb (like built-ins) - load it, and on a
                  // miss (e.g. a new bundled part not yet regenerated) ask the app to render the package in-browser
                  if (bundledSet.has(pkg))
                    return (
                      <img
                        src={versionedAssetUrl(`/thumbnails/pkg/${packageThumbFile(pkg.id)}.webp`)}
                        alt=""
                        draggable={false}
                        onError={() => onPackageThumbnailMissing(pkg.id)}
                      />
                    )
                  return <span className="catalog-card-glyph"><PartGlyph /></span>
                })()}
                {buildError && <span className="catalog-card-error-badge" aria-label={t(M.buildError)}>⚠</span>}
              </span>
              <span className="catalog-card-label">{pkg.name}</span>
            </button>
            {/* always-visible badges, stacked in the corner: what to decide about this part, not hover tools */}
            {(update || shelfStatus) && (
              <span className="catalog-card-badges">
                {/* a newer version where the part came from: the app, a part library or the shelf */}
                {update && controller && (
                  <button
                    className={`catalog-card-badge is-${update.edited ? 'warn' : 'act'}`}
                    data-testid="part-update"
                    data-source={update.source}
                    disabled={state.readOnly}
                    title={updateTitle(update)}
                    onClick={() => void reviewUpdate(controller, update)}
                  >
                    {t(M.update)}
                  </button>
                )}
                {/* what the shelf's part of this id is to this project (docs/parts-shelf.md) */}
                {shelfStatus && badgeElement(pkg, shelfStatus)}
              </span>
            )}
            <button
              className="catalog-card-edit"
              // store.enterPackageEdit refuses in a room (its throwaway instance would reach every peer)
              disabled={state.readOnly || state.collab}
              title={
                state.readOnly
                  ? t(M.viewOnly)
                  : state.collab
                    ? t(M.partEditorInRoom)
                    : t(M.editInPartEditor, { name: pkg.name })
              }
              onClick={() => controller?.editPartPackage(pkg.id)}
            >
              <PencilIcon size="1em" />
            </button>
            <button
              className="catalog-card-download"
              title={t(M.download, { name: pkg.name })}
              onClick={() => {
                const part = getPackage(pkg.id) ?? pkg
                // a built-in copy's model travels in the file as its bytes, not as a path into this app
                void warmShippedAssets([part]).then(() => downloadPart(part, { assetBytes: shippedAssetBytes }))
              }}
            >
              <ExportIcon size="1em" />
            </button>
            {/* the Edit Behavior command (commands.ts part.editBehavior), aimed at this card's package */}
            <button
              className="catalog-card-code"
              disabled={!commandEnabledOn('part.editBehavior', { packageId: pkg.id })}
              title={t(M.editBehavior, { name: pkg.name })}
              // preload the Monaco chunk on hover so the editor opens without its download spinner
              onPointerEnter={() => preloadBehaviorEditor()}
              onClick={() => runCommandOn('part.editBehavior', { packageId: pkg.id })}
            >
              <ScriptIcon />
            </button>
            {userCopy && (
              <button
                className="catalog-card-remove"
                disabled={state.readOnly || state.collab || editingThis}
                title={
                  state.readOnly
                    ? t(M.viewOnly)
                    : state.collab
                      ? t(M.deleteInRoom)
                      : editingThis
                        ? t(M.openForEditing)
                        : shadowsBundled
                          ? t(M.revertTitle, { name: pkg.name })
                          : t(M.deleteTitle, { name: pkg.name })
                }
                onClick={() => {
                  if (!controller) return
                  // a shadow reverts (instances rebuild on the shadowed copy); a plain deletion strands
                  // placed instances, so it's blocked until no placed part uses it
                  if (!shadowsBundled) {
                    const used = controller.packageUsage(pkg.id)
                    if (used.length > 0) {
                      alert(t(M.stillUsed, { name: pkg.name, users: used.join(', ') }))
                      return
                    }
                  }
                  const message = shadowsBundled
                    ? t(lost ? M.revertConfirmLost : M.revertConfirm, { name: pkg.name })
                    : t(M.deleteConfirm, { name: pkg.name })
                  if (window.confirm(message)) controller.removeUserPackage(pkg.id)
                }}
              >
                <TrashIcon size="1em" />
              </button>
            )}
            </div>
          )
        })}
        {/* shelf parts this project has no copy of: pressing the card copies the part in, then places it */}
        {shelfCards.map((pkg) => (
          <div key={`shelf:${pkg.id}`} className="catalog-card catalog-card-prefab catalog-card-shelf" data-shelf-status="notInProject">
            <CatalogPlaceButton
              pkg={pkg}
              blocked={!editable}
              title={state.readOnly ? t(M.viewOnly) : t(M.fromShelf, { name: pkg.name })}
              state={state}
              controller={controller}
              image={pkg.thumbnail ?? shelf?.listing?.thumbnails.get(pkg.id)}
              beforePlace={() => {
                setPlacingFromShelf(pkg.id)
                if (store && statusInProject(store.getState(), pkg) === 'notInProject') copyFromShelf(store, pkg)
              }}
            />
            <span className="catalog-card-badges">{badgeElement(pkg, 'notInProject')}</span>
          </div>
        ))}
        {searching && defs.length === 0 && customCards.length === 0 && shelfCards.length === 0 && (
          <p className="catalog-hint">{t(M.noMatch, { query })}</p>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
