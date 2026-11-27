// The camera's barcode reader where the browser has no BarcodeDetector -- every
// iPhone browser (Safari, Chrome, Edge: all WebKit) and desktop browsers.
// zxing-wasm is zxing-cpp compiled to WebAssembly: it reads the thin 0.25 mm
// bars of our stickers from a phone camera, which the pure-JS zxing could not.
//
// CameraScanner imports this file only through import(), so neither the glue
// nor the ~1 MB .wasm is in the main bundle.
//
// The .wasm is served from our own /assets (Vite's ?url), not zxing-wasm's
// default CDN: the CSP only allows 'self'. It comes from the same package as
// the JS glue, so the two versions cannot drift apart. Compiling it needs
// 'wasm-unsafe-eval', which frontend/vercel.json allows on /barcode-station
// only.

import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

const OPTIONS = { formats: ['Code128'], maxNumberOfSymbols: 1 };

let ready = null;

// Resolves to read(imageData) -> Promise<string[]> once the .wasm is compiled.
// A failed load is not cached, so the next tap on the camera button retries.
export function loadWasmReader() {
  if (!ready) {
    ready = prepareZXingModule({
      overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
      fireImmediately: true,
    })
      .then(() => async (imageData) => (await readBarcodes(imageData, OPTIONS))
        .filter((r) => r.isValid)
        .map((r) => r.text))
      .catch((err) => {
        ready = null;
        const e = err instanceof Error ? err : new Error(String(err));
        e.name = 'ReaderLoadError';
        throw e;
      });
  }
  return ready;
}
