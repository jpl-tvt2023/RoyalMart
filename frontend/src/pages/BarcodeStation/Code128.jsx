import { QUIET_MODULES } from './stationHelpers';

// A Code128 barcode drawn as plain SVG rectangles. `bits` is the module string
// encodeKey (stationHelpers.js) returns; `moduleMm` is the width of one narrow
// bar. React draws the bars -- no DOM work by the barcode library.

// Consecutive 1-modules merged into one bar each.
function bars(bits) {
  const out = [];
  let i = 0;
  while (i < bits.length) {
    if (bits[i] === '1') {
      let j = i;
      while (j < bits.length && bits[j] === '1') j++;
      out.push([i, j - i]);
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

export default function Code128({ bits, moduleMm, heightMm }) {
  const total = bits.length + QUIET_MODULES * 2;
  return (
    <svg
      width={`${total * moduleMm}mm`}
      height={`${heightMm}mm`}
      viewBox={`0 0 ${total} 100`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      role="img"
      aria-label="barcode"
    >
      <rect x="0" y="0" width={total} height="100" fill="#fff" />
      {bars(bits).map(([x, w]) => (
        <rect key={x} x={x + QUIET_MODULES} y="0" width={w} height="100" fill="#000" />
      ))}
    </svg>
  );
}
