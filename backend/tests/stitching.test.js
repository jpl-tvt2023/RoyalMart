const request = require('supertest');
const app = require('../app');
const { db } = require('./helpers/db');

let token;
let warehousePocId;
let untaggedUserId;
let prefixes;

const uid = () => Math.random().toString(36).slice(2, 8);

// A challan number nobody else will use. Since migration 085 the pair
// (challan_no, party_name) is unique across the whole business, and this suite
// deliberately never resets stitching_entries -- so two tests that both reach
// for a tidy literal like 'C1' against the same party collide, and the second
// one fails on a duplicate rather than on what it was actually testing. Tests
// that assert ON the number capture this in a const, the rest just call it.
const challanNo = (tag = 'C') => `${tag}-${uid()}`;
const A = (r) => r.set('Authorization', `Bearer ${token}`);

const {
  DESTINATIONS, DOZEN_STAGES, STOCK_STAGE, EXIT_STAGE,
} = require('../src/services/stitching.service');

// The two destinations that ask who checked the goods over.
const CHECKER_STAGES = [STOCK_STAGE, EXIT_STAGE];

// The stage a parent lot is at, which decides both where a forward lands by
// default (its first destination, exactly what create() falls back to) and what
// unit a challan out of it is counted in.
async function parentStageOf(parentSrc, parentId) {
  if (parentId == null) return null;
  const { rows } = parentSrc === 'receipt'
    ? await db.execute({
      sql: `SELECT sp.stage FROM outbound_po_line_receipts r
              JOIN stitching_prefixes sp ON sp.id = r.incoming_prefix_id
             WHERE r.id = ?`,
      args: [parentId],
    })
    : await db.execute({ sql: 'SELECT stage FROM stitching_entries WHERE id = ?', args: [parentId] });
  return rows[0]?.stage || null;
}

const api = {
  listStage: (query = {}) => A(request(app).get('/api/stitching').query({ page_size: 'all', ...query })),
  // Adding a challan IS sending the lot on, so this is one call again. The
  // challan number defaults to a fresh one because it must be unique within a
  // lot -- a test that cares about the number passes its own.
  //
  // received_qty defaults to sent_qty: nothing short is the ordinary case, and
  // the tests that are about shortage say so explicitly.
  //
  // challan_type defaults to Fresh for the same reason the challan number does:
  // it is required on every dispatch, and only the tests that are ABOUT the
  // grade care which one. Those pass their own.
  forward: async (body) => {
    // Dozens are required wherever the goods land as countable pieces. Rather
    // than sprinkling a count through every chain-walking test that happens to
    // pass through Stitched or Packed, the fixture works out the destination the
    // same way the server does and supplies one. A test that is ABOUT the count
    // passes its own, and one that is about the count being MISSING passes null.
    const parentStage = await parentStageOf(body.parent_src, body.parent_id);
    const target = body.target_stage || (parentStage ? (DESTINATIONS[parentStage] || [])[0] || null : null);
    // Out of a lot that already counts dozens, a challan is dozens only: what
    // was sent IS what arrives. Chain-walking tests speak in one quantity, so
    // the fixture carries their sent_qty across as the dozens sent. A test that
    // is ABOUT the unit passes sent_dozens (or a stray sent_qty) itself.
    if (DOZEN_STAGES.includes(parentStage) && body.sent_dozens === undefined && !body.lines) {
      const { sent_qty: sentQty, received_qty: _r, received_dozens: _d, ...rest } = body;
      return A(request(app).post('/api/stitching')).send({
        challan_no: `CH-${uid()}`,
        challan_type: 'Fresh',
        ...(sentQty != null ? { sent_dozens: sentQty } : {}),
        ...(CHECKER_STAGES.includes(target) && body.checked_by === undefined
          ? { checked_by: warehousePocId } : {}),
        ...(target === STOCK_STAGE && body.panchal_incoming_no === undefined
          ? { panchal_incoming_no: `PCL-${uid()}` } : {}),
        ...rest,
      });
    }
    return A(request(app).post('/api/stitching')).send({
      challan_no: `CH-${uid()}`,
      challan_type: 'Fresh',
      ...(body.received_qty == null && body.sent_qty != null
        ? { received_qty: body.sent_qty } : {}),
      // A 1 m/dozen yield by default, so a chain-walking test's numbers carry on
      // unchanged once the lot starts counting dozens.
      ...(DOZEN_STAGES.includes(target) && body.received_dozens === undefined && !body.lines
        ? { received_dozens: body.received_qty ?? body.sent_qty ?? 12 } : {}),
      // Checked By is a real question at the two destinations where the goods
      // change hands for good -- the warehouse and the exit -- and is stamped
      // from the session everywhere else. Supplied here for the same reason the
      // dozen count is: so a test walking the chain does not have to know.
      ...(CHECKER_STAGES.includes(target) && body.checked_by === undefined
        ? { checked_by: warehousePocId } : {}),
      // Panchal files what it takes in under its own number.
      ...(target === STOCK_STAGE && body.panchal_incoming_no === undefined
        ? { panchal_incoming_no: `PCL-${uid()}` } : {}),
      ...body,
    });
  },
  writeOff: (body) => A(request(app).post('/api/stitching/write-off')).send(body),
  removeChallan: (id, reason) =>
    A(request(app).post(`/api/stitching/${id}/remove`)).send({ reason }),
  patchLot: (id, body) => A(request(app).patch(`/api/stitching/${id}`)).send(body),
  deleteLot: (id) => A(request(app).delete(`/api/stitching/${id}`)),
  restoreLot: (id) => A(request(app).post(`/api/stitching/${id}/restore`)),
  listParties: (query = {}) => A(request(app).get('/api/stitching/parties').query(query)),
  listPartyMaster: () => A(request(app).get('/api/configurations/stitching-parties')),
  createParty: (body) => A(request(app).post('/api/configurations/stitching-parties')).send(body),
  patchParty: (id, body) => A(request(app).patch(`/api/configurations/stitching-parties/${id}`)).send(body),
  deleteParty: (id) => A(request(app).delete(`/api/configurations/stitching-parties/${id}`)),
  listPrefixes: () => A(request(app).get('/api/configurations/stitching-prefixes')),
  createPrefix: (body) => A(request(app).post('/api/configurations/stitching-prefixes')).send(body),
  patchPrefix: (id, body) => A(request(app).patch(`/api/configurations/stitching-prefixes/${id}`)).send(body),
  deletePrefix: (id) => A(request(app).delete(`/api/configurations/stitching-prefixes/${id}`)),
  counts: (query = {}) => A(request(app).get('/api/stitching/stage-counts').query(query)),
  journey: (src, id) => A(request(app).get(`/api/stitching/journey/${src}/${id}`)),
  close: (src, id) => A(request(app).post(`/api/stitching/${src}/${id}/close`)),
  reopen: (src, id) => A(request(app).post(`/api/stitching/${src}/${id}/reopen`)),
};

// Build a vendor + PO + line, then return the ids a receipt needs.
async function setupLine(qty = 1000) {
  const vendor = await A(request(app).post('/api/outbound-vendors')).send({
    name: `Stitch Vend ${uid()}`,
    // Fabric, because only fabric travels the stage chain now -- the flag lives
    // on the product master and migration 076 sets it for these two names.
    articles: [{ category: 'Raw Material', item_name: 'Handkerchief - Bundle Fabric' }],
  });
  const po = await A(request(app).post('/api/outbound-pos')).send({
    vendor_id: vendor.body.id,
    po_date: '2026-09-05',
    approved_by: warehousePocId,
    approval_date: '2026-09-05',
    lines: [{ line_no: 1, category: 'Raw Material', item_name: 'Handkerchief - Bundle Fabric', qty, rate: 50 }],
  });
  const detail = await A(request(app).get(`/api/outbound-pos/${po.body.id}`));
  return { poId: po.body.id, lineId: detail.body.lines[0].id, vendorName: vendor.body.name };
}

// Every line in this suite is fabric, and a fabric receipt must name the stage
// it arrived at, its gate number and its metres. Tests that are ABOUT one of
// those being absent override it explicitly.
function receiptBody(overrides = {}) {
  return {
    received_qty: 100,
    received_rate: 50,
    bill_no: `B-${uid()}`,
    checked_by: warehousePocId,
    qty_in_metres: 100,
    incoming_no: `IN-${uid()}`,
    incoming_stage: 'Processing',
    ...overrides,
  };
}

const postReceipt = (poId, lineId, body) =>
  A(request(app).post(`/api/outbound-pos/${poId}/lines/${lineId}/receipts`)).send(receiptBody(body));

// Pin a SPECIFIC prefix onto a receipt, which the API deliberately cannot do:
// a receipt names a stage and the server picks the code. The prefix-master
// tests below are about rename/re-stage/deactivate rules, not about how a
// receipt chooses, so they reach for the column directly rather than bending
// the endpoint into offering a choice nobody should have.
const attachPrefix = (receiptId, prefixId) => db.execute({
  sql: 'UPDATE outbound_po_line_receipts SET incoming_prefix_id = ? WHERE id = ?',
  args: [prefixId, receiptId],
});

