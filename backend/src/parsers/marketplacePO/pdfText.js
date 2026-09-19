const pdfParse = require('pdf-parse');

// pdf-parse@1.1.1 bundles a very old pdf.js (v1.10.88, ~2017) with weak
// recovery for malformed/non-standard cross-reference tables. A real-world
// Flipkart stock transfer invoice PDF has been seen throwing "bad XRef entry"
// from that old engine in some deployments, even though the file opens fine
// in any modern PDF reader. Fall back to pdfjs-dist directly — a current,
// far more battle-tested implementation with much better xref recovery —
// before giving up. pdfjs-dist ships ESM-only, hence the dynamic import in
// this CommonJS module.
//
// Deliberately NO standardFontDataUrl. Locating it needs
// require.resolve('pdfjs-dist/package.json'), and that file is absent from the
// deployed Vercel function: the platform ships only what @vercel/nft statically
// traces, and pdfjs-dist has no "exports" field, so the deep import below
// resolves by plain path join without the tracer ever reading package.json
// (the standard_fonts/*.pfb data is never required by anything either). The
// resolve therefore threw MODULE_NOT_FOUND in production while working fine
// locally. Nothing here needs it: standard font data only matters for RENDERING
// glyphs, while getTextContent() builds text from the PDF's own
// encoding/ToUnicode tables. Do not reintroduce it.
async function extractViaFallback(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    // ERRORS, or pdf.js warns once per font that standardFontDataUrl is unset.
    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
    useSystemFonts: false, // there are no system fonts in a serverless sandbox
  }).promise;

  let text = '';
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // Mirrors pdf-parse's default render_page: same-line items are
      // concatenated without a separator, a new line starts whenever the Y
      // transform changes — so downstream regex parsers see the same line
      // layout regardless of which engine produced the text.
      let lastY, pageText = '';
      for (const item of content.items) {
        if (lastY === item.transform[5] || lastY === undefined) pageText += item.str;
        else pageText += '\n' + item.str;
        lastY = item.transform[5];
      }
      text += `\n\n${pageText}`;
    }
  } finally {
    await doc.destroy();
  }
  return text;
}

async function extractPdfText(buffer) {
  let primary;
  try {
    const data = await pdfParse(buffer);
    return data.text;
  } catch (err) {
    primary = err;
  }
  try {
    return await extractViaFallback(buffer);
  } catch (fallbackErr) {
    // Report both engines. The fallback only ever runs after pdf-parse has
    // already failed, so letting its error replace the primary one hides the
    // reason the fallback was reached at all -- which is exactly what happened
    // when the standardFontDataUrl resolve above blew up in production.
    throw new Error(
      `PDF text extraction failed (pdf-parse: ${primary.message}; pdfjs-dist: ${fallbackErr.message})`
    );
  }
}

module.exports = extractPdfText;
// Exposed for tests: the fallback is unreachable locally (pdf-parse succeeds on
// every sample we hold), so it needs to be callable directly to be covered.
module.exports.extractViaFallback = extractViaFallback;
