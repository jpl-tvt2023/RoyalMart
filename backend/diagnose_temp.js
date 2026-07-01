const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { fieldByLabel, NUMERIC_LINE_RE } = require('./src/parsers/marketplacePO/scootsy/shared');

// Legacy parser qty extraction
function parseQtyFromBlob_Legacy(blob) {
  const D2 = '\d+\.\d{2}';
  const D3 = '\d+\.\d{3}';
  for (let qLen = 1; qLen <= 5; qLen++) {
    const re = new RegExp(
      `^(\d{8})(\d{${qLen}})(${D2})(${D3})(${D2})` +
      `(${D2})(${D2})(${D2})(${D2})(${D2})(${D2})(${D2})(${D2})` +
      `(${D2})(${D2})$`
    );
    const m = blob.match(re);
    if (!m) continue;
    const qty = parseInt(m[2], 10);
    const unitBase = parseFloat(m[4]);
    const taxable = parseFloat(m[5]);
    if (qty > 0 && Math.abs(qty * unitBase - taxable) / Math.max(taxable, 1) < 0.005) return qty;
  }
  return null;
}

// OTB parser row extraction
function parseRowFromBlob_OTB(blob) {
  const D2 = '\d+\.\d{2}';
  for (let qLen = 1; qLen <= 5; qLen++) {
    for (let ubDec = 2; ubDec <= 7; ubDec++) {
      const UB = `\d+\.\d{${ubDec}}`;
      const re = new RegExp(
        `^(\d{8})(\d{${qLen}})(${D2})(${UB})(${D2})` +
        `(${D2})(${D2})(${D2})(${D2})(${D2})(${D2})(${D2})(${D2})` +
        `(${D2})(${D2})$`
      );
      const m = blob.match(re);
      if (!m) continue;
      const qty = parseInt(m[2], 10);
      const unitBase = parseFloat(m[4]);
      const taxable = parseFloat(m[5]);
      if (qty > 0 && Math.abs(qty * unitBase - taxable) / Math.max(taxable, 1) < 0.005) {
        return { qty, ubDec, unitBase, taxable };
      }
    }
  }
  return null;
}

async function diagnose() {
  const pdfPath = path.join(__dirname, 'src/parsers/marketplacePO/samples/scootsy/exception/QLGRP0NZIALDDSA4DPXH_CREATE_OTB_PURCHASE_ORDER_d216565b-ed8f-4ed2-b118-65f1c0a85cbd.pdf');
  const buffer = fs.readFileSync(pdfPath);
  const { text } = await pdf(buffer);
  const rawLines = text.split(/\r?\n/).map(l => l.trim());
  const flatLines = rawLines.filter(Boolean);

  console.log('=== RAW PDF TEXT (first 80 lines) ===\n');
  flatLines.slice(0, 80).forEach((l, i) => console.log(`${String(i).padStart(3)}: ${l}`));

  console.log('\n\n=== FINDING TABLE BODY ===\n');
  const endIdx = flatLines.findIndex(l => /^Total\s+Amount\s+\(INR\)/i.test(l));
  const bodyEnd = endIdx === -1 ? flatLines.length : endIdx;
  console.log(`Body ends at line ${bodyEnd} (Total Amount line at ${endIdx})`);

  const numericish = (l) => /^[\d.\s]+$/.test(l) && /\d/.test(l);

  let legacyCount = 0;
  let otbCount = 0;
  const skipped = [];

  let i = 0;
  let expectedSr = 1;

  console.log('\n\n=== LINE-ITEM EXTRACTION ANALYSIS ===\n');

  while (i < bodyEnd) {
    const line = flatLines[i];
    const srStr = String(expectedSr);
    const head = line.match(new RegExp(`^${srStr}(\d{5,6})(\D.*)?$`));

    if (!head) {
      i++;
      continue;
    }

    const item_code = head[1];
    const descParts = [];
    if (head[2] && head[2].trim()) descParts.push(head[2].trim());
    let j = i + 1;

    // Scan for HSN
    while (j < bodyEnd && !/^\d{8}/.test(flatLines[j].replace(/\s/g, ''))) {
      const t = flatLines[j].trim();
      if (t && !/^\d+$/.test(t)) descParts.push(t);
      j++;
    }

    console.log(`\n--- SR ${expectedSr}, Code ${item_code} ---`);
    console.log(`Head line (${i}): "${line}"`);
    console.log(`Description: "${descParts.join(' ')}"`);
    console.log(`HSN search range: ${j} to ${bodyEnd}`);

    // Accumulate numeric lines
    let blob = '';
    let legacyQty = null;
    let otbRow = null;
    const blobLines = [];

    while (j < bodyEnd && numericish(flatLines[j])) {
      const numLine = flatLines[j];
      blobLines.push(numLine);
      blob += numLine.replace(/\s/g, '');
      j++;

      legacyQty = parseQtyFromBlob_Legacy(blob);
      otbRow = parseRowFromBlob_OTB(blob);

      if (legacyQty || otbRow) break;
    }

    console.log(`Numeric lines found: ${blobLines.length}`);
    if (blobLines.length > 0) {
      console.log(`  Concatenated blob: "${blob.substring(0, 60)}..."`);
      console.log(`  Blob length: ${blob.length} chars`);
    }

    if (legacyQty && legacyQty > 0) {
      legacyCount++;
      console.log(`✓ LEGACY: qty=${legacyQty}`);
    } else {
      console.log(`✗ LEGACY: failed`);
    }

    if (otbRow && otbRow.qty > 0) {
      otbCount++;
      console.log(`✓ OTB: qty=${otbRow.qty}, ubDec=${otbRow.ubDec}, unitBase=${otbRow.unitBase}, taxable=${otbRow.taxable}`);
    } else {
      console.log(`✗ OTB: failed`);
      skipped.push(expectedSr);
    }

    expectedSr++;
    i = j > i ? j : i + 1;
  }

  console.log('\n\n=== SUMMARY ===');
  console.log(`Legacy parser: ${legacyCount} lines extracted`);
  console.log(`OTB parser: ${otbCount} lines extracted`);
  console.log(`Expected Sr numbers: 1 to ${expectedSr - 1}`);
  console.log(`Skipped by OTB (Sr numbers): ${skipped.length > 0 ? skipped.join(', ') : 'none'}`);
  console.log(`Dispatcher choice: ${otbCount > legacyCount ? 'OTB' : legacyCount >= otbCount ? 'LEGACY' : 'OTB'}`);
}

diagnose().catch(err => console.error('ERROR:', err.message, err.stack));
