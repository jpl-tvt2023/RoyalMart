const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const { db } = require('./helpers/db');

// Daily stock counts (migration 102): the station's start / scan / close, and
// the portal's reports. The rules under test:
//   Day 1 is the baseline. A pack seen before and missing from a closed count
//   is Out at once. One that comes back is a missed scan (Admin/Owner only),
//   and the earlier count's Out total corrects itself. A sticker never counted
//   is never Out. A scan on another floor is flagged.
// Messages are asserted verbatim where src/utils/barcodeStation.js mirrors them.
//
// One scenario, built up in order: the describe blocks below run top to bottom
// against the same counts (jest runs a file's tests in order).

let adminToken;
let employeeToken;
let stationToken;
let uidCounter = 0;
const uid = () => `${Date.now()}-${uidCounter++}`;

const PIN = '5731';
const OP = 'Suresh';
const fx = {};
const counts = {};

const asAdmin = (r) => r.set('Authorization', `Bearer ${adminToken}`);
const asEmployee = (r) => r.set('Authorization', `Bearer ${employeeToken}`);
const asStation = (r) => r.set('Authorization', `Bearer ${stationToken}`);

const startCount = (body = { operator: OP }) => asStation(request(app).post('/api/station/counts')).send(body);
const scan = (countId, floorId, keys, operator = OP) => asStation(request(app).post(`/api/station/counts/${countId}/scans`))
  .send({ operator, floor_id: floorId, keys: keys.map(String) });
const closeCount = (countId, operator = OP) => asStation(request(app).post(`/api/station/counts/${countId}/close`)).send({ operator });
const current = () => asStation(request(app).get('/api/station/counts/current'));
const stock = (path, as = asAdmin) => as(request(app).get(`/api/stock${path}`));

const insertId = async (sql, args) => Number((await db.execute({ sql, args })).rows[0].id);

async function cleanStock() {
  await db.execute('DELETE FROM stock_count_scans');
  await db.execute('DELETE FROM stock_counts');
  await db.execute('DELETE FROM label_keys');
  await db.execute('DELETE FROM label_batches');
}

// A generated batch through the station API; returns its keys in label order.
async function batchWithKeys({ articleId, floorId, packSize, labels }) {
  const draft = await asStation(request(app).post('/api/station/batches')).send({
    outbound_vendor_id: fx.vendorId, article_id: articleId, pack_size: packSize,
    floor_id: floorId, label_count: labels, operator: OP,
  });
  expect(draft.status).toBe(201);
  const gen = await asStation(request(app).post(`/api/station/batches/${draft.body.id}/generate`)).send({ operator: OP });
  expect(gen.status).toBe(200);
  const { rows } = await db.execute({
    sql: 'SELECT label_key FROM label_keys WHERE batch_id = ? ORDER BY label_no',
    args: [draft.body.id],
  });
  return rows.map((r) => String(r.label_key));
}

const summaryRow = (body, articleId, floorId) => body.rows.find((r) => r.article_id === articleId && r.floor_id === floorId);
const countRow = (body, id) => body.rows.find((r) => r.id === id);

beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'RoyalMart#Admin' });
  adminToken = login.body.accessToken;
  fx.adminId = Number(login.body.user.id);

  const empUser = `sc-emp-${uid()}`;
  fx.employeeId = await insertId(
    'INSERT INTO users (name, username, email, password_hash, is_first_login) VALUES (?, ?, ?, ?, 0) RETURNING id',
    ['SC Employee', empUser, `${empUser}@x.com`, bcrypt.hashSync('Employee#Pass1', 4)],
  );
  await db.execute({ sql: "INSERT INTO user_roles (user_id, role) VALUES (?, 'Employee')", args: [fx.employeeId] });
  employeeToken = (await request(app).post('/api/auth/login').send({ username: empUser, password: 'Employee#Pass1' })).body.accessToken;

  const tag = uid();
  fx.tag = tag;
  fx.boxName = `SC Box ${tag}`;
  fx.cartonName = `Corrugated SC ${tag}`;
  fx.boxId = await insertId(
    "INSERT INTO packaging_raw_materials (category, item_name, variant, unit_metric) VALUES ('Packaging', ?, '', 'pcs') RETURNING id",
    [fx.boxName],
  );
  fx.cartonId = await insertId(
    "INSERT INTO packaging_raw_materials (category, item_name, variant, unit_metric) VALUES ('Packaging', ?, '', 'pcs') RETURNING id",
    [fx.cartonName],
  );
  fx.vendorId = await insertId('INSERT INTO outbound_vendors (name) VALUES (?) RETURNING id', [`SC Vendor ${tag}`]);
  for (const item of [fx.boxName, fx.cartonName]) {
    await db.execute({
      sql: "INSERT INTO outbound_vendor_articles (vendor_id, category, item_name, variant) VALUES (?, 'Packaging', ?, NULL)",
      args: [fx.vendorId, item],
    });
  }
  fx.floor1 = await insertId('INSERT INTO floors (name) VALUES (?) RETURNING id', [`SC Ground ${tag}`]);
  fx.floor2 = await insertId('INSERT INTO floors (name) VALUES (?) RETURNING id', [`SC First ${tag}`]);
  fx.shutFloor = await insertId('INSERT INTO floors (name, is_active) VALUES (?, 0) RETURNING id', [`SC Shut ${tag}`]);

  await cleanStock();
  await db.execute(`UPDATE barcode_station_settings SET pin_hash = NULL, pin_version = 0, failed_attempts = 0, locked_until = NULL WHERE id = 1`);
  const pinRes = await asAdmin(request(app).put('/api/configurations/barcode-station')).send({ pin: PIN });
  expect(pinRes.status).toBe(200);
  stationToken = (await request(app).post('/api/station/session').send({ pin: PIN })).body.token;
  expect(stationToken).toBeTruthy();

  // Boxes: 3 packs of 100 on floor 1. Cartons: 2 packs of 10 on floor 2.
  fx.box = await batchWithKeys({ articleId: fx.boxId, floorId: fx.floor1, packSize: 100, labels: 3 });
  fx.carton = await batchWithKeys({ articleId: fx.cartonId, floorId: fx.floor2, packSize: 10, labels: 2 });

  // A key no sticker has.
  let k = 99999999;
  for (;;) {
    const { rows } = await db.execute({ sql: 'SELECT 1 FROM label_keys WHERE label_key = ?', args: [k] });
    if (!rows.length) break;
    k -= 1;
  }
  fx.unknownKey = String(k);
});

afterAll(async () => {
  await cleanStock();
  await db.execute(`UPDATE barcode_station_settings SET pin_hash = NULL, pin_version = 0, failed_attempts = 0, locked_until = NULL WHERE id = 1`);
  if (fx.poId) {
    await db.execute({ sql: 'DELETE FROM marketplace_po_lines WHERE po_id = ?', args: [fx.poId] });
    await db.execute({ sql: 'DELETE FROM marketplace_pos WHERE po_id = ?', args: [fx.poId] });
  }
  if (fx.productId) {
    await db.execute({ sql: 'DELETE FROM product_packaging_requirements WHERE product_id = ?', args: [fx.productId] });
    await db.execute({ sql: 'DELETE FROM product_barcode_requirements WHERE product_id = ?', args: [fx.productId] });
    await db.execute({ sql: 'DELETE FROM product_vendor_codes WHERE product_id = ?', args: [fx.productId] });
    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [fx.productId] });
  }
  await db.execute({ sql: 'DELETE FROM outbound_vendor_articles WHERE vendor_id = ?', args: [fx.vendorId] });
  await db.execute({ sql: 'DELETE FROM outbound_vendors WHERE id = ?', args: [fx.vendorId] });
  await db.execute({ sql: 'DELETE FROM packaging_raw_materials WHERE id IN (?, ?)', args: [fx.boxId, fx.cartonId] });
  await db.execute("DELETE FROM floors WHERE name LIKE 'SC %'");
  await db.execute({ sql: 'DELETE FROM user_roles WHERE user_id = ?', args: [fx.employeeId] });
  await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [fx.employeeId] });
});

describe('Stock counts — schema', () => {
  test('at most one count can be open', async () => {
    await db.execute("INSERT INTO stock_counts (started_by) VALUES ('x')");
    await expect(db.execute("INSERT INTO stock_counts (started_by) VALUES ('y')")).rejects.toThrow(/UNIQUE/i);
    await db.execute('DELETE FROM stock_counts');
  });
});

