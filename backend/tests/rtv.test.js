const request = require('supertest');
const app = require('../app');
const { db } = require('./helpers/db');
const {
  QUALIFIES_SQL, EFFECTIVE_STATUS_SQL, rtvQualifies, effectiveStatus,
} = require('../src/services/rtv.service');

let token;
let adminId;
let courierId;
let inactiveCourierId;
let uidCounter = 0;
const uid = () => `${Date.now()}${uidCounter++}`;
const A = (r) => r.set('Authorization', `Bearer ${token}`);

const patchSummary = (poId, body) => A(request(app).patch(`/api/order-summary/${poId}`)).send(body);
const listRtv = (query = {}) => A(request(app).get('/api/rtv')).query({ page_size: 'all', ...query });
const patchRtv = (id, body) => A(request(app).patch(`/api/rtv/${id}`)).send(body);
const rtvFor = async (poId, query = {}) => (await listRtv(query)).body.rows.find(r => r.po_id === poId);

// A dispatched marketplace PO of 5 units, with a bill on it -- everything the
// RTV page reads off the Builty page is there to be read.
async function shipped(vendor = 'Blinkit') {
  const created = await A(request(app).post('/api/marketplace-pos')).send({
    vendor, vendor_po_id: `RTV-${uid()}`, po_date: '2026-09-01', city: 'Delhi',
    lines: [{ line_no: 1, item_code: 'ITEM-1', qty: 5 }],
  });
  expect(created.status).toBe(201);
  const poId = created.body.po_id;
  const closed = await patchSummary(poId, {
    status: 'Closed', dispatch_date: '2026-09-02', courier_id: courierId, tracking_id: `TRK${uid()}`,
    bill_no: `BILL${uid()}`, bill_date: '2026-09-02',
  });
  expect(closed.status).toBe(200);
  return poId;
}

const returned = (poId) => patchSummary(poId, { grn_status: 'Returned to Vendor' });
const short = (poId, dn = `DN${uid()}`) => patchSummary(poId, {
  grn_status: 'Delivered - GRN Received', grn_date: '2026-09-05', grn_qty: 3,
  grn_number: `GRN${uid()}`, discrepancy_qty: 2, discrepancy_number: dn,
});

beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = login.body.accessToken;
  adminId = login.body.user.id;
  await db.execute({ sql: "INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'Warehouse_POC')", args: [adminId] });
  for (const v of ['Blinkit', 'Scootsy']) {
    await db.execute({ sql: 'INSERT OR IGNORE INTO vendors (name, is_active, has_parser) VALUES (?, 1, 1)', args: [v] });
  }
  const c = await A(request(app).post('/api/couriers')).send({ name: `Courier ${uid()}` });
  courierId = c.body.id;
  const off = await A(request(app).post('/api/couriers')).send({ name: `Old Courier ${uid()}` });
  inactiveCourierId = off.body.id;
  await A(request(app).delete(`/api/couriers/${inactiveCourierId}`));
});

describe('Which POs are on the RTV page', () => {
  test('a shipment returned to vendor opens an RTV row, read live off the PO', async () => {
    const poId = await shipped();
    expect(await rtvFor(poId)).toBeUndefined();
    expect((await returned(poId)).status).toBe(200);

    const row = await rtvFor(poId);
    expect(row.rtv_no).toMatch(/^BR\d{3}$/);
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM marketplace_pos WHERE po_id = ?', args: [poId] });
    expect(row).toMatchObject({
      po_id: poId, outward_tracking_id: po.tracking_id, bill_no: po.bill_no, city: 'Delhi',
      po_qty: 5, rtv_dn: null, status: null,
    });
    expect(row.outward_courier_name).toBeTruthy();
  });

  test('a discrepancy opens one too, and shows DN - Yes until someone picks a status', async () => {
    const poId = await shipped();
    expect((await short(poId, 'DN-777')).status).toBe(200);
    const row = await rtvFor(poId);
    expect(row).toMatchObject({ rtv_dn: 'DN-777', status: 'DN - Yes', stored_status: null });
  });

  test('a PO that was neither stays off the page', async () => {
    const poId = await shipped();
    await patchSummary(poId, { grn_status: 'Out For Delivery' });
    expect(await rtvFor(poId)).toBeUndefined();
    const { rows } = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM rtv_returns WHERE po_id = ?', args: [poId] });
    expect(rows[0].n).toBe(0);
  });

  test('numbers run per vendor letter and are never reused', async () => {
    const a = await shipped('Blinkit');
    const b = await shipped('Blinkit');
    const s = await shipped('Scootsy');
    await returned(a); await returned(b); await returned(s);
    const [ra, rb, rs] = [await rtvFor(a), await rtvFor(b), await rtvFor(s)];
    const serial = (no) => Number(no.slice(2));
    expect(serial(rb.rtv_no)).toBe(serial(ra.rtv_no) + 1);
    expect(rs.rtv_no).toMatch(/^SR\d{3}$/);
  });

  test('a PO that stops qualifying drops off with its details kept, and comes back with them', async () => {
    const poId = await shipped();
    await returned(poId);
    const before = await rtvFor(poId);
    expect((await patchRtv(before.id, { inward_tracking_id: 'IN-TRK-1' })).status).toBe(200);

    await patchSummary(poId, { grn_status: 'Pending' });
    expect(await rtvFor(poId)).toBeUndefined();
    // The GRN page highlight goes with it.
    const summary = await A(request(app).get('/api/order-summary')).query({ po_id: poId, page_size: 'all' });
    expect(summary.body.rows[0]).toMatchObject({ in_rtv: 0, rtv_no: before.rtv_no });
    // And an off-page row cannot be edited.
    const refused = await patchRtv(before.id, { inward_tracking_id: 'X' });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/no longer returned or short/);

    await returned(poId);
    const after = await rtvFor(poId);
    expect(after).toMatchObject({ id: before.id, rtv_no: before.rtv_no, inward_tracking_id: 'IN-TRK-1' });
  });

  test('the GRN list marks rows that are on the RTV page', async () => {
    const poId = await shipped();
    await returned(poId);
    const summary = await A(request(app).get('/api/order-summary')).query({ po_id: poId, page_size: 'all' });
    expect(summary.body.rows[0].in_rtv).toBe(1);
    expect(summary.body.rows[0].rtv_no).toMatch(/^BR/);
  });

  test('a deleted PO leaves the page', async () => {
    const poId = await shipped();
    await returned(poId);
    expect(await rtvFor(poId)).toBeTruthy();
    await A(request(app).delete(`/api/marketplace-pos/${poId}`));
    expect(await rtvFor(poId)).toBeUndefined();
  });
});

