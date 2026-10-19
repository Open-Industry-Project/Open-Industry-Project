// Outlines the sensor housings draw their windows, panels and holes from: closed point lists in a 2-D plane,
// for g.extrude's profile and its `holes`.

// a rounded-corner rectangle, for windows and panels
export function rrect(x0, y0, x1, y1, r) {
  const pts = []
  for (const [cx, cy, a0] of [[x1 - r, y0 + r, -Math.PI / 2], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, Math.PI / 2], [x0 + r, y0 + r, Math.PI]])
    for (let k = 0; k <= 3; k++) { const a = a0 + (k * Math.PI) / 6; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]) }
  return pts
}

// a 16-sided circle, for mounting holes
export function circle(cy, cz, r) {
  const pts = []
  for (let k = 0; k < 16; k++) { const a = (k * Math.PI) / 8; pts.push([cy + r * Math.cos(a), cz + r * Math.sin(a)]) }
  return pts
}
