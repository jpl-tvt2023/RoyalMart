import { Fragment } from 'react';
import Code128 from './Code128';
import { articleLabel, packSizeLabel } from '../../utils/barcodeStation';
import { formatDateTime } from '../../utils/formatters';

// One sticker, laid out as the client's mockup: the barcode centred on top
// with its key underneath, then Vendor Name, Article, Pack Size, Inbound Date
// and Panchal Floor. Inbound Date carries the time as well as the date (the
// moment the keys were generated, in IST).
//
// Used by the Admin's on-screen preview (`framed`, with an outline) and by the
// station's off-screen PrintPortal (plain, never seen). Each sticker is one
// printed page; the last one does not force a trailing blank page.
export default function Sticker({ batch, label, bits, widthMm, heightMm, layout, last, framed = false }) {
  const rows = [
    ['Vendor Name', batch.vendor_name],
    ['Article', articleLabel(batch)],
    ['Pack Size', packSizeLabel(batch)],
    ['Inbound Date', formatDateTime(batch.generated_at)],
    ['Panchal Floor', batch.floor_name],
  ];
  return (
    <div
      className={`sticker${framed ? ' shadow-sm outline outline-1 outline-gray-300' : ''}`}
      style={{
        width: `${widthMm}mm`,
        height: `${heightMm}mm`,
        boxSizing: 'border-box',
        padding: `${layout.padMm}mm ${layout.padMm * 1.6}mm`,
        overflow: 'hidden',
        background: '#fff',
        color: '#000',
        fontFamily: 'Arial, Helvetica, sans-serif',
        display: 'flex',
        flexDirection: 'column',
        breakAfter: last ? 'auto' : 'page',
        pageBreakAfter: last ? 'auto' : 'always',
        marginBottom: framed ? '4mm' : 0,
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