describe('Stock counts — station, count 1 (the baseline)', () => {
  test('needs a station token', async () => {
    expect((await request(app).get('/api/station/counts/current')).status).toBe(401);
  });

  test('nothing open yet', async () => {
    const res = await current();
    expect(res.status).toBe(200);
    expect(res.body.count).toBeNull();
  });

  test('start needs an operator, then a second start is refused', async () => {
    expect((await startCount({})).body.message).toBe('Operator name is required');
    const res = await startCount();
    expect(res.status).toBe(201);
    counts.c1 = res.body.count.id;
    expect(res.body.count.started_by).toBe(OP);

    const again = await startCount();
    expect(again.status).toBe(409);
    expect(again.body.count.id).toBe(counts.c1);
  });

  test('a count with no scans cannot be closed', async () => {
    const res = await closeCount(counts.c1);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Scan at least one pack before closing the count');
  });

  test('scan validation, in field order, with the mirrored messages', async () => {
    const send = (body) => asStation(request(app).post(`/api/station/counts/${counts.c1}/scans`)).send({ operator: OP, ...body });
    expect((await send({ keys: [fx.box[0]] })).body.message).toBe('Floor is required');
    expect((await send({ floor_id: fx.floor1, keys: [] })).body.message).toBe('Scan at least one key');
    expect((await send({ floor_id: fx.floor1, keys: ['1234'] })).body.message).toBe('Every key must be 8 digits');
    expect((await send({ floor_id: fx.floor1, keys: Array(201).fill(fx.box[0]) })).body.message).toBe('Send at most 200 keys at a time');
    expect((await send({ floor_id: fx.shutFloor, keys: [fx.box[0]] })).body.message).toMatch(/no longer active/);
    const noOp = await asStation(request(app).post(`/api/station/counts/${counts.c1}/scans`)).send({ floor_id: fx.floor1, keys: [fx.box[0]] });
    expect(noOp.body.message).toBe('Operator name is required');
  });

  test('counted, already counted, unknown, and the floor flag', async () => {
    // box 0 twice in one batch (deduped), box 1, an unknown key, and a carton
    // -- whose sticker says floor 2 -- scanned on floor 1.
    const res = await scan(counts.c1, fx.floor1, [fx.box[0], fx.box[0], fx.box[1], fx.unknownKey, fx.carton[0]]);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => [r.key, r.status])).toEqual([
      [fx.box[0], 'counted'],
      [fx.box[1], 'counted'],
      [fx.unknownKey, 'unknown'],
      [fx.carton[0], 'counted'],
    ]);
    const carton = res.body.results[3];
    expect(carton.floor_mismatch).toBe(true);
    expect(carton.pack.sticker_floor_id).toBe(fx.floor2);
    expect(res.body.results[0].floor_mismatch).toBe(false);
    expect(res.body.results[0].pack).toMatchObject({ pack_size: 100, item_name: fx.boxName, label_no: 1, label_count: 3 });
    expect(res.body.scanned).toBe(3);

    // Re-sent (a retry after the Wi-Fi dropped): nothing counts twice.
    const again = await scan(counts.c1, fx.floor1, [fx.box[0], fx.box[1]]);
    expect(again.body.results.map((r) => r.status)).toEqual(['already_counted', 'already_counted']);
    expect(again.body.scanned).toBe(3);
  });

  test('progress: everything not Out is expected, by floor and article', async () => {
    const res = await current();
    expect(res.body.count.id).toBe(counts.c1);
    const p = res.body.progress;
    expect(p).toMatchObject({ scanned: 3, expected: 5, found: 3, to_go: 2 });
    const f1 = p.by_floor.find((f) => f.floor_id === fx.floor1);
    const f2 = p.by_floor.find((f) => f.floor_id === fx.floor2);
    expect(f1).toMatchObject({ expected: 3, found: 2, scanned_here: 3, to_go: 1 });
    expect(f2).toMatchObject({ expected: 2, found: 1, scanned_here: 0, to_go: 1 });
    expect(p.by_article.find((a) => a.article_id === fx.boxId)).toMatchObject({ expected: 3, found: 2 });
  });

  test('no station response ever mentions Out or missed scans', async () => {
    const bodies = [(await current()).body, (await scan(counts.c1, fx.floor1, [fx.box[0]])).body];
    for (const b of bodies) expect(JSON.stringify(b)).not.toMatch(/missed|out_packs|"out"/i);
  });

  test('close: totals, then a second close and a late scan are refused', async () => {
    const res = await closeCount(counts.c1);
    expect(res.status).toBe(200);
    expect(res.body.count).toMatchObject({ id: counts.c1, found: 3, new_packs: 3, out_packs: 0, flagged: 1 });
    expect(res.body.count.closed_by).toBe(OP);

    expect((await closeCount(counts.c1)).status).toBe(409);
    const late = await scan(counts.c1, fx.floor1, [fx.box[2]]);
    expect(late.status).toBe(409);
    expect(late.body.message).toBe('This count is closed — start a new one');

    const audit = await db.execute({
      sql: "SELECT action_type FROM audit_logs WHERE entity_type = 'stock_count' AND entity_id = ? ORDER BY id",
      args: [counts.c1],
    });
    expect(audit.rows.map((r) => r.action_type)).toEqual(['STOCK_COUNT_START', 'STOCK_COUNT_CLOSE']);
  });

  test('summary after Day 1: in stock where seen, never-counted stays Not yet counted', async () => {
    const res = await stock('/summary');
    expect(res.status).toBe(200);
    // Boxes 0 and 1 seen on floor 1; box 2 never counted (its sticker's floor).
    expect(summaryRow(res.body, fx.boxId, fx.floor1)).toMatchObject({
      in_stock_packs: 2, in_stock_pcs: 200, not_counted_packs: 1, out_last_packs: 0, flagged_packs: 0,
    });
    // Carton 0 was seen on floor 1 (flagged), carton 1 never counted (floor 2).
    expect(summaryRow(res.body, fx.cartonId, fx.floor1)).toMatchObject({ in_stock_packs: 1, flagged_packs: 1 });
    expect(summaryRow(res.body, fx.cartonId, fx.floor2)).toMatchObject({ in_stock_packs: 0, not_counted_packs: 1 });
    expect(res.body.latest_count.id).toBe(counts.c1);
  });
});