const patchReceipt = (poId, lineId, receiptId, body) =>
  A(request(app).patch(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${receiptId}`)).send(body);

const getReceipt = async (poId, receiptId) => {
  const detail = await A(request(app).get(`/api/outbound-pos/${poId}`));
  return detail.body.lines[0].receipts.find(r => r.id === receiptId);
};

// A Gray lot of `qty` metres at rate 50 + process 5, so its after rate is 55.
//
// received_qty is the taga delivered and qty_in_metres is what the Stitching
// page counts, so the two are deliberately different numbers -- a test that
// asserts on a lot's quantity is asserting on the metres.
async function processingLot({ qty = 100, process_rate = 5 } = {}) {
  const { poId, lineId, vendorName } = await setupLine(Math.max(qty, 1000));
  const receipt = await postReceipt(poId, lineId, {
    received_qty: 7,
    qty_in_metres: qty,
    process_rate,
    incoming_no: `G-${uid()}`,
    incoming_stage: 'Processing',
  });
  return { poId, lineId, vendorName, receiptId: receipt.body.id };
}

const findLot = (rows, src, id) => rows.find(r => r.src === src && r.id === id);

beforeAll(async () => {
  const login = await request(app).post('/api/auth/login')
    .send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = login.body.accessToken;
  warehousePocId = login.body.user.id;

  // Still needed for the RECEIPT side: outbound PO receipts validate checked_by
  // with the strict userHasRole, so being Admin is not enough there. Stitching
  // challans no longer ask -- they record the session user -- but every lot in
  // this suite starts life as a receipt. Tag the seeded admin rather than mint a
  // user, matching the approach in outboundPOs.test.js.
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
  // 067 seeded four, 081 added PNL for Panchal. Third Party is deliberately
  // absent and has no prefix: nothing ARRIVES there, so there is nothing to
  // number -- see the CHECK in 081.
  test('one active prefix is seeded per receivable stage', () => {
    expect(Object.keys(prefixes).sort()).toEqual(['Packing', 'Panchal', 'Processing', 'Stitching']);
    for (const p of Object.values(prefixes)) expect(p.is_active).toBe(1);
    expect(prefixes).not.toHaveProperty('Third Party');
  });

  test('a duplicate prefix code is a 409', async () => {
    const res = await api.createPrefix({ prefix: prefixes.Processing.prefix, stage: 'Processing' });
    expect(res.status).toBe(409);
  });

  test('the code is unique case-insensitively', async () => {
    const res = await api.createPrefix({ prefix: prefixes.Processing.prefix.toLowerCase(), stage: 'Processing' });
    expect(res.status).toBe(409);
  });

  test('an unknown stage is rejected', async () => {
    const res = await api.createPrefix({ prefix: `Z${uid()}`, stage: 'Washed' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Stage must be one of/);
  });

  test('several prefixes may map to the same stage', async () => {
    const res = await api.createPrefix({ prefix: `GY${uid()}`, stage: 'Processing' });
    expect(res.status).toBe(201);
    expect(res.body.stage).toBe('Processing');
  });

  test('renaming an in-use prefix is allowed — it is display-only', async () => {
    const created = await api.createPrefix({ prefix: `RN${uid()}`, stage: 'Processing' });
    const { poId, lineId } = await setupLine();
    const r1 = await postReceipt(poId, lineId, { incoming_no: 'R-1', incoming_stage: 'Processing' });
    await attachPrefix(r1.body.id, created.body.id);

    const renamed = `RN2${uid()}`;
    const res = await api.patchPrefix(created.body.id, { prefix: renamed });
    expect(res.status).toBe(200);
    expect(res.body.prefix).toBe(renamed);
  });

  test('re-staging an in-use prefix is refused', async () => {
    const created = await api.createPrefix({ prefix: `RS${uid()}`, stage: 'Processing' });
    const { poId, lineId } = await setupLine();
    const r2 = await postReceipt(poId, lineId, { incoming_no: 'R-2', incoming_stage: 'Processing' });
    await attachPrefix(r2.body.id, created.body.id);

    const res = await api.patchPrefix(created.body.id, { stage: 'Packing' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/were received under it/);
  });

  test('re-staging an unused prefix is fine', async () => {
    const created = await api.createPrefix({ prefix: `RU${uid()}`, stage: 'Processing' });
    const res = await api.patchPrefix(created.body.id, { stage: 'Packing' });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('Packing');
  });

  test('deactivating an in-use prefix is allowed, but it cannot be used again', async () => {
    const created = await api.createPrefix({ prefix: `DA${uid()}`, stage: 'Processing' });
    const { poId, lineId } = await setupLine();
    const receipt = await postReceipt(poId, lineId, { incoming_no: 'D-1', incoming_stage: 'Processing' });
    await attachPrefix(receipt.body.id, created.body.id);

    const del = await api.deletePrefix(created.body.id);
    expect(del.status).toBe(200);
    expect(del.body.is_active).toBe(0);

    // The receipt that already carries it still resolves for display.
    const still = await getReceipt(poId, receipt.body.id);
    expect(still.incoming_stage).toBe('Processing');

    // A receipt names a stage, and a stage only ever resolves to an ACTIVE
    // prefix -- so a deactivated code simply stops being reachable rather than
    // being refused by name.
    const reuse = await postReceipt(poId, lineId, { incoming_no: 'D-2', incoming_stage: 'Processing' });
    expect(reuse.status).toBe(201);
    const reused = await getReceipt(poId, reuse.body.id);
    expect(reused.incoming_prefix_id).not.toBe(created.body.id);
  });

  test('in_use counts live lots only', async () => {
    const created = await api.createPrefix({ prefix: `IU${uid()}`, stage: 'Processing' });
    const { poId, lineId } = await setupLine();
    const receipt = await postReceipt(poId, lineId, { incoming_no: 'U-1', incoming_stage: 'Processing' });
    await attachPrefix(receipt.body.id, created.body.id);

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

  test('a process rate of 0 is accepted — a free job costs nothing, not an unknown amount', async () => {
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

  test('a stage with no incoming number is refused', async () => {
    const { poId, lineId } = await setupLine();
    const res = await postReceipt(poId, lineId, { incoming_stage: 'Processing', incoming_no: '' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Incoming No is required/);
  });

  // Fabric travels the stage chain, so a fabric receipt that names no stage
  // could never appear on it. The legacy shape -- a number with no stage -- is
  // still what every pre-feature row is in, and still what the
  // missing_incoming_stage flag reports, but it cannot be created any more.
  test('a fabric receipt with no stage is refused', async () => {
    const { poId, lineId } = await setupLine();
    const res = await postReceipt(poId, lineId, { incoming_no: 'IN-legacy', incoming_stage: '' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Stage is required/);
  });

  test('an unknown stage is refused', async () => {
    const { poId, lineId } = await setupLine();
    const res = await postReceipt(poId, lineId, { incoming_no: 'IN-1', incoming_stage: 'Nowhere' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Stage must be one of/);
  });

  // Challan moved off the PO receipt entirely: Bill No already covers what a
  // receipt records, and a challan is raised when material is SENT OUT to a
  // processor, which is a Stitching concept. The column still exists and is
  // still written -- but only by the Stitching page.
  test('challan_no posted to a receipt is ignored', async () => {
    const { poId, lineId } = await setupLine();
    const created = await postReceipt(poId, lineId, { challan_no: 'CH-9' });
    expect(created.status).toBe(201);
    const receipt = await getReceipt(poId, created.body.id);
    expect(receipt.challan_no).toBeUndefined();
  });
});

describe('Stitching page — lots and stages', () => {
  test('a receipt at Processing appears on the Processing tab and nowhere else', async () => {
    const { receiptId } = await processingLot();
    const gray = await api.listStage({ stage: 'Processing' });
    expect(findLot(gray.body.rows, 'receipt', receiptId)).toBeTruthy();

    for (const stage of ['Stitching', 'Packing', 'Panchal']) {
      const res = await api.listStage({ stage });
      expect(findLot(res.body.rows, 'receipt', receiptId)).toBeFalsy();
    }
  });

  test('a receipt with no prefix appears on no tab at all', async () => {
    const { poId, lineId } = await setupLine();
    // A fabric receipt cannot be CREATED without a stage any more, so the legacy
    // shape is reached by clearing the column -- which is exactly the state
    // every pre-feature row is in, and what missing_incoming_stage reports.
    const created = await postReceipt(poId, lineId, { incoming_no: 'NOSTAGE-1' });
    await attachPrefix(created.body.id, null);
    const all = await api.listStage();
    expect(findLot(all.body.rows, 'receipt', created.body.id)).toBeFalsy();
  });

  test('an origin lot carries its article, PO and vendor through', async () => {
    const { receiptId, poId, vendorName } = await processingLot();
    const gray = await api.listStage({ stage: 'Processing' });
    const lot = findLot(gray.body.rows, 'receipt', receiptId);
    expect(lot.item_name).toBe('Handkerchief - Bundle Fabric');
    expect(lot.po_order_no).toBe(String(poId).padStart(3, '0'));
    expect(lot.party_name).toBe(vendorName);
  });

  test('a fresh lot is Pending with full balance and can be forwarded', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const gray = await api.listStage({ stage: 'Processing' });
    const lot = findLot(gray.body.rows, 'receipt', receiptId);
    expect(lot.status).toBe('Pending');
    expect(lot.balance).toBe(100);
    expect(lot.can_forward).toBe(true);
    expect(lot.next_stage).toBe('Stitching');
    // Processing is the one stage that still counts metres.
    expect(lot.balance_unit).toBe('m');
  });

  test('a soft-deleted receipt drops off the page, and comes back on restore', async () => {
    const { poId, lineId, receiptId } = await processingLot();
    await A(request(app).delete(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${receiptId}`));
    let gray = await api.listStage({ stage: 'Processing' });
    expect(findLot(gray.body.rows, 'receipt', receiptId)).toBeFalsy();

    await A(request(app).post(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${receiptId}/restore`));
    gray = await api.listStage({ stage: 'Processing' });
    expect(findLot(gray.body.rows, 'receipt', receiptId)).toBeTruthy();
  });

  test('an unknown stage is rejected', async () => {
    const res = await api.listStage({ stage: 'Washed' });
    expect(res.status).toBe(400);
  });
});

describe('Only fabric, and only in metres', () => {
  test('a Processing lot counts the METRES, not the taga delivered', async () => {
    const { poId, lineId } = await setupLine();
    const receipt = await postReceipt(poId, lineId, {
      received_qty: 6, qty_in_metres: 240, incoming_no: `M-${uid()}`, incoming_stage: 'Processing',
    });
    const lot = findLot((await api.listStage({ stage: 'Processing' })).body.rows, 'receipt', receipt.body.id);
    expect(lot.received_qty).toBe(240);
    expect(lot.balance).toBe(240);
    // The line is bought in taga, but nothing on this page is measured in it.
    expect(lot.unit_metric).toBe('m');
  });

  test('a packaging receipt never reaches the page, however it is numbered', async () => {
    const vendor = await A(request(app).post('/api/outbound-vendors')).send({
      name: `Pack Vend ${uid()}`,
      articles: [{ category: 'Raw Material', item_name: 'Caps' }],
    });
    const po = await A(request(app).post('/api/outbound-pos')).send({
      vendor_id: vendor.body.id,
      po_date: '2026-09-05',
      approved_by: warehousePocId,
      approval_date: '2026-09-05',
      lines: [{ line_no: 1, category: 'Raw Material', item_name: 'Caps', qty: 50, rate: 10 }],
    });
    const detail = await A(request(app).get(`/api/outbound-pos/${po.body.id}`));
    const receipt = await A(request(app)
      .post(`/api/outbound-pos/${po.body.id}/lines/${detail.body.lines[0].id}/receipts`))
      .send({
        received_qty: 10, received_rate: 10, bill_no: `B-${uid()}`,
        checked_by: warehousePocId, incoming_no: `P-${uid()}`,
      });
    expect(receipt.status).toBe(201);

    const all = await api.listStage();
    expect(findLot(all.body.rows, 'receipt', receipt.body.id)).toBeFalsy();
  });

  test('a fabric receipt with no metres waits off the page rather than showing as zero', async () => {
    const { poId, lineId } = await setupLine();
    const receipt = await postReceipt(poId, lineId, { incoming_no: `Z-${uid()}` });
    await db.execute({
      sql: 'UPDATE outbound_po_line_receipts SET qty_in_metres = NULL WHERE id = ?',
      args: [receipt.body.id],
    });
    const all = await api.listStage();
    expect(findLot(all.body.rows, 'receipt', receipt.body.id)).toBeFalsy();
  });
});

describe('Forwarding through the stages', () => {
  test('sending part of a lot leaves it Partial with the balance reduced by what was SENT', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dyeing House',
      sent_qty: 60, received_qty: 58, process_rate: 7, checked_by: warehousePocId,
    });
    expect(res.status).toBe(201);
    expect(res.body.stage).toBe('Stitching');

    const gray = await api.listStage({ stage: 'Processing' });
    const parent = findLot(gray.body.rows, 'receipt', receiptId);
    expect(parent.status).toBe('Partial');
    // 40, not 42 — the 2 metres lost in processing belong to the child.
    expect(parent.balance).toBe(40);
  });

  test('the child records what actually arrived, and inherits the rate chain', async () => {
    const { receiptId } = await processingLot({ qty: 100, process_rate: 5 });
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dyeing House',
      sent_qty: 60, received_qty: 58, process_rate: 7, checked_by: warehousePocId,
    });
    const processed = await api.listStage({ stage: 'Stitching' });
    const child = findLot(processed.body.rows, 'entry', res.body.id);
    expect(child.received_qty).toBe(58);
    expect(child.sent_qty).toBe(60);
    expect(child.rate).toBe(55);        // the Processing lot's after rate
    expect(child.after_rate).toBe(62);  // 55 + 7
    expect(child.item_name).toBe('Handkerchief - Bundle Fabric');
    expect(child.party_name).toBe('Dyeing House');
    // From Stitching on, the lot is counted in dozens -- 58 by the fixture's
    // 1 m/dozen default -- and so is its balance.
    expect(child.received_dozens).toBe(58);
    expect(child.balance).toBe(58);
    expect(child.balance_unit).toBe('dz');
  });

  test('sending the whole balance leaves the parent Forwarded', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 100, received_qty: 95, checked_by: warehousePocId,
    });
    const gray = await api.listStage({ stage: 'Processing' });
    const parent = findLot(gray.body.rows, 'receipt', receiptId);
    expect(parent.status).toBe('Forwarded');
    expect(parent.balance).toBe(0);
    expect(parent.can_forward).toBe(false);
  });

  test('a lot can be split across several forwards', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    for (const qty of [30, 30, 40]) {
      const res = await api.forward({
        parent_src: 'receipt', parent_id: receiptId, party_name: `P-${qty}`,
        sent_qty: qty, received_qty: qty, checked_by: warehousePocId,
      });
      expect(res.status).toBe(201);
    }
    const gray = await api.listStage({ stage: 'Processing' });
    expect(findLot(gray.body.rows, 'receipt', receiptId).status).toBe('Forwarded');

    const processed = await api.listStage({ stage: 'Stitching' });
    const children = processed.body.rows.filter(r => r.parent_src === 'receipt' && r.parent_id === receiptId);
    expect(children).toHaveLength(3);
  });

  test('over-forwarding is refused', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 100.01, received_qty: 100, checked_by: warehousePocId,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only 100m is left/);
  });

  // WAS a rate column per stage, and before that a running after_rate. The page
  // now shows ONE figure -- the whole cost of a dozen -- with each stage's rate
  // spelled out beside it. A challan's rate belongs to the stage it LEFT, and is
  // per dozen. The PO rate (and a process rate already paid on the receipt) is
  // per metre, so it is converted at the lot's metres-per-dozen.
  test('the rate total is per dozen, each rate named for the stage it was paid at', async () => {
    const { receiptId } = await processingLot({ qty: 100, process_rate: 5 });
    // 98m came back from processing as 49 dozen: 2 metres per dozen.
    const f1 = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye',
      sent_qty: 100, received_qty: 98, received_dozens: 49, process_rate: 7,
    });
    const f2 = await api.forward({
      parent_src: 'entry', parent_id: f1.body.id, party_name: 'Stitch',
      sent_dozens: 49, process_rate: 3,
    });
    const f3 = await api.forward({
      parent_src: 'entry', parent_id: f2.body.id, target_stage: 'Panchal', party_name: 'Pack',
      sent_dozens: 49, process_rate: 2,
    });
    expect(f1.body.stage).toBe('Stitching');
    expect(f2.body.stage).toBe('Packing');
    expect(f3.body.stage).toBe('Panchal');

    const panchal = await api.listStage({ stage: 'Panchal' });
    const lot = findLot(panchal.body.rows, 'entry', f3.body.id);

    // One PO rate, shared by every lot in the chain and read off the origin
    // receipt rather than copied down it.
    expect(lot.po_rate).toBe(50);
    // The yield is carried from the challan where metres became dozens.
    expect(lot.metres_per_dozen).toBe(2);
    expect(lot.m_per_dozen_source).toMatchObject({ kind: 'entry', carried: true, metres: 98, dozens: 49 });

    expect(lot.rate_breakdown.map(l => [l.label, l.unit, l.contributes])).toEqual([
      ['PO rate', 'metre', 100],                     // 50/m x 2 m/dz
      ['Processing rate (on receipt)', 'metre', 10], // 5/m x 2 m/dz
      ['Processing rate', 'dozen', 7],
      ['Stitching rate', 'dozen', 3],
      ['Packing rate', 'dozen', 2],
    ]);
    expect(lot.rate_total).toBe(122);
    expect(lot.rate_total_unit).toBe('dozen');
    // The article survives three hops because origin_receipt_id is carried down.
    expect(lot.item_name).toBe('Handkerchief - Bundle Fabric');
  });

  test('a lot that skipped a stage has no rate for it', async () => {
    const { receiptId } = await processingLot({ qty: 100, process_rate: 5 });
    const f1 = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye',
      sent_qty: 100, received_qty: 98, process_rate: 7,
    });
    // Stitching straight to Panchal, skipping Packing entirely.
    const f2 = await api.forward({
      parent_src: 'entry', parent_id: f1.body.id, target_stage: 'Panchal',
      party_name: 'Pack', sent_qty: 98, process_rate: 4,
    });
    expect(f2.body.stage).toBe('Panchal');

    const panchal = await api.listStage({ stage: 'Panchal' });
    const lot = findLot(panchal.body.rows, 'entry', f2.body.id);
    expect(lot.rate_breakdown.map(l => l.label)).toEqual(
      ['PO rate', 'Processing rate (on receipt)', 'Processing rate', 'Stitching rate'],
    );
  });

  test('a lot still at Processing totals per metre -- it has no yield yet', async () => {
    const { receiptId } = await processingLot({ qty: 100, process_rate: 5 });
    const lot = findLot((await api.listStage({ stage: 'Processing' })).body.rows, 'receipt', receiptId);
    expect(lot.rate_total).toBe(55);
    expect(lot.rate_total_unit).toBe('metre');
    expect(lot.metres_per_dozen).toBeNull();
  });

  // Historical rows kept the unit they were entered in (migration 087). A rate
  // entered per metre is converted like the PO rate, not taken as per dozen.
  test('a historical per-metre challan rate is converted, not read as per dozen', async () => {
    const { receiptId } = await processingLot({ qty: 100, process_rate: 0 });
    const f1 = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye',
      sent_qty: 100, received_dozens: 50, process_rate: 4,
    });
    await db.execute({ sql: "UPDATE stitching_entries SET rate_unit = 'metre' WHERE id = ?", args: [f1.body.id] });
    const lot = findLot((await api.listStage({ stage: 'Stitching' })).body.rows, 'entry', f1.body.id);
    const rung = lot.rate_breakdown.find(l => l.label === 'Processing rate');
    expect(rung).toMatchObject({ unit: 'metre', contributes: 8 }); // 4/m x 2 m/dz
    expect(lot.rate_total).toBe(108);                              // 50 x 2 + 0 + 8
  });

  // WAS "a Packed lot cannot be forwarded further". Packed forwards on to the
  // warehouse now -- Panchal is the end of the chain, and what sits there is
  // stock that leaves by being closed rather than forwarded.
  test('a Panchal lot cannot be forwarded further', async () => {
    const { receiptId } = await processingLot();
    let parent = { src: 'receipt', id: receiptId };
    for (const stage of ['Stitching', 'Packing', 'Panchal']) {
      const res = await api.forward({
        parent_src: parent.src, parent_id: parent.id, target_stage: stage, party_name: 'P',
        sent_qty: 100, received_qty: 100,
      });
      expect(res.body.stage).toBe(stage);
      parent = { src: 'entry', id: res.body.id };
    }
    const res = await api.forward({
      parent_src: 'entry', parent_id: parent.id, party_name: 'P',
      sent_qty: 1, received_qty: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/nowhere further/);
  });

  test('a lot sold to a third party cannot be sent anywhere', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const f1 = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye',
      sent_qty: 100, received_qty: 100,
    });
    const sold = await api.forward({
      parent_src: 'entry', parent_id: f1.body.id, target_stage: 'Third Party',
      party_name: 'Buyer', sent_qty: 50, received_qty: 50, outbound_bill_no: 'OB-1',
    });
    expect(sold.status).toBe(201);
    const res = await api.forward({
      parent_src: 'entry', parent_id: sold.body.id, party_name: 'P',
      sent_qty: 1, received_qty: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sold to a third party/);
  });

  test('a destination the graph does not allow is refused', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    // Nothing is ever sent TO Processing -- material enters the chain there.
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, target_stage: 'Processing',
      party_name: 'P', sent_qty: 10, received_qty: 10,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/can only be sent to Stitching, Packing, Panchal, Third Party/);
  });

  test('the stage is never taken from the request body', async () => {
    const { receiptId } = await processingLot();
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId,
      stage: 'Packing',
    });
    expect(res.body.stage).toBe('Stitching');
  });

  // A dispatch derives its own number, so a prefix in the body is ignored rather
  // than refused -- see the Challans block. The stage guard still matters on an
  // edit, where a prefix from the wrong stage would print a misleading number.
  test('editing a lot to a prefix from another stage is refused', async () => {
    const { receiptId } = await processingLot();
    const created = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId,
    });
    const res = await api.patchLot(created.body.id, { incoming_prefix_id: prefixes.Packing.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/belongs to the Packing stage/);
  });

  test('editing to the prefix for its own stage is accepted', async () => {
    const { receiptId } = await processingLot();
    const created = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId,
    });
    const res = await api.patchLot(created.body.id, { incoming_prefix_id: prefixes.Stitching.id });
    expect(res.status).toBe(200);
  });

  test.each([
    [{ party_name: '' }, /Party Name is required/],
    [{ sent_qty: 0 }, /Sent Qty must be a number > 0/],
    [{ received_qty: -5 }, /Received Qty must be a number > 0/],
    [{ process_rate: 1.005 }, /at most 2 decimal places/],
  ])('rejects %j', async (override, matcher) => {
    const { receiptId } = await processingLot();
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId, ...override,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(matcher);
  });

  // WAS "checked_by must be tagged Warehouse_POC". The field stopped being a
  // question: it records WHO ENTERED the challan, taken from the session, and
  // every logged-in user qualifies to have done that. Asking made every dispatch
  // wait on picking a name the person filling the form already knew -- their own.
  test('checked_by defaults to whoever entered the challan', async () => {
    const { receiptId } = await processingLot();
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, received_qty: 10,
    });
    expect(res.status).toBe(201);
    const row = findLot((await api.listStage({ stage: 'Stitching' })).body.rows, 'entry', res.body.id);
    // The session user, which in this suite is the seeded admin.
    expect(row.checked_by).toBe(warehousePocId);
  });

  test('an untagged user is accepted, because the tag no longer gates it', async () => {
    const { receiptId } = await processingLot();
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, received_qty: 10, checked_by: untaggedUserId,
    });
    expect(res.status).toBe(201);
  });

  test('a checked_by naming no real user is still refused', async () => {
    const { receiptId } = await processingLot();
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, received_qty: 10, checked_by: 999999,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/user not found/);
  });

  test('an unknown parent is a 404', async () => {
    const res = await api.forward({
      parent_src: 'receipt', parent_id: 999999, party_name: 'P',
      sent_qty: 1, received_qty: 1, checked_by: warehousePocId,
    });
    expect(res.status).toBe(404);
  });

  test('a bad parent_src is a 400', async () => {
    const res = await api.forward({
      parent_src: 'nonsense', parent_id: 1, party_name: 'P',
      sent_qty: 1, received_qty: 1, checked_by: warehousePocId,
    });
    expect(res.status).toBe(400);
  });
});

describe('Integrity guards back on the receipt', () => {
  async function forwardedProcessingLot() {
    const lot = await processingLot({ qty: 100 });
    const child = await api.forward({
      parent_src: 'receipt', parent_id: lot.receiptId, party_name: 'Dye',
      sent_qty: 60, received_qty: 58, checked_by: warehousePocId,
    });
    return { ...lot, childId: child.body.id };
  }

  test('a receipt with forwarded lots cannot be deleted', async () => {
    const { poId, lineId, receiptId } = await forwardedProcessingLot();
    const res = await A(request(app).delete(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${receiptId}`));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/forwarded from it/);
  });

  // The METRES are what the Stitching page counts, so they are what cannot be
  // cut below the lots already sent out of this receipt. The taga figure beside
  // them is the PO's business and nothing downstream reads it.
  test('its metres cannot drop below what has been forwarded', async () => {
    const { poId, lineId, receiptId } = await forwardedProcessingLot();
    const res = await patchReceipt(poId, lineId, receiptId, { qty_in_metres: 50 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already forwarded/);
  });

  test('but they can still be reduced to exactly what was forwarded', async () => {
    const { poId, lineId, receiptId } = await forwardedProcessingLot();
    const res = await patchReceipt(poId, lineId, receiptId, { qty_in_metres: 60 });
    expect(res.status).toBe(200);
  });

  test('its stage cannot be changed once anything has been forwarded', async () => {
    const { poId, lineId, receiptId } = await forwardedProcessingLot();
    const res = await patchReceipt(poId, lineId, receiptId, { incoming_stage: 'Stitching' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/change the receipt/);
  });

  test('re-picking the SAME stage is a no-op, not a refusal', async () => {
    const { poId, lineId, receiptId } = await forwardedProcessingLot();
    const res = await patchReceipt(poId, lineId, receiptId, { incoming_stage: 'Processing' });
    expect(res.status).toBe(200);
  });

  test('correcting the receipt rate flows down the chain', async () => {
    const { poId, lineId, receiptId, childId } = await forwardedProcessingLot();
    await patchReceipt(poId, lineId, receiptId, { received_rate: 80 });
    const processed = await api.listStage({ stage: 'Stitching' });
    // 80 + the 5 process rate processingLot() sets = 85 carried in, not the old 55.
    expect(findLot(processed.body.rows, 'entry', childId).rate).toBe(85);
  });
});

