// The Catalog's Shelf tab (docs/parts-shelf.md): the parts shelf's parts, each with what it is to the open project,
// and this project's parts that are not on the shelf yet. Every shelf action lives here, so the part cards on the
// other tabs keep their size: placing copies a shelf part into the project (editor/parts/partShelf.ts), "Update" takes the
// shelf's newer version, "Put on shelf" files the project's.
//
// Desktop only: the Catalog renders this only when the shell has a shelf (getShelfApi).

import { useCallback, useEffect, useState } from 'react'
import { partChanges } from '../../core/parts/partChanges'
import type { PartPackage } from '../../core/parts/partPackage'
import { getPackage } from '../../core/parts/partRegistry'
import { freePartId } from '../../core/parts/partRename'
import type { ShelfStatus } from '../../core/parts/partShelf'
import type { EditorController } from '../controller'
import { documentSceneOf, type EditorState } from '../store/store'
import { askName } from '../nameDialog'
import { copyFromShelf, putOnShelf, readShelf, statusInProject } from '../parts/partShelf'
import type { OipShelfApi, ShelfListing } from '../parts/partShelf'
import { CatalogPlaceButton } from './CatalogPlaceButton'
import { ShelfChangeDialog } from './ShelfChangeDialog'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('catalogShelf', {
  inProject: 'In project',
  inProjectTitle: "This project has the shelf's “{name}”.",
  update: 'Update',
  updateTitle: "The shelf has a newer “{name}” than this project. Click to update this project's.",
  putOnShelf: 'Put on shelf',
  editedHereTitle: "This project has changed “{name}” since it came from the shelf. Click to put this project's version on the shelf.",
  changedInBothTitle: "“{name}” has changed both here and on the shelf. Updating replaces this project's changes.",
  renameOurs: 'Rename ours…',
  sameIdTitle:
    "This project has its own part with the same id as the shelf's “{name}”, and they are not the same part. Click to give this project's a new id, so both can be used.",
  putConfirm: 'Put “{name}” on the shelf? Other projects can then place it, and update when it changes.',
  putTitle: 'Put “{name}” on the shelf',
  putIntro: "This replaces the shelf's version for every project that updates from it. What changes on the shelf:",
  updateDialogTitle: 'Update “{name}” from the shelf',
  updateIntroBoth:
    "This part has changed both in this project and on the shelf. Updating replaces this project's changes, and every placed copy changes. What changes here, including undoing this project's edits:",
  updateIntro: 'Every placed copy in this project changes. What changes here:',
  renameTitle: "Rename this project's part",
  renameIntro: "This project's “{name}” and the shelf's are different parts with the same id. Give this project's a new id. Every placed copy moves with it.",
  rename: 'Rename',
  idTaken: 'The shelf already has a part with the id “{id}”.',
  where: 'Shelf: {root}',
  readFailed: 'The shelf could not be read: {error}',
  reading: 'Reading the shelf…',
  showFolderTitle: 'Show the shelf folder',
  showFolder: 'Show folder',
  changeFolderTitle: 'Use another folder as the shelf, such as a shared drive or a git repository your team keeps its parts in',
  changeFolder: 'Change folder…',
  unreadable: { one: '{count} folder could not be read', other: '{count} folders could not be read' },
  empty: 'The shelf is empty. A custom part put on it from a project can be placed in any other project, and updated there when it changes.',
  viewOnly: 'View only: editing is disabled',
  sameIdPlace: "This project has a different part with the id “{id}”. Rename this project's to place the shelf's.",
  fromShelfCopies: '{name} · from the shelf. Placing it copies it into this project.',
  fromShelf: '{name} · from the shelf',
  notOnShelf: "This project's parts, not on the shelf",
  ours: "{name} · this project's",
  putOwnTitle: 'Put “{name}” on the shelf, so other projects can place it',
})

interface Props {
  state: EditorState
  controller: EditorController | null
  api: OipShelfApi
  /** the Catalog's search text, lower-cased and trimmed ('' = everything) */
  query: string
  packageThumbnails: Map<string, string>
}

