import { useEffect, useRef, useState } from 'react';
import { X, CameraOff } from 'lucide-react';
import { keyError } from '../../utils/barcodeStation';
import { cameraErrorMessage } from './stationHelpers';

// Scanning with a phone's camera (stock counts, migration 102). A scanner gun
// -- USB on a PC or Bluetooth on a phone -- needs none of this: it types into
// the scan box like a keyboard.
//
// The rear camera feeds a decoder that looks for Code128 only:
//   Android Chrome: the browser's own BarcodeDetector -- fast, no download.
//   iPhone Safari (no BarcodeDetector): @zxing/browser, imported only when the
//     camera opens, so it never weighs on the rest of the app.
// Every read is checked with keyError, and the same key is ignored for 2 s, so
// a sticker held in view is sent once, not thirty times. Reads go to onKey --
// the same queue and result card the gun uses.
//
// The site's Permissions-Policy allows the camera on /barcode-station only
// (frontend/vercel.json), and browsers allow it only on https.

const REPEAT_MS = 2000;
const TICK_MS = 120;

export default function CameraScanner({ onKey, onClose }) {
  const videoRef = useRef(null);
  const onKeyRef = useRef(onKey);
  const onCloseRef = useRef(onClose);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onKeyRef.current = onKey;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    let stopped = false;
    let stream = null;
    let timer = null;
    let controls = null;
    const recent = new Map();

    const emit = (text) => {
      const key = String(text || '').trim();
      if (keyError(key)) return;
      const now = Date.now();
      if (now - (recent.get(key) || 0) < REPEAT_MS) return;
      recent.set(key, now);
      onKeyRef.current(key);
    };

    (async () => {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw Object.assign(new Error('no camera'), { name: window.isSecureContext ? 'NotFoundError' : 'SecurityError' });
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play().catch(() => {});

        let native = false;
        if ('BarcodeDetector' in window) {
          try { native = (await window.BarcodeDetector.getSupportedFormats()).includes('code_128'); } catch { native = false; }
        }
        if (stopped) return;
        setReady(true);

        if (native) {
          const detector = new window.BarcodeDetector({ formats: ['code_128'] });
          const tick = async () => {
            if (stopped) return;
            try {
              if (video.readyState >= 2) (await detector.detect(video)).forEach((c) => emit(c.rawValue));
            } catch { /* a frame that failed to decode */ }
            if (!stopped) timer = setTimeout(tick, TICK_MS);
          };
          tick();
        } else {
          const [{ BrowserMultiFormatOneDReader, BarcodeFormat }, { DecodeHintType }] = await Promise.all([
            import('@zxing/browser'),
            import('@zxing/library'),
          ]);
          if (stopped) return;
          const hints = new Map([
            [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]],
            [DecodeHintType.TRY_HARDER, true],
          ]);
          const reader = new BrowserMultiFormatOneDReader(hints, { delayBetweenScanAttempts: TICK_MS, delayBetweenScanSuccess: 300 });
          controls = await reader.decodeFromVideoElement(video, (result) => { if (result) emit(result.getText()); });
          if (stopped) controls.stop();
        }
      } catch (err) {
        if (!stopped) setError(cameraErrorMessage(err));
      }
    })();

    // A hidden tab keeps the camera light on for nothing: close instead.
    const onVisibility = () => { if (document.hidden) onCloseRef.current(); };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(timer);
      try { controls?.stop(); } catch { /* already stopped */ }
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="relative rounded-xl overflow-hidden bg-black">
      <video ref={videoRef} playsInline muted className="block w-full h-64 sm:h-80 object-cover" />
      {ready && !error && (
        <>
          <div className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 h-24 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]" />
          <p className="pointer-events-none absolute bottom-2 inset-x-0 text-center text-xs text-white/90">
            Hold one barcode inside the box
          </p>
        </>
      )}
      {!ready && !error && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-white/80">Starting the camera…</p>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/85 p-4 text-center text-sm text-white">
          <CameraOff size={22} />
          <p>{error}</p>
        </div>
      )}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-2 right-2 flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
        title="Close the camera"
        aria-label="Close the camera"
      >
        <X size={20} />
      </button>
    </div>
  );
}
