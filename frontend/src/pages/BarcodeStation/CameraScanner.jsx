import { useEffect, useRef, useState } from 'react';
import { X, CameraOff } from 'lucide-react';
import { keyError } from '../../utils/barcodeStation';
import { cameraErrorMessage, preferredBackCamera, visibleCrop } from './stationHelpers';

// Scanning with a phone's camera (stock counts, migration 102). A scanner gun
// -- USB on a PC or Bluetooth on a phone -- needs none of this: it types into
// the scan box like a keyboard.
//
// The reader is chosen BEFORE the camera opens, because each wants its own
// camera settings:
//   Built-in -- the browser's own BarcodeDetector (Android Chrome): fast, no
//     download, decodes the video element directly at 1280x720.
//   WASM -- zxing-wasm (wasmReader.js, imported only here and only when
//     needed) wherever there is no BarcodeDetector with Code128: every iPhone
//     browser, since Chrome and Edge on iOS are WebKit too. Our stickers'
//     narrow bar is 0.25 mm, so the camera asks for 1920x1080 and, on a Pro
//     iPhone, moves to the "Back Triple/Dual Wide Camera", which switches to the
//     ultra-wide lens up close; the plain back lens cannot focus nearer than
//     ~15 cm. Each tick decodes only the part of the frame on screen
//     (visibleCrop), so a sticker cut off the screen is never read.
// Both readers share one tick loop that never stops on a bad frame: it waits
// for a real frame (videoWidth > 0) and catches per-frame errors. (The old
// pure-JS @zxing/browser fallback could stop for good with no error shown.)
//
// Every read is checked with keyError, and the same key is ignored for 2 s, so
// a sticker held in view is sent once, not thirty times. Reads go to onKey --
// the same queue and result card the gun uses. The top-left line names the
// reader, the resolution and the lens, for when someone reports a problem.
//
// The site's Permissions-Policy allows the camera on /barcode-station only, and
// its CSP allows WebAssembly ('wasm-unsafe-eval') there only
// (frontend/vercel.json). Browsers allow the camera only on https.

const REPEAT_MS = 2000;
const TICK_MS = 120;

const BACK = { ideal: 'environment' };
const NATIVE_VIDEO = { facingMode: BACK, width: { ideal: 1280 }, height: { ideal: 720 } };
const WASM_SIZE = { width: { ideal: 1920 }, height: { ideal: 1080 } };
const WASM_VIDEO = { facingMode: BACK, ...WASM_SIZE };

async function nativeReadsCode128() {
  if (!('BarcodeDetector' in window)) return false;
  try { return (await window.BarcodeDetector.getSupportedFormats()).includes('code_128'); } catch { return false; }
}

