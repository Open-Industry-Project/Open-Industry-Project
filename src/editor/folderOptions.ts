// How the editor spills a project into folder files (core/projectFolder.ts): one set of options for every writer, so
// the folder sync, a saved .oip and the agent guide all write the program's files and the part assets the same way.
import type { FolderOptions } from '../core/projectFolder'
import { programFiles } from '../plc/programFiles'
import { shippedAssetBytes } from './shippedAssetCache'

export const FOLDER_OPTIONS: FolderOptions = { assetBytes: shippedAssetBytes, splitProgram: programFiles }