describe('Stock counts — count 2: a pack goes Out', () => {
  test('box 1 is not scanned, carton 1 turns up for the first time', async () => {
    counts.c2 = (await startCount()).body.count.id;
    await scan(counts.c2, fx.floor1, [fx.box[0]]);
    await scan(counts.c2, fx.floor2, [fx.carton[0], fx.carton[1]]);
    const res = await closeCount(counts.c2);
    // found 3, new 1 (carton 1), Out 1 (box 1). Box 2 is still not counted:
    // never Out.
    expect(res.body.count).toMatchObject({ found: 3, new_packs: 1, out_packs: 1, flagged: 0 });
  });

  test('summary: box 1 Out on the last count, box 2 still Not yet counted', async () => {
    const res = await stock('/summary');
    expect(summaryRow(res.body, fx.boxId, fx.floor1)).toMatchObject({
      in_stock_packs: 1, out_last_packs: 1, out_last_pcs: 100, not_counted_packs: 1,
    });
    expect(summaryRow(res.body, fx.cartonId, fx.floor2)).toMatchObject({ in_stock_packs: 2, flagged_packs: 0 });
  });

  test('count 2 Out list names the pack without its key', async () => {
    const res = await stock(`/counts/${counts.c2}/packs?list=out`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0]).toMatchObject({ item_name: fx.boxName, label_no: 2, seen_floor_id: fx.floor1 });
    expect(res.body.rows[0]).not.toHaveProperty('label_key');
  });
});