describe('Editing and deleting a stage lot', () => {
  async function chain() {
    const { receiptId } = await processingLot({ qty: 100 });
    const mid = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye',
      sent_qty: 60, received_qty: 58, process_rate: 7, checked_by: warehousePocId,
    });
    const leaf = await api.forward({
      parent_src: 'entry', parent_id: mid.body.id, party_name: 'Stitch',
      sent_qty: 50, received_qty: 50, checked_by: warehousePocId,
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
    const processed = await api.listStage({ stage: 'Stitching' });
    const mid = findLot(processed.body.rows, 'entry', midId);
    expect(mid.balance).toBe(58);
    expect(mid.status).toBe('Pending');
  });

  test('a deleted leaf can be restored', async () => {
    const { leafId } = await chain();
    await api.deleteLot(leafId);
    const res = await api.restoreLot(leafId);
    expect(res.status).toBe(200);
    const stitched = await api.listStage({ stage: 'Packing' });
    expect(findLot(stitched.body.rows, 'entry', leafId)).toBeTruthy();
  });

  test('restoring is refused when the source has since been forwarded elsewhere', async () => {
    const { midId, leafId } = await chain();
    await api.deleteLot(leafId);
    // Take the freed 50 metres somewhere else, then try to bring the old lot back.
    await api.forward({
      parent_src: 'entry', parent_id: midId, party_name: 'Other',
      sent_qty: 58, received_qty: 58, checked_by: warehousePocId,
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

  // A Stitching lot holds dozens, so its dozens are what cannot be cut below
  // what it has already sent on.
  test('dozens received cannot drop below what this lot has already forwarded', async () => {
    const { midId } = await chain();
    const res = await api.patchLot(midId, { received_dozens: 10 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Dozens Received cannot be less than 50/);
  });

  // after_rate is dead (the rate total replaced it), so editing a rate records
  // the new figure in the unit the form now asks for, and nothing else.
  test('editing the rate re-stamps it per dozen', async () => {
    const { midId } = await chain();
    await db.execute({ sql: "UPDATE stitching_entries SET rate_unit = 'metre' WHERE id = ?", args: [midId] });
    const res = await api.patchLot(midId, { process_rate: 10 });
    expect(res.status).toBe(200);
    expect(res.body.process_rate).toBe(10);
    expect(res.body.rate_unit).toBe('dozen');
  });

  // A challan's lines share one header, so a header edit on one line lands on
  // all of them -- one challan can never name two parties or two rates.
  test('a header edit on one line is applied to every line of the challan', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const no = challanNo('HDR');
    const created = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye', challan_no: no, process_rate: 4,
      lines: [
        { challan_type: 'Fresh', sent_qty: 60, received_dozens: 30 },
        { challan_type: 'Second', sent_qty: 20, received_dozens: 8 },
      ],
    });
    expect(created.status).toBe(201);
    const [first, second] = created.body.ids;
    const res = await api.patchLot(first, { process_rate: 6, party_name: 'Dye Works' });
    expect(res.status).toBe(200);
    const { rows } = await db.execute({
      sql: 'SELECT id, process_rate, party_name, challan_type FROM stitching_entries WHERE id IN (?, ?) ORDER BY id',
      args: [first, second],
    });
    expect(rows.map(r => [r.process_rate, r.party_name])).toEqual([[6, 'Dye Works'], [6, 'Dye Works']]);
    // Line fields stay with their own line.
    expect(rows.map(r => r.challan_type)).toEqual(['Fresh', 'Second']);
  });
});

describe('Listing, filtering and sorting', () => {
  test('status filter narrows to matching lots', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId,
    });
    const res = await api.listStage({ stage: 'Processing', status: 'Partial' });
    expect(res.body.rows.length).toBeGreaterThan(0);
    expect(res.body.rows.every(r => r.status === 'Partial')).toBe(true);
    expect(findLot(res.body.rows, 'receipt', receiptId)).toBeTruthy();
  });

  test('an all-unticked status filter matches nothing', async () => {
    const res = await api.listStage({ stage: 'Processing', status: '__none_selected__' });
    expect(res.body.rows).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  test('incoming_no is searched as prefix+number, the way it is printed', async () => {
    const { poId, lineId } = await setupLine();
    const marker = `FIND${uid()}`;
    const created = await postReceipt(poId, lineId, {
      incoming_no: marker, incoming_stage: 'Processing',
    });
    const res = await api.listStage({ stage: 'Processing', incoming_no: `${prefixes.Processing.prefix}${marker}` });
    expect(findLot(res.body.rows, 'receipt', created.body.id)).toBeTruthy();
  });

  test('party name is a substring match', async () => {
    const { receiptId } = await processingLot();
    const party = `Unique Dyer ${uid()}`;
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: party,
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId,
    });
    const res = await api.listStage({ stage: 'Stitching', party_name: party.slice(7, 15) });
    expect(res.body.rows.some(r => r.party_name === party)).toBe(true);
  });

  // The page leads with the PO party on every tab, so that is searchable too --
  // on a lot that has long since moved to a job worker.
  test('party name also matches the PO party a downstream lot started from', async () => {
    const { receiptId, vendorName } = await processingLot();
    const f = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: `Dyer ${uid()}`, sent_qty: 10,
    });
    const res = await api.listStage({ stage: 'Stitching', party_name: vendorName });
    expect(findLot(res.body.rows, 'entry', f.body.id)).toBeTruthy();
  });

  test('paging reports a total larger than the page', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    for (const n of [10, 10, 10]) {
      await api.forward({
        parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
        sent_qty: n, received_qty: n, checked_by: warehousePocId,
      });
    }
    const res = await api.listStage({ stage: 'Processing', page_size: 10, page: 1 });
    expect(res.body.rows.length).toBeLessThanOrEqual(10);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.page_size).toBe(10);
  });

  // Was "offers vendors and previously typed processors" -- it unioned
  // outbound_vendors with every name ever typed, which offered every name for
  // every job. Migration 079's master replaced that, and the use tags are the
  // whole point: picking a destination should not then offer a packer for
  // stitching work.
  test('the party list comes from the master and is narrowed by use', async () => {
    const stitcher = `Stitch Co ${uid()}`;
    const packer = `Pack Co ${uid()}`;
    await api.createParty({ name: stitcher, uses: ['Stitching'] });
    await api.createParty({ name: packer, uses: ['Packing'] });

    const all = await api.listParties();
    expect(all.body).toEqual(expect.arrayContaining([stitcher, packer]));

    const forStitching = await api.listParties({ use: 'Stitching' });
    expect(forStitching.body).toContain(stitcher);
    expect(forStitching.body).not.toContain(packer);
  });

  test('an inactive party is no longer offered', async () => {
    const name = `Retired Co ${uid()}`;
    const created = await api.createParty({ name, uses: ['Stitching'] });
    expect((await api.listParties({ use: 'Stitching' })).body).toContain(name);
    await api.deleteParty(created.body.id);
    expect((await api.listParties({ use: 'Stitching' })).body).not.toContain(name);
  });

  test('an unknown use is rejected rather than silently ignored', async () => {
    const res = await api.listParties({ use: 'Nowhere' });
    expect(res.status).toBe(400);
  });
});

