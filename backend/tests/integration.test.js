const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const { db } = require('./helpers/db');

// The RAMS integration (Tally -> RAMS -> ROMS): the tally-sync system user, the
// token gate, the references RAMS reads, and auto-fill -- Tally's numbers
// written as Tally prints them, compare-and-set on what RAMS read, under the
// same rules a person on the page is held to.

const TOKEN = 'test-integration-token-0123456789';
let token;
let courierId;
let tallySyncId;
let uidCounter = 0;
const uid = () => `${Date.now()}${uidCounter++}`;
// A unique invoice serial, so bill numbers never collide across tests.
let serial = 100;
const nextSerial = () => `${serial++}${String(Date.now()).slice(-4)}`;

const A = (r) => r.set('Authorization', `Bearer ${token}`);
const S = (r, t = TOKEN) => r.set('Authorization', `Bearer ${t}`);
const patchSummary = (poId, body) => A(request(app).patch(`/api/order-summary/${poId}`)).send(body);
const autofill = (items, extra = {}) => S(request(app).post('/api/integration/autofill')).send({ items, ...extra });
const one = async (item, extra) => {
  const res = await autofill([item], extra);
  expect(res.status).toBe(200);
  return res.body.results[0];
};
const poRow = async (poId) => (await db.execute({ sql: 'SELECT * FROM marketplace_pos WHERE po_id = ?', args: [poId] })).rows[0];
const lastAudit = async (actionType, where, arg) => (await db.execute({
  sql: `SELECT * FROM audit_logs WHERE action_type = ? AND ${where} = ? ORDER BY id DESC LIMIT 1`,
  args: [actionType, arg],
})).rows[0];

// A dispatched Blinkit PO of 5 units, billed with `bill` (or not billed).
async function shipped({ bill = null } = {}) {
  const created = await A(request(app).post('/api/marketplace-pos')).send({
    vendor: 'Blinkit', vendor_po_id: `INT-${uid()}`, po_date: '2026-09-01', city: 'Delhi',
    lines: [{ line_no: 1, item_code: 'ITEM-1', qty: 5 }],
  });
  expect(created.status).toBe(201);
  const poId = created.body.po_id;
  const closed = await patchSummary(poId, {
    status: 'Closed', dispatch_date: '2026-09-02', courier_id: courierId, tracking_id: `TRK${uid()}`,
    ...(bill ? { bill_no: bill, bill_date: '2026-09-02' } : {}),
  });
  expect(closed.status).toBe(200);
  return poId;
}

let savedToken;
beforeAll(async () => {
  savedToken = process.env.INTEGRATION_TOKEN;
  process.env.INTEGRATION_TOKEN = TOKEN;
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = login.body.accessToken;
  await db.execute("INSERT OR IGNORE INTO vendors (name, is_active, has_parser) VALUES ('Blinkit', 1, 1)");
  const c = await A(request(app).post('/api/couriers')).send({ name: `Courier ${uid()}` });
  courierId = c.body.id;
  tallySyncId = Number((await db.execute("SELECT id FROM users WHERE username = 'tally-sync'")).rows[0].id);
});

afterAll(() => {
  if (savedToken === undefined) delete process.env.INTEGRATION_TOKEN;
  else process.env.INTEGRATION_TOKEN = savedToken;
});

