// Compiles the open program off the main thread, for the readers that only ask what it declares
// (programSurfaceClient.ts). Compiling costs about 30 ms per thousand lines, on the page a stall once a program is
// a few thousand lines long. Working out the controller table it compiles under reads the whole text too, so that is
// done here as well: the page hands over the program as the store holds it.
//
// On the walker engine: this worker runs no SES lockdown, and the walker builds a program without generating code,
// so no text from the program is ever evaluated here. Both engines declare the same surface (they share the program
// builders, plc/pou.ts).
import { compile, setScanEngine } from '../../plc/interpreter'
import { surfaceOf, type ProgramSurface } from '../../plc/programSurface'
import { compiledText, type SurfaceReply, type SurfaceRequest } from './programSurfaceAsk'

setScanEngine('walker')

self.onmessage = (e: MessageEvent<SurfaceRequest>) => {
  let surface: ProgramSurface | null = null
  try {
    surface = surfaceOf(compile(compiledText(e.data)))
  } catch {
    // the Problems panel says why a program does not compile
  }
  self.postMessage({ id: e.data.id, surface } satisfies SurfaceReply)
}
