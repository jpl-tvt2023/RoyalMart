// Runs the pdfjs-dist fallback in a plain Node process, for tests/parsers/pdf-fallback.test.js.
//
// The fallback reaches pdfjs-dist through `await import('pdfjs-dist/legacy/build/pdf.mjs')`,
// and jest's CommonJS sandbox refuses dynamic import without --experimental-vm-modules.
// Turning that on for the whole suite to cover one branch is a poor trade, and it
// would test the branch under jest's module registry rather than Node's. A child
// process exercises exactly the resolution path the deployed function uses — which
// is the thing that broke in production — so the test drives this script instead.
//
// Usage: node pdfFallbackRunner.js <mode> [pdfPath]   -> JSON on stdout
//   text <pdf>               extract text via the fallback engine only
//   flipkart-fallback <pdf>  make pdf-parse throw, then parse the PO end to end
//   both-fail                make pdf-parse throw and hand the fallback garbage

const fs = require('fs');

// Replace pdf-parse in the require cache before anything pulls it in, so the
// parsers see a failing engine exactly as they do on Vercel.
function breakPdfParse(message) {
  const resolved = require.resolve('pdf-parse');
  require(resolved);
  require.cache[resolved].exports = function failingPdfParse() {
    throw new Error(message);
  };
}

async function main() {
  const [mode, pdfPath] = process.argv.slice(2);

  if (mode === 'text') {
    const { extractViaFallback } = require('../../src/parsers/marketplacePO/pdfText');
    return { text: await extractViaFallback(fs.readFileSync(pdfPath)) };
  }

  if (mode === 'flipkart-fallback') {
    breakPdfParse('bad XRef entry');
    const { parse } = require('../../src/parsers/marketplacePO');
    return { result: await parse('Flipkart', fs.readFileSync(pdfPath)) };
  }

  if (mode === 'both-fail') {
    breakPdfParse('bad XRef entry');
    const extractPdfText = require('../../src/parsers/marketplacePO/pdfText');
    try {
      await extractPdfText(Buffer.from('not a pdf at all'));
    } catch (err) {
      return { message: err.message };
    }
    throw new Error('expected extractPdfText to throw');
  }

  throw new Error(`unknown mode: ${mode}`);
}

main().then(
  (out) => {
    process.stdout.write(JSON.stringify(out));
  },
  (err) => {
    process.stderr.write(err.stack || String(err));
    process.exit(1);
  }
);