describe('Editing an RTV row', () => {
  async function openRow({ discrepancy = false } = {}) {
    const poId = await shipped();
    if (discrepancy) await short(poId); else await returned(poId);
    return rtvFor(poId);
  }

  test('RTV Booked needs a credit note, and a credit note needs its date', async () => {
    const row = await openRow();
    const booked = await patchRtv(row.id, { status: 'RTV Booked' });
    expect(booked.status).toBe(400);
    expect(booked.body.message).toBe('Credit Note Number is required when the status is RTV Booked');

    const noDate = await patchRtv(row.id, { status: 'RTV Booked', cn_number: 'CN-1' });
    expect(noDate.status).toBe(400);
    expect(noDate.body.message).toBe('CN Date is required when a Credit Note Number is entered');

    const ok = await patchRtv(row.id, { status: 'RTV Booked', cn_number: 'CN-1', cn_date: '2026-09-10' });
    expect(ok.status).toBe(200);
    expect(await rtvFor(row.po_id)).toMatchObject({ status: 'RTV Booked', cn_number: 'CN-1', cn_date: '2026-09-10' });
  });

  test('Delivered Yes needs its date, and anything else clears it', async () => {
    const row = await openRow();
    const noDate = await patchRtv(row.id, { delivered: 'Yes' });
    expect(noDate.status).toBe(400);
    expect(noDate.body.message).toBe('Delivery Date is required when Delivered is Yes');

    expect((await patchRtv(row.id, { delivered: 'Yes', delivery_date: '2026-09-12' })).status).toBe(200);
    expect((await patchRtv(row.id, { delivered: 'No' })).status).toBe(200);
    expect(await rtvFor(row.po_id)).toMatchObject({ delivered: 'No', delivery_date: null });
  });

  test('DN - Disposed clears every column after it, and the history keeps them', async () => {
    const row = await openRow({ discrepancy: true });
    await patchRtv(row.id, {
      inward_courier_id: courierId, inward_tracking_id: 'IN-1', delivered: 'Yes', delivery_date: '2026-09-12',
      cn_number: 'CN-9', cn_date: '2026-09-13', checked_by: adminId,
    });
    const disposed = await patchRtv(row.id, { status: 'DN - Disposed' });
    expect(disposed.status).toBe(200);
    expect(await rtvFor(row.po_id)).toMatchObject({
      status: 'DN - Disposed', inward_courier_id: null, inward_tracking_id: null, delivered: null,
      delivery_date: null, cn_number: null, cn_date: null, checked_by: null,
    });
    const audit = await A(request(app).get('/api/audit-logs')).query({ entity_type: 'rtv_return', entity_id: row.id });
    const entry = audit.body.find(e => e.action_type === 'RTV_UPDATE' && /Disposed/.test(e.description));
    expect(entry.changes.some(c => c.field === 'cn_number' && c.old === 'CN-9' && c.new == null)).toBe(true);
  });

  test('the DN is typed here only when the GRN page has none', async () => {
    const returnedRow = await openRow();
    expect((await patchRtv(returnedRow.id, { dn_number: 'DN-R1' })).status).toBe(200);
    // A DN arriving makes the derived status DN - Yes.
    expect(await rtvFor(returnedRow.po_id)).toMatchObject({ rtv_dn: 'DN-R1', status: 'DN - Yes' });

    const shortRow = await openRow({ discrepancy: true });
    const refused = await patchRtv(shortRow.id, { dn_number: 'DN-X' });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe('This row takes its DN from the GRN page — edit it there');
  });

  test('field rules: alphanumeric references, active couriers, Warehouse POCs, known values', async () => {
    const row = await openRow();
    expect((await patchRtv(row.id, { inward_tracking_id: 'has space' })).body.message)
      .toBe('Inward Tracking ID must be alphanumeric (dashes allowed)');
    expect((await patchRtv(row.id, { inward_courier_id: inactiveCourierId })).body.message)
      .toBe('Inward Channel Partner is inactive');
    expect((await patchRtv(row.id, { status: 'Lost' })).body.message)
      .toBe('Status must be one of RTV Booked, DN - Yes, DN - Disposed');
    expect((await patchRtv(row.id, { delivered: 'Maybe' })).body.message).toBe('Delivered must be Yes or No');

    const { rows: [untagged] } = await db.execute(`SELECT id FROM users
      WHERE id NOT IN (SELECT user_id FROM user_roles WHERE role = 'Warehouse_POC') LIMIT 1`);
    expect((await patchRtv(row.id, { checked_by: untagged.id })).body.message)
      .toBe('Checked Warehouse POC must be a user tagged Warehouse_POC');
    expect((await patchRtv(row.id, { checked_by: adminId })).status).toBe(200);
  });

  test('every edit is audited with a field diff', async () => {
    const row = await openRow();
    await patchRtv(row.id, { inward_tracking_id: 'AUD-1' });
    const audit = await A(request(app).get('/api/audit-logs')).query({ entity_type: 'rtv_return', entity_id: row.id });
    expect(audit.body.some(e => e.action_type === 'RTV_CREATE')).toBe(true);
    const upd = audit.body.find(e => e.action_type === 'RTV_UPDATE');
    expect(upd.changes).toEqual([expect.objectContaining({ field: 'inward_tracking_id', new: 'AUD-1' })]);
  });
});

