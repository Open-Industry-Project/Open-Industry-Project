// Barcode Scanner - the receiving scan point over a conveyor: an arch whose head reads the label on every case that
// passes under it. Its local Z is the direction of travel, the arch's two columns stand at +-X either side of the bed,
// and the part origin is the centre of the arch, on the floor.
//
// A case is READ once, however long it stays under the arch: the scanner MARKS each case it reads (`scanned`), and a
// case already marked is never counted again. So a case stopped under the arch by a held line, or one backed up into
// it, still counts one, and anything downstream can ask whether a case has been scanned (ctx.marked, or a beam hit's
// `marks`) without being wired to this part. The read zone counts CARGO only, so a person walking through never reads.
//
// Today every read is a good read. What a real scan point adds on top - a no-read the program diverts to a reject
// spur, a count checked against the shipment's expected count, a case's SKU routing it - builds on these same tags.
//
// Demonstrates a sensing zone used to identify rather than to trip, product state (`mark` / `marked`) as a
// read-once memory, and a one-shot pulse to the PLC. Its only indicators are the ones a real scan arch has: the red
// scan window and a good-read beacon. The count goes to the PLC, where a real line keeps it (an HMI, not the arch).

const PULSE = 0.25 // s the good-read tag stays true after a read: several scans of any program, however slow its task

let count = 0
let pulse = 0 // s left on the good-read pulse (and the green lamp)

