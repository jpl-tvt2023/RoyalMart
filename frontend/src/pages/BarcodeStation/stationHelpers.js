// Non-component helpers shared by the Barcode Station pages. Kept out of the
// .jsx files so those export only components (react-refresh).

export const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30';

// The five operator fields of a batch, as form state.
export const fieldsOf = (b) => ({
  outbound_vendor_id: b?.outbound_vendor_id ?? '',
  article_id: b?.article_id ?? '',
  pack_size: b?.pack_size ?? '',
  floor_id: b?.floor_id ?? '',
  label_count: b?.label_count ?? '',
});

// The sticker sheet opens in its own tab -- never an iframe, which the site's
// CSP forbids. from/to print a slice of the batch again.
export const openPrintSheet = (batchId, from, to) => {
  const qs = from || to ? `?from=${from}&to=${to}` : '';
  window.open(`/barcode-station/print/${batchId}${qs}`, '_blank', 'noopener');
};

// Code128 via jsbarcode: handed a plain object instead of an <svg> or
// <canvas>, it only fills in `encodings` and never touches the DOM. An 8-digit
// key comes out in set C (two digits per symbol): 79 modules including start,
// check digit and stop.
export function encodeKey(JsBarcode, text) {
  const target = {};
  JsBarcode(target, String(text), { format: 'CODE128' });
  return target.encodings.map((e) => e.data).join('');
}

// Loaded on demand, so jsbarcode is fetched only when a print sheet opens --
// not in the main bundle that every page imports.
export async function loadKeyEncoder() {
  const mod = await import('jsbarcode');
  const JsBarcode = mod.default || mod;
  return (text) => encodeKey(JsBarcode, text);
}

// The blank margin a scanner needs either side of the bars: 10 modules, the
// Code128 minimum.
export const QUIET_MODULES = 10;
