const request = require('supertest');
const app = require('../app');
const { db } = require('./helpers/db');

let token;
let uidCounter = 0;
const uid = () => String(Date.now()) + '-' + (uidCounter++);

const VENDOR = 'Blinkit';

function createPO(body) {
  return request(app).post('/api/marketplace-pos').set('Authorization', 'Bearer ' + token).send(body);
}

function patchSummary(poId, body) {
  return request(app).patch('/api/order-summary/' + poId).set('Authorization', 'Bearer ' + token).send(body);
}

function getPartyNames(vendor) {
  const req = request(app).get('/api/marketplace-pos/party-names').set('Authorization', 'Bearer ' + token);
  return vendor === undefined ? req : req.query({ vendor });
}

async function partyNameOf(poId) {
  const { rows } = await db.execute({
    sql: 'SELECT party_name FROM marketplace_pos WHERE po_id = ?',
    args: [poId],
  });
  return rows[0] ? rows[0].party_name : undefined;
}

// Creates a PO and returns its generated po_id. vendor_po_id is unique per call
// so each test gets an insert rather than tripping the upsert branch.
async function makePO(overrides = {}) {
  const res = await createPO(Object.assign({
    vendor: VENDOR,
    vendor_po_id: 'PN-' + uid(),
    po_date: '2026-01-01',
    city: 'Delhi',
    lines: [{ line_no: 1, item_code: 'ITEM-1', qty: 5 }],
  }, overrides));
  expect(res.status).toBe(201);
  return res.body.po_id;
}

beforeAll(async () => {
  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = login.body.accessToken;

  await db.execute({
    sql: 'INSERT OR IGNORE INTO vendors (name, is_active, has_parser) VALUES (?, 1, 1)',
    args: [VENDOR],
  });
});

describe('Party name -- editable after creation', () => {
  test('PATCH /api/order-summary/:poId sets party_name', async () => {
    const poId = await makePO();
    const res = await patchSummary(poId, { party_name: 'BLINK COMMERCE PRIVATE LIMITED' });
    expect(res.status).toBe(200);
    expect(await partyNameOf(poId)).toBe('BLINK COMMERCE PRIVATE LIMITED');
  });

  test('corrects a party name that was set at creation', async () => {
    const poId = await makePO({ party_name: 'WRONG NAME' });
    expect(await partyNameOf(poId)).toBe('WRONG NAME');
    await patchSummary(poId, { party_name: 'RIGHT NAME' });
    expect(await partyNameOf(poId)).toBe('RIGHT NAME');
  });

  test('fills in a blank party name (the manually-onboarded case)', async () => {
    const poId = await makePO({ party_name: '' });
    expect(await partyNameOf(poId)).toBeNull();
    await patchSummary(poId, { party_name: 'LATER ENTERED' });
    expect(await partyNameOf(poId)).toBe('LATER ENTERED');
  });

  test('trims, and treats blank as NULL', async () => {
    const poId = await makePO({ party_name: 'SOMETHING' });
    await patchSummary(poId, { party_name: '   SPACED OUT   ' });
    expect(await partyNameOf(poId)).toBe('SPACED OUT');
    await patchSummary(poId, { party_name: '   ' });
    expect(await partyNameOf(poId)).toBeNull();
  });

  test('accepts spaces, periods and commas (not alphanumeric-only)', async () => {
    const poId = await makePO();
    const name = 'Blink Commerce Pvt. Ltd., Unit 4';
    const res = await patchSummary(poId, { party_name: name });
    expect(res.status).toBe(200);
    expect(await partyNameOf(poId)).toBe(name);
  });

  test('a PATCH that does not mention party_name leaves it intact', async () => {
    const poId = await makePO({ party_name: 'KEEP ME' });
    const res = await patchSummary(poId, { bill_no: 'B' + (uidCounter++), bill_date: '2026-02-02' });
    expect(res.status).toBe(200);
    expect(await partyNameOf(poId)).toBe('KEEP ME');
  });

  test('the change is recorded in the audit log', async () => {
    const poId = await makePO({ party_name: 'OLD PARTY' });
    await patchSummary(poId, { party_name: 'NEW PARTY' });
    const { rows } = await db.execute({
      sql: "SELECT changes FROM audit_logs WHERE entity_ref = ? AND changes LIKE '%party_name%' ORDER BY id DESC LIMIT 1",
      args: [poId],
    });
    expect(rows.length).toBe(1);
    expect(rows[0].changes).toContain('NEW PARTY');
    expect(rows[0].changes).toContain('OLD PARTY');
  });
});

