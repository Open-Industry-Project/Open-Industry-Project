// A project folder's files in the codec's {path, contents} form, read by the desktop shell's own walk
// (apps/desktop/projectFolderIo.cjs), so a CLI never reads a folder differently from the app. A CLI with its own copy
// of the walk could miss a directory or a file extension and reject a valid folder.
import projectFolderIo from '../../apps/desktop/projectFolderIo.cjs'

/** Every project file under `root` (throws when the folder itself is gone). */
export const readProjectFolder = projectFolderIo.readProjectFolder
