// A new part made from a URDF robot, from Import part > A robot (URDF)… or a .urdf dropped on the Parts dock.
//
// The robot is converted at once (editor/urdfImport.ts): unlike a model, it has no options to show, since its links,
// joints and placement are all in the file. The part is then made as New part makes one and opened as its own scene,
// with the teach gizmo on its joints. Anything imported other than as written is reported in one message.

import type { EditorController } from '../controller'
import { defineMessages, t } from '../../core/i18n'
import { UrdfError } from '../../core/urdf'
import type { UrdfRigNote } from '../../core/urdfRig'
import { importUrdf, urdfCandidates, URDF_TRIANGLE_BUDGET, type UrdfImport } from '../urdfImport'
import { largeModelAdvisory } from './modelStorage'

const M = defineMessages('urdfImport', {
  noUrdf: 'The folder {name} has no URDF file (.urdf).',
  xacro: '{file} is a xacro file, which builds a URDF from macros. Expand it to a .urdf first (in ROS: xacro {file} > robot.urdf) and import that.',
  notUrdf: '{file} is not a URDF robot description: {reason}',
  failed: 'Could not import {file}: {reason}',
  imported: { one: 'Imported {name}: {links} links and {count} joint.', other: 'Imported {name}: {links} links and {count} joints.' },
  missing: {
    one: '{count} mesh file was not found, so its geometry is left out: {first}. Import the folder that holds the robot\'s meshes as well (Import part > A robot (URDF)…).',
    other:
      '{count} mesh files were not found, so their geometry is left out, for example {first}. Import the folder that holds the robot\'s meshes as well (Import part > A robot (URDF)…).',
  },
  unreadable: {
    one: '{count} mesh file could not be read: {first}. STL, COLLADA (.dae) and OBJ files are read.',
    other: '{count} mesh files could not be read, for example {first}. STL, COLLADA (.dae) and OBJ files are read.',
  },
  simplified: 'Its meshes had {source}k triangles, more than a simulation needs, so they were simplified to {kept}k.',
  noteSecondParent: 'Link {subject} is the child of more than one joint; the first one places it.',
  noteUnknownLink: 'Joint {subject} names a link the file does not have, so it was left out.',
  noteFixedInPlace: 'Joint {subject} is floating or planar, which a part cannot move, so its link stays where it was described.',
  noteNoLimit: 'Joint {subject} has no usable limits, so it turns ±180° (or slides ±1 m).',
  noteMimic: 'Joint {subject} follows a joint that is missing, fixed or following another itself, so here it moves on its own.',
})

const NOTE: Record<UrdfRigNote['code'], (typeof M)[keyof typeof M]> = {
  'second-parent': M.noteSecondParent,
  'unknown-link': M.noteUnknownLink,
  'fixed-in-place': M.noteFixedInPlace,
  'no-limit': M.noteNoLimit,
  mimic: M.noteMimic,
}

/** The URDF files a picked folder could import, nearest the top first; the caller asks which when there are several. */
export function urdfRootsOf(files: ReadonlyMap<string, Blob>): string[] {
  return urdfCandidates([...files.keys()])
}

/** A picked folder's files keyed by their path inside the pick (webkitRelativePath), as the importer resolves them. */
export function folderFiles(list: FileList | readonly File[]): Map<string, Blob> {
  return new Map(Array.from(list).map((f) => [(f.webkitRelativePath || f.name).replaceAll('\\', '/'), f]))
}

/**
 * Import the robot whose URDF is `root` (a key of `files`) as a new part and open it. Returns the part's id (null
 * when nothing was made) and the message to show, or '' when the import went as written.
 */
export async function newPartFromUrdf(controller: EditorController, files: ReadonlyMap<string, Blob>, root: string): Promise<{ packageId: string | null; message: string }> {
  const file = root.split('/').pop() ?? root
  let result: UrdfImport
  try {
    result = await importUrdf(files, root)
  } catch (e) {
    if (e instanceof UrdfError) return { packageId: null, message: e.code === 'xacro' ? t(M.xacro, { file }) : t(M.notUrdf, { file, reason: e.message }) }
    return { packageId: null, message: t(M.failed, { file, reason: (e as Error).message }) }
  }
  const packageId = controller.createBlankPart({
    name: result.name,
    geometry: result.geometry,
    assets: result.assets,
    materials: result.materials,
    ...(result.behavior ? { behavior: result.behavior } : {}),
  })
  return { packageId, message: packageId ? summary(result) : '' }
}

/** What the user should know about an import: everything that differs from the file, and nothing when nothing does. */
function summary(r: UrdfImport): string {
  const lines: string[] = []
  if (r.missing.length) lines.push(t(M.missing, { count: r.missing.length, first: r.missing[0]! }))
  if (r.unreadable.length) lines.push(t(M.unreadable, { count: r.unreadable.length, first: r.unreadable[0]! }))
  if (r.stats.sourceTriangles > URDF_TRIANGLE_BUDGET)
    lines.push(t(M.simplified, { source: Math.round(r.stats.sourceTriangles / 1000), kept: Math.round(r.stats.triangles / 1000) }))
  const storage = largeModelAdvisory(r.stats.glbBytes)
  if (storage) lines.push(storage)
  for (const n of r.notes) lines.push(t(NOTE[n.code], { subject: n.subject }))
  if (lines.length === 0) return ''
  return [t(M.imported, { name: r.name, links: r.stats.links, count: r.stats.joints }), ...lines].join('\n\n')
}

/** The message for a picked folder with no URDF in it. */
export const noUrdfMessage = (folder: string): string => t(M.noUrdf, { name: folder })