describe("Builty Bill No keeps Tally's format", () => {
  test("a Tally invoice number with '/' is accepted as typed", async () => {
    const bill = `${nextSerial()}/RM/26-27`;
    const poId = await shipped({ bill });
    expect((await poRow(poId)).bill_no).toBe(bill);
  });

  test('anything but letters, digits, dashes and slashes is still refused', async () => {
    const poId = await shipped();
    const res = await patchSummary(poId, { bill_no: '607 RM', bill_date: '2026-09-02' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Bill no may contain only letters, digits, dashes and slashes');
  });

  test('the whole number is still unique across POs', async () => {
    const bill = `${nextSerial()}/RM/26-27`;
    const first = await shipped({ bill });
    const second = await shipped();
    const res = await patchSummary(second, { bill_no: bill, bill_date: '2026-09-02' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'bill_no_duplicate' });
    expect(res.body.conflicts[0].po_id).toBe(first);
  });
});

describe('the tally-sync system user', () => {
  test('exists, as an Employee', async () => {
    const { rows } = await db.execute({ sql: 'SELECT role FROM user_roles WHERE user_id = ?', args: [tallySyncId] });
    expect(rows.map((r) => r.role)).toEqual(['Employee']);
  });

  test('can never sign in — not even after an Admin sets it a real password', async () => {
    const refused = await request(app).post('/api/auth/login').send({ username: 'tally-sync', password: 'anything' });
    expect(refused.status).toBe(401);
    expect(refused.body.message).toBe('This account cannot sign in');

    const before = (await db.execute({ sql: 'SELECT password_hash FROM users WHERE id = ?', args: [tallySyncId] })).rows[0].password_hash;
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [await bcrypt.hash('Known#Pass1', 4), tallySyncId] });
    try {
      const stillRefused = await request(app).post('/api/auth/login').send({ username: 'tally-sync', password: 'Known#Pass1' });
      expect(stillRefused.status).toBe(401);
      expect(stillRefused.body.accessToken).toBeUndefined();
    } finally {
      await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [before, tallySyncId] });
    }
  });
});

describe('the integration token gate', () => {
  test('no token configured: the integration is off (503)', async () => {
    delete process.env.INTEGRATION_TOKEN;
    try {
      const res = await S(request(app).get('/api/integration/refs/vendors'));
      expect(res.status).toBe(503);
    } finally {
      process.env.INTEGRATION_TOKEN = TOKEN;
    }
  });

  test('a missing or wrong token is refused, and so is a user login', async () => {
    expect((await request(app).get('/api/integration/refs/vendors')).status).toBe(401);
    expect((await S(request(app).get('/api/integration/refs/vendors'), 'wrong')).status).toBe(401);
    expect((await A(request(app).get('/api/integration/refs/vendors'))).status).toBe(401);
  });

  test('the right token gets in', async () => {
    expect((await S(request(app).get('/api/integration/refs/vendors'))).status).toBe(200);
  });
});

