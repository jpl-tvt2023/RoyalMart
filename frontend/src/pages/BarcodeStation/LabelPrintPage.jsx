import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Printer } from 'lucide-react';
import StickerPages from './StickerPages';
import { loadKeyEncoder, toPrintJob } from './stationHelpers';
import { getLabelBatchKeysAdmin, printLabelBatchAdmin } from '../../api/labelBatches.api';
import { articleLabel } from '../../utils/barcodeStation';
import { useAuth } from '../../context/AuthContext';
import { useRBAC } from '../../hooks/useRBAC';

// ADMIN ONLY: the sticker sheet with an on-screen preview, for one label batch
// or a from/to slice of it -- laid out as printed pages (104): as many stickers
// per page as the roll carries, at the label page set in Purchase Config ->
// Barcode Station, in the client's mockup layout.
//
// Only Admins see keys (client's rule), so this page loads them through the
// Admin API with the portal login, and anyone else gets a message and no call.
// Everyone else prints from the station through PrintPortal, which never shows
// a sticker. It no longer prints by itself: the Admin looks, then presses
// Print, which logs the print first -- no print without a record.
//
// Opened in its own tab, never an iframe: the site's CSP forbids framing.
export default function LabelPrintPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const from = params.get('from') || undefined;
  const to = params.get('to') || undefined;

  const { loading: authLoading } = useAuth();
  const { isAdmin } = useRBAC();

  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');
  const [sheet, setSheet] = useState(null);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (authLoading || !isAdmin) return undefined;
    let cancelled = false;
    Promise.all([getLabelBatchKeysAdmin(id, { from, to }), loadKeyEncoder()])
      .then(([data, encode]) => {
        if (cancelled) return;
        setSheet(toPrintJob(data, encode));
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setMessage(err.response?.data?.message || 'Could not load the labels');
        setStatus('error');
      });
    return () => { cancelled = true; };
  }, [authLoading, isAdmin, id, from, to]);

  const doPrint = async () => {
    setPrinting(true);
    try {
      // Log first: if the record cannot be written, nothing prints.
      await printLabelBatchAdmin(id, { from, to });
      window.print();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not record the print — nothing was printed');
    } finally {
      setPrinting(false);
    }
  };

  const shell = (children) => (
    <div className="min-h-screen bg-[#fdf0d5] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 border border-[#003049]/10 max-w-md w-full text-center">{children}</div>
    </div>
  );

  if (!authLoading && !isAdmin) {
    return shell(
      <>
        <p className="text-[#003049] font-semibold mb-2">Only Admins can preview labels</p>
        <p className="text-sm text-gray-500 mb-4">On the Barcode Station, use Print on the entry — the labels print without a preview.</p>
        <Link to="/barcode-station" className="text-[#c1121f] font-medium hover:underline">Go to the Barcode Station</Link>
      </>
    );
  }
  if (status === 'loading') return shell(<p className="text-[#003049]">Preparing labels…</p>);
  if (status === 'error') {
    return shell(
      <>
        <p className="text-[#c1121f] font-semibold mb-4">{message}</p>
        <Link to="/barcode-station" className="text-[#003049] font-medium hover:underline">Back to the Barcode Station</Link>
      </>
    );
  }

  const { batch, labels, widthMm, heightMm, perPage, pageHeightMm } = sheet;
  const range = labels.length === batch.label_count
    ? `all ${labels.length} labels`
    : `labels ${labels[0]?.label_no}–${labels[labels.length - 1]?.label_no} of ${batch.label_count}`;

  return (
    <div className="label-sheet min-h-screen bg-gray-100 p-6">
      <style>{`
        @page { size: ${widthMm}mm ${pageHeightMm}mm; margin: 0; }
        @media print {
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
          .no-print { display: none !important; }
          .label-sheet { padding: 0 !important; background: #fff !important; min-height: 0 !important; }
          .sticker-list { display: block !important; }
          .sticker, .sticker-page { margin: 0 !important; box-shadow: none !important; outline: none !important; }
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
          onClick={doPrint}
          disabled={printing}
          className="inline-flex items-center gap-2 bg-[#c1121f] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#a01019] disabled:opacity-60"
        >
          <Printer size={16} /> Print {labels.length} label{labels.length !== 1 ? 's' : ''}
        </button>
        <p className="w-full text-xs text-gray-500">
          Admin preview. Sticker {widthMm} × {heightMm} mm, {perPage} per page. In the print dialog pick the label
          printer, set the paper size to {widthMm} × {pageHeightMm} mm, scale 100% (Actual size), margins None, and
          turn off headers and footers.
        </p>
      </div>

      {/* Flex on screen to centre the pages. Print switches it to a block,
          because page breaks are ignored between flex items. */}
      <div className="sticker-list flex flex-col items-center">
        <StickerPages job={sheet} framed />
      </div>
    </div>
  );
}
