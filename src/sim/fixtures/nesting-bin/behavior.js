// Small load carrier - a 600 x 400 x 280 mm stacking bin, the kind automotive and electronics lines move parts in. Cargo
// with its own body (docs/cargo-bodies.md): an open box on a narrower foot, the tote's stacking collider at this size,
// so cargo goes in it and a bin set on another sits with its foot inside the rim below. Its manifest's `cargo` says so:
// `nestDepth` (placement seats it the foot's height lower) and `separateContacts` (the floor over the foot does not sink
// into what it stands on). There is nothing to simulate here: cargo is passive payload, so step() is empty.

definePart({
  params: {
    mass: { type: 'number', default: 1.8, min: 0.5, max: 40, step: 0.1, label: 'Mass (kg)', desc: 'Physical mass. An empty bin is about 1.8 kg.' },
    color: { type: 'color', default: '#3c6e9f', label: 'Color', desc: 'The plastic.' },
  },
  step() {
  },
})
