// A roller bed's side frame depth, shared by every roller bed (straight, curved, spur).

/** The roller beds' `frameHeight` param: the side frame channel's height (deck-side top 5 mm under the
 *  conveying plane, as on every bed). Same meaning and default as the belt's `height`, whose frame wall is that deep,
 *  so a roller bed set to a belt's Frame height meets its frame flush. A geometry()-tier bed reads its frame bottom
 *  through frameBottom(); a rig bed tracks it with sizeParams / offsetParams / leg frameDepthParam.
 *  Same range as the belt's, so every Frame height has a roller bed that matches it; on a shallow frame the legs'
 *  mounting brackets shorten to stay under the deck (legPieces' frameDepth, _shared/legs.js). */
export function frameHeightParam(group) {
  return {
    frameHeight: { type: 'number', default: 0.17, min: 0.1, max: 0.6, step: 0.01, label: 'Frame height (m)', ...(group ? { group } : {}), desc: 'Depth of the side frame channel below the rollers. Set it to the Frame height of the conveyor this bed butts against so the two frames line up at the joint. The legs shorten or lengthen to meet the frame bottom; the deck height does not move.' },
  }
}

/** The frame bottom's y (negative, below the deck) for a geometry()-tier bed.
 *  Rounded to the micrometre exactly as the belt's is, so at the default it is the literal -0.175 the pooled rail
 *  template is shared by value with (0.17 + 0.005 is 0.17500000000000002 in binary). */
export function frameBottom(p) {
  var fh = typeof p.frameHeight === 'number' && p.frameHeight > 0 ? p.frameHeight : 0.17
  return -Math.round((fh + 0.005) * 1e6) / 1e6
}
