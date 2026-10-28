const request = require('supertest');
const app = require('../app');
const { db } = require('./helpers/db');

let token;
let uidCounter = 0;
const uid = () => `${Date.now()}${uidCounter++}`;
const A = (r) => r.set('Authorization', `Bearer ${token}`);

const patchSummary = (poId, body) => A(request(app).patch(`/api/order-summary/${poId}`)).send(body);

// A marketplace PO nobody has dispatched yet -- still Open.
async function openPo(vendor) {
  const created = await A(request(app).post('/api/marketplace-pos')).send({
    vendor, vendor_po_id: `APPT-${uid()}`, po_date: '2026-10-20', city: 'Delhi',
    lines: [{ line_no: 1, item_code: 'ITEM-1', qty: 4 }],
  });
  expect(created.status).toBe(201);
  return created.body.po_id;
}

const appointmentOf = async (poId) => (await db.execute({
  sql: 'SELECT status, appointment_date, asn, appointment_id FROM marketplace_pos WHERE po_id = ?',
  args: [poId],
})).rows[0];

beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = login.body.accessToken;
  for (const v of ['Zepto', 'Blinkit', 'Now']) {
    await db.execute({ sql: 'INSERT OR IGNORE INTO vendors (name, is_active, has_parser) VALUES (?, 1, 1)', args: [v] });
  }
});

// The GRN page's Appointment Date may be set at any stage, dispatched or not,
// and on its own: the client dropped the rule that it needs its companion
// reference -- an ASN on Zepto, an Appointment ID on Now and Blinkit
// (2026-10-28). Only the formats are still checked.
describe('GRN appointment date', () => {
  test('an undispatched Zepto PO takes an appointment date with no ASN', async () => {
    const poId = await openPo('Zepto');
    expect((await patchSummary(poId, { appointment_date: '2026-10-30' })).status).toBe(200);
    expect(await appointmentOf(poId)).toMatchObject({ status: 'Open', appointment_date: '2026-10-30', asn: null });
  });

  test('Now and Blinkit take one with no Appointment ID', async () => {
    for (const vendor of ['Now', 'Blinkit']) {
      const poId = await openPo(vendor);
      expect((await patchSummary(poId, { appointment_date: '2026-10-31', appointment_id: '' })).status).toBe(200);
      expect(await appointmentOf(poId)).toMatchObject({ appointment_date: '2026-10-31', appointment_id: null });
    }
  });

  test('the formats are still checked', async () => {
    const poId = await openPo('Blinkit');
    const badId = await patchSummary(poId, { appointment_id: 'has space' });
    expect(badId.status).toBe(400);
    expect(badId.body.message).toBe('appointment_id must be alphanumeric (dashes allowed)');
    const badDate = await patchSummary(poId, { appointment_date: '30-10-2026' });
    expect(badDate.status).toBe(400);
    expect(badDate.body.message).toBe('Invalid appointment_date format (expected YYYY-MM-DD)');
  });
});