describe('Party name -- re-import no longer wipes a correction', () => {
  test('re-POSTing without a party name preserves the stored value', async () => {
    const vendorPoId = 'PN-' + uid();
    const base = {
      vendor: VENDOR, vendor_po_id: vendorPoId, po_date: '2026-01-01', city: 'Delhi',
      lines: [{ line_no: 1, item_code: 'ITEM-1', qty: 1 }],
    };
    const created = await createPO(Object.assign({}, base, { party_name: 'PARSED NAME' }));
    const poId = created.body.po_id;
    await patchSummary(poId, { party_name: 'HAND CORRECTED' });

    // The Amazon parser always yields null -- this stands in for that re-upload.
    const again = await createPO(Object.assign({}, base, { party_name: null }));
    expect(again.status).toBe(200);
    expect(again.body.po_id).toBe(poId);
    expect(await partyNameOf(poId)).toBe('HAND CORRECTED');
  });

  test('re-POSTing WITH a party name still overwrites', async () => {
    const vendorPoId = 'PN-' + uid();
    const base = {
      vendor: VENDOR, vendor_po_id: vendorPoId, po_date: '2026-01-01', city: 'Delhi',
      lines: [{ line_no: 1, item_code: 'ITEM-1', qty: 1 }],
    };
    const created = await createPO(Object.assign({}, base, { party_name: 'FIRST' }));
    const poId = created.body.po_id;
    const again = await createPO(Object.assign({}, base, { party_name: 'SECOND' }));
    expect(again.status).toBe(200);
    expect(await partyNameOf(poId)).toBe('SECOND');
  });
});

describe('GET /api/marketplace-pos/party-names', () => {
  test('requires a vendor', async () => {
    const res = await getPartyNames();
    expect(res.status).toBe(400);
  });

  test('resolves as a lookup, not as a PO id', async () => {
    const res = await getPartyNames(VENDOR);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('returns distinct, sorted names and excludes blanks', async () => {
    const name = 'ZZ PARTY ' + uid();
    await makePO({ party_name: name });
    await makePO({ party_name: name });
    await makePO({ party_name: '' });

    const res = await getPartyNames(VENDOR);
    expect(res.status).toBe(200);
    expect(res.body.filter(n => n === name).length).toBe(1);
    expect(res.body).not.toContain('');
    expect(res.body).not.toContain(null);
    expect([...res.body].sort()).toEqual(res.body);
  });

  test('a newly entered name joins the list', async () => {
    const poId = await makePO();
    const fresh = 'BRAND NEW PARTY ' + uid();
    expect((await getPartyNames(VENDOR)).body).not.toContain(fresh);
    await patchSummary(poId, { party_name: fresh });
    expect((await getPartyNames(VENDOR)).body).toContain(fresh);
  });

  test('excludes names that only appear on deleted POs', async () => {
    const name = 'DELETED ONLY ' + uid();
    const poId = await makePO({ party_name: name });
    expect((await getPartyNames(VENDOR)).body).toContain(name);

    await request(app).delete('/api/marketplace-pos/' + poId).set('Authorization', 'Bearer ' + token);
    expect((await getPartyNames(VENDOR)).body).not.toContain(name);
  });

  test('is scoped to the requested vendor', async () => {
    const name = 'SCOPED ' + uid();
    await makePO({ party_name: name });
    await db.execute({
      sql: "INSERT OR IGNORE INTO vendors (name, is_active, has_parser) VALUES ('Zepto', 1, 1)",
    });
    const other = await getPartyNames('Zepto');
    expect(other.body).not.toContain(name);
  });
});
