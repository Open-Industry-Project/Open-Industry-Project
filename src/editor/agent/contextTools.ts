// The tools for working beside a person (docs/agent-tools.md): what they are looking at, and what has become of the
// agent's own edits. "This conveyor" or "the rung I'm on" needs the first. The second lets the agent learn that the
// person reverted its work, rather than building on edits that are gone.

import { getPackage } from '../../core/parts/partRegistry'
import type { SdkPart } from '../../core/types'
import { readPlcReading } from '../program/plcReading'
import { reviewChanges } from './agentReview'
import { round, type AgentTool } from './toolKit'

/** a selection this long is summarised past this many parts: the ids an agent acts on fit, a box-select of a hall does not */
const SELECTION_SHOWN = 25

export const getContext: AgentTool = {
  name: 'get_context',
  description:
    'What the person is looking at, so "this part", "these conveyors" or "the line I am on" can be resolved: the ' +
    "selected parts, the part isolated for editing, the PLC panel's open POU and cursor line and word, whether the " +
    'sim runs, and the active tool. Also the review of your own edits: the steps the person has not yet kept or ' +
    'reverted, what they changed, and how the person last answered (a "reverted" answer means your edits are gone).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: ({ store, session }) => {
    const s = store.getState()
    const byId = new Map(s.scene.parts.map((p) => [p.id, p]))
    const selected = s.selectedIds.flatMap((id) => {
      const p = byId.get(id)
      if (!p) return []
      const pkg = p.type === 'part' ? (p as SdkPart).packageId : undefined
      return [{ id, ...(p.name ? { name: p.name } : {}), ...(pkg ? { package: pkg, packageName: getPackage(pkg)?.name } : { type: p.type }), position: p.position.map(round) }]
    })
    const activity = session?.getSnapshot()
    const pending = session?.pending() ?? []
    return {
      selection: selected.slice(0, SELECTION_SHOWN),
      ...(selected.length > SELECTION_SHOWN ? { selectionCount: selected.length } : {}),
      ...(s.focusedPartId ? { isolatedPart: s.focusedPartId } : {}),
      ...(s.selectedRigNode ? { selectedRigNode: s.selectedRigNode } : {}),
      ...(s.packageEdit ? { editingDefinition: s.packageEdit.packageId } : {}),
      plcPanel: readPlcReading(),
      running: s.running,
      ...(s.running ? { paused: s.paused } : {}),
      tool: s.tool,
      mode: s.mode,
      readOnly: s.readOnly,
      review:
        activity?.baseline && pending.length > 0
          ? {
              steps: pending.map((e) => e.label),
              personStepsInRun: session!.userStepsInRun().map((e) => e.label),
              changes: reviewChanges(activity.baseline, store),
            }
          : null,
      lastAnswer: activity?.answer ?? null,
    }
  },
}

