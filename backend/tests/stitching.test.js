const request = require('supertest');
const app = require('../app');
const { db } = require('./helpers/db');

let token;
let warehousePocId;
let untaggedUserId;
let prefixes;

const uid = () => Math.random().toString(36).slice(2, 8);
const A = (r) => r.set('Authorization', `Bearer ${token}`);

const api = {
  listStage: (query = {}) => A(request(app).get('/api/stitching').query({ page_size: 'all', ...query })),
  forward: (body) => A(request(app).post('/api/stitching')).send(body),
  patchLot: (id, body) => A(request(app).patch(`/api/stitching/${id}`)).send(body),
  deleteLot: (id) => A(request(app).delete(`/api/stitching/${id}`)),
  restoreLot: (id) => A(request(app).post(`/api/stitching/${id}/restore`)),
  listPrefixes: () => A(request(app).get('/api/configurations/stitching-prefixes')),
  createPrefix: (body) => A(request(app).post('/api/configurations/stitching-prefixes')).send(body),
  patchPrefix: (id, body) => A(request(app).patch(`/api/configurations/stitching-prefixes/${id}`)).send(body),
  deletePrefix: (id) => A(request(app).delete(`/api/configurations/stitching-prefixes/${id}`)),
};

// Build a vendor + PO + line, then return the ids a receipt needs.
async function setupLine(qty = 1000) {
  const vendor = await A(request(app).post('/api/outbound-vendors')).send({
    name: `Stitch Vend ${uid()}`,
    articles: [{ category: 'Raw Material', item_name: 'Caps' }],
  });
  const po = await A(request(app).post('/api/outbound-pos')).send({
    vendor_id: vendor.body.id,
    po_date: '2026-09-05',
    approved_by: warehousePocId,
    approval_date: '2026-09-05',
    lines: [{ line_no: 1, category: 'Raw Material', item_name: 'Caps', qty, rate: 50 }],
  });
  const detail = await A(request(app).get(`/api/outbound-pos/${po.body.id}`));
  return { poId: po.body.id, lineId: detail.body.lines[0].id, vendorName: vendor.body.name };
}

function receiptBody(overrides = {}) {
  return {
    received_qty: 100,
    received_rate: 50,
    bill_no: `B-${uid()}`,
    checked_by: warehousePocId,
    ...overrides,
  };
}

const postReceipt = (poId, lineId, body) =>
  A(request(app).post(`/api/outbound-pos/${poId}/lines/${lineId}/receipts`)).send(receiptBody(body));

