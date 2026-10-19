# The parts shelf

Desktop only. Code: `src/core/partShelf.ts` (the statuses),
`src/editor/partShelf.ts` (moving parts), `src/editor/components/CatalogShelf.tsx` (the Catalog's Shelf tab),
`apps/desktop/partsShelf.cjs` (the folder). Gate: `e2e/verify-parts-shelf-electron.mjs`.

## Why a shelf

A project's custom parts are stored with the project (its `parts/` folder on the desktop) and nowhere else, so a
project opens the same way on any machine.
A second, shared home for parts would let one project's parts leak into another, with load order deciding between
the two homes.

Reuse across projects is still common. An integrator builds the same transfer, merge or customer-specific machine
for job after job, and a team keeps a standard set of equipment. Without the shelf, the only way to carry a part to
another project is to download it from the Catalog (a part file, `.oippart`) and Import part there, again after
every fix, and nothing tells a project its copy is out of date.

## The rule the shelf keeps

**A project's own copies are the only place its parts come from.** The shelf is a place to copy from, never a
place a project reads live. Placing a part from the shelf copies it into the project, as Import part does, so a
project stays self-contained: it exports, syncs to its folder and opens on another machine with
everything it needs, shelf or no shelf.

## What it is

- **The shelf** is a collection of custom parts kept outside any project.
  - Desktop: `Documents/Open Industry Project/Parts Shelf` unless you choose another folder (Change folder… on
    the Shelf tab; remembered in `<userData>/parts-shelf.json`). "Parts Shelf", not "Shelf": projects are made as
    folders in the same place. One part per subfolder, in the same layout a project's `parts/` uses. Point it at a
    shared drive or a git repository and a team works from one standard set. An isolated profile (every e2e gate)
    keeps its shelf inside the profile; `OIP_SHELF_DIR` moves it outright.
  - Browser: none. The people who reuse parts across jobs work on the desktop, and sharing needs folders. The
    statuses live in `src/core`, apart from the desktop's folder code.
  - There is one shelf. A team points it at its shared folder. The default location is used without asking, as the
    app already makes project folders without asking.
- **In the Catalog** it is its own tab, "Shelf": the shelf's parts, each badged with what it is to this project, then
  "This project's parts, not on the shelf". Every shelf action lives on that tab, so the cards on the other tabs keep
  their size.
- **Placing** a shelf part copies it into the project's parts at the press, then places it the usual way. Copying
  in is a library change like Import part, not an undo step, and it stays if the placement is cancelled.
- **Put on shelf** copies the project's version onto the shelf.
- The shelf is read each time the tab opens, since a teammate or a git pull can change it under the app.

## Knowing a copy is out of date

A copy needs to remember what it was copied from. Each library entry that came from the shelf records the content
hash of the shelf version it was copied from (`origin.shelf: <hash>`, kept in the project). The hash covers the
part's manifest, behavior and assets in a canonical order. It leaves out what the SDK derives from the behavior, so
a newer app does not turn untouched copies into updates ([part-sources.md](part-sources.md)). Comparing three hashes
gives four states:

| Project copy vs what it was copied from | Shelf now vs what it was copied from | State | Shown |
|---|---|---|---|
| same | same | up to date | nothing |
| same | changed | the shelf has a newer version | "Update available" on the card |
| changed | same | edited in this project | "Edited here" (offers Add to shelf) |
| changed | changed | both changed | "Changed in both"; updating asks first, showing that this project's edits will be replaced |

**Updating is always explicit and one part at a time**, after a dialog that lists what changes (`partChanges`, the
list the built-in update Review shows, with what a breaking signal change breaks in this project) and says every
placed copy changes (and, for "changed in both", that this project's changes are replaced). Declining "changed in
both" keeps this project's version, and the card stays "changed in both". Updates are never automatic, so a fix to a
standard part cannot change a line that is already delivered or under acceptance testing. Like Import part, an
update is a library change, not an undo step.

**Put on shelf over a different shelf version** asks first in the same dialog, listing what changes on the shelf and
saying it replaces the shelf's version for every project that updates from it. It does not compare dates, because
file dates on a shared drive or after a git checkout say little about which version is newer.

## Identity

A part is matched by its id (`acme.transfer`). Two different parts that share an id (the project's did not come from
the shelf, and its content differs) are a conflict neither side resolves silently: the shelf card cannot be placed,
and the project's part cannot be put over it. The card offers "Rename ours…", which gives the project's part a new id
(`store.renameUserPackage`, core/partRename.ts). Every placed copy moves with it, and the undo history is rewritten
to the new id, so no earlier step brings the old one back. Like Import part it is a library change, not an undo step.
The shelf's part is never the one renamed: other projects may use it under its id. The rename is refused in a room,
while running, for a copy of a built-in (Save as a New Part makes a variant), and while another part's definition
names the part (held cargo, a unit load's pieces), since that part's script would have to change.

## What it is not

- No version numbers, ranges or lock files. One version per part on a shelf; the hash is the version.
- Not an online store. Published parts come from part libraries ([part-libraries.md](part-libraries.md)).
- No dependencies: placing a shelf part copies that part alone, not other parts its definition names.
- No live reading of the shelf by a project, ever (see the rule above).
- No saved layouts. A project holds one scene and no assemblies (docs/scene-composition.md), so the shelf holds parts
  only.
