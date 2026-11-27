import { Fragment } from 'react';
import Code128 from './Code128';
import { articleLabel, packSizeLabel } from '../../utils/barcodeStation';
import { formatDateTime } from '../../utils/formatters';

// One sticker, laid out as the client's mockup: the barcode centred on top
// with its key underneath, then Vendor Name, Stitching/Packing (only when the
// entry names a party, 105), Article, Pack Size and Inbound Date. Inbound Date
// carries the time as well as the date (the moment the keys were generated,
// in IST).
//
// No floor (client, 2026-11-27): an entry has none (106) -- a pack gets its
// location from its first scan, and packs move between floors.
//
// Used by StickerPages -- the Admin's on-screen preview (`framed`, with an
// outline) and the station's off-screen PrintPortal (plain, never seen). The
// printed page, which may hold several stickers, owns the page breaks.
export default function Sticker({ batch, label, bits, widthMm, heightMm, layout, framed = false }) {
  const rows = [
    ['Vendor Name', batch.vendor_name],
    ...(batch.stitching_party_name ? [['Stitching/Packing', batch.stitching_party_name]] : []),
    ['Article', articleLabel(batch)],
    ['Pack Size', packSizeLabel(batch)],
    ['Inbound Date', formatDateTime(batch.generated_at)],
  ];
  return (
    <div
      className={`sticker${framed ? ' outline outline-1 outline-gray-300' : ''}`}
      style={{
        width: `${widthMm}mm`,
        height: `${heightMm}mm`,
        flex: 'none',
        boxSizing: 'border-box',
        padding: `${layout.padMm}mm ${layout.padMm * 1.6}mm`,
        overflow: 'hidden',
        background: '#fff',
        color: '#000',
        fontFamily: 'Arial, Helvetica, sans-serif',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Code128 bits={bits} moduleMm={layout.moduleMm} heightMm={layout.barHeightMm} />
        <div
          style={{
            fontFamily: 'Consolas, "Courier New", monospace',
            fontSize: `${layout.keyFontMm}mm`,
            fontWeight: 700,
            letterSpacing: '0.18em',
            lineHeight: 1.1,
            marginTop: '0.6mm',
          }}
        >
          {label.label_key}
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          columnGap: '1.2mm',
          fontSize: `${layout.lineFontMm}mm`,
          lineHeight: 1.15,
          marginTop: `${layout.padMm * 0.6}mm`,
          paddingLeft: `${widthMm * 0.06}mm`,
          minWidth: 0,
        }}
      >
        {rows.map(([caption, value]) => (
          <Fragment key={caption}>
            <span>{caption} -</span>
            <span
              style={{
                fontWeight: 600,
                minWidth: 0,
                overflow: 'hidden',
                ...(caption === 'Article'
                  ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }
                  : { whiteSpace: 'nowrap', textOverflow: 'ellipsis' }),
              }}
            >
              {value}
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
