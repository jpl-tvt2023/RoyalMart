const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../../app');

// End-to-end check of POST /api/marketplace-pos/parse for the two new vendors.
// Exercises the full HTTP path — auth, multer file filter (incl. binary .xls),
// vendor lookup, parser dispatch and SKU enrichment — against the local test DB
// (vendors seeded by migration 036). The /parse endpoint is preview-only and
// never writes PO rows.

const SAMPLES = path.join(__dirname, '..', '..', 'src', 'parsers', 'marketplacePO', 'samples');
const NOW_PDF = path.join(SAMPLES, 'Now', '031969eb-72f2-446c-b00a-bff5edce655d.pdf');
const MINUTES_XLS = path.join(SAMPLES, 'Minutes', 'purchase_order_FCAWG08341319.xls');
const MYNTRA_00 = path.join(SAMPLES, 'Myntra', 'STNROMXMYNT121126-00_2026-11-202730877118560781952.xlsx');
const MYNTRA_01 = path.join(SAMPLES, 'Myntra', 'STNROMXMYNT121126-01_2026-11-204693566561046187473.xlsx');

async function adminToken() {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'RoyalMart#Admin' });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

describe('POST /api/marketplace-pos/parse — new vendors', () => {
  let token;
  beforeAll(async () => { token = await adminToken(); });

  test('Now (PDF) returns a parsed preview', async () => {
    const res = await request(app)
      .post('/api/marketplace-pos/parse')
      .set('Authorization', `Bearer ${token}`)
      .field('vendor', 'Now')
      .attach('file', NOW_PDF);

    expect(res.status).toBe(200);
    expect(res.body.vendor).toBe('Now');
    expect(res.body.vendor_po_id).toBe('6O2Q2A7B');
    expect(res.body.lines.length).toBe(19);
    expect(res.body.lines[0]).toHaveProperty('item_code');
    expect(res.body.lines[0]).toHaveProperty('internal_sku_code'); // enrichment ran
    expect(res.body.lines.reduce((a, l) => a + l.qty, 0)).toBe(741);
  });

  test('Minutes (binary .xls) returns a parsed preview', async () => {
    const res = await request(app)
      .post('/api/marketplace-pos/parse')
      .set('Authorization', `Bearer ${token}`)
      .field('vendor', 'Minutes')
      .attach('file', MINUTES_XLS);

    expect(res.status).toBe(200);
    expect(res.body.vendor).toBe('Minutes');
    expect(res.body.vendor_po_id).toBe('FCAWG08341319');
    expect(res.body.lines.length).toBe(16);
    expect(res.body.lines.reduce((a, l) => a + l.qty, 0)).toBe(384);
  });

  // Myntra's STN sheet (vendor seeded by migration 097). PO Date is the Invoice
  // Date and the Slot Date arrives as the appointment date.
  test.each([
    ['STNROMXMYNT121126-00', MYNTRA_00, 3, 90],
    ['STNROMXMYNT121126-01', MYNTRA_01, 1, 10],
  ])('Myntra (.xlsx) returns a parsed preview: %s', async (poNo, file, lineCount, totalQty) => {
    const res = await request(app)
      .post('/api/marketplace-pos/parse')
      .set('Authorization', `Bearer ${token}`)
      .field('vendor', 'Myntra')
      .attach('file', file);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      vendor: 'Myntra', vendor_po_id: poNo, po_date: '2026-11-13', appointment_date: '2026-11-20',
      po_expiry_date: null, city: null, party_name: null,
    });
    expect(res.body.lines.length).toBe(lineCount);
    expect(res.body.lines[0].item_code).toMatch(/^RMRTHKCF\d+$/);
    expect(res.body.lines[0]).toHaveProperty('internal_sku_code'); // enrichment ran
    expect(res.body.lines.reduce((a, l) => a + l.qty, 0)).toBe(totalQty);
  });
});