// The SQL CASE in stitching.service.js drives filtering and paging, the JS
// function labels rows; this pins them together the way the outbound PO flag
// parity test does for its predicates.
// Closing moved from Packing to Panchal. Closing means "this stock has left the
// warehouse", and Panchal IS the warehouse -- Packing only held the role while
// the chain had nowhere else to end.
describe('Closing a Panchal lot', () => {
  // Walk a Processing lot all the way to the warehouse and hand back the leaf.
  async function panchalLot() {
    const { receiptId } = await processingLot({ qty: 100 });
    let parent = { src: 'receipt', id: receiptId };
    for (const stage of ['Stitching', 'Packing', 'Panchal']) {
      const res = await api.forward({
        parent_src: parent.src, parent_id: parent.id, target_stage: stage,
        party_name: 'P', sent_qty: 100, received_qty: 100,
      });
      parent = { src: 'entry', id: res.body.id };
    }
    return parent;
  }

  test('a lot that reaches Panchal is In Stock, not Closed', async () => {
    const lot = await panchalLot();
    const panchal = await api.listStage({ stage: 'Panchal' });
    expect(findLot(panchal.body.rows, 'entry', lot.id).status).toBe('In Stock');
  });

  test('closing it makes it Closed, and reopening restores In Stock', async () => {
    const lot = await panchalLot();

    const closed = await api.close('entry', lot.id);
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('Closed');
    expect(closed.body.closed_by_name).toBeTruthy();
    expect(closed.body.closed_at).toBeTruthy();

    const reopened = await api.reopen('entry', lot.id);
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe('In Stock');
    expect(reopened.body.closed_at).toBeNull();
  });

  // The case migration 070's second pair of columns exists for: a lot can reach
  // the warehouse without ever being a stitching_entries row. Panchal is the end
  // of the chain, so a receipt bought straight into it has nothing left to
  // happen to it and is CLOSED as it is saved -- it can still be reopened.
  test('a receipt bought straight at the Panchal stage is closed on save', async () => {
    const { poId, lineId } = await setupLine();
    const receipt = await postReceipt(poId, lineId, {
      incoming_no: `K-${uid()}`, incoming_stage: 'Panchal', received_dozens: 20,
    });
    expect(receipt.status).toBe(201);

    let panchal = await api.listStage({ stage: 'Panchal' });
    const lot = findLot(panchal.body.rows, 'receipt', receipt.body.id);
    expect(lot.status).toBe('Closed');
    expect(lot.closed_by_name).toBeTruthy();

    const reopened = await api.reopen('receipt', receipt.body.id);
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe('In Stock');

    const closed = await api.close('receipt', receipt.body.id);
    expect(closed.body.status).toBe('Closed');
    panchal = await api.listStage({ stage: 'Panchal' });
    expect(findLot(panchal.body.rows, 'receipt', receipt.body.id).status).toBe('Closed');
  });

  test('moving a receipt into Panchal closes it, and out of Panchal reopens it', async () => {
    const { poId, lineId } = await setupLine();
    const receipt = await postReceipt(poId, lineId, {
      incoming_no: `K-${uid()}`, incoming_stage: 'Packing', received_dozens: 20,
    });
    const status = async () => {
      const all = await api.listStage();
      return findLot(all.body.rows, 'receipt', receipt.body.id).status;
    };
    expect(await status()).toBe('Pending');

    await patchReceipt(poId, lineId, receipt.body.id, { incoming_stage: 'Panchal' });
    expect(await status()).toBe('Closed');

    await patchReceipt(poId, lineId, receipt.body.id, { incoming_stage: 'Packing' });
    expect(await status()).toBe('Pending');
  });

  test('a lot short of Panchal cannot be closed, and the message names its stage', async () => {
    const { receiptId } = await processingLot();
    const res = await api.close('receipt', receiptId);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only a Panchal lot can be closed — this one is Processing/);
  });

  // Packing used to be closeable and is not any more: it is an ordinary
  // forwarding stage with a real balance, and its goods are not stock until they
  // reach the warehouse.
  test('a Packing lot can no longer be closed', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    let parent = { src: 'receipt', id: receiptId };
    for (const stage of ['Stitching', 'Packing']) {
      const res = await api.forward({
        parent_src: parent.src, parent_id: parent.id, target_stage: stage,
        party_name: 'P', sent_qty: 100, received_qty: 100,
      });
      parent = { src: 'entry', id: res.body.id };
    }
    const res = await api.close('entry', parent.id);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/this one is Packing/);
  });

  test('double-closing is refused rather than rewriting the attribution', async () => {
    const lot = await panchalLot();
    await api.close('entry', lot.id);
    const again = await api.close('entry', lot.id);
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already closed/);
  });

  test('reopening a lot that is not closed is refused', async () => {
    const lot = await panchalLot();
    const res = await api.reopen('entry', lot.id);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not closed/);
  });

  test('an unknown lot type is a 400', async () => {
    const res = await api.close('nonsense', 1);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/receipt.*entry/);
  });

  test('closing writes an audit entry', async () => {
    const lot = await panchalLot();
    await api.close('entry', lot.id);
    const audit = await A(request(app).get('/api/audit-logs')
      .query({ entity_type: 'stitching_entry', entity_id: lot.id }));
    const rows = audit.body.rows || audit.body;
    expect(rows.some(r => r.action_type === 'STITCHING_LOT_CLOSE')).toBe(true);
  });
});

describe('Open-lot counts per stage', () => {
  test('every stage is reported, including zero', async () => {
    const res = await api.counts();
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.counts).sort())
      .toEqual(['Packing', 'Panchal', 'Processing', 'Stitching', 'Third Party']);
    for (const v of Object.values(res.body.counts)) expect(typeof v).toBe('number');
  });

  test('a Pending lot counts, and stops counting once fully forwarded', async () => {
    const party = `Counted ${uid()}`;
    const { receiptId } = await processingLot({ qty: 100 });
    // Scope by party so other suites' rows cannot perturb the numbers. The origin
    // lot's party is the vendor, so filter the Processing side by its own name.
    const before = await api.counts();
    const grayBefore = before.body.counts.Processing;

    const fwd = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: party,
      sent_qty: 100, received_qty: 100, checked_by: warehousePocId,
    });

    const after = await api.counts();
    // Forwarded lots are not open, so Processing drops by exactly the one we moved.
    expect(after.body.counts.Processing).toBe(grayBefore - 1);
    // …and the child is now open at Stitching.
    const scoped = await api.counts({ party_name: party });
    expect(scoped.body.counts.Stitching).toBe(1);
    expect(scoped.body.counts.Processing).toBe(0);

    // Deleting the child hands the metres back, so Processing becomes open again.
    await api.deleteLot(fwd.body.id);
    const restored = await api.counts();
    expect(restored.body.counts.Processing).toBe(grayBefore);
  });

  test('a part-forwarded lot still counts as open', async () => {
    const party = `Partial ${uid()}`;
    const { receiptId } = await processingLot({ qty: 100 });
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: party,
      sent_qty: 40, received_qty: 40, checked_by: warehousePocId,
    });
    const gray = await api.listStage({ stage: 'Processing' });
    expect(findLot(gray.body.rows, 'receipt', receiptId).status).toBe('Partial');

    const scoped = await api.counts({ party_name: party });
    expect(scoped.body.counts.Stitching).toBe(1);
  });

  test('a Panchal lot counts while In Stock and stops once closed', async () => {
    // An origin lot's party is its PO vendor, and setupLine mints a unique one,
    // so filtering by that name isolates this test from every other row.
    const { poId, lineId, vendorName } = await setupLine();
    const receipt = await postReceipt(poId, lineId, {
      incoming_no: `K-${uid()}`, incoming_stage: 'Panchal', received_dozens: 20,
    });

    // Closed on save, so it is not open work...
    expect((await api.counts({ party_name: vendorName })).body.counts.Panchal).toBe(0);
    // ...until someone reopens it.
    await api.reopen('receipt', receipt.body.id);
    expect((await api.counts({ party_name: vendorName })).body.counts.Panchal).toBe(1);

    await api.close('receipt', receipt.body.id);
    expect((await api.counts({ party_name: vendorName })).body.counts.Panchal).toBe(0);
  });

  // A sale is never outstanding work, so it never appears in a stage count even
  // while the row is perfectly live.
  test('a Third Party sale is never counted as open', async () => {
    const { receiptId, vendorName } = await processingLot({ qty: 100 });
    const f1 = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 100, received_qty: 100,
    });
    await api.forward({
      parent_src: 'entry', parent_id: f1.body.id, target_stage: 'Third Party',
      party_name: 'Buyer', sent_qty: 30, received_qty: 30, outbound_bill_no: 'OB-2',
    });
    expect((await api.counts({ party_name: vendorName })).body.counts['Third Party']).toBe(0);
  });

  test('filters narrow the counts', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const party = `Narrow ${uid()}`;
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: party,
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId,
    });
    const mine = await api.counts({ party_name: party });
    expect(mine.body.counts.Stitching).toBe(1);

    const nobody = await api.counts({ party_name: `absent ${uid()}` });
    expect(Object.values(nobody.body.counts).every(n => n === 0)).toBe(true);
  });

  // The count is about open lots by definition, so a status filter aimed at the
  // table must not compound with it and silently zero every badge.
  test('an active status filter is ignored', async () => {
    const party = `Ignored ${uid()}`;
    const { receiptId } = await processingLot({ qty: 100 });
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: party,
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId,
    });
    const withFilter = await api.counts({ party_name: party, status: 'Closed' });
    expect(withFilter.body.counts.Stitching).toBe(1);
  });

  test('a soft-deleted lot stops counting', async () => {
    const party = `Deleted ${uid()}`;
    const { receiptId } = await processingLot({ qty: 100 });
    const fwd = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: party,
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId,
    });
    expect((await api.counts({ party_name: party })).body.counts.Stitching).toBe(1);
    await api.deleteLot(fwd.body.id);
    expect((await api.counts({ party_name: party })).body.counts.Stitching).toBe(0);
  });
});

