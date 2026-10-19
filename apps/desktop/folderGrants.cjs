// Which folders the user has handed this app: the only places main will read, write, watch or open on the page's
// request.
//
// Every path-taking channel (project:write, project:readAt, parts:list, parts:openScript, ...) takes a path from the
// page. A page can run part code from a collab room (src/collab/codeTrust.ts), and a path is all it takes to write a
// file anywhere the user can (a Startup folder runs it at the next login). So main keeps its own list of folders the
// user chose, and refuses any path outside them. It learns them only from things main saw itself: a native picker, a
// folder main created, a folder named on the command line, Open Recent, the managed parts folder.
//
// Not a source: anything the page reports. project:remember can record any path in the folder
// registry (folderRegistry.cjs), so the registry seeds the grants once, at launch, and never again. Plain Node -
// testable with `node apps/desktop/folderGrants.test.cjs`.

const { isAbsolute, relative, resolve } = require('node:path')

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
const norm = (p) => (caseInsensitive ? resolve(p).toLowerCase() : resolve(p))

/** Is `child` the folder `parent` or somewhere inside it? (resolved first, so `..` cannot climb out) */
function isWithin(parent, child) {
  const rel = relative(norm(parent), norm(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function createFolderGrants() {
  const roots = []
  return {
    /** Grant `folder` (and everything under it). Ignores anything that is not a non-empty absolute path. */
    grant(folder) {
      if (typeof folder !== 'string' || folder === '' || !isAbsolute(folder)) return
      if (!roots.some((r) => isWithin(r, folder))) roots.push(resolve(folder))
    },
    /** May the page have main act on `path`? Only inside a granted folder. */
    allows(path) {
      return typeof path === 'string' && path !== '' && isAbsolute(path) && roots.some((r) => isWithin(r, path))
    },
    /** the granted folders, for diagnostics */
    list() {
      return [...roots]
    },
  }
}

module.exports = { createFolderGrants, isWithin }
