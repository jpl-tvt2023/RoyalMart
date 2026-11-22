const request = require('supertest');
const app = require('../app');
const { db } = require('./helpers/db');

// Migration 097: a marketplace PO id is the vendor's PO Prefix plus a serial
// counted per PREFIX. Until then it was the first letter of the name with a
// serial per vendor NAME, so Myntra's first PO came out as M001 -- Minutes' id
// -- and the insert died on the primary key (client, 2026-11-22).

let token;
let courierId;
let uidCounter = 0;
const uid = () => `${Date.now()}${uidCounter++}`;
const A = (r) => r.set('Authorization', `Bearer ${token}`);

const createPO = (vendor, extra = {}) => A(request(app).post('/api/marketplace-pos')).send({
  vendor, vendor_po_id: `VP-${uid()}`, po_date: '2026-11-13', city: 'Delhi',
  lines: [{ line_no: 1, item_code: 'ITEM-1', qty: 5 }], ...extra,
});
const serial = (poId) => Number(String(poId).replace(/^[A-Z]+/, ''));

const vendorsUrl = '/api/configurations/vendors';
const listVendors = async () => (await A(request(app).get(vendorsUrl))).body;
const addVendor = (body) => A(request(app).post(vendorsUrl)).send(body);
const editVendor = (id, body) => A(request(app).patch(`${vendorsUrl}/${id}`)).send(body);

const patchSummary = (poId, body) => A(request(app).patch(`/api/order-summary/${poId}`)).send(body);
// Dispatch and return a PO, which opens its RTV row. Returns the RTV number.
async function returnedRtvNo(vendor) {
  const created = await createPO(vendor);
  expect(created.status).toBe(201);
  const poId = created.body.po_id;
  expect((await patchSummary(poId, {
    status: 'Closed', dispatch_date: '2026-11-14', courier_id: courierId, tracking_id: `TRK${uid()}`, box: 1,
  })).status).toBe(200);
  expect((await patchSummary(poId, { grn_status: 'Returned to Vendor' })).status).toBe(200);
  const { rows } = await db.execute({ sql: 'SELECT rtv_no FROM rtv_returns WHERE po_id = ?', args: [poId] });
  return rows[0].rtv_no;
}

beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = login.body.accessToken;
  const c = await A(request(app).post('/api/couriers')).send({ name: `Courier ${uid()}` });
  courierId = c.body.id;
});

describe('Migration 097 backfill', () => {
  test('every seeded vendor keeps its first letter, and Myntra is MY with its parser', async () => {
    const byName = Object.fromEntries((await listVendors()).map(v => [v.name, v]));
    expect(byName.Minutes.po_prefix).toBe('M');
    expect(byName.Zepto.po_prefix).toBe('Z');
    expect(byName.Blinkit.po_prefix).toBe('B');
    expect(byName.Flipkart.po_prefix).toBe('F');
    expect(byName.Myntra).toMatchObject({ po_prefix: 'MY', has_parser: 1, is_active: 1 });
  });
});