describe('Journey view', () => {
  // Processing 100m -> Stitching 58dz (sent 60m, 58m back) -> Packing 58dz.
  // Only the hop out of Processing can be short: from Stitching on, what was
  // sent in dozens IS what arrives.
  async function chain() {
    const { receiptId, poId } = await processingLot({ qty: 100, process_rate: 5 });
    const mid = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye House',
      sent_qty: 60, received_qty: 58, process_rate: 7, checked_by: warehousePocId,
    });
    const leaf = await api.forward({
      parent_src: 'entry', parent_id: mid.body.id, party_name: 'Stitch Unit',
      sent_qty: 58, received_qty: 57, process_rate: 3, checked_by: warehousePocId,
    });
    return { receiptId, poId, midId: mid.body.id, leafId: leaf.body.id };
  }

  test('the same chain comes back from any node in it', async () => {
    const { receiptId, midId, leafId } = await chain();
    const fromOrigin = await api.journey('receipt', receiptId);
    const fromMiddle = await api.journey('entry', midId);
    const fromLeaf = await api.journey('entry', leafId);

    expect(fromOrigin.status).toBe(200);
    const keys = r => r.body.nodes.map(n => n.lot_key);
    expect(keys(fromMiddle)).toEqual(keys(fromOrigin));
    expect(keys(fromLeaf)).toEqual(keys(fromOrigin));
    expect(keys(fromOrigin)).toHaveLength(3);
  });

  test('nodes come back in walk order with the right depth and stages', async () => {
    const { receiptId } = await chain();
    const { body } = await api.journey('receipt', receiptId);
    expect(body.nodes.map(n => n.stage)).toEqual(['Processing', 'Stitching', 'Packing']);
    expect(body.nodes.map(n => n.depth)).toEqual([0, 1, 2]);
  });

  test('loss is per hop, and null on the origin nobody sent', async () => {
    const { receiptId } = await chain();
    const { body } = await api.journey('receipt', receiptId);
    expect(body.nodes.map(n => n.short)).toEqual([null, 2, null]);
  });

  test('the rate builds up along the chain', async () => {
    const { receiptId } = await chain();
    const { body } = await api.journey('receipt', receiptId);
    expect(body.nodes.map(n => n.after_rate)).toEqual([55, 62, 65]);
  });

  test('the anchor is marked, and only the anchor', async () => {
    const { receiptId, midId } = await chain();
    const { body } = await api.journey('entry', midId);
    expect(body.nodes.filter(n => n.is_anchor)).toHaveLength(1);
    expect(body.nodes.find(n => n.is_anchor).id).toBe(midId);
    expect(body.anchor).toEqual({ src: 'entry', id: midId });
  });

  test('a split lot returns both branches under the same parent', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    for (const qty of [30, 40]) {
      await api.forward({
        parent_src: 'receipt', parent_id: receiptId, party_name: `Split ${qty}`,
        sent_qty: qty, received_qty: qty, checked_by: warehousePocId,
      });
    }
    const { body } = await api.journey('receipt', receiptId);
    expect(body.nodes).toHaveLength(3);
    expect(body.nodes.map(n => n.depth)).toEqual([0, 1, 1]);
    expect(body.nodes.filter(n => n.depth === 1).map(n => n.received_qty).sort((a, b) => a - b))
      .toEqual([30, 40]);
  });

  test('the summary totals agree with the hops', async () => {
    const { receiptId } = await chain();
    const { body } = await api.journey('receipt', receiptId);
    expect(body.summary.origin_qty).toBe(100);
    expect(body.summary.origin_rate).toBe(50);
    expect(body.summary.total_short).toBe(2);
    expect(body.summary.article).toBe('Handkerchief - Bundle Fabric');
  });

  test('a deleted hop is still in the record, marked', async () => {
    const { receiptId, leafId } = await chain();
    await api.deleteLot(leafId);
    const { body } = await api.journey('receipt', receiptId);
    const removed = body.nodes.find(n => n.id === leafId && n.src === 'entry');
    expect(removed).toBeTruthy();
    expect(removed.deleted).toBe(true);
    expect(removed.deleted_by_name).toBeTruthy();
    // …and it stops contributing to the live totals (it never had a short).
    expect(body.summary.total_short).toBe(2);
  });

  test('an unknown lot is a 404 and a bad type a 400', async () => {
    expect((await api.journey('entry', 999999)).status).toBe(404);
    expect((await api.journey('nonsense', 1)).status).toBe(400);
  });
});

describe('Challans — a lot moves on only under one', () => {
  const lotRow = async (stage, src, id) =>
    findLot((await api.listStage({ stage })).body.rows, src, id);

  const grayRow = async (receiptId) => lotRow('Processing', 'receipt', receiptId);

  test('a challan takes its quantity out of the lot straight away', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const d = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dyeing House',
      sent_qty: 40, received_qty: 40, checked_by: warehousePocId, challan_no: '12345',
    });
    expect(d.status).toBe(201);
    expect(d.body.stage).toBe('Stitching');

    // 40 has left, 60 waits for instructions -- the user's own example.
    const gray = await grayRow(receiptId);
    expect(gray.balance).toBe(60);
    expect(gray.status).toBe('Partial');
  });

  test('the challan is the next-stage lot, complete from the moment it exists', async () => {
    const { receiptId } = await processingLot({ qty: 100, process_rate: 5 });
    const challan = challanNo();
    const d = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 40, received_qty: 38, process_rate: 7,
      checked_by: warehousePocId, challan_no: challan,
    });
    const row = await lotRow('Stitching', 'entry', d.body.id);
    expect(row.status).toBe('Pending');
    expect(row.received_qty).toBe(38);
    expect(row.sent_qty).toBe(40);
    expect(row.short).toBe(2);
    expect(row.challan_no).toBe(challan);
    expect(row.rate).toBe(55);       // the Processing lot's after rate, carried in
    expect(row.after_rate).toBe(62); // 55 + 7
    // It holds material, so it can be sent on immediately -- no second step.
    expect(row.can_forward).toBe(true);
  });

  test('there is no In Transit anywhere, and no receive endpoint', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const d = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 40, received_qty: 40, checked_by: warehousePocId, challan_no: challanNo(),
    });
    const row = await lotRow('Stitching', 'entry', d.body.id);
    expect(row.status).not.toBe('In Transit');

    const gone = await A(request(app).post(`/api/stitching/${d.body.id}/receive`))
      .send({ received_qty: 40, checked_by: warehousePocId });
    expect(gone.status).toBe(404);
  });

  test('a challan can be sent on the moment it exists', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const d = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 40, received_qty: 40, checked_by: warehousePocId, challan_no: challanNo(),
    });
    const onward = await api.forward({
      parent_src: 'entry', parent_id: d.body.id, party_name: 'Stitch',
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId, challan_no: challanNo(),
    });
    expect(onward.status).toBe(201);
    expect(onward.body.stage).toBe('Packing');
  });

  test('every stage works the way Processing does', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    let parent = { src: 'receipt', id: receiptId };
    for (const stage of ['Stitching', 'Packing', 'Panchal']) {
      const r = await api.forward({
        parent_src: parent.src, parent_id: parent.id, target_stage: stage,
        party_name: `P-${stage}`, sent_qty: 50, received_qty: 50,
      });
      expect(r.status).toBe(201);
      const row = await lotRow(stage, 'entry', r.body.id);
      // Holds material, and offers the same next step -- except at the warehouse,
      // which is the end of the chain and has nowhere left to go.
      expect(row.balance).toBe(50);
      expect(row.can_forward).toBe(stage !== 'Panchal');
      parent = { src: 'entry', id: r.body.id };
    }
  });

  test('challan_no is required, free text, and capped', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const base = {
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId,
    };

    const missing = await api.forward({ ...base, challan_no: '   ' });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/Challan No is required/i);

    // Free text by explicit decision -- pinned so it is not tightened later.
    const text = await api.forward({ ...base, challan_no: 'CH-2026/07' });
    expect(text.status).toBe(201);

    const long = await api.forward({ ...base, challan_no: 'x'.repeat(51) });
    expect(long.status).toBe(400);
    expect(long.body.message).toMatch(/50 characters or less/);
  });

  test('sending more than the lot has left is refused', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 120, received_qty: 120, checked_by: warehousePocId, challan_no: challanNo(),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only 100m is left/);
  });

  test('more coming back than went out is refused', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 40, received_qty: 41, checked_by: warehousePocId, challan_no: challanNo(),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot be more than Sent Qty/i);
  });

  test('the incoming number is derived, not supplied', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const d = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId, challan_no: challanNo(),
      // Both ignored: the stage decides the prefix and the number carries down.
      incoming_prefix_id: prefixes.Packing.id, incoming_no: 'SPOOFED',
    });
    const row = await lotRow('Stitching', 'entry', d.body.id);
    expect(row.incoming_prefix).toBe('STC');
    expect(row.incoming_no).not.toBe('SPOOFED');
  });

  test('the challan lives on the dispatch row, not on the lot it came from', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const d = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId,
      challan_no: 'ON-THE-DISPATCH',
    });
    expect((await lotRow('Stitching', 'entry', d.body.id)).challan_no).toBe('ON-THE-DISPATCH');
    // An origin lot has no challan of its own at all -- the PO screen stopped
    // managing one, so surfacing that column would print a stale number.
    expect((await grayRow(receiptId)).challan_no).toBeNull();
  });

  test('a lot lists what has gone out of it', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'A',
      sent_qty: 40, received_qty: 40, checked_by: warehousePocId, challan_no: 'C1',
    });
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'B',
      sent_qty: 30, received_qty: 30, checked_by: warehousePocId, challan_no: 'C2',
    });
    const gray = await grayRow(receiptId);
    expect(gray.outgoing.map(c => c.challan_no).sort()).toEqual(['C1', 'C2']);
    expect(gray.balance).toBe(30);
  });

  // The 40 + 60 question, answered explicitly: both halves of a split carry the
  // same incoming number, because the number identifies the material. What tells
  // them apart is the challan number, so that is what has to be unique.
  describe('two challans out of one lot', () => {
    const split = async () => {
      const { receiptId } = await processingLot({ qty: 100 });
      const a = await api.forward({
        parent_src: 'receipt', parent_id: receiptId, party_name: 'A',
        sent_qty: 40, received_qty: 40, checked_by: warehousePocId, challan_no: 'CH-A',
      });
      const b = await api.forward({
        parent_src: 'receipt', parent_id: receiptId, party_name: 'B',
        sent_qty: 60, received_qty: 60, checked_by: warehousePocId, challan_no: 'CH-B',
      });
      return { receiptId, a: a.body.id, b: b.body.id };
    };

    test('both carry the same incoming number', async () => {
      const { receiptId, a, b } = await split();
      const origin = await grayRow(receiptId);
      const rowA = await lotRow('Stitching', 'entry', a);
      const rowB = await lotRow('Stitching', 'entry', b);
      expect(rowA.incoming_no).toBe(origin.incoming_no);
      expect(rowB.incoming_no).toBe(origin.incoming_no);
      expect(rowA.incoming_prefix).toBe('STC');
      expect(rowB.incoming_prefix).toBe('STC');
    });

    test('a challan omitting Received Qty records what was sent', async () => {
      const { receiptId } = await processingLot({ qty: 100 });
      // No received_qty at all -- the form stopped asking for it. Sending is
      // receiving, so nothing is short and the lot's Balance is the number that
      // shows material still to come.
      const d = await A(request(app).post('/api/stitching')).send({
        parent_src: 'receipt', parent_id: receiptId, party_name: 'A',
        sent_qty: 40, received_dozens: 20, challan_type: 'Fresh', challan_no: challanNo(),
      });
      expect(d.status).toBe(201);
      const row = await lotRow('Stitching', 'entry', d.body.id);
      expect(row.sent_qty).toBe(40);
      expect(row.received_qty).toBe(40);
      expect(row.short).toBe(0);
      // The balance is the dozens it now holds.
      expect(row.balance).toBe(20);
    });

    // Still honoured when a caller supplies one, so a genuine shortfall can be
    // recorded through the API or a later correction.
    test('an explicit Received Qty still records a shortfall', async () => {
      const { receiptId } = await processingLot({ qty: 100 });
      const d = await api.forward({
        parent_src: 'receipt', parent_id: receiptId, party_name: 'A',
        sent_qty: 40, received_qty: 38, checked_by: warehousePocId, challan_no: challanNo(),
      });
      const row = await lotRow('Stitching', 'entry', d.body.id);
      expect(row.received_qty).toBe(38);
      expect(row.short).toBe(2);
    });

    test('the same challan number twice to the same party is refused', async () => {
      const { receiptId } = await processingLot({ qty: 100 });
      const base = {
        parent_src: 'receipt', parent_id: receiptId, party_name: 'A',
        received_qty: 40, checked_by: warehousePocId, challan_no: 'SAME',
      };
      expect((await api.forward({ ...base, sent_qty: 40 })).status).toBe(201);
      const again = await api.forward({ ...base, sent_qty: 40 });
      expect(again.status).toBe(400);
      expect(again.body.message).toMatch(/already been used for A/i);
    });

    // The pair is the key, so the number alone is not. Two parties number their
    // challan books from 1 independently and always did.
    test('the same number to a different party is fine, even on one lot', async () => {
      const { receiptId } = await processingLot({ qty: 100 });
      const base = {
        parent_src: 'receipt', parent_id: receiptId,
        sent_qty: 10, received_qty: 10, checked_by: warehousePocId, challan_no: 'SHARED',
      };
      expect((await api.forward({ ...base, party_name: 'A' })).status).toBe(201);
      expect((await api.forward({ ...base, party_name: 'B' })).status).toBe(201);
    });

    // WAS "the same number on a different lot is fine". Migration 085 widened
    // the key from (lot, number) to (number, party) across the whole business:
    // a challan number is printed once on a document handed to one party, and a
    // party's challan book does not restart per lot.
    test('the same number to the same party is refused on a DIFFERENT lot too', async () => {
      const one = await processingLot({ qty: 100 });
      const two = await processingLot({ qty: 100 });
      const base = {
        parent_src: 'receipt', party_name: 'A',
        sent_qty: 10, received_qty: 10, checked_by: warehousePocId, challan_no: 'CROSS-LOT',
      };
      expect((await api.forward({ ...base, parent_id: one.receiptId })).status).toBe(201);
      const res = await api.forward({ ...base, parent_id: two.receiptId });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/already been used for A/i);
    });

    test('withdrawing a challan frees its number for the corrected entry', async () => {
      const { receiptId } = await processingLot({ qty: 100 });
      const first = await api.forward({
        parent_src: 'receipt', parent_id: receiptId, party_name: 'A',
        sent_qty: 40, received_qty: 40, checked_by: warehousePocId, challan_no: 'REUSE',
      });
      await api.removeChallan(first.body.id, 'wrong PO');
      const again = await api.forward({
        parent_src: 'receipt', parent_id: receiptId, party_name: 'A',
        sent_qty: 40, received_qty: 40, checked_by: warehousePocId, challan_no: 'REUSE',
      });
      expect(again.status).toBe(201);
    });

    test('an edit is held to the same rule', async () => {
      const { receiptId } = await processingLot({ qty: 100 });
      const base = {
        parent_src: 'receipt', parent_id: receiptId, party_name: 'A',
        sent_qty: 40, received_qty: 40, checked_by: warehousePocId,
      };
      const first = challanNo('EDIT-A');
      const second = challanNo('EDIT-B');
      const a = await api.forward({ ...base, challan_no: first });
      const b = await api.forward({ ...base, challan_no: second });

      const res = await api.patchLot(b.body.id, { challan_no: first });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/already been used for A/i);
      // Its own number is not a clash with itself.
      expect((await api.patchLot(a.body.id, { challan_no: first })).status).toBe(200);
    });

    // Renaming the party can collide just as easily as renumbering, so the edit
    // re-checks when EITHER half of the pair moves.
    test('moving a challan onto a party that already has that number is refused', async () => {
      const { receiptId } = await processingLot({ qty: 100 });
      const base = {
        parent_src: 'receipt', parent_id: receiptId,
        sent_qty: 40, received_qty: 40, checked_by: warehousePocId, challan_no: 'DUP',
      };
      await api.forward({ ...base, party_name: 'A' });
      const b = await api.forward({ ...base, party_name: 'B' });

      const res = await api.patchLot(b.body.id, { party_name: 'A' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/already been used for A/i);
    });
  });

  describe('the Challan No filter', () => {
    test('finds a lot by a challan raised against it, and by its own', async () => {
      const { receiptId } = await processingLot({ qty: 100 });
      const tag = `F-${uid()}`;
      const d = await api.forward({
        parent_src: 'receipt', parent_id: receiptId, party_name: 'A',
        sent_qty: 40, received_qty: 40, checked_by: warehousePocId, challan_no: tag,
      });

      // From the parent's tab: the Processing lot matches because the challan
      // hangs off it, which is the only place that number is visible.
      const gray = await api.listStage({ stage: 'Processing', challan_no: tag });
      expect(findLot(gray.body.rows, 'receipt', receiptId)).toBeTruthy();

      // And from the challan's own tab, where it IS the row.
      const processed = await api.listStage({ stage: 'Stitching', challan_no: tag });
      expect(findLot(processed.body.rows, 'entry', d.body.id)).toBeTruthy();
    });

    test('an origin lot no longer matches a legacy PO challan number', async () => {
      const { receiptId, poId, lineId } = await processingLot({ qty: 100 });
      const legacy = `LEG-${uid()}`;
      // Written straight to the column the PO screen stopped managing.
      await db.execute({
        sql: 'UPDATE outbound_po_line_receipts SET challan_no = ? WHERE id = ?',
        args: [legacy, receiptId],
      });
      expect(poId && lineId).toBeTruthy();

      const res = await api.listStage({ stage: 'Processing', challan_no: legacy });
      expect(findLot(res.body.rows, 'receipt', receiptId)).toBeFalsy();
    });
  });
});

