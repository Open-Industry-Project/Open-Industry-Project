/// <reference lib="webworker" />

// The controller's own worker (plcThread.ts): it holds the programs and scans them when the sim worker asks.
//
// First: a program's text becomes generated code here, as it does in the sim worker, so this realm locks down before
// anything else runs (core/lockdownBoot.ts).
import '../core/lockdownBoot'
import { StError } from '../plc'
import { PlcGroup } from './plcGroup'
import type { PlcThreadInit, PlcThreadStarted } from './plcThread'
import { PlcThreadServer, statsOf } from './plcThreadServer'
import { Ask, Ctl } from './plcThreadWire'

function post(msg: PlcThreadStarted): void {
  self.postMessage(msg)
}

self.onmessage = (e: MessageEvent<PlcThreadInit>) => {
  const { runs, memory } = e.data
  let group: PlcGroup
  try {
    group = new PlcGroup(runs)
  } catch (err) {
    return post({ type: 'failed', fault: err instanceof StError ? { message: err.message, line: err.pos.line, col: err.pos.col, offset: err.pos.offset } : { message: String(err instanceof Error ? err.message : err) } })
  }
  const plan = group.watchPlan()
  if (!plan) return post({ type: 'unsupported' })
  // the sim worker takes the watch table from a copy of the program's memory, left here when it asks for one
  const copy = new SharedArrayBuffer(plan.memory.byteLength)
  post({ type: 'ready', memory: copy, layout: plan.layout, stats: statsOf(group) })
  const server = new PlcThreadServer(group, memory, { from: plan.memory, to: copy })
  const ctl = new Int32Array(memory.ctl)
  // From here on this worker takes no message: it sleeps on the ask word, answers, and sleeps again. The sim worker
  // ends it by terminating it.
  for (;;) {
    Atomics.wait(ctl, Ctl.Ask, Ask.None)
    if (Atomics.load(ctl, Ctl.Ask) === Ask.Stop) break
    server.serve()
    Atomics.store(ctl, Ctl.Ask, Ask.None)
    Atomics.store(ctl, Ctl.Done, 1)
    Atomics.notify(ctl, Ctl.Done)
  }
}

export {}
