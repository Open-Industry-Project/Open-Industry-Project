import { partCreditText } from '../parts/partCredit'
import { lazy, Suspense, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, MouseEvent as ReactMouseEvent } from 'react'
import { versionedAssetUrl } from '../../core/assetVersions'
import { PART_DEFS } from '../../core/types'
import type { PartDef, PartType } from '../../core/types'
import { packageThumbFile } from '../../core/parts/partPackage'
import { getPackage, packageCategory } from '../../core/parts/partRegistry'
import type { EditorController } from '../controller'
import type { EditorState } from '../store/store'
import { downloadPart } from '../parts/partFile'
import { shippedAssetBytes, warmShippedAssets } from '../parts/shippedAssetCache'
import { preloadBehaviorEditor } from './behaviorEditorChunk'
import { ScriptIcon } from './toolbarIcons'
import { commandEnabledOn, runCommand, runCommandOn } from '../commands'
import { ExportIcon, ImportIcon, PartGlyph, PencilIcon, TrashIcon } from './toolbarIcons'
import { builtInsUpdated } from '../store/storePackages'
import { builtInUpdateChoices, builtInUpdatedText } from './builtInUpdate'
import { PartUpdatesNotice } from './PartUpdatesNotice'
import { UNLISTED_BUILT_INS, editedSinceCopied, sameAsBuiltIn } from '../../core/builtInVersion'
import { ContextMenu } from './inspector/menu'
import { getShelfApi } from '../parts/partShelf'
import { defineMessages, t, type MessageId } from '../../core/i18n'

const M = defineMessages('catalog', {
  replaceLoaded: 'A part “{name}” is already loaded. Replace it with the one from “{file}”?',
  importErrorLine: '{file}: {error}',
  importFailed: "Couldn't import:\n{errors}",
  title: 'Parts',
  viewOnly: 'View only: editing is disabled',
  viewOnlyLink: 'View only: editing is disabled on this link',
  partEditorInRoom: 'The Part Editor is unavailable in a shared room',
  newPartTitle: 'New blank part:a single box you can reshape, add nodes to, and script (the same portable format the built-ins use)',
  newPart: '＋ New part',
  importTitle: 'Import a shared part file (.oippart or .part.json) into this project',
  importPart: 'Import part',
  getPartsTitle: 'Get parts from the part libraries: containers, machines and more, added to this project',
  getParts: '⬇ Get parts',
  catEquipment: 'Equipment',
  catDevices: 'Devices',
  catProducts: 'Products',
  catStructure: 'Structure',
  shelfTitle: 'Parts kept outside any project, for every project to place and update from',
  shelf: 'Shelf',
  placingTouch: 'Tap the viewport to place · tap the card again to finish',
  placingMouse: 'Click or drag to the viewport · Alt: no snap · Esc: done',
  search: 'Search parts',
  oneBuilding: 'One building per scene',
  buildFailed: 'Latest edit failed to build (showing last working version):\n{error}',
  credited: '{name} · {credit}',
  customPart: '{name} · custom part',
  buildError: 'build error',
  updatedTitle: '{text} Click to choose which to use.',
  updated: 'Updated',
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
})

// The Shelf tab loads when it opens: the shelf is the desktop app's alone, so it does not belong in the first frame.
// Lazying it kept the eager-JS budget (scripts/lib/eager-js.mjs) from a raise. Part libraries are reached through Get
// parts (components/GetPartsWindow.tsx), not a tab here: the dock shows what this project can place.
const CatalogShelf = lazy(() => import('./CatalogShelf').then((m) => ({ default: m.CatalogShelf })))

