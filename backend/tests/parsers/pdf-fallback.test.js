const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SAMPLES = path.join(__dirname, '..', '..', 'src', 'parsers', 'marketplacePO', 'samples', 'Flipkart');
const RUNNER = path.join(__dirname, '..', 'helpers', 'pdfFallbackRunner.js');
const WRAPPED_PO = 'stock_transfer_invoice_205012925_20260918131700.pdf';

// pdfText.js tries pdf-parse first and only reaches pdfjs-dist when it throws —
// which, so far, only ever happens in the deployed serverless function. That
// left the fallback branch with no coverage at all, and it shipped broken: it
// called require.resolve('pdfjs-dist/package.json') to locate standard_fonts,
// and that file is not traced into the Vercel bundle, so every fallback died
// with MODULE_NOT_FOUND before extracting a single character.
//
// The fallback loads pdfjs-dist through a dynamic import, which jest's CJS
// sandbox will not run, so these tests drive helpers/pdfFallbackRunner.js in a
// child process. That is the stricter check anyway: it resolves modules through
// Node exactly as the deployed function does.
function runFallback(mode, pdfPath) {
  const args = pdfPath ? [RUNNER, mode, pdfPath] : [RUNNER, mode];
  const out = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (out.status !== 0) {
    throw new Error(`pdfFallbackRunner ${mode} failed:\n${out.stderr}`);
  }
  return JSON.parse(out.stdout);
}

function pdfsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf'));
}

describe('extractViaFallback — the pdfjs-dist engine', () => {
  const files = pdfsIn(SAMPLES);

  it('has samples to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)('extracts text from %s', (file) => {
    const { text } = runFallback('text', path.join(SAMPLES, file));
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(100);
    expect(text).toMatch(/Consignment Note No/i);
  });
});

describe('Flipkart parse when pdf-parse fails', () => {
  // The production scenario end to end: pdf-parse's ancient bundled pdf.js
  // throws "bad XRef entry", and the parse must still succeed off pdfjs-dist.
  // It also pins that flipkart.js tolerates both engines' text layouts — the
  // two differ (pdf-parse glues "Consignment Note No:205012925", pdfjs-dist
  // emits "Consignment Note No: 205012925" with a space).
  it('falls back to pdfjs-dist and still returns a well-formed PO', () => {
    const { result } = runFallback('flipkart-fallback', path.join(SAMPLES, WRAPPED_PO));

    expect(result.vendor_po_id).toBe('205012925');
    expect(result.po_date).toBe('2026-09-18');
    expect(result.lines.length).toBeGreaterThan(0);
    for (const ln of result.lines) {
      expect(String(ln.item_code).trim()).not.toBe('');
      expect(Number(ln.qty)).toBeGreaterThan(0);
    }
  });

  // When both engines fail the caller must be told why the FIRST one did. The
  // fallback's own error used to replace it, which is exactly what made the
  // production failure unreadable: the toast blamed a missing module and said
  // nothing about the bad xref that sent us down the fallback in the first place.
  it('reports both engines when the fallback also fails', () => {
    const { message } = runFallback('both-fail');
    expect(message).toMatch(/pdf-parse: bad XRef entry/);
    expect(message).toMatch(/pdfjs-dist: .+/);
  });
});
