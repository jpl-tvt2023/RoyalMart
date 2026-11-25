import { Fragment, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import Code128 from './Code128';
import { loadKeyEncoder, QUIET_MODULES } from './stationHelpers';
import {
  getLabelBatchKeys, getStationOptions, getStationToken, onStationSignedOut,
} from '../../api/station.api';
import { articleLabel, packSizeLabel } from '../../utils/barcodeStation';
import { formatDate } from '../../utils/formatters';

// The sticker sheet for one label batch (or a from/to slice of it, for a
// reprint): one sticker per printed page, at the size set in Purchase Config ->
// Barcode Station, laid out as the client's mockup -- the barcode centred on
// top with its key underneath, then Vendor Name, Article, Pack Size, Inbound
// Date and Panchal Floor.
//
// Opened in its own tab, never an iframe: the site's CSP forbids framing.

// Thermal printers print in dots -- 8 per mm at 203 dpi -- and a bar a whole
// number of dots wide prints crisp. Narrow bars of 0.25 to 0.5 mm read
// reliably on any handheld scanner, and the barcode stays inside the ~60% of
// the sticker width the mockup gives it.
const DOT_MM = 0.125;
const MODULE_MIN_MM = 0.25;
const MODULE_MAX_MM = 0.5;

function layoutFor(widthMm, heightMm, modules) {
  const total = modules + QUIET_MODULES * 2;
  const fit = Math.floor(((widthMm * 0.6) / total) / DOT_MM) * DOT_MM;
  return {
    moduleMm: Math.max(MODULE_MIN_MM, Math.min(MODULE_MAX_MM, fit)),
    barHeightMm: heightMm * 0.28,
    keyFontMm: Math.max(2.2, heightMm * 0.072),
    lineFontMm: Math.max(2, heightMm * 0.066),
    padMm: Math.max(1.5, heightMm * 0.05),
  };
}

function Sticker({ batch, label, bits, widthMm, heightMm, layout, last }) {
  const rows = [
    ['Vendor Name', batch.vendor_name],
    ['Article', articleLabel(batch)],
    ['Pack Size', packSizeLabel(batch)],
    ['Inbound Date', formatDate(batch.generated_at)],
    ['Panchal Floor', batch.floor_name],
  ];
  return (
    <div
      className="sticker shadow-sm outline outline-1 outline-gray-300"
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
        marginBottom: '4mm',
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

export default function LabelPrintPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const from = params.get('from') || undefined;
  const to = params.get('to') || undefined;

  const [status, setStatus] = useState(() => (getStationToken() ? 'loading' : 'signedOut'));
  const [message, setMessage] = useState('');
  const [sheet, setSheet] = useState(null);

  useEffect(() => {
    if (!getStationToken()) return undefined;
    const off = onStationSignedOut(() => setStatus('signedOut'));
    let cancelled = false;
    Promise.all([getLabelBatchKeys(id, { from, to }), getStationOptions(), loadKeyEncoder()])
      .then(([data, options, encode]) => {
        if (cancelled) return;
        setSheet({
          batch: data.batch,
          labels: data.keys.map((k) => ({ ...k, bits: encode(String(k.label_key)) })),
          widthMm: options.label.width_mm,
          heightMm: options.label.height_mm,
        });
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled || err.response?.status === 401) return;
        setMessage(err.response?.data?.message || 'Could not load the labels');
        setStatus('error');
      });
    return () => { cancelled = true; off(); };
  }, [id, from, to]);

  // Open the print dialog once the stickers are on screen. A cleared timeout,
  // not a "printed" flag, so StrictMode's double effect still prints once.
  useEffect(() => {
    if (status !== 'ready') return undefined;
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [status]);

  if (status !== 'ready') {
    return (
      <div className="min-h-screen bg-[#fdf0d5] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 border border-[#003049]/10 max-w-md w-full text-center">
          {status === 'loading' && <p className="text-[#003049]">Preparing labels…</p>}
          {status === 'signedOut' && (
            <>
              <p className="text-[#003049] font-semibold mb-2">This device is not signed in to the Barcode Station</p>
              <p className="text-sm text-gray-500 mb-4">Open the station, enter the PIN, then print again.</p>
              <Link to="/barcode-station" className="text-[#c1121f] font-medium hover:underline">Go to the Barcode Station</Link>
            </>
          )}
          {status === 'error' && (
            <>
              <p className="text-[#c1121f] font-semibold mb-4">{message}</p>
              <Link to="/barcode-station" className="text-[#003049] font-medium hover:underline">Back to the Barcode Station</Link>
            </>
          )}
        </div>
      </div>
    );
  }

  const { batch, labels, widthMm, heightMm } = sheet;
  const layout = layoutFor(widthMm, heightMm, labels[0]?.bits.length || 79);
  const range = labels.length === batch.label_count
    ? `all ${labels.length} labels`
    : `labels ${labels[0]?.label_no}–${labels[labels.length - 1]?.label_no} of ${batch.label_count}`;

  return (
    <div className="label-sheet min-h-screen bg-gray-100 p-6">
      <style>{`
        @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
        @media print {
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
          .no-print { display: none !important; }
          .label-sheet { padding: 0 !important; background: #fff !important; min-height: 0 !important; }
          .sticker-list { display: block !important; }
          .sticker { margin: 0 !important; box-shadow: none !important; outline: none !important; }
        }
      `}</style>

      <div className="no-print max-w-3xl mx-auto mb-6 bg-white rounded-xl border border-gray-200 p-4 flex flex-wrap items-center gap-4">
        <Link to="/barcode-station" className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-[#003049]">
          <ArrowLeft size={16} /> Station
        </Link>
        <div className="flex-1 min-w-[220px]">
          <p className="font-semibold text-[#003049]">Batch #{batch.id} · {range}</p>
          <p className="text-xs text-gray-500">
            {batch.vendor_name} · {articleLabel(batch)} · {batch.floor_name}
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 bg-[#c1121f] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#a01019]"
        >
          <Printer size={16} /> Print {labels.length} label{labels.length !== 1 ? 's' : ''}
        </button>
        <p className="w-full text-xs text-gray-500">
          Sticker {widthMm} × {heightMm} mm. In the print dialog pick the label printer, set the paper size to the
          sticker, scale 100% (Actual size), margins None, and turn off headers and footers.
        </p>
      </div>

      {/* Flex on screen to centre the stickers. Print switches it to a block,
          because page breaks are ignored between flex items. */}
      <div className="sticker-list flex flex-col items-center">
        {labels.map((l, i) => (
          <Sticker
            key={l.label_key}
            batch={batch}
            label={l}
            bits={l.bits}
            widthMm={widthMm}
            heightMm={heightMm}
            layout={layout}
            last={i === labels.length - 1}
          />
        ))}
      </div>
    </div>
  );
}