const patchReceipt = (poId, lineId, receiptId, body) =>
  A(request(app).patch(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${receiptId}`)).send(body);

const getReceipt = async (poId, receiptId) => {
  const detail = await A(request(app).get(`/api/outbound-pos/${poId}`));
  return detail.body.lines[0].receipts.find(r => r.id === receiptId);
};

// A Gray lot of `qty` metres at rate 50 + process 5, so its after rate is 55.
async function grayLot({ qty = 100, process_rate = 5 } = {}) {
  const { poId, lineId, vendorName } = await setupLine(Math.max(qty, 1000));
  const receipt = await postReceipt(poId, lineId, {
    received_qty: qty,
    process_rate,
    incoming_no: `G-${uid()}`,
    incoming_prefix_id: prefixes.Gray.id,
  });
  return { poId, lineId, vendorName, receiptId: receipt.body.id };
}

const findLot = (rows, src, id) => rows.find(r => r.src === src && r.id === id);

beforeAll(async () => {
  const login = await request(app).post('/api/auth/login')
    .send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = login.body.accessToken;
  warehousePocId = login.body.user.id;

  // checked_by is validated with the strict userHasRole, so being Admin is not
  // enough. Tag the seeded admin rather than mint a user, matching the approach
  // in outboundPOs.test.js.
  await db.execute({
    sql: "INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'Warehouse_POC')",
    args: [warehousePocId],
  });
  const { rows: others } = await db.execute({
    sql: `SELECT id FROM users
          WHERE id NOT IN (SELECT user_id FROM user_roles WHERE role = 'Warehouse_POC')
          LIMIT 1`,
  });
  untaggedUserId = others[0].id;

  const list = await api.listPrefixes();
  prefixes = Object.fromEntries(list.body.map(p => [p.stage, p]));
});

// Every suite shares one database file under --runInBand, and several of them
// clear outbound_po_line_receipts in their own setup. stitching_entries holds
// foreign keys into that table, so rows left behind here turn an unrelated
// suite's resetTable into a FOREIGN KEY constraint failure. Clear the children
// first, deepest link last, so this suite cannot break whatever runs next.
afterAll(async () => {
  await db.execute('DELETE FROM stitching_entries');
});

describe('Stitching prefixes master', () => {
  test('migration 067 seeds one active prefix per stage', () => {
    expect(Object.keys(prefixes).sort()).toEqual(['Gray', 'Packed', 'Processed', 'Stitched']);
    for (const p of Object.values(prefixes)) expect(p.is_active).toBe(1);
  });

  test('a duplicate prefix code is a 409', async () => {
    const res = await api.createPrefix({ prefix: prefixes.Gray.prefix, stage: 'Gray' });
    expect(res.status).toBe(409);
  });

  test('the code is unique case-insensitively', async () => {
    const res = await api.createPrefix({ prefix: prefixes.Gray.prefix.toLowerCase(), stage: 'Gray' });
    expect(res.status).toBe(409);
  });

  test('an unknown stage is rejected', async () => {
    const res = await api.createPrefix({ prefix: `Z${uid()}`, stage: 'Washed' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Stage must be one of/);
  });

  test('several prefixes may map to the same stage', async () => {
    const res = await api.createPrefix({ prefix: `GY${uid()}`, stage: 'Gray' });
    expect(res.status).toBe(201);
    expect(res.body.stage).toBe('Gray');
  });

  test('renaming an in-use prefix is allowed — it is display-only', async () => {
    const created = await api.createPrefix({ prefix: `RN${uid()}`, stage: 'Gray' });
    const { poId, lineId } = await setupLine();
    await postReceipt(poId, lineId, { incoming_no: 'R-1', incoming_prefix_id: created.body.id });

    const renamed = `RN2${uid()}`;
    const res = await api.patchPrefix(created.body.id, { prefix: renamed });
    expect(res.status).toBe(200);
    expect(res.body.prefix).toBe(renamed);
  });

  test('re-staging an in-use prefix is refused', async () => {
    const created = await api.createPrefix({ prefix: `RS${uid()}`, stage: 'Gray' });
    const { poId, lineId } = await setupLine();
    await postReceipt(poId, lineId, { incoming_no: 'R-2', incoming_prefix_id: created.body.id });

    const res = await api.patchPrefix(created.body.id, { stage: 'Packed' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/were received under it/);
  });

  test('re-staging an unused prefix is fine', async () => {
    const created = await api.createPrefix({ prefix: `RU${uid()}`, stage: 'Gray' });
    const res = await api.patchPrefix(created.body.id, { stage: 'Packed' });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('Packed');
  });

  test('deactivating an in-use prefix is allowed, but it cannot be used again', async () => {
    const created = await api.createPrefix({ prefix: `DA${uid()}`, stage: 'Gray' });
    const { poId, lineId } = await setupLine();
    const receipt = await postReceipt(poId, lineId, { incoming_no: 'D-1', incoming_prefix_id: created.body.id });

    const del = await api.deletePrefix(created.body.id);
    expect(del.status).toBe(200);
    expect(del.body.is_active).toBe(0);

    // The receipt that already carries it still resolves for display.
    const still = await getReceipt(poId, receipt.body.id);
    expect(still.incoming_stage).toBe('Gray');

    const reuse = await postReceipt(poId, lineId, { incoming_no: 'D-2', incoming_prefix_id: created.body.id });
    expect(reuse.status).toBe(400);
    expect(reuse.body.message).toMatch(/is inactive/);
  });

  test('in_use counts live lots only', async () => {
    const created = await api.createPrefix({ prefix: `IU${uid()}`, stage: 'Gray' });
    const { poId, lineId } = await setupLine();
    const receipt = await postReceipt(poId, lineId, { incoming_no: 'U-1', incoming_prefix_id: created.body.id });

    let list = await api.listPrefixes();
    expect(list.body.find(p => p.id === created.body.id).in_use).toBe(1);

    await A(request(app).delete(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${receipt.body.id}`));
    list = await api.listPrefixes();
    expect(list.body.find(p => p.id === created.body.id).in_use).toBe(0);
  });
});

