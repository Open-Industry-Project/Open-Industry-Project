// The CAD kernel's own worker. Reading a big assembly is one blocking call of up to a minute and ~1 GB, so it
// can never run on the page; one worker per import, terminated after, frees that memory at once.
// Not the sim worker and not under SES lockdown: this is first-party code reading a file the
// person picked, and emscripten's glue predates frozen intrinsics.
import occtimportjs from 'occt-import-js'
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url'
import { convertStep, type OcctKernel, type StepImportOptions } from './stepConvert'

export interface StepWorkerRequest {
  bytes: Uint8Array
  options: StepImportOptions
}

self.onmessage = async (e: MessageEvent<StepWorkerRequest>) => {
  try {
    const occt = (await occtimportjs({ locateFile: () => wasmUrl })) as OcctKernel
    const { glb, stats } = convertStep(occt, e.data.bytes, e.data.options)
    self.postMessage({ ok: true, glb, stats }, { transfer: [glb.buffer] })
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
