export const LAYER_NON_MOVING = 0
export const LAYER_MOVING = 1
/** a cargo body that takes pieces into slots: an assembly base or fixture, and the load built on it (assemblyBodies.ts) */
export const LAYER_ASSEMBLY = 2
/** a piece of an assembly while something holds it: it collides with everything but LAYER_ASSEMBLY */
export const LAYER_HELD_PIECE = 3
export const NUM_OBJECT_LAYERS = 4
export const NUM_BROAD_PHASE_LAYERS = 2