export default function CameraScanner({ onKey, onClose }) {
  const videoRef = useRef(null);
  const onKeyRef = useRef(onKey);
  const onCloseRef = useRef(onClose);
  const [error, setError] = useState('');
  // 'camera' (opening it) -> 'reader' (WASM still loading) -> 'scanning'
  const [phase, setPhase] = useState('camera');
  const [wasm, setWasm] = useState(false);
  const [paused, setPaused] = useState(false);
  const [info, setInfo] = useState('');

  useEffect(() => {
    onKeyRef.current = onKey;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    let stopped = false;
    let stream = null;
    let timer = null;
    const recent = new Map();

    const emit = (text) => {
      const key = String(text || '').trim();
      if (keyError(key)) return;
      const now = Date.now();
      if (now - (recent.get(key) || 0) < REPEAT_MS) return;
      recent.set(key, now);
      onKeyRef.current(key);
    };

    const stopStream = () => {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };
    const open = (video) => navigator.mediaDevices.getUserMedia({ audio: false, video });

    const describe = (native) => {
      const track = stream?.getVideoTracks()[0];
      const s = track?.getSettings?.() || {};
      return [
        `Reader: ${native ? 'built-in' : 'WASM'}`,
        s.width && s.height ? `${s.width}×${s.height}` : '',
        track?.label || '',
      ].filter(Boolean).join(' · ');
    };

    // One loop for both readers. `decode(video)` returns the texts it read.
    const run = (decode) => {
      const tick = async () => {
        if (stopped) return;
        try {
          const video = videoRef.current;
          if (video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
            (await decode(video)).forEach(emit);
          }
        } catch { /* a frame that failed to decode */ }
        if (!stopped) timer = setTimeout(tick, TICK_MS);
      };
      tick();
    };

    (async () => {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw Object.assign(new Error('no camera'), { name: window.isSecureContext ? 'NotFoundError' : 'SecurityError' });
        }
        const native = await nativeReadsCode128();
        if (stopped) return;
        setWasm(!native);

        // The .wasm downloads while the person answers the camera prompt.
        const readerP = native ? null : import('./wasmReader').then((m) => m.loadWasmReader());
        readerP?.catch(() => {}); // awaited below; this only marks it handled

        stream = await open(native ? NATIVE_VIDEO : WASM_VIDEO);
        if (stopped) { stopStream(); return; }

        if (!native) {
          // Device labels are readable now that access is granted. Best-effort:
          // a phone without these lenses keeps the camera it has.
          try {
            const want = preferredBackCamera(await navigator.mediaDevices.enumerateDevices());
            const have = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
            if (want && want !== have && !stopped) {
              stopStream();
              try {
                stream = await open({ deviceId: { exact: want }, ...WASM_SIZE });
              } catch {
                stream = await open(WASM_VIDEO);
              }
            }
          } catch { /* keep the camera we have */ }
          if (stopped) { stopStream(); return; }
        }

        const video = videoRef.current;
        video.srcObject = stream;
        try { await video.play(); } catch { /* shown as "Tap to start" */ }
        if (stopped) return;
        setPaused(video.paused);
        setInfo(describe(native));

        if (native) {
          const detector = new window.BarcodeDetector({ formats: ['code_128'] });
          setPhase('scanning');
          run(async (v) => (await detector.detect(v)).map((c) => c.rawValue));
          return;
        }

        setPhase('reader');
        const read = await readerP;
        if (stopped) return;
        setPhase('scanning');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        run((v) => {
          const { sx, sy, sw, sh } = visibleCrop(v.videoWidth, v.videoHeight, v.clientWidth, v.clientHeight);
          if (canvas.width !== sw) canvas.width = sw;
          if (canvas.height !== sh) canvas.height = sh;
          ctx.drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh);
          return read(ctx.getImageData(0, 0, sw, sh));
        });
      } catch (err) {
        if (stopped) return;
        stopStream(); // no camera light behind an error message
        setError(cameraErrorMessage(err));
      }
    })();

    // A hidden tab keeps the camera light on for nothing: close instead.
    const onVisibility = () => { if (document.hidden) onCloseRef.current(); };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(timer);
      stopStream();
    };
  }, []);

  const tapToPlay = () => { videoRef.current?.play().catch(() => {}); };

  return (
    <div className="relative rounded-xl overflow-hidden bg-black">
      <video
        ref={videoRef}
        playsInline
        muted
        onPlaying={() => setPaused(false)}
        onClick={tapToPlay}
        className="block w-full h-64 sm:h-80 object-cover"
      />
      {phase === 'scanning' && !error && (
        <>
          <div className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 h-24 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]" />
          <p className="pointer-events-none absolute bottom-2 inset-x-0 px-3 text-center text-xs text-white/90">
            {wasm
              ? 'Hold one barcode inside the box — if it is blurry, move the phone back a little'
              : 'Hold one barcode inside the box'}
          </p>
        </>
      )}
      {phase === 'camera' && !error && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-white/80">Starting the camera…</p>
      )}
      {phase === 'reader' && !error && (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center">
          <span className="rounded-full bg-black/70 px-3 py-1.5 text-sm text-white">Loading the barcode reader…</span>
        </p>
      )}
      {paused && phase !== 'camera' && !error && (
        <button
          type="button"
          onClick={tapToPlay}
          className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm font-medium text-white"
        >
          Tap to start the camera
        </button>
      )}
      {info && !error && (
        <p className="pointer-events-none absolute top-2 left-2 max-w-[70%] truncate rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white/80">
          {info}
        </p>
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