describe('Writing material off', () => {
  const grayRow = async (receiptId) =>
    findLot((await api.listStage({ stage: 'Processing' })).body.rows, 'receipt', receiptId);

  test('it comes off the balance without becoming a lot anywhere', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const res = await api.writeOff({
      parent_src: 'receipt', parent_id: receiptId, qty: 60, reason: 'water damage in storage',
    });
    expect(res.status).toBe(201);

    const gray = await grayRow(receiptId);
    expect(gray.balance).toBe(40);

    // Not a lot: it is at no stage, and no stage counts it.
    for (const stage of ['Processing', 'Stitching', 'Packing', 'Panchal']) {
      const rows = (await api.listStage({ stage })).body.rows;
      expect(rows.find(r => r.src === 'entry' && r.id === res.body.id)).toBeFalsy();
    }
  });

  test('it appears under the lot it came off, with its reason', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const res = await api.writeOff({
      parent_src: 'receipt', parent_id: receiptId, qty: 60, reason: 'water damage',
    });
    const gray = await grayRow(receiptId);
    const row = gray.outgoing.find(c => c.id === res.body.id);
    expect(row).toBeTruthy();
    expect(row.is_write_off).toBe(true);
    expect(row.write_off_reason).toBe('water damage');
    expect(row.sent_qty).toBe(60);
    expect(row.challan_no).toBeNull();
  });

  test('it shows in the journey', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const res = await api.writeOff({
      parent_src: 'receipt', parent_id: receiptId, qty: 60, reason: 'ruined',
    });
    const journey = await api.journey('receipt', receiptId);
    const node = journey.body.nodes.find(n => n.src === 'entry' && n.id === res.body.id);
    expect(node).toBeTruthy();
    expect(node.is_write_off).toBe(true);
    expect(node.write_off_reason).toBe('ruined');
  });

  test('the reason is required and capped', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const base = { parent_src: 'receipt', parent_id: receiptId, qty: 10 };
    for (const bad of [undefined, '', '   ']) {
      const res = await api.writeOff({ ...base, reason: bad });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/reason is required/i);
    }
    const long = await api.writeOff({ ...base, reason: 'x'.repeat(301) });
    expect(long.status).toBe(400);
    expect(long.body.message).toMatch(/at most 300 characters/);
  });

  test('writing off more than the lot has left is refused', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const res = await api.writeOff({
      parent_src: 'receipt', parent_id: receiptId, qty: 120, reason: 'gone',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only 100m is left/);
  });

  test('it competes for the same balance as challans do', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'A',
      sent_qty: 70, received_qty: 70, checked_by: warehousePocId,
    });
    const tooMuch = await api.writeOff({
      parent_src: 'receipt', parent_id: receiptId, qty: 40, reason: 'gone',
    });
    expect(tooMuch.status).toBe(400);
    expect((await api.writeOff({
      parent_src: 'receipt', parent_id: receiptId, qty: 30, reason: 'gone',
    })).status).toBe(201);
    expect((await grayRow(receiptId)).balance).toBe(0);
  });

  test('withdrawing it puts the quantity straight back', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const res = await api.writeOff({
      parent_src: 'receipt', parent_id: receiptId, qty: 60, reason: 'ruined',
    });
    expect((await grayRow(receiptId)).balance).toBe(40);

    const undone = await api.removeChallan(res.body.id, 'the bundle turned up');
    expect(undone.status).toBe(200);
    expect((await grayRow(receiptId)).balance).toBe(100);
  });

  test('it is audited with the reason', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const res = await api.writeOff({
      parent_src: 'receipt', parent_id: receiptId, qty: 60, reason: 'flood in the godown',
    });
    const audit = await A(request(app).get('/api/audit-logs')
      .query({ entity_type: 'stitching_entry', entity_id: res.body.id }));
    const rows = audit.body.rows || audit.body;
    const entry = rows.find(r => r.action_type === 'STITCHING_WRITE_OFF');
    expect(entry).toBeTruthy();
    expect(entry.description).toMatch(/flood in the godown/);
  });

  test('a lot downstream can be written off too', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const child = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'A',
      sent_qty: 100, received_qty: 100, checked_by: warehousePocId,
    });
    const res = await api.writeOff({
      parent_src: 'entry', parent_id: child.body.id, qty: 25, reason: 'burnt in pressing',
    });
    expect(res.status).toBe(201);
    const row = findLot((await api.listStage({ stage: 'Stitching' })).body.rows, 'entry', child.body.id);
    // A Stitching lot holds dozens -- 100 by the fixture's 1 m/dozen default.
    expect(row.balance).toBe(75);
  });
});

describe('Short — sent but never arrived', () => {
  test('the shortfall belongs to the hop, not to the lot it came from', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const d = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 40, received_qty: 38, checked_by: warehousePocId,
    });
    const gray = findLot((await api.listStage({ stage: 'Processing' })).body.rows, 'receipt', receiptId);
    const child = findLot((await api.listStage({ stage: 'Stitching' })).body.rows, 'entry', d.body.id);

    // The full 40 left Processing. The 2 lost on the way is the child's, not a
    // reason to credit Processing back.
    expect(gray.balance).toBe(60);
    expect(child.received_qty).toBe(38);
    expect(child.short).toBe(2);
    expect(child.balance).toBe(38);
  });

  test('an origin lot has no short, because nobody sent it', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const gray = findLot((await api.listStage({ stage: 'Processing' })).body.rows, 'receipt', receiptId);
    expect(gray.short).toBeNull();
  });

  test('nothing short reads as zero, not as a gap', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const d = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 40, received_qty: 40, checked_by: warehousePocId,
    });
    const child = findLot((await api.listStage({ stage: 'Stitching' })).body.rows, 'entry', d.body.id);
    expect(child.short).toBe(0);
  });
});

describe('Withdrawing a wrongly entered challan', () => {
  // A fresh number every call. One of the tests below RESTORES the challan it
  // withdrew, which puts that (number, party) pair back in play -- with a fixed
  // literal the next test's dispatch would be refused as a duplicate and fail
  // on a 404 further down, nowhere near the cause.
  const dispatched = async (qty = 100, sent = 40) => {
    const { receiptId } = await processingLot({ qty });
    const challan = challanNo('WRONG');
    const d = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dyeing House',
      sent_qty: sent, received_qty: sent, checked_by: warehousePocId, challan_no: challan,
    });
    return { receiptId, challanId: d.body.id, challanNo: challan };
  };

  const grayRow = async (receiptId) =>
    findLot((await api.listStage({ stage: 'Processing' })).body.rows, 'receipt', receiptId);

  test('withdrawing returns the quantity to the lot it was taken from', async () => {
    const { receiptId, challanId } = await dispatched();
    expect((await grayRow(receiptId)).balance).toBe(60);

    const res = await api.removeChallan(challanId, 'entered against the wrong PO');
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);

    const gray = await grayRow(receiptId);
    expect(gray.balance).toBe(100);
    expect(gray.status).toBe('Pending');
  });

  // Nothing about this is a movement, so nothing in the response may name a
  // stage as somewhere material went back to.
  test('the response names no stage as a destination', async () => {
    const { challanId } = await dispatched();
    const res = await api.removeChallan(challanId, 'wrong PO');
    const body = JSON.stringify(res.body);
    for (const stage of ['Processing', 'Stitching', 'Packing', 'Panchal']) {
      expect(body).not.toContain(stage);
    }
  });

  test('the reason is required and capped', async () => {
    const { challanId } = await dispatched();
    for (const bad of [undefined, '', '   ']) {
      const res = await api.removeChallan(challanId, bad);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/reason is required/i);
    }
    const long = await api.removeChallan(challanId, 'x'.repeat(301));
    expect(long.status).toBe(400);
    expect(long.body.message).toMatch(/at most 300 characters/);
  });

  test('a challan with challans of its own is refused', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const first = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 100, received_qty: 100, checked_by: warehousePocId,
    });
    await api.forward({
      parent_src: 'entry', parent_id: first.body.id, party_name: 'S',
      sent_qty: 50, received_qty: 50, checked_by: warehousePocId, challan_no: challanNo(),
    });
    const res = await api.removeChallan(first.body.id, 'too late');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Withdraw those first/i);
  });

  test('a closed lot must be reopened first', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    let parent = { src: 'receipt', id: receiptId };
    let last;
    // All the way to the warehouse: closing is a Panchal-only action now.
    for (const stage of ['Stitching', 'Packing', 'Panchal']) {
      const r = await api.forward({
        parent_src: parent.src, parent_id: parent.id, target_stage: stage,
        party_name: `P-${stage}`, sent_qty: 100, received_qty: 100,
      });
      last = r.body.id;
      parent = { src: 'entry', id: last };
    }
    await api.close('entry', last);
    const res = await api.removeChallan(last, 'wrong');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/reopen it/i);

    await api.reopen('entry', last);
    expect((await api.removeChallan(last, 'wrong')).status).toBe(200);
  });

  test('an unknown challan is a 404', async () => {
    const res = await api.removeChallan(99999999, 'nope');
    expect(res.status).toBe(404);
  });

  test('it is audited with the reason, which survives a restore', async () => {
    const { challanId } = await dispatched();
    await api.removeChallan(challanId, 'wrong PO entirely');
    const audit = await A(request(app).get('/api/audit-logs')
      .query({ entity_type: 'stitching_entry', entity_id: challanId }));
    const rows = audit.body.rows || audit.body;
    const entry = rows.find(r => r.action_type === 'STITCHING_ENTRY_REVERT');
    expect(entry).toBeTruthy();
    expect(entry.description).toMatch(/wrong PO entirely/);
    expect(entry.description).toMatch(/Withdrew challan/);

    await api.restoreLot(challanId);
    const after = await A(request(app).get('/api/audit-logs')
      .query({ entity_type: 'stitching_entry', entity_id: challanId }));
    expect((after.body.rows || after.body)
      .find(r => r.action_type === 'STITCHING_ENTRY_REVERT').description)
      .toMatch(/wrong PO entirely/);
  });

  test('restoring clears the reason and takes the quantity out again', async () => {
    const { receiptId, challanId } = await dispatched();
    await api.removeChallan(challanId, 'mistake');
    expect((await api.restoreLot(challanId)).status).toBe(200);
    expect((await grayRow(receiptId)).balance).toBe(60);

    const journey = await api.journey('receipt', receiptId);
    const node = journey.body.nodes.find(n => n.src === 'entry' && n.id === challanId);
    expect(node.deleted).toBeFalsy();
    expect(node.revert_reason).toBeFalsy();
  });

  test('re-entering it against the right lot afterwards is an ordinary dispatch', async () => {
    const { receiptId, challanId, challanNo: wrongNo } = await dispatched();
    await api.removeChallan(challanId, 'wrong PO');

    // The SAME number again -- withdrawing frees it, which is the whole point.
    const again = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Right Processor',
      sent_qty: 40, received_qty: 40, checked_by: warehousePocId, challan_no: wrongNo,
    });
    expect(again.status).toBe(201);
    expect((await grayRow(receiptId)).balance).toBe(60);

    const journey = await api.journey('receipt', receiptId);
    const ids = journey.body.nodes.filter(n => n.src === 'entry').map(n => n.id);
    expect(ids).toEqual([challanId, again.body.id]);
    const withdrawn = journey.body.nodes.find(n => n.id === challanId && n.src === 'entry');
    expect(withdrawn.deleted).toBe(true);
    expect(withdrawn.revert_reason).toBe('wrong PO');
  });
});