describe('Filtering the RTV page', () => {
  test('by vendor, status (blank included), search and date ranges, with matching counts', async () => {
    const blank = await shipped();
    await returned(blank);
    const dn = await shipped();
    await short(dn, `DNF${uid()}`);
    const booked = await shipped();
    await returned(booked);
    const bookedRow = await rtvFor(booked);
    await patchRtv(bookedRow.id, { status: 'RTV Booked', cn_number: 'CNF1', cn_date: '2026-08-15' });

    const ids = async (query) => (await listRtv({ vendor: 'Blinkit', ...query })).body.rows.map(r => r.po_id);
    expect(await ids({ status: '__blank__' })).toContain(blank);
    expect(await ids({ status: '__blank__' })).not.toContain(dn);
    expect(await ids({ status: 'DN - Yes' })).toContain(dn);
    expect(await ids({ status: '__none_selected__' })).toEqual([]);
    expect(await ids({ q: bookedRow.rtv_no })).toEqual([booked]);
    expect(await ids({ cn_date_from: '2026-08-01', cn_date_to: '2026-08-31' })).toContain(booked);
    expect(await ids({ cn_date_from: '2026-09-01' })).not.toContain(booked);

    const counts = await A(request(app).get('/api/rtv/counts-by-vendor')).query({ status: 'RTV Booked' });
    const listed = await listRtv({ vendor: 'Blinkit', status: 'RTV Booked' });
    expect(counts.body.counts.Blinkit).toBe(listed.body.total);
  });
});

// The SQL halves filter and page in the database; the JS halves label one row
// and tell the GRN page whether a save takes a row off. Pinned together here.
describe('RTV SQL/JS parity', () => {
  test('qualification and effective status agree on every row', async () => {
    const { rows } = await db.execute(`
      SELECT p.status, p.grn_status, p.discrepancy_qty, p.discrepancy_number AS grn_dn,
             r.dn_number, r.status AS stored_status,
             CASE WHEN ${QUALIFIES_SQL} THEN 1 ELSE 0 END AS q_sql,
             ${EFFECTIVE_STATUS_SQL} AS s_sql
        FROM rtv_returns r JOIN marketplace_pos p ON p.po_id = r.po_id`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(rtvQualifies(r) ? 1 : 0).toBe(r.q_sql);
      expect(effectiveStatus({ status: r.stored_status, grn_dn: r.grn_dn, dn_number: r.dn_number })).toBe(r.s_sql);
    }
  });

  test.each([
    [{ status: null, grn_dn: 'DN1', dn_number: null }, 'DN - Yes'],
    [{ status: null, grn_dn: '  ', dn_number: 'DN2' }, 'DN - Yes'],
    [{ status: null, grn_dn: null, dn_number: null }, null],
    [{ status: 'RTV Booked', grn_dn: 'DN1', dn_number: null }, 'RTV Booked'],
  ])('effective status of %j is %j', (row, expected) => {
    expect(effectiveStatus(row)).toBe(expected);
  });
});

afterAll(async () => {
  await db.execute('DELETE FROM rtv_returns');
});