type Category = PartDef['category']
// catalog tab order; tabs with nothing to show are hidden (see `tabs` in Catalog)
const CATEGORIES: Category[] = ['Equipment', 'Devices', 'Products', 'Structure']
// each tab's heading; the category itself is a key parts match on
const CATEGORY_LABEL: Record<Category, MessageId> = {
  Equipment: M.catEquipment,
  Devices: M.catDevices,
  Products: M.catProducts,
  Structure: M.catStructure,
}

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
  const [category, setCategory] = useState<Category>('Equipment')
  // the Shelf tab (CatalogShelf.tsx): only where the shell has a parts shelf, the desktop app
  const shelfApi = getShelfApi()
  // the Shelf tab in place of a category (desktop)
  const [onShelf, setOnShelf] = useState(false)
  const [query, setQuery] = useState('')
  // the "Updated" badge's menu: which version of an updated built-in this project uses (builtInUpdate.ts)
  const [updateMenu, setUpdateMenu] = useState<{ x: number; y: number; id: string; name: string } | null>(null)
  const updatedBuiltIns = builtInsUpdated(state)
  // has this project changed its copy of a built-in (what taking the app's version would discard)?
  const editedHere = (id: string): boolean => {
    const copy = state.userPackages.find((p) => p.id === id)
    return copy !== undefined && editedSinceCopied(copy)
  }
  const importRef = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const searching = q !== ''
  const showShelf = onShelf && shelfApi !== null
  const onSource = showShelf

  // import shared part files (.oippart, or the older .part.json) into the library (the file-level counterpart of the scene Load
  // button); reached from the header button (multi-select) and by dropping files anywhere on the dock
  const importFiles = async (files: File[]): Promise<void> => {
    if (!controller || state.readOnly || files.length === 0) return
    const errors: string[] = []
    for (const file of files) {
      const error = await controller.importPart(new Uint8Array(await file.arrayBuffer()), (name) =>
        window.confirm(t(M.replaceLoaded, { name, file: file.name })),
      )
      if (error) errors.push(t(M.importErrorLine, { file: file.name, error }))
    }
    if (errors.length > 0) alert(t(M.importFailed, { errors: errors.join('\n') }))
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
  // an unlisted built-in (core/parts/partCatalog UNLISTED_BUILT_INS) stays out unless the project changed its own version
  const customById = new Map([...state.bundledPackages.filter((p) => !UNLISTED_BUILT_INS.has(p.id)), ...ownVersions].map((p) => [p.id, p]))
  // Pristine first-party bundled packages (by object identity, so a user/folder copy that shadows a bundled
  // id, and takes precedence in customById, is excluded): only these have a committed /thumbnails/pkg/*.webp; every
  // other package renders its card in-browser. Identity, not id, because a shadow's content differs from the
  // baked image.
  const bundledSet = new Set(state.bundledPackages)
  // tabs with nothing to show are hidden; loaded packages count too, so a category populated only by
  // packages (no built-in defs) still gets its tab
  const tabs = CATEGORIES.filter(
    (c) =>
      Object.values(PART_DEFS).some((d) => d.category === c && !d.noCatalog) ||
      [...customById.values()].some((p) => packageCategory(p) === c),
  )
  // the remembered tab can disappear (e.g. the last package in a category was removed) - fall back
  const activeCategory = tabs.includes(category) ? category : (tabs[0] ?? 'Equipment')
  // search spans every category; otherwise the active tab decides what shows.
  // noCatalog types (the Group node, the generic 'part') are never placed directly from the palette.
  const defs = Object.values(PART_DEFS).filter(
    (def) =>
      !def.noCatalog &&
      (searching
        ? def.label.toLowerCase().includes(q) || def.type.toLowerCase().includes(q)
        : def.category === activeCategory),
  )
  const customCards = [...customById.values()].filter((pkg) =>
    searching ? pkg.name.toLowerCase().includes(q) || pkg.id.toLowerCase().includes(q) : packageCategory(pkg) === activeCategory,
  )

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
        void importFiles(
          Array.from(e.dataTransfer.files).filter(
            (f) => /\.(json|oippart)$/i.test(f.name) || f.type === 'application/json',
          ),
        )
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
          title={state.readOnly ? t(M.viewOnly) : t(M.importTitle)}
          onClick={() => importRef.current?.click()}
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
        <div className="catalog-tabs segmented" role="group">
          {tabs.map((c) => (
            <button
              key={c}
              className={`catalog-tab${!searching && !onSource && c === activeCategory ? ' active' : ''}`}
              data-tutorial={`catalog-${c}`}
              onClick={() => {
                setQuery('')
                setCategory(c)
                setOnShelf(false)
              }}
            >
              {t(CATEGORY_LABEL[c])}
            </button>
          ))}
          {/* the shelf is a source, not a category, but still exclusive with them: same row, past a divider */}
          {shelfApi && <span className="segmented-sep" aria-hidden="true" />}
          {shelfApi && (
            <button
              className={`catalog-tab${showShelf ? ' active' : ''}`}
              data-testid="catalog-tab-shelf"
              title={t(M.shelfTitle)}
              onClick={() => {
                setQuery('')
                setOnShelf(true)
              }}
            >
              {t(M.shelf)}
            </button>
          )}
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
        {showShelf && shelfApi && (
          <Suspense fallback={null}>
            <CatalogShelf state={state} controller={controller} api={shelfApi} query={q} packageThumbnails={packageThumbnails} />
          </Suspense>
        )}
        {!onSource && defs.map((def) => {
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
        {!onSource && customCards.map((pkg) => {
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
          return (
            <div
              key={`pkg:${pkg.id}`}
              className={`catalog-card catalog-card-prefab catalog-card-custom${userCopy ? ' catalog-card-deletable' : ''}`}
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
            {/* this project's version of a built-in the app has changed since (core/builtInVersion.ts) */}
            {updatedBuiltIns.has(pkg.id) && controller && (
              <button
                className="catalog-card-updated"
                data-testid="catalog-builtin-updated"
                disabled={state.readOnly}
                title={t(M.updatedTitle, { text: builtInUpdatedText(pkg.name, editedHere(pkg.id)) })}
                onClick={(e) => setUpdateMenu({ x: e.clientX, y: e.clientY, id: pkg.id, name: pkg.name })}
              >
                {t(M.updated)}
              </button>
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
        {!onSource && defs.length === 0 && customCards.length === 0 && (
          <p className="catalog-hint">{t(M.noMatch, { query })}</p>
        )}
      </div>
      {updateMenu && controller && (
        <ContextMenu
          x={updateMenu.x}
          y={updateMenu.y}
          items={builtInUpdateChoices(controller, updateMenu.id, updateMenu.name, editedHere(updateMenu.id))}
          onClose={() => setUpdateMenu(null)}
        />
      )}
    </div>
  )
}
