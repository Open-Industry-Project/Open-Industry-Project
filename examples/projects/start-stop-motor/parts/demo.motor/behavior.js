// A motor that reports Running whenever the PLC commands Run - the feedback half of the start/stop
// seal-in circuit (plc/program.st). Reads the Run coil the ST program drives each scan and echoes it
// back as the observable Running tag the tests assert on. Both are declared tag params with a
// direction, which is the device's PLC interface: what the wiring checks read, and what a test's
// `faults` act on (an actuatorDead fault blocks Run, a sensorStuck fault forces Running).
definePart({
  params: {
    runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: 'Run', label: 'Run tag' },
    runningTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: 'Running', label: 'Running tag' },
  },
  step(ctx) {
    ctx.writeTag(ctx.params.runningTag, ctx.readTag(ctx.params.runTag) === true)
  },
})