describe('Receipt rate fields', () => {
  test('after_rate defaults to billed + process when omitted', async () => {
    const { poId, lineId } = await setupLine();
    const created = await postReceipt(poId, lineId, { received_rate: 50, process_rate: 5 });
    const receipt = await getReceipt(poId, created.body.id);
    expect(receipt.after_rate).toBe(55);
  });

  test('after_rate can be overridden and the override is what is stored', async () => {
    const { poId, lineId } = await setupLine();
    const created = await postReceipt(poId, lineId, { received_rate: 50, process_rate: 5, after_rate: 60 });
    const receipt = await getReceipt(poId, created.body.id);
    expect(receipt.after_rate).toBe(60);
  });

  test('a process rate of 0 is accepted — a Gray lot has had nothing done to it', async () => {
    const { poId, lineId } = await setupLine();
    const created = await postReceipt(poId, lineId, { received_rate: 50, process_rate: 0 });
    expect(created.status).toBe(201);
    const receipt = await getReceipt(poId, created.body.id);
    expect(receipt.process_rate).toBe(0);
    expect(receipt.after_rate).toBe(50);
  });

  test.each([
    ['process_rate', 1.005],
    ['after_rate', 99.999],
  ])('%s is rejected beyond 2 decimal places', async (field, value) => {
    const { poId, lineId } = await setupLine();
    const res = await postReceipt(poId, lineId, { [field]: value });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at most 2 decimal places/);
  });

  test('a negative process rate is rejected', async () => {
    const { poId, lineId } = await setupLine();
    const res = await postReceipt(poId, lineId, { process_rate: -1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/>= 0/);
  });

  test('0.29 is accepted — float representation must not fail the 2dp check', async () => {
    const { poId, lineId } = await setupLine();
    const res = await postReceipt(poId, lineId, { process_rate: 0.29 });
    expect(res.status).toBe(201);
  });

  test('after_rate keeps following process_rate until the user pins it', async () => {
    const { poId, lineId } = await setupLine();
    const created = await postReceipt(poId, lineId, { received_rate: 50, process_rate: 5 });
    await patchReceipt(poId, lineId, created.body.id, { process_rate: 9 });
    expect((await getReceipt(poId, created.body.id)).after_rate).toBe(59);

    await patchReceipt(poId, lineId, created.body.id, { after_rate: 100 });
    await patchReceipt(poId, lineId, created.body.id, { process_rate: 3 });
    expect((await getReceipt(poId, created.body.id)).after_rate).toBe(100);
  });

  test('a prefix with no incoming number is refused', async () => {
    const { poId, lineId } = await setupLine();
    const res = await postReceipt(poId, lineId, { incoming_prefix_id: prefixes.Gray.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Incoming No is required/);
  });

  test('an incoming number with no prefix is allowed — that is the legacy shape', async () => {
    const { poId, lineId } = await setupLine();
    const res = await postReceipt(poId, lineId, { incoming_no: 'IN-legacy' });
    expect(res.status).toBe(201);
  });

  test('an unknown prefix is refused', async () => {
    const { poId, lineId } = await setupLine();
    const res = await postReceipt(poId, lineId, { incoming_no: 'IN-1', incoming_prefix_id: 999999 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/prefix not found/);
  });

  test('challan_no round-trips', async () => {
    const { poId, lineId } = await setupLine();
    const created = await postReceipt(poId, lineId, { challan_no: '  CH-9  ' });
    expect((await getReceipt(poId, created.body.id)).challan_no).toBe('CH-9');
  });
});

describe('Stitching page — lots and stages', () => {
  test('a receipt with a Gray prefix appears on the Gray tab and nowhere else', async () => {
    const { receiptId } = await grayLot();
    const gray = await api.listStage({ stage: 'Gray' });
    expect(findLot(gray.body.rows, 'receipt', receiptId)).toBeTruthy();

    for (const stage of ['Processed', 'Stitched', 'Packed']) {
      const res = await api.listStage({ stage });
      expect(findLot(res.body.rows, 'receipt', receiptId)).toBeFalsy();
    }
  });

  test('a receipt with no prefix appears on no tab at all', async () => {
    const { poId, lineId } = await setupLine();
    const created = await postReceipt(poId, lineId, { incoming_no: 'NOSTAGE-1' });
    const all = await api.listStage();
    expect(findLot(all.body.rows, 'receipt', created.body.id)).toBeFalsy();
  });

  test('an origin lot carries its article, PO and vendor through', async () => {
    const { receiptId, poId, vendorName } = await grayLot();
    const gray = await api.listStage({ stage: 'Gray' });
    const lot = findLot(gray.body.rows, 'receipt', receiptId);
    expect(lot.item_name).toBe('Caps');
    expect(lot.po_order_no).toBe(String(poId).padStart(3, '0'));
    expect(lot.party_name).toBe(vendorName);
  });

  test('a fresh lot is Pending with full balance and can be forwarded', async () => {
    const { receiptId } = await grayLot({ qty: 100 });
    const gray = await api.listStage({ stage: 'Gray' });
    const lot = findLot(gray.body.rows, 'receipt', receiptId);
    expect(lot.status).toBe('Pending');
    expect(lot.balance).toBe(100);
    expect(lot.can_forward).toBe(true);
    expect(lot.next_stage).toBe('Processed');
  });

  test('a soft-deleted receipt drops off the page, and comes back on restore', async () => {
    const { poId, lineId, receiptId } = await grayLot();
    await A(request(app).delete(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${receiptId}`));
    let gray = await api.listStage({ stage: 'Gray' });
    expect(findLot(gray.body.rows, 'receipt', receiptId)).toBeFalsy();

    await A(request(app).post(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${receiptId}/restore`));
    gray = await api.listStage({ stage: 'Gray' });
    expect(findLot(gray.body.rows, 'receipt', receiptId)).toBeTruthy();
  });

  test('an unknown stage is rejected', async () => {
    const res = await api.listStage({ stage: 'Washed' });
    expect(res.status).toBe(400);
  });
});

describe('Forwarding through the stages', () => {
  test('sending part of a lot leaves it Partial with the balance reduced by what was SENT', async () => {
    const { receiptId } = await grayLot({ qty: 100 });
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dyeing House',
      sent_qty: 60, metre: 58, process_rate: 7, checked_by: warehousePocId,
    });
    expect(res.status).toBe(201);
    expect(res.body.stage).toBe('Processed');

    const gray = await api.listStage({ stage: 'Gray' });
    const parent = findLot(gray.body.rows, 'receipt', receiptId);
    expect(parent.status).toBe('Partial');
    // 40, not 42 — the 2 metres lost in processing belong to the child.
    expect(parent.balance).toBe(40);
  });

  test('the child records what actually arrived, and inherits the rate chain', async () => {
    const { receiptId } = await grayLot({ qty: 100, process_rate: 5 });
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dyeing House',
      sent_qty: 60, metre: 58, process_rate: 7, checked_by: warehousePocId,
    });
    const processed = await api.listStage({ stage: 'Processed' });
    const child = findLot(processed.body.rows, 'entry', res.body.id);
    expect(child.metre).toBe(58);
    expect(child.sent_qty).toBe(60);
    expect(child.rate).toBe(55);        // the Gray lot's after rate
    expect(child.after_rate).toBe(62);  // 55 + 7
    expect(child.item_name).toBe('Caps');
    expect(child.party_name).toBe('Dyeing House');
  });

  test('sending the whole balance leaves the parent Forwarded', async () => {
    const { receiptId } = await grayLot({ qty: 100 });
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 100, metre: 95, checked_by: warehousePocId,
    });
    const gray = await api.listStage({ stage: 'Gray' });
    const parent = findLot(gray.body.rows, 'receipt', receiptId);
    expect(parent.status).toBe('Forwarded');
    expect(parent.balance).toBe(0);
    expect(parent.can_forward).toBe(false);
  });

  test('a lot can be split across several forwards', async () => {
    const { receiptId } = await grayLot({ qty: 100 });
    for (const qty of [30, 30, 40]) {
      const res = await api.forward({
        parent_src: 'receipt', parent_id: receiptId, party_name: `P-${qty}`,
        sent_qty: qty, metre: qty, checked_by: warehousePocId,
      });
      expect(res.status).toBe(201);
    }
    const gray = await api.listStage({ stage: 'Gray' });
    expect(findLot(gray.body.rows, 'receipt', receiptId).status).toBe('Forwarded');

    const processed = await api.listStage({ stage: 'Processed' });
    const children = processed.body.rows.filter(r => r.parent_src === 'receipt' && r.parent_id === receiptId);
    expect(children).toHaveLength(3);
  });

  test('over-forwarding is refused', async () => {
    const { receiptId } = await grayLot({ qty: 100 });
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 100.01, metre: 100, checked_by: warehousePocId,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only 100 is left/);
  });

  test('the full Gray to Packed chain compounds the rate at every stage', async () => {
    const { receiptId } = await grayLot({ qty: 100, process_rate: 5 });
    const f1 = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye',
      sent_qty: 100, metre: 98, process_rate: 7, checked_by: warehousePocId,
    });
    const f2 = await api.forward({
      parent_src: 'entry', parent_id: f1.body.id, party_name: 'Stitch',
      sent_qty: 98, metre: 97, process_rate: 3, checked_by: warehousePocId,
    });
    const f3 = await api.forward({
      parent_src: 'entry', parent_id: f2.body.id, party_name: 'Pack',
      sent_qty: 97, metre: 97, process_rate: 2, checked_by: warehousePocId,
    });
    expect(f2.body.stage).toBe('Stitched');
    expect(f3.body.stage).toBe('Packed');

    const packed = await api.listStage({ stage: 'Packed' });
    const lot = findLot(packed.body.rows, 'entry', f3.body.id);
    expect(lot.rate).toBe(65);       // 50 + 5 + 7 + 3
    expect(lot.after_rate).toBe(67); // + 2
    expect(lot.status).toBe('Closed');
    expect(lot.can_forward).toBe(false);
    // The article survives three hops because origin_receipt_id is carried down.
    expect(lot.item_name).toBe('Caps');
  });

  test('a Packed lot cannot be forwarded further', async () => {
    const { receiptId } = await grayLot();
    let parent = { src: 'receipt', id: receiptId };
    for (const stage of ['Processed', 'Stitched', 'Packed']) {
      const res = await api.forward({
        parent_src: parent.src, parent_id: parent.id, party_name: 'P',
        sent_qty: 100, metre: 100, checked_by: warehousePocId,
      });
      expect(res.body.stage).toBe(stage);
      parent = { src: 'entry', id: res.body.id };
    }
    const res = await api.forward({
      parent_src: 'entry', parent_id: parent.id, party_name: 'P',
      sent_qty: 1, metre: 1, checked_by: warehousePocId,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already Packed/);
  });

  test('the stage is never taken from the request body', async () => {
    const { receiptId } = await grayLot();
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, metre: 10, checked_by: warehousePocId,
      stage: 'Packed',
    });
    expect(res.body.stage).toBe('Processed');
  });

  test('a prefix belonging to another stage is refused', async () => {
    const { receiptId } = await grayLot();
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, metre: 10, checked_by: warehousePocId,
      incoming_prefix_id: prefixes.Packed.id, incoming_no: 'X-1',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/belongs to the Packed stage/);
  });

  test('the prefix for the target stage is accepted', async () => {
    const { receiptId } = await grayLot();
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, metre: 10, checked_by: warehousePocId,
      incoming_prefix_id: prefixes.Processed.id, incoming_no: 'P-1',
    });
    expect(res.status).toBe(201);
  });

  test.each([
    [{ party_name: '' }, /Party Name is required/],
    [{ sent_qty: 0 }, /Sent Metre must be a number > 0/],
    [{ metre: -5 }, /Received Metre must be a number > 0/],
    [{ process_rate: 1.005 }, /at most 2 decimal places/],
  ])('rejects %j', async (override, matcher) => {
    const { receiptId } = await grayLot();
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, metre: 10, checked_by: warehousePocId, ...override,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(matcher);
  });

  test('checked_by must be tagged Warehouse_POC', async () => {
    const { receiptId } = await grayLot();
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, metre: 10, checked_by: untaggedUserId,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Warehouse_POC/);
  });

  test('an unknown parent is a 404', async () => {
    const res = await api.forward({
      parent_src: 'receipt', parent_id: 999999, party_name: 'P',
      sent_qty: 1, metre: 1, checked_by: warehousePocId,
    });
    expect(res.status).toBe(404);
  });

  test('a bad parent_src is a 400', async () => {
    const res = await api.forward({
      parent_src: 'nonsense', parent_id: 1, party_name: 'P',
      sent_qty: 1, metre: 1, checked_by: warehousePocId,
    });
    expect(res.status).toBe(400);
  });
});

