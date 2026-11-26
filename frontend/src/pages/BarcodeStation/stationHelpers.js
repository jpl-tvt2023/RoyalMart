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

// ADMIN ONLY: the sticker sheet with an on-screen preview, in its own tab --
// never an iframe, which the site's CSP forbids. from/to preview a slice of the
// batch. Everyone else prints through PrintPortal, which never shows a sticker.
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

// Thermal printers print in dots -- 8 per mm at 203 dpi -- and a bar a whole
// number of dots wide prints crisp. Narrow bars of 0.25 to 0.5 mm read
// reliably on any handheld scanner, and the barcode stays inside the ~60% of
// the sticker width the client's mockup gives it.
const DOT_MM = 0.125;
const MODULE_MIN_MM = 0.25;
const MODULE_MAX_MM = 0.5;

// Bar, type and padding sizes for one sticker of widthMm x heightMm whose
// barcode is `modules` wide. Everything scales with the sticker height.
export function layoutFor(widthMm, heightMm, modules) {
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

// A print job from a print response: each key with its barcode modules, plus
// the sticker size. `encode` comes from loadKeyEncoder.
export const toPrintJob = (data, encode) => ({
  batch: data.batch,
  labels: data.keys.map((k) => ({ ...k, bits: encode(String(k.label_key)) })),
  widthMm: data.label.width_mm,
  heightMm: data.label.height_mm,
});
