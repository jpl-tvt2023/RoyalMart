const XLSX = require('xlsx');
const parseMyntra = require('../../src/parsers/marketplacePO/myntra');

// The real samples are pinned in parse-endpoint and vendor-samples. These build
// workbooks in memory to reach what the samples do not: one SKU over several
// cartons, a row that does not add up, two POs in one file, Excel-typed dates.

const HEADER = [
  'Slot Date (yyyy-MM-dd)', 'PO Barcode/STR Barcode', 'Vendor GST Registration No', 'SKU Code', 'HSN Code',
  'Invoice No/STN Invoice No', 'Invoice Date (yyyy-MM-dd)', 'Quantity', 'Unit Price Excluding Taxes',
  'Total Cost Excluding Taxes [Qnty * Unit Price]', 'CGST Rate', 'SGST Rate', 'IGST Rate',
  'Total Cost Including GST', 'Carton Number', 'Status & Remarks',
];

// slot, barcode, sku, invoice date, qty, unit price, total ex tax, carton
const row = (o = {}) => {
  const r = {
    slot: '2026-11-20', barcode: 'STNTEST-00', sku: 'SKU-A', invDate: '2026-11-13',
    qty: 10, price: 100, carton: '1', ...o,
  };
  const total = 'total' in o ? o.total : r.qty * r.price;
  return [r.slot, r.barcode, '27ABGFR0562B1ZI', r.sku, '62132000', '1752/RM/26-27', r.invDate,
    r.qty, r.price, total, 0, 0, 5, total * 1.05, r.carton, 'SUCCESS'];
};

const book = (rows, header = HEADER) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

describe('Myntra parser', () => {
  test('maps the barcode, invoice date and slot date, and merges a SKU split over cartons', async () => {
    const out = await parseMyntra(book([
      row({ sku: 'SKU-A', qty: 6, carton: '1' }),
      row({ sku: 'SKU-B', qty: 4, carton: '1' }),
      row({ sku: 'SKU-A', qty: 5, carton: '2' }),
    ]));
    expect(out).toMatchObject({
      vendor_po_id: 'STNTEST-00', po_date: '2026-11-13', appointment_date: '2026-11-20',
      po_expiry_date: null, expected_delivery_date: null, party_name: null, city: null,
    });
    expect(out.lines).toEqual([
      { line_no: 1, item_code: 'SKU-A', item_desc: '', qty: 11 },
      { line_no: 2, item_code: 'SKU-B', item_desc: '', qty: 4 },
    ]);
  });

  test('finds columns by label, in any order, without the date-format suffix', async () => {
    const header = ['SKU Code', 'Quantity', 'PO Barcode', 'Invoice Date', 'Slot Date'];
    const out = await parseMyntra(book([['SKU-Z', 7, 'STNX-01', '13/11/2026', '2026-11-21']], header));
    expect(out).toMatchObject({ vendor_po_id: 'STNX-01', po_date: '2026-11-13', appointment_date: '2026-11-21' });
    expect(out.lines).toEqual([{ line_no: 1, item_code: 'SKU-Z', item_desc: '', qty: 7 }]);
  });

  test('reads dates Excel typed as serial day numbers', async () => {
    // 46339 is 2026-11-13 and 46346 is 2026-11-20 in Excel's 1900 date system.
    const out = await parseMyntra(book([row({ invDate: 46339, slot: 46346 })]));
    expect(out).toMatchObject({ po_date: '2026-11-13', appointment_date: '2026-11-20' });
  });

  test('skips blank and zero-quantity rows', async () => {
    const out = await parseMyntra(book([row({ sku: 'SKU-A' }), [], row({ sku: 'SKU-B', qty: 0 })]));
    expect(out.lines.map(l => l.item_code)).toEqual(['SKU-A']);
  });

  test('a row whose Quantity x Unit Price is not its Total Cost fails the upload', async () => {
    await expect(parseMyntra(book([row(), row({ sku: 'SKU-B', qty: 35, price: 99.6, total: 5904 })])))
      .rejects.toThrow('Row 3 of the Myntra sheet does not add up');
  });

  test('two PO barcodes in one file are refused', async () => {
    await expect(parseMyntra(book([row({ barcode: 'STN-00' }), row({ barcode: 'STN-01', sku: 'SKU-B' })])))
      .rejects.toThrow('more than one PO (STN-00, STN-01)');
  });

  test('a fractional quantity, a missing header and an empty table are refused', async () => {
    await expect(parseMyntra(book([row({ qty: 2.5, total: 250 })]))).rejects.toThrow('is not a whole number');
    await expect(parseMyntra(book([['x', 'y']], ['Foo', 'Bar']))).rejects.toThrow('Could not find the header row');
    await expect(parseMyntra(book([]))).rejects.toThrow('Could not find the PO Barcode');
  });
});
