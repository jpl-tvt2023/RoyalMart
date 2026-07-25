const pdfParse = require('pdf-parse');
const path = require('path');

// pdf-parse@1.1.1 bundles a very old pdf.js (v1.10.88, ~2017) with weak
// recovery for malformed/non-standard cross-reference tables. A real-world
// Flipkart stock transfer invoice PDF has been seen throwing "bad XRef entry"
// from that old engine in some deployments, even though the file opens fine
// in any modern PDF reader. Fall back to pdfjs-dist directly — a current,
// far more battle-tested implementation with much better xref recovery —
// before giving up. pdfjs-dist ships ESM-only, hence the dynamic import in
// this CommonJS module.
async function extractViaFallback(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: path.join(require.resolve('pdfjs-dist/package.json'), '..', 'standard_fonts') + path.sep,
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
  try {
    const data = await pdfParse(buffer);
    return data.text;
  } catch (err) {
    return extractViaFallback(buffer);
  }
}

module.exports = extractPdfText;
