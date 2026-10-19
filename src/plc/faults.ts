// Controller faults: the engine's one fault model.
//
// A fault stops the program: the scan is abandoned where it stood and the controller drops out of Run. It is thrown
// (`StFault`, an StError, so everything that already reported a positioned runtime error keeps working) and carries
// which of the faults below it is. What faults is this engine's own choice, pinned by its conformance corpus
// (docs/st-conformance.md): an array subscript outside its dimension, a loop that does not end within the scan (the
// task watchdog), and - thrown as a plain StError - integer division by zero.

import { StError } from './types'
import type { SourcePos } from './types'

export interface FaultCode {
  /** a short name for the fault, in our words */
  readonly name: string
}

export const FAULT = {
  /** a subscript past the end of its array */
  SUBSCRIPT: { name: 'array subscript out of range' },
  /** the task's watchdog ran out - what an endless loop comes to on a controller */
  WATCHDOG: { name: 'task watchdog expired' },
} as const satisfies Record<string, FaultCode>

/** A fault: the scan stops here. */
export class StFault extends StError {
  constructor(
    readonly fault: FaultCode,
    message: string,
    pos: SourcePos,
  ) {
    super(message, pos)
    this.name = 'StFault'
  }
}
