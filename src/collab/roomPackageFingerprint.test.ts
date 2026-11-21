import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { matchesRecord, originOf, partFingerprint, withOrigin } from '../core/parts/partOrigin'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'
import type { PartPackage } from '../core/parts/partPackage'
import { packagesMap, readPackages, writePackage } from './schema'

// What 16 built-ins look like: an empty materials list and nothing else heavy.
const plain: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 'acme.plain',
  name: 'Plain',
  params: {},
  behavior: 'definePart(() => ({}))',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, 0, 0] }], joints: [] },
  materials: [],
}
const stamped = withOrigin(plain, 'app', partFingerprint(plain))
const untouched = (p: PartPackage): boolean => matchesRecord(p, originOf(p, 'app')!)

describe("a part reads as untouched after a trip through a room (schema.ts packageFields)", () => {
  it('keeps an empty materials list, so the copy still matches the version it records', () => {
    const doc = new Y.Doc()
    writePackage(packagesMap(doc), stamped)
    const [read] = readPackages(doc)
    expect(read).toEqual(stamped)
    expect(untouched(read!)).toBe(true)
  })

  it('gives the list back to an entry an older build wrote without it', () => {
    const doc = new Y.Doc()
    writePackage(packagesMap(doc), stamped)
    packagesMap(doc).get(stamped.id)!.set('blob', '') // as that build wrote it
    const [read] = readPackages(doc)
    expect(read!.materials).toEqual([])
    expect(untouched(read!)).toBe(true)
  })

  it('leaves a part alone when its record does not say it had the list', () => {
    const { materials: _none, ...bare } = plain
    const edited = withOrigin({ ...bare, name: 'Plain, renamed here' }, 'app', partFingerprint(plain))
    const doc = new Y.Doc()
    writePackage(packagesMap(doc), edited)
    const [read] = readPackages(doc)
    expect(read!.materials).toBeUndefined()
    expect(untouched(read!)).toBe(false)
  })
})
