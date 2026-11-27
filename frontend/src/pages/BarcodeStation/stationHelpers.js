// Non-component helpers shared by the Barcode Station pages. Kept out of the
// .jsx files so those export only components (react-refresh).

import { labelPageHeight } from '../../utils/barcodeStation';

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

// ---- Stock counts (migration 102) ------------------------------------------

// Scan feedback by ear -- the person scanning watches the boxes, not the
// screen. Web Audio tones, no sound files. Phones only allow sound after a tap,
// so unlockAudio() runs on the Start / camera buttons.
let audioCtx = null;
function audio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}
export function unlockAudio() {
  try { audio()?.resume(); } catch { /* no sound on this device */ }
}
const TONES = {
  ok: [{ f: 1046, d: 0.09 }],                          // counted
  info: [{ f: 520, d: 0.06 }],                         // already counted
  error: [{ f: 196, d: 0.35, type: 'square' }],        // unknown key
};
export function beep(kind) {
  try {
    const ctx = audio();
    if (!ctx) return;
    let t = ctx.currentTime;
    for (const tone of TONES[kind] || TONES.ok) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = tone.type || 'sine';
      osc.frequency.value = tone.f;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + tone.d);
      t += tone.d + 0.05;
    }
  } catch { /* no sound on this device */ }
}

// ---- Camera scanning ---------------------------------------------------------

// Every iPhone browser is WebKit: no BarcodeDetector, and camera permission is
// granted per app in the iOS Settings. An iPad on iPadOS 13+ reports itself as
// a Mac, so a Mac with a touch screen counts too.
export function isIOS(nav = typeof navigator !== 'undefined' ? navigator : null) {
  if (!nav) return false;
  return /iPad|iPhone|iPod/.test(nav.userAgent || '')
    || (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1);
}

// The part of a vw x vh camera frame that an `object-cover` box of boxW x boxH
// actually shows. The reader decodes only this, so a sticker cut off the
// screen is never read. A box with no size yet gets the whole frame.
export function visibleCrop(vw, vh, boxW, boxH) {
  if (!(vw > 0 && vh > 0 && boxW > 0 && boxH > 0)) return { sx: 0, sy: 0, sw: vw, sh: vh };
  const scale = Math.max(boxW / vw, boxH / vh);
  const sw = Math.min(vw, Math.round(boxW / scale));
  const sh = Math.min(vh, Math.round(boxH / scale));
  return { sx: Math.round((vw - sw) / 2), sy: Math.round((vh - sh) / 2), sw, sh };
}

// iPhones list each back lens as its own camera. The "Triple" and "Dual Wide"
// ones are virtual devices that switch to the ultra-wide lens up close (iOS
// 17+), which focuses a few cm away; the plain "Back Camera" a Pro iPhone
// picks for facingMode cannot focus nearer than ~15 cm. Labels are only filled
// in once camera access is granted. Returns a deviceId, or null.
const PREFERRED_BACK_CAMERAS = [/back triple camera/i, /back dual wide camera/i];
export function preferredBackCamera(devices) {
  const cams = (devices || []).filter((d) => d.kind === 'videoinput' && d.label);
  for (const re of PREFERRED_BACK_CAMERAS) {
    const hit = cams.find((d) => re.test(d.label));
    if (hit) return hit.deviceId;
  }
  return null;
}

// What to tell the person when the camera will not start.
export function cameraErrorMessage(err, ios = isIOS()) {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'The camera only works on the secure https:// link of this page.';
  }
  switch (err?.name) {
    case 'ReaderLoadError':
      return 'The barcode reader could not load. Check the connection and tap the camera button again — or use a scanner gun.';
    case 'NotAllowedError':
    case 'SecurityError':
      return ios
        ? 'Camera access is blocked. On iPhone open Settings → Chrome (or Safari) → Camera, allow it, then reload this page.'
        : 'Camera access is blocked. Allow the camera for this site in your browser settings, then tap the camera button again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy in another app. Close that app, then try again.';
    default:
      return 'The camera could not be started on this browser.';
  }
}

// The printed page a print response's `label` makes (migrations 098, 104):
// one sticker's size, how many share a page, the gap between them and the
// margin above and below -- and the page's height, which the printer's paper
// must match.
export function pageOf(label) {
  const l = label || {};
  const widthMm = Number(l.width_mm) || 152;
  const heightMm = Number(l.height_mm) || 51;
  const perPage = Number(l.per_page) || 1;
  const gapMm = Number(l.gap_mm) || 0;
  const marginMm = Number(l.margin_mm) || 0;
  return { widthMm, heightMm, perPage, gapMm, marginMm, pageHeightMm: labelPageHeight(heightMm, perPage, gapMm, marginMm) };
}

// A print job from a print response: each key with its barcode modules, plus
// the label page. `encode` comes from loadKeyEncoder.
export const toPrintJob = (data, encode) => ({
  batch: data.batch,
  labels: data.keys.map((k) => ({ ...k, bits: encode(String(k.label_key)) })),
  ...pageOf(data.label),
});

// The labels in printed pages of `perPage` each, in label order.
export function pagesOf(labels, perPage) {
  const n = Math.max(1, Number(perPage) || 1);
  const pages = [];
  for (let i = 0; i < labels.length; i += n) pages.push(labels.slice(i, i + n));
  return pages;
}