describe('Stock counts — count 3: the Out pack comes back (a missed scan)', () => {
  test('box 1 is scanned again', async () => {
    counts.c3 = (await startCount()).body.count.id;
    await scan(counts.c3, fx.floor1, [fx.box[0], fx.box[1]]);
    await scan(counts.c3, fx.floor2, [fx.carton[0], fx.carton[1]]);
    const res = await closeCount(counts.c3);
    expect(res.body.count).toMatchObject({ found: 4, new_packs: 0, out_packs: 0 });
  });

  test("count 2's Out total corrects itself, and the list shows no missed figure", async () => {
    const res = await stock('/counts');
    expect(res.status).toBe(200);
    expect(countRow(res.body, counts.c2)).toMatchObject({ out_packs: 0, found: 3 });
    expect(JSON.stringify(res.body)).not.toMatch(/missed/i);
  });

  test('Admin sees the missed scan on count 2, with the key and when it turned up', async () => {
    const list = await stock('/missed');
    expect(list.status).toBe(200);
    expect(countRow(list.body, counts.c2)).toMatchObject({ found: 3, missed: 1, miss_rate: 25, operators: [OP] });
    expect(countRow(list.body, counts.c3)).toMatchObject({ missed: 0 });

    const packs = await stock(`/missed/${counts.c2}`);
    expect(packs.body.rows).toHaveLength(1);
    expect(packs.body.rows[0]).toMatchObject({ label_key: Number(fx.box[1]), found_again_count_id: counts.c3 });
  });
});