definePart({
  lamps: ['read', 'scan'],
  params: {
    width: { type: 'number', default: 1.0, min: 0.4, max: 3, step: 0.01, label: 'Clear width (m)', desc: 'The gap between the two columns, across the direction of travel. Wider than the conveyor, so the columns stand clear of its legs.' },
    surfaceHeight: { type: 'number', default: 0.8, min: 0.2, max: 2, step: 0.01, label: 'Conveyor height (m)', desc: 'Height of the conveying surface under the arch: the bottom of the read zone.' },
    clearance: { type: 'number', default: 0.6, min: 0.2, max: 2, step: 0.01, label: 'Clearance (m)', desc: 'From the conveying surface up to the scanner head. The tallest load must pass under it; the read zone fills that height.' },
    readDepth: { type: 'number', default: 0.5, min: 0.1, max: 2, step: 0.05, label: 'Read depth (m)', desc: 'How far along the direction of travel (local Z) the read zone reaches, centred under the head. A case is read when its CENTRE enters it.' },
    beamColor: { type: 'color', default: '#f2bd0f', label: 'Beam color', desc: 'Paint of the crossbeam the head hangs from.' },
    enableComms: { type: 'boolean', default: false, label: 'Enable comms', group: 'Comms', desc: 'Connect this part to a PLC program. Its tags appear once this is on.' },
    readTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Good read tag (pulse)', group: 'Comms', desc: 'Goes true for a quarter of a second each time a case is read. Take its rising edge to count or to act on a read.' },
    countTag: { type: 'tag', dir: 'out', stType: 'DINT', default: '', label: 'Read count tag', group: 'Comms', desc: 'Running total of cases read this run. It only ever climbs.' },
  },
  geometry(g, p) {
    const width = typeof p.width === 'number' && p.width > 0 ? p.width : 1.0
    const s = typeof p.surfaceHeight === 'number' ? p.surfaceHeight : 0.8
    const c = typeof p.clearance === 'number' && p.clearance > 0 ? p.clearance : 0.6
    // two PW x PD aluminium profiles on anchored floor plates, a crossbeam resting ON them, and the scanner head hung
    // on a bracket under the beam's centre with its window at the clearance height. The columns stop at the beam's
    // underside: run up into it, they share its end, front, back and top faces and those z-fight. Everything dark (slots, end caps, brackets, bolts, the head) is ONE submesh
    // with no collider, so the detail costs neither a draw nor a change to what the arch collides as.
    const PW = 0.05, PD = 0.1, FOOT_X = 0.14, FOOT_Z = 0.22, FOOT_T = 0.012, B = 0.003
    const HEAD_H = 0.12, BEAM_H = 0.08, HEAD_X = 0.24, HEAD_Z = 0.09
    const hw = width / 2
    const beamBottom = s + c + HEAD_H
    const top = beamBottom + BEAM_H
    const win = s + c // the window's underside
    const bb = (size, center, square) => g.bevelBox(size, center, B, square)
    // a hex head standing on a face: `face` its coordinate along the axis, sg the side it stands out to
    const hex = (axis, center, face, sg, af, h) => {
      const a = sg > 0 ? face : face - h, b = sg > 0 ? face + h : face, r = af / Math.sqrt(3)
      return g.lathe([[0, a], [r, a], [r, b], [0, b]], { axis, center, segments: 6, smooth: false })
    }
    const dark = []
    const parts = []
    for (const side of [-1, 1]) {
      const cx = side * (hw + PW / 2)
      parts.push({
        desc: g.merge(
          bb([PW, beamBottom - FOOT_T, PD], [cx, (FOOT_T + beamBottom) / 2, 0], ['y-', 'y+']),
          bb([FOOT_X, FOOT_T, FOOT_Z], [cx, FOOT_T / 2, 0], ['y-']),
        ),
        material: 'housing', collision: 'box',
      })
      // the profile's T-slots, one down each face
      const h0 = FOOT_T + 0.02, h1 = beamBottom - 0.01
      for (const f of [-1, 1]) {
        dark.push(g.box([0.0016, h1 - h0, 0.008], [cx + f * (PW / 2 + 0.0006), (h0 + h1) / 2, 0]))
        dark.push(g.box([0.008, h1 - h0, 0.0016], [cx, (h0 + h1) / 2, f * (PD / 2 + 0.0006)]))
        // two anchors through the foot plate, fore and aft of the profile
        dark.push(g.box([0.03, 0.003, 0.03], [cx, FOOT_T + 0.0015, f * 0.08]))
        dark.push(hex('y', [cx, 0, f * 0.08], FOOT_T + 0.003, 1, 0.02, 0.011))
        dark.push(hex('y', [cx, 0, f * 0.08], FOOT_T + 0.014, 1, 0.011, 0.008))
        // a corner bracket on each face where the column meets the beam, bolted into both
        const ix = side * hw, zf = f * PD / 2
        dark.push(g.extrude([[ix, beamBottom], [ix - side * 0.08, beamBottom], [ix, beamBottom - 0.08]], zf, zf + f * 0.004, { axis: 'z' }))
        dark.push(hex('z', [ix - side * 0.052, beamBottom - 0.014, 0], zf + f * 0.004, f, 0.014, 0.006))
        dark.push(hex('z', [ix - side * 0.014, beamBottom - 0.052, 0], zf + f * 0.004, f, 0.014, 0.006))
      }
      // the beam's end cap
      dark.push(bb([0.008, BEAM_H - 0.006, PD - 0.006], [side * (hw + PW + 0.004), beamBottom + BEAM_H / 2, 0], [side > 0 ? 'x-' : 'x+']))
    }
    parts.push({ desc: bb([width + 2 * PW, BEAM_H, PD], [0, beamBottom + BEAM_H / 2, 0]), material: 'cap', colorParam: 'beamColor', collision: 'box' })
    // the head: a finned housing on a bracket bolted up into the beam, a bezel round its window, and its cable
    // leaving through a gland on top and running up into the beam
    const bodyTop = beamBottom - 0.028
    dark.push(bb([HEAD_X - 0.02, bodyTop - win - 0.012, HEAD_Z], [0, (win + 0.012 + bodyTop) / 2, 0]))
    dark.push(bb([HEAD_X, 0.012, HEAD_Z + 0.006], [0, win + 0.016, 0]))
    for (const f of [-1, 1]) {
      for (let k = 0; k < 3; k++) dark.push(g.box([0.012, bodyTop - win - 0.04, 0.004], [f * (HEAD_X / 2 - 0.004), (win + 0.03 + bodyTop) / 2, -0.03 + k * 0.03]))
      dark.push(hex('y', [f * 0.03, 0, f * 0.045], beamBottom, -1, 0.014, 0.006))
    }
    dark.push(bb([0.1, 0.028, 0.07], [0, bodyTop + 0.014, 0], ['y+']))
    dark.push(g.lathe([[0, bodyTop], [0.011, bodyTop], [0.011, bodyTop + 0.012], [0.007, bodyTop + 0.012], [0, bodyTop + 0.012]], { axis: 'y', center: [0.075, 0, 0], segments: 6, smooth: false }))
    dark.push(g.lathe([[0, bodyTop + 0.012], [0.005, bodyTop + 0.012], [0.005, beamBottom], [0, beamBottom]], { axis: 'y', center: [0.075, 0, 0], segments: 10 }))
    // the beacon's collar on top of the beam
    dark.push(g.lathe([[0, top], [0.037, top], [0.037, top + 0.008], [0, top + 0.008]], { axis: 'y', center: [0, 0, 0], segments: 20 }))
    parts.push({ desc: g.merge(...dark), material: 'head' })
    // the head's window, lit red while a case is under it: the scan line
    parts.push({ desc: g.box([HEAD_X - 0.04, 0.01, HEAD_Z - 0.03], [0, win + 0.005, 0]), material: 'lens', lamps: [{ name: 'scan', emissive: [1, 0.05, 0.03] }] })
    // the good-read beacon on top of the beam, over the head
    parts.push({ desc: g.lathe([[0, 0], [0.03, 0], [0.03, 0.03], [0.02, 0.05], [0, 0.056]], { axis: 'y', center: [0, top, 0], segments: 16 }), material: 'lens', lamps: [{ name: 'read', emissive: [0.1, 1, 0.2] }] })
    return parts
  },
  step(ctx) {
    const inZone = ctx.zone('read')
    // marks land after the tick, so a case read this tick shows as marked from the next one: never counted twice
    const unread = inZone - ctx.marked('read', 'scanned')
    if (unread > 0) {
      count += unread
      pulse = PULSE
      ctx.mark('read', 'scanned', true)
    } else if (pulse > 0) {
      pulse = Math.max(0, pulse - ctx.dt)
    }
    const good = pulse > 0
    ctx.lamps.scan = inZone > 0
    ctx.lamps.read = good
    if (ctx.params.enableComms) {
      if (ctx.params.readTag) ctx.writeTag(ctx.params.readTag, good)
      if (ctx.params.countTag) ctx.writeNumber(ctx.params.countTag, count)
    }
  },
})