// The chain branches now, so "always the next stage" is no longer the rule. What
// survives -- and what this pins -- is that it only ever goes FORWARD. A lot may
// skip a stage, go to the warehouse, or be sold out, but it never returns to a
// stage it has left.
describe('Material only ever flows forward', () => {
  const { STAGES, DESTINATIONS, destinationsFor } = require('../src/services/stitching.service');

  test('every destination in the graph is later in the chain than its source', () => {
    for (const stage of STAGES) {
      expect(DESTINATIONS).toHaveProperty(stage);
      for (const dest of DESTINATIONS[stage]) {
        expect(STAGES).toContain(dest);
        expect(STAGES.indexOf(dest)).toBeGreaterThan(STAGES.indexOf(stage));
      }
    }
  });

  test('the two terminal stages lead nowhere', () => {
    expect(destinationsFor('Panchal')).toEqual([]);
    expect(destinationsFor('Third Party')).toEqual([]);
  });

  test('a dispatch lands on the destination it asked for', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    let parent = { src: 'receipt', id: receiptId };
    const seen = [];
    for (const stage of ['Stitching', 'Packing', 'Panchal']) {
      const r = await api.forward({
        parent_src: parent.src, parent_id: parent.id, target_stage: stage,
        party_name: `P-${stage}`, sent_qty: 100, received_qty: 100,
      });
      seen.push(r.body.stage);
      parent = { src: 'entry', id: r.body.id };
    }
    expect(seen).toEqual(['Stitching', 'Packing', 'Panchal']);
  });

  test('omitting the destination takes the first one', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const r = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 40, received_qty: 40,
    });
    expect(r.status).toBe(201);
    expect(r.body.stage).toBe('Stitching');
  });

  // create() now takes target_stage -- but ONLY as a choice among the parent's
  // allowed destinations, and no other endpoint accepts a stage at all. A PATCH
  // still cannot move a lot, which is what keeps the chain from running backwards.
  test('a PATCH cannot move a lot to another stage', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const d = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'D',
      sent_qty: 40, received_qty: 40, challan_no: challanNo(), stage: 'Processing',
    });
    expect(d.status).toBe(201);
    // A bare `stage` in the body is ignored -- only target_stage is read, and
    // only on create.
    expect(d.body.stage).toBe('Stitching');

    const patched = await api.patchLot(d.body.id, { stage: 'Packing', target_stage: 'Packing' });
    const row = findLot((await api.listStage({ stage: 'Stitching' })).body.rows, 'entry', d.body.id);
    expect([200, 400]).toContain(patched.status);
    expect(row).toBeTruthy();
    expect(row.stage).toBe('Stitching');
  });
});

// prevStage is gone. It answered "the stage before this one", which a strictly
// linear chain had exactly one of -- a branching one does not: a Packing lot may
// have come from Processing or from Stitching. Every caller that wanted it
// actually wanted the parent row, which a lot already carries.
describe('a hop knows its real parent', () => {
  test('parent_stage is the stage this hop actually left', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const child = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dyeing House',
      sent_qty: 100, received_qty: 100, checked_by: warehousePocId,
    });
    const skipped = await api.forward({
      parent_src: 'entry', parent_id: child.body.id, target_stage: 'Panchal',
      party_name: 'Store', sent_qty: 40,
    });
    const rows = (await api.listStage()).body.rows;
    // parent_stage is exposed because a challan's rate belongs to the stage it
    // LEFT -- it is a label for the rate, not somewhere material can go back to.
    const row = findLot(rows, 'entry', child.body.id);
    expect(row.parent_stage).toBe('Processing');
    expect(row.parent_src).toBe('receipt');
    expect(row.parent_id).toBe(receiptId);
    expect(findLot(rows, 'entry', skipped.body.id).parent_stage).toBe('Stitching');
  });
});

describe('Chain-order sorting for the All view', () => {
  // Walks one lot the whole way, so a single PO holds all four stages.
  const fullChain = async () => {
    const { receiptId, poId } = await processingLot({ qty: 100 });
    let parent = { src: 'receipt', id: receiptId };
    for (const party of ['Dyeing House', 'Stitch Unit', 'Packer A']) {
      const r = await api.forward({
        parent_src: parent.src, parent_id: parent.id, party_name: party,
        sent_qty: 100, received_qty: 100, checked_by: warehousePocId,
      });
      parent = { src: 'entry', id: r.body.id };
    }
    return { receiptId, poId };
  };

  test('omitting stage returns every stage of the chain', async () => {
    const { poId } = await fullChain();
    const res = await api.listStage({ po_order_no: String(poId) });
    expect(res.status).toBe(200);
    expect(res.body.rows.map(r => r.stage).sort())
      .toEqual(['Packing', 'Panchal', 'Processing', 'Stitching']);
  });

  // The assertion that fails if anyone "simplifies" po_stage to a plain stage
  // sort: alphabetically Packing comes FIRST, ahead of where the chain starts.
  test('po_stage orders by the chain, not alphabetically', async () => {
    const { poId } = await fullChain();
    const res = await api.listStage({
      po_order_no: String(poId), sort_by: 'po_stage', sort_dir: 'asc',
    });
    expect(res.status).toBe(200);
    expect(res.body.rows.map(r => r.stage))
      .toEqual(['Processing', 'Stitching', 'Packing', 'Panchal']);
  });

  test('lots from different POs group by PO before stage', async () => {
    const a = await fullChain();
    const b = await fullChain();
    const res = await api.listStage({ sort_by: 'po_stage', sort_dir: 'asc', page_size: 'all' });
    const ids = res.body.rows.map(r => r.po_id).filter(id => id === a.poId || id === b.poId);
    // Every row of the lower PO comes before any row of the higher one.
    const [lo, hi] = [a.poId, b.poId].sort((x, y) => x - y);
    expect(ids).toEqual([...ids.filter(i => i === lo), ...ids.filter(i => i === hi)]);
  });

  test('an unknown sort key falls back rather than erroring', async () => {
    const res = await api.listStage({ sort_by: 'nonsense' });
    expect(res.status).toBe(200);
  });
});

// Processing is the last stage in metres. A challan out of it records the
// metres sent and the dozens that came back -- that is where fabric becomes
// pieces, and the yield is born there. From Stitching on, a lot counts dozens
// and nothing else: its balance is dozens, a challan out of it sends dozens,
// and what was sent IS what arrives.
describe('Dozens from Stitching on', () => {
  const svc = require('../src/services/stitching.service');

  // A Processing lot sent on to Stitching as 40 dozen out of 96 metres back.
  async function stitchingLot() {
    const { receiptId } = await processingLot({ qty: 100 });
    const r = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye',
      sent_qty: 100, received_qty: 96, received_dozens: 40,
    });
    expect(r.status).toBe(201);
    return { receiptId, id: r.body.id };
  }

  test('a challan out of Processing records metres and dozens, and derives the yield', async () => {
    const { id } = await stitchingLot();
    const row = findLot((await api.listStage({ stage: 'Stitching' })).body.rows, 'entry', id);
    expect(row.received_qty).toBe(96);
    expect(row.received_dozens).toBe(40);
    expect(row.metres_per_dozen).toBe(2.4);
    expect(row.m_per_dozen_source).toMatchObject({ kind: 'entry', carried: false, metres: 96, dozens: 40 });
    // The lot now holds dozens, so that is what its balance counts.
    expect(row.balance).toBe(40);
    expect(row.balance_unit).toBe('dz');
    // PO Qty stays the metre figure the chain started from.
    expect(row.po_qty_metres).toBe(100);
  });

  test('dozens are required on a challan out of Processing', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const r = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye',
      sent_qty: 100, received_dozens: null,
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Dozens Received is required/);
  });

  test('a challan out of a dozen stage is dozens only, and carries the yield', async () => {
    const { id } = await stitchingLot();
    // Metres are refused rather than ignored once goods are counted in dozens.
    const metres = await A(request(app).post('/api/stitching')).send({
      parent_src: 'entry', parent_id: id, party_name: 'Pack', challan_no: challanNo(),
      challan_type: 'Fresh', sent_qty: 30,
    });
    expect(metres.status).toBe(400);
    expect(metres.body.message).toMatch(/enter Dozens Sent/);

    const r = await api.forward({
      parent_src: 'entry', parent_id: id, party_name: 'Pack', sent_dozens: 30,
    });
    expect(r.status).toBe(201);
    expect(r.body.stage).toBe('Packing');

    const row = findLot((await api.listStage({ stage: 'Packing' })).body.rows, 'entry', r.body.id);
    // Dozens sent ARE the dozens received.
    expect(row.sent_dozens).toBe(30);
    expect(row.received_dozens).toBe(30);
    expect(row.sent_qty).toBeNull();
    expect(row.balance).toBe(30);
    // No metres on this hop, so the yield is carried from where they were counted.
    expect(row.metres_per_dozen).toBe(2.4);
    expect(row.m_per_dozen_source).toMatchObject({ carried: true, metres: 96, dozens: 40 });

    const parent = findLot((await api.listStage({ stage: 'Stitching' })).body.rows, 'entry', id);
    expect(parent.balance).toBe(10);
    expect(parent.status).toBe('Partial');
  });

  test('dozens sent cannot exceed the dozens left', async () => {
    const { id } = await stitchingLot();
    const r = await api.forward({
      parent_src: 'entry', parent_id: id, party_name: 'Pack', sent_dozens: 41,
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/only 40 dozen is left/);
  });

  test('a write-off from a dozen lot is counted in dozens', async () => {
    const { id } = await stitchingLot();
    const res = await api.writeOff({ parent_src: 'entry', parent_id: id, qty: 15, reason: 'stained' });
    expect(res.status).toBe(201);
    const { rows } = await db.execute({
      sql: 'SELECT sent_qty, sent_dozens FROM stitching_entries WHERE id = ?', args: [res.body.id],
    });
    expect(rows[0].sent_qty).toBeNull();
    expect(rows[0].sent_dozens).toBe(15);
    const parent = findLot((await api.listStage({ stage: 'Stitching' })).body.rows, 'entry', id);
    expect(parent.balance).toBe(25);
  });

  test('the yield is derived, never stored, and agrees with the service', () => {
    expect(svc.metresPerDozen(96, 40)).toBe(2.4);
    // Two places, rounded not truncated.
    expect(svc.metresPerDozen(100, 3)).toBe(33.33);
    // Nothing to divide by is blank rather than Infinity.
    expect(svc.metresPerDozen(96, 0)).toBeNull();
    expect(svc.metresPerDozen(null, 40)).toBeNull();
  });

  // A lot can be BOUGHT already stitched, in which case it is a receipt and
  // never passes through stitching_entries at all. Its yield is the PO metres
  // against the dozens received.
  test('a receipt bought in at Packing carries its own dozens and yield', async () => {
    const { poId, lineId } = await setupLine();
    const receipt = await postReceipt(poId, lineId, {
      incoming_no: `K-${uid()}`, incoming_stage: 'Packing', received_dozens: 25,
    });
    expect(receipt.status).toBe(201);

    const row = findLot((await api.listStage({ stage: 'Packing' })).body.rows,
      'receipt', receipt.body.id);
    expect(row.received_dozens).toBe(25);
    expect(row.balance).toBe(25);
    // receiptBody puts 100 metres on the receipt: 100 / 25.
    expect(row.metres_per_dozen).toBe(4);
    expect(row.m_per_dozen_source).toMatchObject({ kind: 'receipt', carried: false });
  });

  test('a receipt at Processing is refused a dozen count', async () => {
    const { poId, lineId } = await setupLine();
    const res = await postReceipt(poId, lineId, {
      incoming_no: `K-${uid()}`, incoming_stage: 'Processing', received_dozens: 25,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only counted on fabric received at Stitching, Packing, Panchal, Third Party/);
  });
});

