// IBC tote - a 1000 litre intermediate bulk container: a tank in a steel cage on its own pallet base. Cargo with its own
// body (docs/cargo-bodies.md): the base is a block pallet's collider at 1200 x 1000 mm, so forks enter it the way they
// enter a pallet, and it declares what that makes it (`cargo` in its manifest): fork pockets (a fork's fit is checked),
// heavy (it bears a stack) and a load base (a wrap starts from it). The tank collides as a box; the cage, the filler cap
// and the valve are drawn only. There is nothing to simulate here: cargo is passive payload, so step() is empty.

definePart({
  params: {
    mass: { type: 'number', default: 65, min: 40, max: 1400, step: 5, label: 'Mass (kg)', desc: 'Physical mass. Empty is about 65 kg; full of water, about 1065 kg.' },
    color: { type: 'color', default: '#eef0ea', label: 'Tank color', desc: 'The tank inside the cage. The cage and base stay bare steel.' },
  },
  step() {
  },
})