describe('Stock counts — count 4, reopen, and who may see what', () => {
  test('only box 0 is scanned: three packs go Out', async () => {
    counts.c4 = (await startCount()).body.count.id;
    await scan(counts.c4, fx.floor1, [fx.box[0]]);
    const res = await closeCount(counts.c4);
    expect(res.body.count).toMatchObject({ found: 1, out_packs: 3 });
  });

  test('only the latest count can be reopened, by Admin/Owner', async () => {
    const old = await asAdmin(request(app).post(`/api/stock/counts/${counts.c3}/reopen`));
    expect(old.status).toBe(409);
    expect(old.body.message).toBe('Only the latest count can be reopened');
    expect((await asEmployee(request(app).post(`/api/stock/counts/${counts.c4}/reopen`))).status).toBe(403);

    const res = await asAdmin(request(app).post(`/api/stock/counts/${counts.c4}/reopen`));
    expect(res.status).toBe(200);
    expect((await current()).body.count.id).toBe(counts.c4);

    // The scanner carries on: carton 0 found after all.
    await scan(counts.c4, fx.floor2, [fx.carton[0]]);
    const closed = await closeCount(counts.c4);
    expect(closed.body.count).toMatchObject({ found: 2, out_packs: 2 });
  });

  test('an Employee sees stock and counts, not missed scans, the cross-check or keys', async () => {
    expect((await stock('/summary', asEmployee)).status).toBe(200);
    expect((await stock('/counts', asEmployee)).status).toBe(200);
    expect((await stock(`/counts/${counts.c4}`, asEmployee)).status).toBe(200);
    expect((await stock(`/counts/${counts.c4}/packs?list=found`, asEmployee)).status).toBe(200);
    expect((await stock('/missed', asEmployee)).status).toBe(403);
    expect((await stock(`/missed/${counts.c2}`, asEmployee)).status).toBe(403);
    expect((await stock('/cross-check', asEmployee)).status).toBe(403);
    expect((await stock(`/keys/${fx.box[1]}`, asEmployee)).status).toBe(403);
  });

  test('a station token gets nowhere near /api/stock', async () => {
    for (const path of ['/summary', '/counts', '/missed', '/cross-check']) {
      expect((await stock(path, asStation)).status).toBe(401);
    }
  });

  test('everyone-visible responses carry no keys', async () => {
    for (const path of ['/summary', '/counts', `/counts/${counts.c4}`, `/counts/${counts.c4}/packs?list=out`]) {
      const body = JSON.stringify((await stock(path, asEmployee)).body);
      expect(body).not.toMatch(/label_key/);
      for (const k of [...fx.box, ...fx.carton]) expect(body).not.toContain(k);
    }
  });

  test('pack lists: unknown list name, and an open count has none yet', async () => {
    expect((await stock(`/counts/${counts.c4}/packs?list=gone`)).status).toBe(400);
    expect((await stock('/counts/999999')).status).toBe(404);
  });

  test("a sticker's history: sightings, missed, Out since", async () => {
    const res = await stock(`/keys/${fx.box[1]}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('out');
    expect(res.body.out_since.count_id).toBe(counts.c4);
    expect(res.body.sightings.map((s) => s.count_id)).toEqual([counts.c1, counts.c3]);
    expect(res.body.missed_on.map((m) => m.count_id)).toEqual([counts.c2]);

    const never = await stock(`/keys/${fx.box[2]}`);
    expect(never.body.status).toBe('not_counted');
    expect(never.body.out_since).toBeNull();

    expect((await stock(`/keys/${fx.unknownKey}`)).status).toBe(404);
    expect((await stock('/keys/12')).status).toBe(400);
  });
});

describe('Stock counts — cross-check against dispatches', () => {
  beforeAll(async () => {
    // A SKU that uses 2 boxes per unit, sold on a test marketplace, and a PO
    // for 50 units dispatched today (IST) -- so 100 boxes should have gone.
    // One more line has no item-code mapping at all.
    const tag = fx.tag;
    fx.market = `SC Market ${tag}`;
    fx.productId = await insertId('INSERT INTO products (sku_code, description) VALUES (?, ?) RETURNING id', [`SC-SKU-${tag}`, 'SC test SKU']);
    await db.execute({
      sql: 'INSERT INTO product_packaging_requirements (product_id, packaging_raw_material_id, qty) VALUES (?, ?, 2)',
      args: [fx.productId, fx.boxId],
    });
    await db.execute({
      sql: 'INSERT INTO product_vendor_codes (product_id, vendor, vendor_item_code) VALUES (?, ?, ?)',
      args: [fx.productId, fx.market, `SCI-${tag}`],
    });
    fx.today = (await db.execute("SELECT date('now', '+5 hours', '+30 minutes') AS d")).rows[0].d;
    fx.poId = `SC${tag}`.slice(0, 30);
    await db.execute({
      sql: `INSERT INTO marketplace_pos (po_id, vendor, vendor_po_id, status, dispatch_date, created_by)
            VALUES (?, ?, ?, 'Closed', ?, ?)`,
      args: [fx.poId, fx.market, `VPO-${tag}`, fx.today, fx.adminId],
    });
    await db.execute({
      sql: 'INSERT INTO marketplace_po_lines (po_id, line_no, item_code, qty) VALUES (?, 1, ?, 50), (?, 2, ?, 7)',
      args: [fx.poId, `SCI-${tag}`, fx.poId, `UNMAPPED-${tag}`],
    });
  });

  test('pieces Out against expected use, per labelled article', async () => {
    const res = await stock(`/cross-check?from=${fx.today}&to=${fx.today}`);
    expect(res.status).toBe(200);
    expect(res.body.counts_closed).toBeGreaterThanOrEqual(4);
    expect(res.body.unlinked_lines).toBeGreaterThanOrEqual(1);

    // Boxes: box 1 went Out on count 4 (box 2 was never counted, so never Out)
    // -- 1 pack of 100 against 50 x 2 = 100 expected.
    const box = res.body.rows.find((r) => r.article_id === fx.boxId);
    expect(box).toMatchObject({ out_packs: 1, out_pcs: 100, has_usage: true, expected_pcs: 100, gap_pcs: 0, gap_pct: 0 });

    // Corrugated: no SKU usage, so no expected figure (carton 1 went Out on 4).
    const carton = res.body.rows.find((r) => r.article_id === fx.cartonId);
    expect(carton).toMatchObject({ out_packs: 1, out_pcs: 10, has_usage: false, expected_pcs: null, gap_pcs: null });
  });

  test('a window before any count has no Out', async () => {
    const res = await stock('/cross-check?from=2001-01-01&to=2001-01-07');
    expect(res.body.counts_closed).toBe(0);
    expect(res.body.rows.find((r) => r.article_id === fx.boxId)).toMatchObject({ out_pcs: 0, expected_pcs: 0 });
  });

  test('date validation', async () => {
    expect((await stock('/cross-check?from=last-week&to=2026-03-01')).status).toBe(400);
    expect((await stock('/cross-check?to=2026-3-1')).status).toBe(400);
    const flipped = await stock('/cross-check?from=2026-03-05&to=2026-03-01');
    expect(flipped.status).toBe(400);
    expect(flipped.body.message).toBe('from cannot be after to');
  });
});