describe('GET /api/integration/refs/:resource', () => {
  test('pages a reference in the house envelope, on a stable order', async () => {
    await shipped();
    await shipped();
    const page1 = await S(request(app).get('/api/integration/refs/pos')).query({ page: 1, page_size: 1 });
    const page2 = await S(request(app).get('/api/integration/refs/pos')).query({ page: 2, page_size: 1 });
    expect(page1.status).toBe(200);
    expect(page1.body).toMatchObject({ page: 1, page_size: 1 });
    expect(page1.body.total).toBeGreaterThanOrEqual(2);
    expect(page1.body.rows[0].po_id < page2.body.rows[0].po_id).toBe(true);
    expect(Object.keys(page1.body.rows[0])).toEqual(expect.arrayContaining(['po_id', 'vendor', 'vendor_po_id', 'bill_no', 'bill_date', 'status']));
  });

  test('lines carry the SKU the vendor mapping gives, and page size is capped', async () => {
    const res = await S(request(app).get('/api/integration/refs/lines')).query({ page_size: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.page_size).toBe(1000);
    expect(Object.keys(res.body.rows[0])).toEqual(['po_id', 'line_no', 'item_code', 'qty', 'sku_code']);
  });

  test('every reference RAMS reads is served, and nothing else', async () => {
    for (const r of ['vendors', 'products', 'vendor-codes', 'pos', 'lines', 'rtv']) {
      expect((await S(request(app).get(`/api/integration/refs/${r}`))).status).toBe(200);
    }
    expect((await S(request(app).get('/api/integration/refs/users'))).status).toBe(404);
  });
});

describe('auto-fill: Builty Bill No', () => {
  test('fills a blank bill no with the whole Tally number, audited as Tally Sync', async () => {
    const poId = await shipped();
    const bill = `${nextSerial()}/RM/26-27`;
    const r = await one({ target: 'bill', po_id: poId, value: bill, date: '2026-09-03', expected: null });
    expect(r).toMatchObject({ index: 0, target: 'bill', po_id: poId, result: 'applied', old: null, new: bill });

    const po = await poRow(poId);
    expect(po).toMatchObject({ bill_no: bill, bill_date: '2026-09-03' });
    expect(Number(po.updated_by)).toBe(tallySyncId);
    const audit = await lastAudit('ORDER_SUMMARY_AUTOFILL', 'entity_ref', poId);
    expect(Number(audit.user_id)).toBe(tallySyncId);
    expect(audit.entity_type).toBe('marketplace_po');
    expect(JSON.parse(audit.changes)).toEqual(expect.arrayContaining([
      { field: 'bill_no', old: null, new: bill }, { field: 'bill_date', old: null, new: '2026-09-03' },
    ]));
  });

  test('replaces the serial staff typed with the whole number, when it is still what RAMS read', async () => {
    const typed = nextSerial();
    const poId = await shipped({ bill: typed });
    const r = await one({ target: 'bill', po_id: poId, value: `${typed}/RM/26-27`, date: '2026-09-02', expected: typed, note: 'serial of the same invoice' });
    expect(r).toMatchObject({ result: 'applied', old: typed, new: `${typed}/RM/26-27` });
    expect((await poRow(poId)).bill_no).toBe(`${typed}/RM/26-27`);
    expect((await lastAudit('ORDER_SUMMARY_AUTOFILL', 'entity_ref', poId)).description).toMatch(/serial of the same invoice$/);
  });

  test('a person changed it since RAMS read it: refused, and their value stays', async () => {
    const poId = await shipped({ bill: nextSerial() });
    const theirs = nextSerial();
    await patchSummary(poId, { bill_no: theirs, bill_date: '2026-09-02' });
    const r = await one({ target: 'bill', po_id: poId, value: `${nextSerial()}/RM/26-27`, date: '2026-09-02', expected: 'what-RAMS-read' });
    expect(r.result).toBe('rejected');
    expect(r.reason).toMatch(/left for a person$/);
    expect((await poRow(poId)).bill_no).toBe(theirs);
  });

  test('already set: skipped, nothing written', async () => {
    const bill = `${nextSerial()}/RM/26-27`;
    const poId = await shipped({ bill });
    const r = await one({ target: 'bill', po_id: poId, value: bill, date: '2026-09-02', expected: bill });
    expect(r).toMatchObject({ result: 'skipped', reason: 'Already set' });
    expect(await lastAudit('ORDER_SUMMARY_AUTOFILL', 'entity_ref', poId)).toBeUndefined();
  });

  test('a number another PO already holds is refused', async () => {
    const bill = `${nextSerial()}/RM/26-27`;
    const holder = await shipped({ bill });
    const poId = await shipped();
    const r = await one({ target: 'bill', po_id: poId, value: bill, date: '2026-09-02', expected: null });
    expect(r).toMatchObject({ result: 'rejected', reason: `Bill no "${bill}" is already used on PO ${holder}` });
  });

  test('a deleted PO, a bad number or date, and a missing expected are refused', async () => {
    const deleted = await shipped();
    await db.execute({ sql: "UPDATE marketplace_pos SET status = 'Deleted' WHERE po_id = ?", args: [deleted] });
    const poId = await shipped();
    const res = await autofill([
      { target: 'bill', po_id: deleted, value: `${nextSerial()}/RM/26-27`, date: '2026-09-02', expected: null },
      { target: 'bill', po_id: poId, value: '607 RM', date: '2026-09-02', expected: null },
      { target: 'bill', po_id: poId, value: `${nextSerial()}/RM/26-27`, date: '02-09-2026', expected: null },
      { target: 'bill', po_id: poId, value: `${nextSerial()}/RM/26-27`, date: '2026-09-02' },
      { target: 'bill', po_id: 'NOPE999', value: `${nextSerial()}/RM/26-27`, date: '2026-09-02', expected: null },
    ]);
    expect(res.body.results.map((x) => x.reason)).toEqual([
      'PO is deleted',
      'Bill no may contain only letters, digits, dashes and slashes',
      'date must be a valid YYYY-MM-DD date',
      'expected is required — the value RAMS read (null for a blank field)',
      'PO not found',
    ]);
    expect(res.body).toMatchObject({ applied: 0, rejected: 5 });
    expect((await poRow(poId)).bill_no).toBeNull();
  });

  test('dry run reports what it would write and writes nothing', async () => {
    const poId = await shipped();
    const bill = `${nextSerial()}/RM/26-27`;
    const res = await autofill([{ target: 'bill', po_id: poId, value: bill, date: '2026-09-02', expected: null }], { dry_run: true });
    expect(res.body).toMatchObject({ dry_run: true, would_apply: 1, applied: 0 });
    expect(res.body.results[0]).toMatchObject({ result: 'would_apply', old: null, new: bill });
    expect((await poRow(poId)).bill_no).toBeNull();
    expect(await lastAudit('ORDER_SUMMARY_AUTOFILL', 'entity_ref', poId)).toBeUndefined();
  });

  test('a refused item never stops the rest of the batch', async () => {
    const good = await shipped();
    const bill = `${nextSerial()}/RM/26-27`;
    const res = await autofill([
      { target: 'nonsense', po_id: good },
      { target: 'bill', po_id: good, value: bill, date: '2026-09-02', expected: null },
    ]);
    expect(res.body.results.map((x) => x.result)).toEqual(['rejected', 'applied']);
    expect(res.body.results[0].reason).toBe('target must be one of bill, rtv_cn');
    expect((await poRow(good)).bill_no).toBe(bill);
  });

  test('the batch itself must be a non-empty list of at most 200', async () => {
    expect((await autofill([])).status).toBe(400);
    expect((await S(request(app).post('/api/integration/autofill')).send({})).status).toBe(400);
    expect((await autofill(Array.from({ length: 201 }, () => ({ target: 'bill' })))).status).toBe(400);
  });
});

describe('auto-fill: RTV Credit Note Number', () => {
  const returned = async () => {
    const poId = await shipped();
    expect((await patchSummary(poId, { grn_status: 'Returned to Vendor' })).status).toBe(200);
    const { rows } = await db.execute({ sql: 'SELECT id FROM rtv_returns WHERE po_id = ?', args: [poId] });
    return { poId, rtvId: Number(rows[0].id) };
  };

  test("fills a blank CN with Tally's credit note number, audited as Tally Sync", async () => {
    const { poId, rtvId } = await returned();
    const r = await one({ target: 'rtv_cn', po_id: poId, value: '841', date: '2026-08-19', expected: null });
    expect(r).toMatchObject({ result: 'applied', old: null, new: '841' });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM rtv_returns WHERE id = ?', args: [rtvId] });
    expect(row).toMatchObject({ cn_number: '841', cn_date: '2026-08-19' });
    expect(Number(row.updated_by)).toBe(tallySyncId);
    const audit = await lastAudit('RTV_AUTOFILL', 'entity_id', rtvId);
    expect(Number(audit.user_id)).toBe(tallySyncId);
    expect(audit.entity_type).toBe('rtv_return');
  });

  test('a DN - Disposed row takes no credit note', async () => {
    const { poId, rtvId } = await returned();
    expect((await A(request(app).patch(`/api/rtv/${rtvId}`)).send({ status: 'DN - Disposed' })).status).toBe(200);
    const r = await one({ target: 'rtv_cn', po_id: poId, value: '842', date: '2026-08-19', expected: null });
    expect(r.result).toBe('rejected');
    expect(r.reason).toMatch(/DN - Disposed — no credit note follows$/);
  });

  test('a row off the RTV page is closed to edits', async () => {
    const { poId } = await returned();
    await patchSummary(poId, { grn_status: 'Pending' });
    const r = await one({ target: 'rtv_cn', po_id: poId, value: '843', date: '2026-08-19', expected: null });
    expect(r.reason).toMatch(/closed to edits$/);
  });

  test("the RTV page's own rules hold: letters, digits and dashes, compare-and-set, a PO with no RTV row", async () => {
    const { poId, rtvId } = await returned();
    await A(request(app).patch(`/api/rtv/${rtvId}`)).send({ cn_number: 'TYPED-1', cn_date: '2026-08-20' });
    const noRtv = await shipped();
    const res = await autofill([
      { target: 'rtv_cn', po_id: poId, value: 'CN/844', date: '2026-08-19', expected: 'TYPED-1' },
      { target: 'rtv_cn', po_id: poId, value: '844', date: '2026-08-19', expected: null },
      { target: 'rtv_cn', po_id: noRtv, value: '845', date: '2026-08-19', expected: null },
    ]);
    expect(res.body.results.map((x) => x.reason)).toEqual([
      'Credit Note Number must be alphanumeric (dashes allowed)',
      'Credit Note Number is now "TYPED-1", not blank as RAMS read it — left for a person',
      'No RTV row for this PO',
    ]);
  });
});