// One challan, several lines: a Fresh line and a Second line travel apart from
// here, so each becomes its own lot, sharing the challan's header.
describe('Challan line items', () => {
  test('each line becomes its own lot, with its own yield', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const no = challanNo('LINES');
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye', challan_no: no, process_rate: 4,
      lines: [
        { challan_type: 'Fresh', sent_qty: 60, received_dozens: 30 },
        { challan_type: 'Second', sent_qty: 20, received_dozens: 8 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.ids).toHaveLength(2);

    const rows = (await api.listStage({ stage: 'Stitching' })).body.rows;
    const [a, b] = res.body.ids.map(id => findLot(rows, 'entry', id));
    expect([a.challan_line_no, b.challan_line_no]).toEqual([1, 2]);
    expect([a.challan_type, b.challan_type]).toEqual(['Fresh', 'Second']);
    expect([a.metres_per_dozen, b.metres_per_dozen]).toEqual([2, 2.5]);
    expect(a.challan_no).toBe(no);
    expect(b.challan_no).toBe(no);
    // One header: the same rate and incoming number on both lines.
    expect([a.process_rate, b.process_rate]).toEqual([4, 4]);
    expect(a.incoming_no).toBe(b.incoming_no);

    // Together they took 80 of the 100 metres.
    const parent = findLot((await api.listStage({ stage: 'Processing' })).body.rows, 'receipt', receiptId);
    expect(parent.balance).toBe(20);
  });

  test('the lines together cannot overdraw the lot', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye',
      lines: [
        { challan_type: 'Fresh', sent_qty: 60, received_dozens: 30 },
        { challan_type: 'Second', sent_qty: 50, received_dozens: 20 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Cannot send 110m — only 100m is left/);
  });

  test('an error on a line names the line', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye',
      lines: [
        { challan_type: 'Fresh', sent_qty: 60, received_dozens: 30 },
        { challan_type: 'Second', sent_qty: 20 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Line 2: Dozens Received is required');
  });

  test('two lines of one challan do not clash with each other', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const no = challanNo('TWO');
    const first = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye', challan_no: no,
      lines: [
        { challan_type: 'Fresh', sent_qty: 10, received_dozens: 5 },
        { challan_type: 'Fresh', sent_qty: 10, received_dozens: 5 },
      ],
    });
    expect(first.status).toBe(201);
    // But the number is still spent for that party.
    const again = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye', challan_no: no, sent_qty: 5,
    });
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already been used for Dye/);
  });
});

// The page leads with the PO party on every tab, and lists each job worker the
// goods passed through beneath it as "<Stage> - <party short name>".
describe('Party chain', () => {
  test('each challan party is tagged with its stage and short name', async () => {
    const stitcher = `Shree Krishna Textiles ${uid()}`;
    await api.createParty({ name: stitcher, short_name: 'SKT', uses: ['Stitching'] });
    const packer = 'Royal Packers';

    const { receiptId, vendorName } = await processingLot({ qty: 100 });
    const f1 = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: stitcher, sent_qty: 100,
    });
    const f2 = await api.forward({
      parent_src: 'entry', parent_id: f1.body.id, party_name: packer, sent_dozens: 50,
    });
    const row = findLot((await api.listStage({ stage: 'Packing' })).body.rows, 'entry', f2.body.id);
    expect(row.vendor_name).toBe(vendorName);
    // Named for the stage each challan LEFT. A master short name wins; a party
    // with none falls back to its initials.
    expect(row.party_chain).toEqual(['Processing - SKT', 'Stitching - RP']);
  });

  test('a short name is capped, and can be cleared', async () => {
    const long = await api.createParty({ name: `Long ${uid()}`, short_name: 'x'.repeat(11) });
    expect(long.status).toBe(400);
    expect(long.body.message).toMatch(/Short Name must be 10 characters or less/);

    const ok = await api.createParty({ name: `Short ${uid()}`, short_name: 'SH' });
    expect(ok.body.short_name).toBe('SH');
    const cleared = await api.patchParty(ok.body.id, { short_name: '' });
    expect(cleared.body.short_name).toBeNull();
  });

  test('a lot booked straight in on a PO receipt has no challan party', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const row = findLot((await api.listStage({ stage: 'Processing' })).body.rows, 'receipt', receiptId);
    expect(row.party_chain).toEqual([]);
  });

  test('initials are derived from the name, and a one-word name keeps three letters', () => {
    const svc = require('../src/services/stitching.service');
    expect(svc.partyShort('Shree Krishna Textiles')).toBe('SKT');
    expect(svc.partyShort('Ramesh')).toBe('RAM');
    expect(svc.partyShort('Ramesh', 'RK')).toBe('RK');
    expect(svc.partyTag('Stitching', 'Shree Krishna Textiles')).toBe('Stitching - SKT');
  });
});

// Checked By and PCL Inc No are asked at the two destinations where the goods
// change hands for good -- our warehouse and the exit -- and nowhere else.
describe('Checked By and PCL Inc No at the two hand-overs', () => {
  // A lot standing at Stitching, which can reach Packing, Panchal and Third
  // Party -- so one fixture serves every case below.
  const processedLot = async () => {
    const { receiptId } = await processingLot({ qty: 200 });
    const d = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Dye', sent_qty: 200,
    });
    expect(d.status).toBe(201);
    return d.body.id;
  };

  test('a challan to Panchal needs a checker', async () => {
    const id = await processedLot();
    const r = await api.forward({
      parent_src: 'entry', parent_id: id, target_stage: 'Panchal',
      party_name: 'Panchal', sent_qty: 10, checked_by: null,
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Checked By is required/);
  });

  test('a challan to Panchal needs its own incoming number', async () => {
    const id = await processedLot();
    const r = await api.forward({
      parent_src: 'entry', parent_id: id, target_stage: 'Panchal',
      party_name: 'Panchal', sent_qty: 10, panchal_incoming_no: null,
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/PCL Inc No is required when sending to Panchal/);
  });

  // The whole point of the separate column: the chain's own suffix is what ties
  // a Panchal lot back to the fabric it was cut from, so the warehouse number
  // must not overwrite it.
  test('the PCL number is stored beside the carried incoming no, not over it', async () => {
    const id = await processedLot();
    const pcl = `PCL-${uid()}`;
    const r = await api.forward({
      parent_src: 'entry', parent_id: id, target_stage: 'Panchal',
      party_name: 'Panchal', sent_qty: 10,
      checked_by: warehousePocId, panchal_incoming_no: pcl,
    });
    expect(r.status).toBe(201);

    const row = findLot((await api.listStage({ stage: 'Panchal' })).body.rows, 'entry', r.body.id);
    expect(row.panchal_incoming_no).toBe(pcl);
    expect(row.incoming_prefix).toBe('PNL');
    // Still the suffix inherited from the parent, untouched by the PCL number.
    expect(row.incoming_no).toBeTruthy();
    expect(row.incoming_no).not.toBe(pcl);
    expect(row.checked_by_name).toBeTruthy();
  });

  test('a challan to a third party needs a checker', async () => {
    const id = await processedLot();
    const r = await api.forward({
      parent_src: 'entry', parent_id: id, target_stage: 'Third Party',
      party_name: 'Buyer', sent_qty: 10,
      outbound_bill_no: `OB-${uid()}`, checked_by: null,
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Checked By is required/);
  });

  // The qualification the outbound receipt used to enforce, moved here.
  test('the checker must actually be tagged Warehouse_POC', async () => {
    const id = await processedLot();
    const { rows } = await db.execute({
      sql: `INSERT INTO users (name, username, email, password_hash, is_first_login)
            VALUES (?, ?, ?, 'x', 0) RETURNING id`,
      args: [`Untagged ${uid()}`, `u-${uid()}`, `u-${uid()}@x.com`],
    });
    const r = await api.forward({
      parent_src: 'entry', parent_id: id, target_stage: 'Panchal',
      party_name: 'Panchal', sent_qty: 10, checked_by: rows[0].id,
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Checked By must be a user tagged Warehouse_POC/);
  });

  // Refused rather than ignored, the same way a bill number on an internal move
  // is -- a number typed against the wrong destination is a question, not noise.
  test('a PCL number is refused anywhere but Panchal', async () => {
    const id = await processedLot();
    const r = await api.forward({
      parent_src: 'entry', parent_id: id, target_stage: 'Packing',
      party_name: 'Packer', sent_qty: 10, panchal_incoming_no: 'PCL-9',
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/PCL Inc No applies only to goods sent to Panchal/);
  });

  // An ordinary move between job workers still stamps the session user rather
  // than asking, and asks for neither of the two fields above.
  test('an internal move asks for neither, and stamps the session user', async () => {
    const id = await processedLot();
    const r = await api.forward({
      parent_src: 'entry', parent_id: id, target_stage: 'Packing',
      party_name: 'Packer', sent_qty: 10,
    });
    expect(r.status).toBe(201);
    const { rows } = await db.execute({
      sql: 'SELECT checked_by, panchal_incoming_no FROM stitching_entries WHERE id = ?',
      args: [r.body.id],
    });
    expect(Number(rows[0].checked_by)).toBe(warehousePocId);
    expect(rows[0].panchal_incoming_no).toBeNull();
  });
});

describe('Status SQL/JS parity', () => {
  const svc = require('../src/services/stitching.service');

  test.each([
    ['Processing', 100, 0, 'Pending'],
    ['Processing', 100, 60, 'Partial'],
    ['Processing', 100, 100, 'Forwarded'],
    ['Processing', 100, 99.999, 'Forwarded'],
    ['Processing', 50, 0, 'Pending'],
    // Packing is an ordinary forwarding stage now. It reads like Processing does.
    ['Packing', 50, 0, 'Pending'],
    ['Packing', 50, 50, 'Forwarded'],
    // Panchal is the warehouse: balance is meaningless because nothing forwards
    // out of it, so it reads In Stock until someone closes it.
    ['Panchal', 50, 0, 'In Stock'],
    ['Panchal', 50, 50, 'In Stock'],
    // Third Party is the exit. The goods are not ours, so there is no state left.
    ['Third Party', 50, 0, 'Sold'],
    ['Third Party', 50, 50, 'Sold'],
  ])('%s lot of %s with %s forwarded is %s', (stage, receivedQty, forwarded, expected) => {
    expect(svc.computeStatus({ stage, receivedQty, forwarded })).toBe(expected);
  });

  // In Transit was added for a two-step move and removed with it. Pinned so it
  // does not creep back: adding a challan IS sending the lot on, and a shortage
  // is a quantity rather than a state.
  test('there is no In Transit status', () => {
    expect(Object.values(svc.STATUS)).not.toContain('In Transit');
    expect(svc.OPEN_STATUSES).not.toContain('In Transit');
  });

  // Panchal is the only stage where closed_at changes the answer.
  test.each([
    [null, 'In Stock'],
    ['2026-09-05 10:00:00', 'Closed'],
  ])('a Panchal lot with closedAt %s is %s', (closedAt, expected) => {
    expect(svc.computeStatus({ stage: 'Panchal', receivedQty: 50, forwarded: 0, closedAt })).toBe(expected);
  });

  // closed_at is inert everywhere else. Rows closed while Packing WAS the stock
  // stage still carry one, and it must not keep changing their status.
  test('closed_at does not change the answer at any other stage', () => {
    for (const stage of ['Processing', 'Stitching', 'Packing']) {
      const closedAt = '2026-09-05 10:00:00';
      expect(svc.computeStatus({ stage, receivedQty: 50, forwarded: 0, closedAt }))
        .toBe(svc.computeStatus({ stage, receivedQty: 50, forwarded: 0 }));
    }
  });

  // Sold is terminal, so it is never outstanding work.
  test('Sold is a status but never an open one', () => {
    expect(Object.values(svc.STATUS)).toContain('Sold');
    expect(svc.OPEN_STATUSES).not.toContain('Sold');
  });

  test('every row the API returns agrees with computeStatus', async () => {
    const { receiptId } = await processingLot({ qty: 100 });
    const f1 = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'P',
      sent_qty: 40, received_qty: 40,
    });
    // Put a lot on each of the new stages too, so the sweep actually exercises
    // the two branches the SQL CASE grew.
    await api.forward({
      parent_src: 'entry', parent_id: f1.body.id, target_stage: 'Panchal',
      party_name: 'P', sent_qty: 20, received_qty: 20,
    });
    await api.forward({
      parent_src: 'entry', parent_id: f1.body.id, target_stage: 'Third Party',
      party_name: 'P', sent_qty: 10, received_qty: 10, outbound_bill_no: 'OB-9',
    });
    const res = await api.listStage();
    expect(res.body.rows.length).toBeGreaterThan(0);
    for (const r of res.body.rows) {
      // qty_basis: the lot's quantity in its own unit -- metres at Processing,
      // dozens from Stitching on -- which is what the SQL twin is handed too.
      expect(r.status).toBe(svc.computeStatus({
        stage: r.stage, receivedQty: r.qty_basis, forwarded: r.forwarded,
        closedAt: r.closed_at,
      }));
    }
  });
});

describe('Audit logging', () => {
  const auditFor = (entityType, entityId) => A(request(app).get('/api/audit-logs')
    .query({ entity_type: entityType, entity_id: entityId }));

  test('a forward writes a STITCHING_ENTRY_CREATE entry', async () => {
    const { receiptId } = await processingLot();
    const res = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Audited Co',
      sent_qty: 10, received_qty: 9, checked_by: warehousePocId,
    });
    const audit = await auditFor('stitching_entry', res.body.id);
    const rows = audit.body.rows || audit.body;
    expect(rows.length).toBeGreaterThan(0);
    const created = rows.find(r => r.action_type === 'STITCHING_ENTRY_CREATE');
    expect(created).toBeTruthy();
    expect(created.description).toMatch(/Audited Co/);
    // One act, so one entry -- what was sent and what came back are both in it.
    expect(created.description).toMatch(/back/);
  });

  test('an edit records the individual field changes', async () => {
    const { receiptId } = await processingLot();
    const created = await api.forward({
      parent_src: 'receipt', parent_id: receiptId, party_name: 'Before Co',
      sent_qty: 10, received_qty: 10, checked_by: warehousePocId,
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
    const created = await api.createPrefix({ prefix: `AU${uid()}`, stage: 'Processing' });
    const audit = await auditFor('stitching_prefix', created.body.id);
    const rows = audit.body.rows || audit.body;
    expect(rows.some(r => r.action_type === 'STITCHING_PREFIX_CREATE')).toBe(true);
  });
});
