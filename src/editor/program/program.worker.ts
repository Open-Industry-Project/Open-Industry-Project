// Checks and compiles the open program off the main thread, for the readers that only ask about it
// (programWorkerClient.ts): what it declares, and what is wrong with it. Checking costs about 19 ms per thousand
// lines and compiling about 30, on the page a stall once a program is a few thousand lines long. Working out the
// controller table it runs under reads the whole text too, so that is done here as well: the page hands over the
// program as the store holds it.
//
// On the walker engine: this worker runs no SES lockdown, and the walker builds a program without generating code,
// so no text from the program is ever evaluated here. Both engines declare the same surface (they share the program
// builders, plc/pou.ts).
import { setScanEngine } from '../../plc/interpreter'
import { checkOfAsk, surfaceOfAsk, type ProgramReply, type ProgramRequest } from './programWorkerAsk'

setScanEngine('walker')

self.onmessage = (e: MessageEvent<ProgramRequest & { id: number }>) => {
  const ask = e.data
  let reply: ProgramReply
  try {
    reply = ask.kind === 'surface' ? { id: ask.id, kind: 'surface', answer: surfaceOfAsk(ask) } : { id: ask.id, kind: 'check', answer: checkOfAsk(ask) }
  } catch {
    // the page works the answer out itself, and reports what went wrong as it always did
    reply = { id: ask.id, kind: 'failed' }
  }
  self.postMessage(reply)
}
