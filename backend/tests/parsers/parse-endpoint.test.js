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
});
