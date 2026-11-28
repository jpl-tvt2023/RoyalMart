const request = require('supertest');
const app = require('../app');
const { db } = require('./helpers/db');
const { entryFieldsError, FIELDS } = require('../src/services/balajiBuilty.service');

// Migration 108: Balaji Builty, the Builty sheet kept by hand. Every field is
// typed, ids are P001, P002 ... (never reused), Vendor is the one required
// field and the page's tabs are its distinct vendors, and Bill no is unique
// among live Balaji entries only.

let token;
const A = (r) => r.set('Authorization', `Bearer ${token}`);
const url = '/api/balaji-builty';
const add = (body) => A(request(app).post(url)).send(body);
const edit = (id, body) => A(request(app).patch(`${url}/${id}`)).send(body);
const del = (id) => A(request(app).delete(`${url}/${id}`));
const list = (query = {}) => A(request(app).get(url)).query(query);
const tabs = (query = {}) => A(request(app).get(`${url}/tabs`)).query(query);

const full = {
  po_date: '2026-11-20', vendor: 'Balaji Traders', party_name: 'Sharma Stores', vendor_po_id: 'BT-100',
  qty: '120', city: 'Mumbai', expiry_date: '2026-12-20', dispatch_date: '2026-11-22',
  courier: 'Delhivery', tracking_id: 'TRK-1', bill_no: '607/RM/26-27', bill_date: '2026-11-22',
};

beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = login.body.accessToken;
});

beforeEach(async () => {
  await db.execute('DELETE FROM balaji_builty');
  await db.execute("DELETE FROM audit_logs WHERE entity_type = 'balaji_builty'");
});

afterAll(async () => {
  await db.execute('DELETE FROM balaji_builty');
});

describe('Ids', () => {
  test('entries are numbered P001, P002 ... and every field is stored as typed', async () => {
    const a = await add(full);
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ ...full, po_id: 'P001', qty: 120, updated_by_name: expect.any(String) });
    const b = await add({ vendor: 'Other' });
    expect(b.status).toBe(201);
    expect(b.body.po_id).toBe('P002');
    // Blank fields are stored as NULL.
    expect(b.body.city).toBeNull();
    expect(b.body.qty).toBeNull();
  });

  test('a deleted entry keeps its number: the next one is not reused', async () => {
    await add({ vendor: 'V' });
    const second = await add({ vendor: 'V' });
    expect((await del(second.body.po_id)).status).toBe(200);
    expect((await add({ vendor: 'V' })).body.po_id).toBe('P003');
  });

  test('past P999 the serial keeps growing, and P1000 sorts after P999', async () => {
    await db.execute("INSERT INTO balaji_builty (po_id, vendor) VALUES ('P999', 'V')");
    const next = await add({ vendor: 'V' });
    expect(next.body.po_id).toBe('P1000');
    const asc = await list({ sort_by: 'po_id', sort_dir: 'asc', page: 1, page_size: 25 });
    expect(asc.body.rows.map(r => r.po_id)).toEqual(['P999', 'P1000']);
    // Default order: newest id first.
    expect((await list()).body.rows.map(r => r.po_id)).toEqual(['P1000', 'P999']);
  });

  test('the schema refuses an id that is not P + digits', async () => {
    await expect(db.execute("INSERT INTO balaji_builty (po_id, vendor) VALUES ('X001', 'V')")).rejects.toThrow();
  });
});

