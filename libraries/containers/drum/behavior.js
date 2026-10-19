// Drum - a steel drum, cargo with its own body (docs/cargo-bodies.md). The manifest's `cargo` makes the rig one dynamic
// body: its shell is a cylinder link, and cargo keeps a cylinder round, so a drum stands on its end and rolls on its
// side (place it lying down by rotating it a quarter turn about X or Z). The hoops, the rolled chimes at each end, the
// lid and its two bung caps are drawn but do not collide (`collision: none`), so the body is the shell alone. There is nothing to simulate here: cargo is passive
// payload, so step() is empty.

definePart({
  params: {
    // the shell's size drives both the visual and the body. The hoops sit at the thirds and the rim on top, both
    // following the height.
    diameter: { type: 'number', default: 0.58, min: 0.2, max: 1.2, step: 0.01, label: 'Diameter (m)', desc: 'Across the shell. 0.58 m is a 200 litre drum.' },
    height: { type: 'number', default: 0.88, min: 0.2, max: 1.5, step: 0.01, label: 'Height (m)', desc: 'End to end. 0.88 m is a 200 litre drum.' },
    mass: { type: 'number', default: 20, min: 1, max: 400, step: 1, label: 'Mass (kg)', desc: 'Physical mass. An empty 200 litre steel drum is about 20 kg, a full one about 200 kg.' },
    color: { type: 'color', default: '#2a5d8f', label: 'Color', desc: 'The paint on the shell, hoops and lid. The chimes and bung caps stay bare steel.' },
  },
  step() {
  },
})