describe('PO ids are minted per prefix', () => {
  test('Myntra counts its own MY series, and Minutes its M series, side by side', async () => {
    const my1 = (await createPO('Myntra')).body.po_id;
    const m1 = (await createPO('Minutes')).body.po_id;
    const my2 = (await createPO('Myntra')).body.po_id;
    const m2 = (await createPO('Minutes')).body.po_id;

    expect(my1).toMatch(/^MY\d{3,}$/);
    expect(m1).toMatch(/^M\d{3,}$/);
    expect(serial(my2)).toBe(serial(my1) + 1);
    expect(serial(m2)).toBe(serial(m1) + 1);
  });

  test("Myntra's appointment date from the file is kept at onboarding", async () => {
    const res = await createPO('Myntra', { appointment_date: '2026-11-20' });
    expect(res.status).toBe(201);
    const { rows } = await db.execute({
      sql: 'SELECT appointment_date FROM marketplace_pos WHERE po_id = ?', args: [res.body.po_id],
    });
    expect(rows[0].appointment_date).toBe('2026-11-20');
  });

  test('re-importing a PO keeps its id', async () => {
    const vendor_po_id = `VP-${uid()}`;
    const first = await createPO('Myntra', { vendor_po_id });
    const again = await createPO('Myntra', { vendor_po_id });
    expect(again.status).toBe(200);
    expect(again.body.po_id).toBe(first.body.po_id);
  });

  test('a vendor with no PO Prefix is told to set one, and no PO is written', async () => {
    const name = `Nameless ${uid()}`;
    await db.execute({ sql: 'INSERT INTO vendors (name, has_parser) VALUES (?, 0)', args: [name] });
    const res = await createPO(name);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(`Set a PO Prefix for ${name} under Configurations → Vendors first.`);
    const { rows } = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM marketplace_pos WHERE vendor = ?', args: [name] });
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe('RTV numbers follow the PO prefix', () => {
  test('a Myntra return is MYR..., and does not move the Minutes MR series', async () => {
    const mBefore = await returnedRtvNo('Minutes');
    const my = await returnedRtvNo('Myntra');
    const mAfter = await returnedRtvNo('Minutes');

    expect(mBefore).toMatch(/^MR\d{3,}$/);
    expect(my).toMatch(/^MYR\d{3,}$/);
    expect(serial(mAfter)).toBe(serial(mBefore) + 1);
  });
});

describe('Configurations → Vendors: PO Prefix', () => {
  test('is required, letters only, and upper-cased', async () => {
    const missing = await addVendor({ name: `V ${uid()}` });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toBe('PO Prefix is required');

    for (const bad of ['M1', 'ABCD', 'A-B']) {
      const res = await addVendor({ name: `V ${uid()}`, po_prefix: bad });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('PO Prefix must be 1 to 3 letters (A-Z)');
    }

    const ok = await addVendor({ name: `V ${uid()}`, po_prefix: ' qx ' });
    expect(ok.status).toBe(201);
    expect(ok.body.po_prefix).toBe('QX');
  });

  test('a prefix another vendor holds is refused, naming that vendor', async () => {
    const res = await addVendor({ name: `Myntra Now ${uid()}`, po_prefix: 'm' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('PO Prefix "M" is already used by Minutes');
  });

  test('can change until the vendor has a PO, then is fixed', async () => {
    const name = `V ${uid()}`;
    const { body: v } = await addVendor({ name, po_prefix: 'QA' });
    expect((await editVendor(v.id, { name, po_prefix: 'QB' })).body.po_prefix).toBe('QB');

    const po = await createPO(name);
    expect(po.status).toBe(201);
    expect(po.body.po_id).toBe('QB001');

    const locked = await editVendor(v.id, { name, po_prefix: 'QC' });
    expect(locked.status).toBe(409);
    expect(locked.body.message).toBe(`PO Prefix cannot change once "${name}" has POs`);

    // Re-saving the same prefix, or touching only other fields, is fine.
    expect((await editVendor(v.id, { name, po_prefix: 'qb' })).status).toBe(200);
    expect((await editVendor(v.id, { is_active: true })).status).toBe(200);

    const row = (await listVendors()).find(x => x.id === v.id);
    expect(row).toMatchObject({ po_prefix: 'QB', has_pos: 1 });
  });

  test('a vendor 097 left without a prefix can be given one', async () => {
    const name = `Orphan ${uid()}`;
    const { rows } = await db.execute({
      sql: 'INSERT INTO vendors (name, has_parser) VALUES (?, 0) RETURNING id', args: [name],
    });
    const res = await editVendor(rows[0].id, { name, po_prefix: 'QD' });
    expect(res.status).toBe(200);
    expect(res.body.po_prefix).toBe('QD');
    expect((await createPO(name)).body.po_id).toBe('QD001');
  });
});