/** The badge a shelf card carries for its status, and what it says when hovered. */
function badgeFor(status: ShelfStatus, name: string): { label: string; title: string; tone: 'quiet' | 'act' | 'warn' } | null {
  switch (status) {
    case 'notInProject':
      return null
    case 'upToDate':
      return { label: t(M.inProject), title: t(M.inProjectTitle, { name }), tone: 'quiet' }
    case 'updateAvailable':
      return { label: t(M.update), title: t(M.updateTitle, { name }), tone: 'act' }
    case 'editedHere':
      return { label: t(M.putOnShelf), title: t(M.editedHereTitle, { name }), tone: 'act' }
    case 'changedInBoth':
      return { label: t(M.update), title: t(M.changedInBothTitle, { name }), tone: 'warn' }
    case 'sameIdDifferentPart':
      return {
        label: t(M.renameOurs),
        title: t(M.sameIdTitle, { name }),
        tone: 'warn',
      }
  }
}

export function CatalogShelf({ state, controller, api, query, packageThumbnails }: Props) {
  const [shelf, setShelf] = useState<ShelfListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      setShelf(await readShelf(api))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [api])
  // read when the tab opens; the shelf can change under the app (a teammate, a git pull), so it is read again on
  // every visit rather than kept
  useEffect(() => {
    void refresh()
  }, [refresh])

  const store = controller?.store ?? null
  const editable = !state.readOnly && store !== null
  const matches = (pkg: PartPackage): boolean => query === '' || pkg.name.toLowerCase().includes(query) || pkg.id.toLowerCase().includes(query)
  const onShelfIds = new Set((shelf?.parts ?? []).map((p) => p.id))
  // this project's own parts that are not on the shelf yet (a pristine built-in is the app's, not the project's)
  const notOnShelf = state.userPackages.filter((p) => !onShelfIds.has(p.id) && matches(p))

  // replacing one version with another is asked in a dialog that lists what changes (core/parts/partChanges.ts)
  const [review, setReview] = useState<Parameters<typeof ShelfChangeDialog>[0] | null>(null)
  const close = (): void => setReview(null)

  const put = async (part: PartPackage, replacing: boolean): Promise<void> => {
    if (!store) return
    const write = async (): Promise<void> => {
      const failed = await putOnShelf(store, api, part)
      if (failed !== '') alert(failed)
      await refresh()
    }
    const onShelf = replacing ? shelf?.parts.find((p) => p.id === part.id) : undefined
    if (!onShelf) {
      if (window.confirm(t(M.putConfirm, { name: part.name }))) await write()
      return
    }
    setReview({
      title: t(M.putTitle, { name: part.name }),
      intro: t(M.putIntro),
      partId: part.id,
      changes: partChanges(onShelf, part),
      confirmLabel: t(M.putOnShelf),
      onConfirm: () => void write(),
      onClose: close,
    })
  }
  const update = (shelfPart: PartPackage, status: ShelfStatus): void => {
    const mine = state.userPackages.find((p) => p.id === shelfPart.id)
    if (!store || !mine) return
    setReview({
      title: t(M.updateDialogTitle, { name: shelfPart.name }),
      intro: status === 'changedInBoth' ? t(M.updateIntroBoth) : t(M.updateIntro),
      partId: shelfPart.id,
      changes: partChanges(mine, shelfPart),
      confirmLabel: t(M.update),
      here: { parts: documentSceneOf(state).parts, program: state.stProgram },
      onConfirm: () => {
        copyFromShelf(store, shelfPart)
        void refresh()
      },
      onClose: close,
    })
  }

  // a different part of the same id: this project's moves to a new id (placed copies with it), and the shelf's can
  // then come in beside it. Not the shelf's: that one may be in use in other projects under its id.
  const rename = async (shelfPart: PartPackage): Promise<void> => {
    const mine = state.userPackages.find((p) => p.id === shelfPart.id)
    if (!store || !mine) return
    const taken = (id: string): boolean =>
      onShelfIds.has(id) || getPackage(id) !== undefined || store.getState().userPackages.some((p) => p.id === id)
    const to = await askName({
      title: t(M.renameTitle),
      intro: t(M.renameIntro, { name: mine.name }),
      initial: freePartId(mine.id, taken),
      confirmLabel: t(M.rename),
    })
    if (to === null) return
    const failed = onShelfIds.has(to) ? t(M.idTaken, { id: to }) : store.renameUserPackage(mine.id, to)
    if (failed !== '') alert(failed)
    await refresh()
  }

  /** a card's main button: pressing it places the part, copying it in from the shelf first if the project lacks it */
  const placeButton = (pkg: PartPackage, blocked: boolean, title: string, fromShelf: PartPackage | null) => (
    <CatalogPlaceButton
      pkg={pkg}
      blocked={blocked}
      title={title}
      state={state}
      controller={controller}
      packageThumbnails={packageThumbnails}
      beforePlace={() => {
        if (fromShelf && store && statusInProject(store.getState(), fromShelf) === 'notInProject') copyFromShelf(store, fromShelf)
      }}
    />
  )

  const shelfParts = (shelf?.parts ?? []).filter(matches)
  return (
    <>
      <div className="catalog-shelf-bar" data-testid="shelf-bar">
        <span className="catalog-shelf-where" title={shelf?.root ?? ''}>
          {shelf ? t(M.where, { root: shelf.root }) : error ? t(M.readFailed, { error }) : t(M.reading)}
        </span>
        <button className="catalog-author" onClick={() => void api.reveal()} title={t(M.showFolderTitle)}>
          {t(M.showFolder)}
        </button>
        <button
          className="catalog-author"
          title={t(M.changeFolderTitle)}
          onClick={() =>
            void api.pickFolder().then((scan) => {
              if (scan) void refresh()
            })
          }
        >
          {t(M.changeFolder)}
        </button>
        {shelf && shelf.problems.length > 0 && (
          <span className="catalog-shelf-problems" title={shelf.problems.map((p) => `${p.dir}: ${p.message}`).join('\n')}>
            {t(M.unreadable, { count: shelf.problems.length })}
          </span>
        )}
      </div>
      {shelf && shelf.parts.length === 0 && notOnShelf.length === 0 && (
        <p className="catalog-hint catalog-shelf-empty">{t(M.empty)}</p>
      )}
      {shelfParts.map((pkg) => {
        const status = statusInProject(state, pkg)
        const badge = badgeFor(status, pkg.name)
        // a project that has the part places its copy; otherwise the shelf's is copied in at the press
        const placing = status === 'notInProject' ? pkg : (state.userPackages.find((p) => p.id === pkg.id) ?? pkg)
        const blocked = !editable || status === 'sameIdDifferentPart'
        const title = state.readOnly
          ? t(M.viewOnly)
          : status === 'sameIdDifferentPart'
            ? t(M.sameIdPlace, { id: pkg.id })
            : status === 'notInProject'
              ? t(M.fromShelfCopies, { name: pkg.name })
              : t(M.fromShelf, { name: pkg.name })
        return (
          <div key={`shelf:${pkg.id}`} className="catalog-card catalog-card-prefab catalog-card-shelf" data-shelf-status={status}>
            {placeButton(placing, blocked, title, status === 'notInProject' ? pkg : null)}
            {badge &&
              (badge.tone === 'quiet' ? (
                <span className={`catalog-card-shelf-badge is-${badge.tone}`} data-testid="shelf-badge" title={badge.title}>
                  {badge.label}
                </span>
              ) : (
                <button
                  className={`catalog-card-shelf-badge is-${badge.tone}`}
                  data-testid={status === 'editedHere' ? 'shelf-put' : status === 'sameIdDifferentPart' ? 'shelf-rename' : 'shelf-update'}
                  disabled={!editable}
                  title={badge.title}
                  onClick={() => {
                    if (status === 'editedHere') {
                      const mine = state.userPackages.find((p) => p.id === pkg.id)
                      if (mine) void put(mine, true)
                    } else if (status === 'sameIdDifferentPart') void rename(pkg)
                    else update(pkg, status)
                  }}
                >
                  {badge.label}
                </button>
              ))}
          </div>
        )
      })}
      {notOnShelf.length > 0 && (
        <>
          <div className="catalog-section-label">{t(M.notOnShelf)}</div>
          {notOnShelf.map((pkg) => (
            <div key={`own:${pkg.id}`} className="catalog-card catalog-card-prefab catalog-card-shelf" data-shelf-status="notOnShelf">
              {placeButton(pkg, !editable, state.readOnly ? t(M.viewOnly) : t(M.ours, { name: pkg.name }), null)}
              <button
                className="catalog-card-shelf-badge is-act"
                data-testid="shelf-put"
                disabled={!editable}
                title={t(M.putOwnTitle, { name: pkg.name })}
                onClick={() => void put(pkg, false)}
              >
                {t(M.putOnShelf)}
              </button>
            </div>
          ))}
        </>
      )}
      {review && <ShelfChangeDialog {...review} />}
    </>
  )
}
