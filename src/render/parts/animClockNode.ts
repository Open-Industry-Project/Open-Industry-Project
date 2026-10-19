import { uniform } from 'three/tsl'
import { tickUniformGroup } from './tickUniformGroup'

/**
 * WebGPU counterpart of the shared sim-animation clock (animClock.ts owns the value; read its header).
 * One TSL uniform node for the whole scene, in the shared tick group so it uploads as a direct byte
 * write with no per-object refresh walk. Every shader-integrated animation (belt scroll, roller
 * spin) samples this node.
 *
 * Lives in its own module because animClock.ts is imported by the WebGL bundle and must stay free
 * of three/webgpu; createRenderer registers `setAnimClockNode` as animClock's sink.
 */
let clock: ReturnType<typeof uniform> | null = null

/** the shared clock node - consumers' node materials multiply their per-instance rate by this */
export function animClockNode(): ReturnType<typeof uniform> {
  if (!clock) clock = uniform(0).setGroup(tickUniformGroup())
  return clock
}

/** the sink animClock.advanceAnimClock drives (registered by createRenderer) */
export function setAnimClockNode(value: number): void {
  animClockNode().value = value
}
