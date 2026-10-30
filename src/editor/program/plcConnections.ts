// The PLC connections window's model (components/plc/PlcConnectionsWindow.tsx): the controllers it can browse, every
// machine's tag fields as one controller sees them, and the edit a connection is. A connection is nothing new in the
// document. It is the name in a part's tag field, the one the Inspector's Comms group shows, with the controller's name
// in front for a named controller (`Cell2::MAIN.Extend`, core/io/controllerTag.ts).

import { controllerTag, splitControllerTag } from '../../core/io/controllerTag'
import type { PartInstance, SceneJSON, SdkPart } from '../../core/types'
import { deviceTags } from '../../plc/bindings'
import type { PlcSetup } from '../store/storePlcs'

/** A controller the window can list variables from: one on a TwinCAT PLC over ADS. `name` is null for the default one. */
export interface BrowsableController {
  name: string | null
  label: string
  netId: string
  port: number
}

/** Every controller that runs on a PLC reached over ADS, the default one first. */
export function browsableControllers(setup: PlcSetup): BrowsableController[] {
  const out: BrowsableController[] = []
  if (setup.enabled && setup.mode === 'ads') out.push({ name: null, label: setup.mainName, netId: setup.adsNetId, port: setup.adsPort })
  for (const c of setup.controllers) {
    if (c.runsOn === 'plc' && c.mode === 'ads') out.push({ name: c.name, label: c.name, netId: c.adsNetId, port: c.adsPort })
  }
  return out
}

/** One tag field of a machine, as one controller sees it. */
export interface ConnectionField {
  key: string
  label: string
  /** fromPlc: the machine reads it (a command); toPlc: the machine writes it (a sensor); null when undeclared */
  dir: 'fromPlc' | 'toPlc' | null
  type: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null
  /** the PLC variable it is wired to on this controller, '' when none */
  variable: string
  /** the controller it is wired to instead, when it names another one (null: the default one) */
  elsewhere: string | null | undefined
}

export interface ConnectionMachine {
  id: string
  name: string
  kind: string
  fields: ConnectionField[]
}

const same = (a: string | null, b: string | null): boolean => (a ?? '').toLowerCase() === (b ?? '').toLowerCase()

/** Every machine with tag fields, in scene order, each field with what it is wired to on `controller`. */
export function connectionMachines(parts: readonly PartInstance[], controller: string | null): ConnectionMachine[] {
  return deviceTags(parts).map((d) => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    fields: d.fields.map((f) => {
      const { controller: on, local } = splitControllerTag(f.value)
      const here = f.value !== '' && same(on, controller)
      return {
        key: f.key,
        label: f.label,
        dir: f.section === 'VAR_OUTPUT' ? 'fromPlc' : f.section === 'VAR_INPUT' ? 'toPlc' : null,
        type: f.type,
        variable: here ? local : '',
        elsewhere: f.value === '' || here ? undefined : on,
      }
    }),
  }))
}

/** A connection as the window lists it. */
export interface Connection {
  partId: string
  machine: string
  key: string
  field: string
  dir: ConnectionField['dir']
  variable: string
}

/** The fields wired to `controller`, in scene order. */
export function connectionsOf(machines: readonly ConnectionMachine[]): Connection[] {
  return machines.flatMap((m) => m.fields.filter((f) => f.variable !== '').map((f) => ({ partId: m.id, machine: m.name, key: f.key, field: f.label, dir: f.dir, variable: f.variable })))
}

/** The scene with part `partId`'s tag field `key` wired to `variable` on `controller` ('' disconnects it), or null when there is no such part. */
export function withConnection(scene: SceneJSON, partId: string, key: string, controller: string | null, variable: string): SceneJSON | null {
  const at = scene.parts.findIndex((p) => p.id === partId)
  const part = scene.parts[at]
  if (!part || part.type !== 'part') return null
  const params = { ...(part as SdkPart).params, [key]: controllerTag(controller, variable.trim()) }
  const parts = scene.parts.slice()
  parts[at] = { ...part, params } as SdkPart
  return { ...scene, parts }
}