describe('Field rules', () => {
  test.each([
    [{}, 'Vendor is required'],
    [{ vendor: '   ' }, 'Vendor is required'],
    [{ vendor: 'V', po_date: '26-11-2026' }, 'Order Date is not a valid date'],
    [{ vendor: 'V', qty: '1.5' }, 'Quantity must be a whole number, 0 or more'],
    [{ vendor: 'V', qty: '-3' }, 'Quantity must be a whole number, 0 or more'],
    [{ vendor: 'V', city: 'x'.repeat(201) }, 'City must be at most 200 characters'],
    [{ vendor: 'V', bill_no: 'BN 1' }, 'Bill no may contain only letters, digits, dashes and slashes'],
    [{ vendor: 'V', bill_no: 'BN-1' }, 'Bill date is required when setting a bill no'],
    // Column order: Order Date is reported before Vendor.
    [{ po_date: 'bad' }, 'Order Date is not a valid date'],
  ])('%j -> %s', async (body, message) => {
    const res = await add(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
    expect(entryFieldsError(body)).toBe(message);
  });

  test('FIELDS is the grid order', () => {
    expect(FIELDS).toEqual([
      'po_date', 'vendor', 'party_name', 'vendor_po_id', 'qty', 'city',
      'expiry_date', 'dispatch_date', 'courier', 'tracking_id', 'bill_no', 'bill_date',
    ]);
  });
});

describe('Edit', () => {
  test('a PATCH changes only the fields sent, and History shows the diff', async () => {
    const { body: created } = await add(full);
    const res = await edit(created.po_id, { city: 'Pune', qty: '150' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ...full, qty: 150, city: 'Pune' });

    const history = await A(request(app).get('/api/audit-logs')).query({ entity_type: 'balaji_builty', entity_id: created.po_id });
    expect(history.body.map(h => h.action_type)).toEqual(['BALAJI_BUILTY_UPDATE', 'BALAJI_BUILTY_CREATE']);
    expect(history.body[0].changes).toEqual([
      { field: 'qty', old: 120, new: 150 },
      { field: 'city', old: 'Mumbai', new: 'Pune' },
    ]);
  });

  test('the rules run on the entry as saved: clearing Bill Date under a Bill no is refused', async () => {
    const { body: created } = await add(full);
    const res = await edit(created.po_id, { bill_date: '' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Bill date is required when setting a bill no');
    // Clearing both is fine.
    expect((await edit(created.po_id, { bill_no: '', bill_date: '' })).body).toMatchObject({ bill_no: null, bill_date: null });
  });

  test('an unchanged PATCH writes nothing', async () => {
    const { body: created } = await add(full);
    expect((await edit(created.po_id, { city: 'Mumbai' })).status).toBe(200);
    const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'balaji_builty' AND entity_ref = ?", args: [created.po_id] });
    expect(Number(rows[0].n)).toBe(1);
  });

  test('a missing or deleted entry is 404', async () => {
    expect((await edit('P404', { city: 'X' })).status).toBe(404);
    const { body: created } = await add({ vendor: 'V' });
    await del(created.po_id);
    expect((await edit(created.po_id, { city: 'X' })).status).toBe(404);
    expect((await del(created.po_id)).status).toBe(404);
  });
});

describe('Bill no', () => {
  test('unique among live entries: a clash is 409 naming the holder', async () => {
    const { body: first } = await add(full);
    const clash = await add({ vendor: 'V', bill_no: full.bill_no, bill_date: '2026-11-23' });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('bill_no_duplicate');
    expect(clash.body.conflicts).toEqual([{ po_id: first.po_id, vendor: full.vendor, vendor_po_id: full.vendor_po_id }]);

    const { body: second } = await add({ vendor: 'V' });
    const editClash = await edit(second.po_id, { bill_no: full.bill_no, bill_date: '2026-11-23' });
    expect(editClash.status).toBe(409);
    expect(editClash.body.conflicts.map(c => c.po_id)).toEqual([first.po_id]);
  });

  test('deleting an entry frees its bill no', async () => {
    const { body: first } = await add(full);
    await del(first.po_id);
    expect((await add({ vendor: 'V', bill_no: full.bill_no, bill_date: '2026-11-23' })).status).toBe(201);
  });

  test('not checked against the marketplace POs (Builty keeps its own numbers)', async () => {
    const { rows } = await db.execute('SELECT po_id FROM marketplace_pos LIMIT 1');
    if (!rows.length) return; // no PO in this run's DB to borrow a bill no from
    await db.execute({ sql: "UPDATE marketplace_pos SET bill_no = 'SHARED-1' WHERE po_id = ?", args: [rows[0].po_id] });
    try {
      expect((await add({ vendor: 'V', bill_no: 'SHARED-1', bill_date: '2026-11-23' })).status).toBe(201);
    } finally {
      await db.execute({ sql: 'UPDATE marketplace_pos SET bill_no = NULL WHERE po_id = ?', args: [rows[0].po_id] });
    }
  });
});

describe('List and tabs', () => {
  beforeEach(async () => {
    await add({ vendor: 'Zeta', po_date: '2026-11-01', city: 'Pune', courier: 'Blue Dart' });
    await add({ vendor: 'zeta', po_date: '2026-10-01', city: 'Mumbai' });
    await add({ vendor: 'Alpha', po_date: '2026-11-05', city: 'Pune', courier: 'Delhivery' });
    await add({ vendor: 'Alpha', po_date: '' }); // no Order Date
    const gone = await add({ vendor: 'Gone' });
    await del(gone.body.po_id);
  });

  test('one tab per vendor, ignoring case, named by its latest spelling; deleted entries are gone', async () => {
    const res = await tabs();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ all: 4, vendors: [{ vendor: 'Alpha', count: 2 }, { vendor: 'zeta', count: 2 }] });
    expect((await list({ vendor: 'ZETA' })).body.total).toBe(2);
    expect((await list()).body.total).toBe(4);
  });

  test('counts follow the filters, and a tab stays (at 0) when the filters empty it', async () => {
    const res = await tabs({ city: 'pune' });
    expect(res.body).toEqual({ all: 2, vendors: [{ vendor: 'Alpha', count: 1 }, { vendor: 'zeta', count: 1 }] });
    const none = await tabs({ courier: 'Nobody' });
    expect(none.body).toEqual({ all: 0, vendors: [{ vendor: 'Alpha', count: 0 }, { vendor: 'zeta', count: 0 }] });
    expect((await tabs({ courier: 'unassigned' })).body.all).toBe(2);
  });

  test('an undated entry matches any Order Date range, so it never vanishes on save', async () => {
    const res = await list({ po_date_from: '2026-11-01', po_date_to: '2026-11-30' });
    expect(res.body.rows.map(r => [r.vendor, r.po_date])).toEqual(
      expect.arrayContaining([['Zeta', '2026-11-01'], ['Alpha', '2026-11-05'], ['Alpha', null]]),
    );
    expect(res.body.total).toBe(3);
  });

  test('options are the values already used, once each, ignoring case', async () => {
    const res = await A(request(app).get(`${url}/options`));
    expect(res.status).toBe(200);
    expect(res.body.vendors.map(v => v.toLowerCase())).toEqual(['alpha', 'zeta']);
    expect(res.body.cities).toEqual(['Mumbai', 'Pune']);
    expect(res.body.couriers).toEqual(['Blue Dart', 'Delhivery']);
  });
});

describe('Vendor PO prefix', () => {
  test('P is reserved for Balaji Builty ids', async () => {
    const res = await A(request(app).post('/api/configurations/vendors')).send({ name: `PVendor ${Date.now()}`, po_prefix: 'P' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('PO Prefix "P" is reserved for Balaji Builty');
  });
});
