// Tote — an open-top plastic container. Demonstrates the cargo geometry kind: the package geometry declares
// { kind: 'cargo', cargoKind: 'tote' } and the host builds the part as one dynamic physics body at the standard size
// its `size` picks (core/tote.ts), rendered through the instanced cargo batch. Its collider is open at the top, so
// cargo put in it rides along, and a tote stacked on another sits with its foot inside the rim below.
// Passive payload: step() is empty.

definePart({
  params: {
    size: {
      type: 'enum', default: '600x400x320', label: 'Size',
      desc: 'Outer length x width x height. The 600 x 400 footprint and its halves are the modular sizes used across distribution. A stack of totes rises by the height less the 15 mm foot per level.',
      options: [
        { value: '600x400x320', label: '600 x 400 x 320 mm' },
        { value: '600x400x420', label: '600 x 400 x 420 mm' },
        { value: '600x400x220', label: '600 x 400 x 220 mm' },
        { value: '600x400x120', label: '600 x 400 x 120 mm' },
        { value: '400x300x320', label: '400 x 300 x 320 mm' },
        { value: '400x300x220', label: '400 x 300 x 220 mm' },
        { value: '400x300x120', label: '400 x 300 x 120 mm' },
        { value: '300x200x120', label: '300 x 200 x 120 mm' },
      ],
    },
    mass: { type: 'number', default: 2, min: 0.5, max: 50, step: 0.5, label: 'Mass (kg)', desc: 'Physical mass of the tote and whatever it is taken to hold. An empty 600 x 400 tote is about 2 kg.' },
    color: { type: 'color', default: '#2f6db3', label: 'Color', desc: 'The colour of the plastic.' },
  },
  step() {
  },
})