describe('Integrity guards back on the receipt', () => {
  async function forwardedGrayLot() {
    const lot = await grayLot({ qty: 100 });
    const child = await api.forward({
      parent_src: 'receipt', parent_id: lot.receiptId, party_name: 'Dye',
      sent_qty: 60, metre: 58, checked_by: warehousePocId,
    });
    return { ...lot, childId: child.body.id };
  }

  test('a receipt with forwarded lots cannot be deleted', async () => {
    const { poId, lineId, receiptId } = await forwardedGrayLot();
    const res = await A(request(app).delete(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${receiptId}`));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/forwarded from it/);
  });

  test('its received qty cannot drop below what has been forwarded', async () => {
    const { poId, lineId, receiptId } = await forwardedGrayLot();
    const res = await patchReceipt(poId, lineId, receiptId, { received_qty: 50 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already forwarded/);
  });

  test('but it can still be reduced to exactly what was forwarded', async () => {
    const { poId, lineId, receiptId } = await forwardedGrayLot();
    const res = await patchReceipt(poId, lineId, receiptId, { received_qty: 60 });
    expect(res.status).toBe(200);
  });

  test('its stage cannot be changed once anything has been forwarded', async () => {
    const { poId, lineId, receiptId } = await forwardedGrayLot();
    const res = await patchReceipt(poId, lineId, receiptId, { incoming_prefix_id: prefixes.Stitched.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/change the receipt/);
  });

  test('swapping to another prefix for the SAME stage is still allowed', async () => {
    const { poId, lineId, receiptId } = await forwardedGrayLot();
    const alt = await api.createPrefix({ prefix: `ALT${uid()}`, stage: 'Gray' });
    const res = await patchReceipt(poId, lineId, receiptId, { incoming_prefix_id: alt.body.id });
    expect(res.status).toBe(200);
  });

  test('correcting the receipt rate flows down the chain', async () => {
    const { poId, lineId, receiptId, childId } = await forwardedGrayLot();
    await patchReceipt(poId, lineId, receiptId, { received_rate: 80 });
    const processed = await api.listStage({ stage: 'Processed' });
    // 80 + the 5 process rate grayLot() sets = 85 carried in, not the old 55.
    expect(findLot(processed.body.rows, 'entry', childId).rate).toBe(85);
  });
});

describe('Editing and deleting a stage lot', () => {
  async function chain() {
    const { receiptId } = await grayLot({ qty: 100 });
    const mid = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye',
      sent_qty: 60, metre: 58, process_rate: 7, checked_by: warehousePocId,
    });
    const leaf = await api.forward({
      parent_src: 'entry', parent_id: mid.body.id, party_name: 'Stitch',
      sent_qty: 50, metre: 50, checked_by: warehousePocId,
    });
    return { receiptId, midId: mid.body.id, leafId: leaf.body.id };
  }

  test('a lot with children cannot be deleted', async () => {
    const { midId } = await chain();
    const res = await api.deleteLot(midId);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/forwarded from it/);
  });

  test('a leaf can be deleted, which returns the balance to its parent', async () => {
    const { midId, leafId } = await chain();
    expect(await api.deleteLot(leafId).then(r => r.status)).toBe(200);
    const processed = await api.listStage({ stage: 'Processed' });
    const mid = findLot(processed.body.rows, 'entry', midId);
    expect(mid.balance).toBe(58);
    expect(mid.status).toBe('Pending');
  });

  test('a deleted leaf can be restored', async () => {
    const { leafId } = await chain();
    await api.deleteLot(leafId);
    const res = await api.restoreLot(leafId);
    expect(res.status).toBe(200);
    const stitched = await api.listStage({ stage: 'Stitched' });
    expect(findLot(stitched.body.rows, 'entry', leafId)).toBeTruthy();
  });

  test('restoring is refused when the source has since been forwarded elsewhere', async () => {
    const { midId, leafId } = await chain();
    await api.deleteLot(leafId);
    // Take the freed 50 metres somewhere else, then try to bring the old lot back.
    await api.forward({
      parent_src: 'entry', parent_id: midId, party_name: 'Other',
      sent_qty: 58, metre: 58, checked_by: warehousePocId,
    });
    const res = await api.restoreLot(leafId);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only 0 is left on the source/);
  });

  test('sent_qty may grow into the parent balance but not past it', async () => {
    const { midId } = await chain();
    // Parent has 100, this lot took 60, so 100 is available to it.
    expect(await api.patchLot(midId, { sent_qty: 90 }).then(r => r.status)).toBe(200);
    const res = await api.patchLot(midId, { sent_qty: 120 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/is available on the source/);
  });

  test('metre cannot drop below what this lot has already forwarded', async () => {
    const { midId } = await chain();
    const res = await api.patchLot(midId, { metre: 10 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot be less than 50/);
  });

  test('editing process rate re-derives after rate until it is pinned', async () => {
    const { midId } = await chain();
    let res = await api.patchLot(midId, { process_rate: 10 });
    expect(res.body.after_rate).toBe(65); // 55 carried in + 10

    await api.patchLot(midId, { after_rate: 200 });
    res = await api.patchLot(midId, { process_rate: 1 });
    expect(res.body.after_rate).toBe(200);
  });
});

describe('Listing, filtering and sorting', () => {
  test('status filter narrows to matching lots', async () => {
    const { receiptId } = await grayLot({ qty: 100 });
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, metre: 10, checked_by: warehousePocId,
    });
    const res = await api.listStage({ stage: 'Gray', status: 'Partial' });
    expect(res.body.rows.length).toBeGreaterThan(0);
    expect(res.body.rows.every(r => r.status === 'Partial')).toBe(true);
    expect(findLot(res.body.rows, 'receipt', receiptId)).toBeTruthy();
  });

  test('an all-unticked status filter matches nothing', async () => {
    const res = await api.listStage({ stage: 'Gray', status: '__none_selected__' });
    expect(res.body.rows).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  test('incoming_no is searched as prefix+number, the way it is printed', async () => {
    const { poId, lineId } = await setupLine();
    const marker = `FIND${uid()}`;
    const created = await postReceipt(poId, lineId, {
      incoming_no: marker, incoming_prefix_id: prefixes.Gray.id,
    });
    const res = await api.listStage({ stage: 'Gray', incoming_no: `${prefixes.Gray.prefix}${marker}` });
    expect(findLot(res.body.rows, 'receipt', created.body.id)).toBeTruthy();
  });

  test('party name is a substring match', async () => {
    const { receiptId } = await grayLot();
    const party = `Unique Dyer ${uid()}`;
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: party,
      sent_qty: 10, metre: 10, checked_by: warehousePocId,
    });
    const res = await api.listStage({ stage: 'Processed', party_name: party.slice(7, 15) });
    expect(res.body.rows.some(r => r.party_name === party)).toBe(true);
  });

  test('paging reports a total larger than the page', async () => {
    const { receiptId } = await grayLot({ qty: 100 });
    for (const n of [10, 10, 10]) {
      await api.forward({
        parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
        sent_qty: n, metre: n, checked_by: warehousePocId,
      });
    }
    const res = await api.listStage({ stage: 'Processed', page_size: 10, page: 1 });
    expect(res.body.rows.length).toBeLessThanOrEqual(10);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.page_size).toBe(10);
  });

  test('the parties datalist offers vendors and previously typed processors', async () => {
    const { receiptId, vendorName } = await grayLot();
    const party = `Datalist Co ${uid()}`;
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: party,
      sent_qty: 10, metre: 10, checked_by: warehousePocId,
    });
    const res = await A(request(app).get('/api/stitching/parties'));
    expect(res.body).toContain(party);
    expect(res.body).toContain(vendorName);
  });
});

// The SQL CASE in stitching.service.js drives filtering and paging, the JS
// function labels rows; this pins them together the way the outbound PO flag
// parity test does for its predicates.
describe('Status SQL/JS parity', () => {
  const svc = require('../src/services/stitching.service');

  test.each([
    ['Gray', 100, 0, 'Pending'],
    ['Gray', 100, 60, 'Partial'],
    ['Gray', 100, 100, 'Forwarded'],
    ['Gray', 100, 99.999, 'Forwarded'],
    ['Processed', 50, 0, 'Pending'],
    ['Packed', 50, 0, 'Closed'],
    ['Packed', 50, 50, 'Closed'],
  ])('%s lot of %s with %s forwarded is %s', (stage, metre, forwarded, expected) => {
    expect(svc.computeStatus({ stage, metre, forwarded })).toBe(expected);
  });

  test('every row the API returns agrees with computeStatus', async () => {
    const { receiptId } = await grayLot({ qty: 100 });
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 40, metre: 40, checked_by: warehousePocId,
    });
    const res = await api.listStage();
    expect(res.body.rows.length).toBeGreaterThan(0);
    for (const r of res.body.rows) {
      expect(r.status).toBe(svc.computeStatus({ stage: r.stage, metre: r.metre, forwarded: r.forwarded }));
    }
  });
});

describe('Audit logging', () => {
  const auditFor = (entityType, entityId) => A(request(app).get('/api/audit-logs')
    .query({ entity_type: entityType, entity_id: entityId }));

  test('a forward writes a STITCHING_ENTRY_CREATE entry', async () => {
    const { receiptId } = await grayLot();
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Audited Co',
      sent_qty: 10, metre: 9, checked_by: warehousePocId,
    });
    const audit = await auditFor('stitching_entry', res.body.id);
    const rows = audit.body.rows || audit.body;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].action_type).toBe('STITCHING_ENTRY_CREATE');
    expect(rows[0].description).toMatch(/Audited Co/);
  });

  test('an edit records the individual field changes', async () => {
    const { receiptId } = await grayLot();
    const created = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Before Co',
      sent_qty: 10, metre: 10, checked_by: warehousePocId,
    });
    await api.patchLot(created.body.id, { party_name: 'After Co' });
    const audit = await auditFor('stitching_entry', created.body.id);
    const rows = audit.body.rows || audit.body;
    const update = rows.find(r => r.action_type === 'STITCHING_ENTRY_UPDATE');
    expect(update).toBeTruthy();
    const changes = typeof update.changes === 'string' ? JSON.parse(update.changes) : update.changes;
    expect(changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'party_name', new: 'After Co' })]),
    );
  });

  test('a prefix create is audited', async () => {
    const created = await api.createPrefix({ prefix: `AU${uid()}`, stage: 'Gray' });
    const audit = await auditFor('stitching_prefix', created.body.id);
    const rows = audit.body.rows || audit.body;
    expect(rows.some(r => r.action_type === 'STITCHING_PREFIX_CREATE')).toBe(true);
  });
});
