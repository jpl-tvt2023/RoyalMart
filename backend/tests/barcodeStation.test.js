const crypto = require('crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const app = require('../app');
const { db } = require('./helpers/db');
const { STATION_SECRET, signStationToken } = require('../src/middleware/stationAuth');
const { barcodeStationUser } = require('../src/services/systemUser.service');

// The public Barcode Station (migration 098): the PIN-issued device token, the
// draft -> Generate lifecycle, the random keys and how each one ties back to
// its batch, plus the admin side (Floors, settings) and the guards it added
// elsewhere. Messages are asserted verbatim where the frontend mirror
// (src/utils/barcodeStation.js) reproduces them.

let adminToken;
let employeeToken;
let stationToken;
let uidCounter = 0;
const uid = () => `${Date.now()}-${uidCounter++}`;

const PIN = '4826';
const OPERATOR = 'Ramesh';
const KEY_RE = /^[1-9]\d{7}$/;

// Fixtures, created once by SQL and removed in afterAll.
const fx = {};

const asAdmin = (req) => req.set('Authorization', `Bearer ${adminToken}`);
const asStation = (req) => req.set('Authorization', `Bearer ${stationToken}`);

const setSettings = (body, token = adminToken) => request(app)
  .put('/api/configurations/barcode-station').set('Authorization', `Bearer ${token}`).send(body);
const signIn = (pin = PIN) => request(app).post('/api/station/session').send({ pin });

const draftBody = (overrides = {}) => ({
  outbound_vendor_id: fx.vendorId,
  article_id: fx.articleId,
  pack_size: 300,
  label_count: 5,
  operator: OPERATOR,
  ...overrides,
});
const createDraft = (overrides) => asStation(request(app).post('/api/station/batches')).send(draftBody(overrides));
const generate = (id, operator = OPERATOR) => asStation(request(app).post(`/api/station/batches/${id}/generate`)).send({ operator });
const keysOf = async (batchId) => (await db.execute({
  sql: 'SELECT label_key, label_no, batch_id FROM label_keys WHERE batch_id = ? ORDER BY label_no',
  args: [batchId],
})).rows.map(r => ({ label_key: Number(r.label_key), label_no: Number(r.label_no), batch_id: Number(r.batch_id) }));

async function cleanStation() {
  // Stock-count scans point at label_keys (migration 102), so they go first.
  await db.execute('DELETE FROM stock_count_scans');
  await db.execute('DELETE FROM stock_counts');
  await db.execute('DELETE FROM label_keys');
  await db.execute('DELETE FROM label_batches');
}

async function resetSettings() {
  await db.execute(`UPDATE barcode_station_settings
                       SET pin_hash = NULL, pin_version = 0, failed_attempts = 0, locked_until = NULL,
                           label_width_mm = 152, label_height_mm = 51, labels_per_page = 1,
                           label_gap_mm = 0, page_margin_mm = 0, print_mode = 'dialog'
                     WHERE id = 1`);
}

// The Admin side (labelBatches.routes.js): portal login, Admin/Owner only.
const asEmployee = (req) => req.set('Authorization', `Bearer ${employeeToken}`);
const stationPrint = (id, body) => asStation(request(app).post(`/api/station/batches/${id}/print`)).send(body);
const printsOf = async (batchId) => (await db.execute({
  sql: `SELECT user_id, description FROM audit_logs
         WHERE entity_type = 'label_batch' AND entity_id = ? AND action_type = 'LABEL_BATCH_PRINT' ORDER BY id`,
  args: [batchId],
})).rows;

const insertId = async (sql, args) => Number((await db.execute({ sql, args })).rows[0].id);

beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'RoyalMart#Admin' });
  adminToken = login.body.accessToken;
  fx.adminId = Number(login.body.user.id);
  fx.adminName = login.body.user.name;

  // An Employee, for the Admin-only checks.
  const empUser = `bs-emp-${uid()}`;
  const empId = await insertId(
    `INSERT INTO users (name, username, email, password_hash, is_first_login) VALUES (?, ?, ?, ?, 0) RETURNING id`,
    ['BS Employee', empUser, `${empUser}@x.com`, bcrypt.hashSync('Employee#Pass1', 4)],
  );
  await db.execute({ sql: `INSERT INTO user_roles (user_id, role) VALUES (?, 'Employee')`, args: [empId] });
  fx.employeeId = empId;
  employeeToken = (await request(app).post('/api/auth/login').send({ username: empUser, password: 'Employee#Pass1' })).body.accessToken;

  const tag = uid();
  fx.itemName = `BS Box ${tag}`;
  const article = (item, variant) => insertId(
    `INSERT INTO packaging_raw_materials (category, item_name, variant, unit_metric) VALUES ('Packaging', ?, ?, 'pcs') RETURNING id`,
    [item, variant],
  );
  fx.articleId = await article(fx.itemName, '');
  fx.silverId = await article(fx.itemName, 'Silver');
  fx.unmappedId = await article(`BS Loose ${tag}`, '');

  fx.vendorName = `BS Vendor ${tag}`;
  fx.vendorId = await insertId(`INSERT INTO outbound_vendors (name) VALUES (?) RETURNING id`, [fx.vendorName]);
  fx.inactiveVendorId = await insertId(`INSERT INTO outbound_vendors (name, is_active) VALUES (?, 0) RETURNING id`, [`BS Old Vendor ${tag}`]);
  const map = (vendorId, item, variant) => db.execute({
    sql: `INSERT INTO outbound_vendor_articles (vendor_id, category, item_name, variant) VALUES (?, 'Packaging', ?, ?)`,
    args: [vendorId, item, variant],
  });
  await map(fx.vendorId, fx.itemName, null);
  await map(fx.vendorId, fx.itemName, null);          // a duplicate mapping, which options must collapse
  await map(fx.vendorId, fx.itemName, 'Silver');
  await map(fx.vendorId, `BS Ghost ${tag}`, null);    // a mapping with no catalog row
  await map(fx.inactiveVendorId, fx.itemName, null);

  fx.floorId = await insertId(`INSERT INTO floors (name) VALUES (?) RETURNING id`, [`BS Floor ${tag}`]);
  fx.inactiveFloorId = await insertId(`INSERT INTO floors (name, is_active) VALUES (?, 0) RETURNING id`, [`BS Shut Floor ${tag}`]);

  // Stitching / Packing parties (105): the list offers active parties tagged
  // Stitching or Packing -- not a Third-Party-only one, not an inactive one.
  const party = async (name, uses, active = 1) => {
    const id = await insertId('INSERT INTO stitching_parties (name, is_active) VALUES (?, ?) RETURNING id', [name, active]);
    for (const u of uses) await db.execute({ sql: 'INSERT INTO stitching_party_uses (party_id, use_stage) VALUES (?, ?)', args: [id, u] });
    return id;
  };
  fx.partyName = `BS Stitcher ${tag}`;
  fx.partyId = await party(fx.partyName, ['Stitching', 'Packing']);
  fx.packerId = await party(`BS Packer ${tag}`, ['Packing']);
  fx.buyerName = `BS Buyer ${tag}`;
  fx.buyerId = await party(fx.buyerName, ['Third Party']);
  fx.oldPartyName = `BS Old Stitcher ${tag}`;
  fx.oldPartyId = await party(fx.oldPartyName, ['Stitching'], 0);

  await cleanStation();
  await resetSettings();
});

afterAll(async () => {
  await cleanStation();
  await resetSettings();
  await db.execute({ sql: 'DELETE FROM outbound_vendor_articles WHERE vendor_id IN (?, ?)', args: [fx.vendorId, fx.inactiveVendorId] });
  await db.execute({ sql: 'DELETE FROM outbound_vendors WHERE id IN (?, ?)', args: [fx.vendorId, fx.inactiveVendorId] });
  await db.execute({ sql: 'DELETE FROM packaging_raw_materials WHERE id IN (?, ?, ?)', args: [fx.articleId, fx.silverId, fx.unmappedId] });
  await db.execute(`DELETE FROM floors WHERE name LIKE 'BS %'`);
  await db.execute(`DELETE FROM stitching_party_uses WHERE party_id IN (SELECT id FROM stitching_parties WHERE name LIKE 'BS %')`);
  await db.execute(`DELETE FROM stitching_parties WHERE name LIKE 'BS %'`);
  await db.execute({ sql: 'DELETE FROM user_roles WHERE user_id = ?', args: [fx.employeeId] });
  await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [fx.employeeId] });
});

describe('Barcode Station — sign-in', () => {
  test('with no PIN set the station refuses every sign-in', async () => {
    const res = await signIn();
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/has not been set up yet/);
  });

  test('the PIN must be 4 to 8 digits', async () => {
    for (const pin of ['123', '123456789', 'abcd', '12 34']) {
      const res = await setSettings({ pin });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('PIN must be 4 to 8 digits');
    }
    const blank = await setSettings({ pin: '' });
    expect(blank.body.message).toBe('PIN is required');
  });

  test('only Admin/Owner may read or change the station settings', async () => {
    expect((await setSettings({ pin: '9999' }, employeeToken)).status).toBe(403);
    const read = await request(app).get('/api/configurations/barcode-station').set('Authorization', `Bearer ${employeeToken}`);
    expect(read.status).toBe(403);
  });

  test('an Admin sets the PIN, and the hash is never returned', async () => {
    const res = await setSettings({ pin: PIN });
    expect(res.status).toBe(200);
    expect(res.body.pin_set).toBe(true);
    expect(res.body).not.toHaveProperty('pin_hash');
    const read = await asAdmin(request(app).get('/api/configurations/barcode-station'));
    expect(read.body).toMatchObject({ pin_set: true, label_width_mm: 152, label_height_mm: 51, locked: false });
    expect(JSON.stringify(read.body)).not.toMatch(/\$2[aby]\$/);
  });

  test('a wrong PIN is refused and audited, a right one returns a token', async () => {
    const wrong = await signIn('0000');
    expect(wrong.status).toBe(401);
    expect(wrong.body.message).toBe('Incorrect PIN');
    const { rows } = await db.execute(`SELECT COUNT(*) AS c FROM audit_logs WHERE action_type = 'BARCODE_STATION_PIN_FAILED'`);
    expect(Number(rows[0].c)).toBeGreaterThan(0);

    const right = await signIn();
    expect(right.status).toBe(200);
    expect(typeof right.body.token).toBe('string');
    stationToken = right.body.token;

    const options = await asStation(request(app).get('/api/station/options'));
    expect(options.status).toBe(200);
  });

  test('a station token is not a portal token, and a portal token is not a station token', async () => {
    const portal = await request(app).get('/api/outbound-pos').set('Authorization', `Bearer ${stationToken}`);
    expect(portal.status).toBe(401);
    const station = await request(app).get('/api/station/options').set('Authorization', `Bearer ${adminToken}`);
    expect(station.status).toBe(401);
    expect(station.body.code).toBe('SESSION_EXPIRED');
    const none = await request(app).get('/api/station/options');
    expect(none.status).toBe(401);
    expect(none.body.code).toBe('NO_SESSION');
  });

  test('a token with the wrong scope, or an expired one, is refused', async () => {
    const wrongScope = jwt.sign({ scope: 'something-else', pv: 1 }, STATION_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const expired = jwt.sign({ scope: 'barcode-station', pv: 1, exp: Math.floor(Date.now() / 1000) - 60 }, STATION_SECRET, { algorithm: 'HS256' });
    for (const t of [wrongScope, expired]) {
      const res = await request(app).get('/api/station/options').set('Authorization', `Bearer ${t}`);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('SESSION_EXPIRED');
    }
  });

  test('nobody can log in to the portal as the barcode-station user', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'barcode-station', password: 'anything' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('This account cannot sign in');
  });

  test('every 10th wrong PIN locks new sign-ins, longer each time, without signing devices out', async () => {
    await db.execute('UPDATE barcode_station_settings SET failed_attempts = 0, locked_until = NULL WHERE id = 1');
    for (let i = 1; i <= 9; i++) expect((await signIn('1111')).status).toBe(401);
    const tenth = await signIn('1111');
    expect(tenth.status).toBe(429);
    expect(tenth.body.locked_until).toBeTruthy();

    // Locked: even the right PIN is refused, but a signed-in device keeps working.
    expect((await signIn()).status).toBe(429);
    expect((await asStation(request(app).get('/api/station/options'))).status).toBe(200);

    const minutesLocked = async () => {
      const { rows } = await db.execute(`SELECT (julianday(locked_until) - julianday('now')) * 1440 AS m FROM barcode_station_settings WHERE id = 1`);
      return Number(rows[0].m);
    };
    const first = await minutesLocked();
    expect(first).toBeGreaterThan(14);
    expect(first).toBeLessThanOrEqual(15);

    // Let the lock lapse: the count carries on, so the next lock is double.
    await db.execute(`UPDATE barcode_station_settings SET locked_until = datetime('now', '-1 minute') WHERE id = 1`);
    for (let i = 1; i <= 9; i++) expect((await signIn('1111')).status).toBe(401);
    expect((await signIn('1111')).status).toBe(429);
    const second = await minutesLocked();
    expect(second).toBeGreaterThan(29);
    expect(second).toBeLessThanOrEqual(30);

    const cleared = await setSettings({ clear_lock: true });
    expect(cleared.status).toBe(200);
    expect(cleared.body.locked).toBe(false);
    const ok = await signIn();
    expect(ok.status).toBe(200);
    stationToken = ok.body.token;
  });

  test('changing the PIN signs every device out, and the new PIN signs back in', async () => {
    const oldToken = stationToken;
    expect((await setSettings({ pin: '73914' })).status).toBe(200);
    const stale = await request(app).get('/api/station/options').set('Authorization', `Bearer ${oldToken}`);
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('PIN_CHANGED');
    expect((await signIn(PIN)).status).toBe(401);
    const fresh = await signIn('73914');
    expect(fresh.status).toBe(200);

    // "Sign out all devices" keeps the PIN but drops every token.
    expect((await setSettings({ sign_out_all: true })).status).toBe(200);
    const dropped = await request(app).get('/api/station/options').set('Authorization', `Bearer ${fresh.body.token}`);
    expect(dropped.body.code).toBe('PIN_CHANGED');

    expect((await setSettings({ pin: PIN })).status).toBe(200);
    stationToken = (await signIn()).body.token;
  });

  test('the sticker size is validated and audited', async () => {
    const bad = await setSettings({ label_width_mm: 5 });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('Sticker width must be from 20 to 300 mm, at most one decimal');
    const ok = await setSettings({ label_width_mm: 100, label_height_mm: 50 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ label_width_mm: 100, label_height_mm: 50, labels_per_page: 1, label_gap_mm: 0, page_margin_mm: 0 });
    const options = await asStation(request(app).get('/api/station/options'));
    expect(options.body.label).toEqual({ width_mm: 100, height_mm: 50, per_page: 1, gap_mm: 0, margin_mm: 0 });
    await setSettings({ label_width_mm: 152, label_height_mm: 51 });
  });

  // Migration 104: the client's TSC TA210 roll, from its BarTender template --
  // two 150 x 48.2 stickers per 150 x 103 page, 4 mm apart, 1.3 mm margins.
  test('the label page takes one decimal and several stickers per page, and is audited', async () => {
    const page = { label_width_mm: 150, label_height_mm: 48.2, labels_per_page: 2, label_gap_mm: 4, page_margin_mm: 1.3 };
    const ok = await setSettings(page);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject(page);
    const audit = await db.execute(`SELECT description FROM audit_logs
                                     WHERE entity_type = 'barcode_station' ORDER BY id DESC LIMIT 1`);
    expect(audit.rows[0].description).toContain(
      'set the label page to 2 stickers of 150 × 48.2 mm, 4 mm gap, 1.3 mm margin (page 150 × 103 mm)',
    );

    const options = await asStation(request(app).get('/api/station/options'));
    expect(options.body.label).toEqual({ width_mm: 150, height_mm: 48.2, per_page: 2, gap_mm: 4, margin_mm: 1.3 });

    // Saved again unchanged: nothing to write, no new audit row.
    const before = (await db.execute("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'barcode_station'")).rows[0].n;
    expect((await setSettings(page)).status).toBe(200);
    expect((await db.execute("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'barcode_station'")).rows[0].n).toBe(before);

    const cases = [
      [{ label_height_mm: 48.25 }, 'Sticker height must be from 10 to 300 mm, at most one decimal'],
      [{ labels_per_page: 0 }, 'Stickers per page must be at least 1'],
      [{ labels_per_page: 5 }, 'Stickers per page cannot be more than 4'],
      [{ labels_per_page: 1.5 }, 'Stickers per page must be a whole number'],
      [{ label_gap_mm: 21 }, 'Gap between stickers must be from 0 to 20 mm, at most one decimal'],
      [{ page_margin_mm: -1 }, 'Top and bottom margin must be from 0 to 20 mm, at most one decimal'],
      [{ label_height_mm: 100, labels_per_page: 3, label_gap_mm: 4 }, 'The page cannot be taller than 300 mm'],
    ];
    for (const [body, message] of cases) {
      const res = await setSettings(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(message);
    }

    await setSettings({ label_width_mm: 152, label_height_mm: 51, labels_per_page: 1, label_gap_mm: 0, page_margin_mm: 0 });
  });
});

describe('Barcode Station — options', () => {
  test('active vendors with their mapped catalog articles, each once, and active floors', async () => {
    const res = await asStation(request(app).get('/api/station/options'));
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');

    const vendor = res.body.vendors.find(v => v.id === fx.vendorId);
    expect(vendor).toBeTruthy();
    expect(vendor.articles.map(a => a.id).sort()).toEqual([fx.articleId, fx.silverId].sort());
    expect(vendor.articles.find(a => a.id === fx.articleId)).toMatchObject({ category: 'Packaging', item_name: fx.itemName, variant: null, unit_metric: 'pcs' });
    expect(res.body.vendors.find(v => v.id === fx.inactiveVendorId)).toBeUndefined();

    const floorIds = res.body.floors.map(f => f.id);
    expect(floorIds).toContain(fx.floorId);
    expect(floorIds).not.toContain(fx.inactiveFloorId);

    // Stitching / Packing: active parties tagged Stitching or Packing, each once.
    const partyIds = res.body.stitching_parties.map(p => p.id);
    expect(partyIds.filter(id => id === fx.partyId)).toHaveLength(1);
    expect(partyIds).toContain(fx.packerId);
    expect(partyIds).not.toContain(fx.buyerId);
    expect(partyIds).not.toContain(fx.oldPartyId);
    expect(res.body.stitching_parties.find(p => p.id === fx.partyId)).toEqual({ id: fx.partyId, name: fx.partyName });
  });
});

describe('Barcode Station — drafts', () => {
  beforeEach(cleanStation);

  test('a valid entry is saved as a draft with no keys', async () => {
    const res = await createDraft({ operator: '  Ramesh   Kumar ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      outbound_vendor_id: fx.vendorId, vendor_name: fx.vendorName, article_id: fx.articleId,
      pack_size: 300, label_count: 5, entered_by: 'Ramesh Kumar', is_generated: false, key_count: 0,
      generated_at: null, stitching_party_id: null, stitching_party_name: null,
    });
    // No floor (106): a pack gets its location from its first scan.
    expect(res.body).not.toHaveProperty('floor_id');
    expect(res.body).not.toHaveProperty('floor_name');
  });

  test('an entry may name a Stitching / Packing party, which the audit names too', async () => {
    const res = await createDraft({ stitching_party_id: fx.partyId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ stitching_party_id: fx.partyId, stitching_party_name: fx.partyName });
    const { rows } = await db.execute({
      sql: `SELECT description FROM audit_logs WHERE entity_type = 'label_batch' AND entity_id = ? AND action_type = 'LABEL_BATCH_CREATE'`,
      args: [res.body.id],
    });
    expect(rows[0].description).toContain(`${fx.vendorName}, ${fx.partyName}, `);

    // Blank clears it on an edit, and the diff shows the party going.
    const cleared = await asStation(request(app).patch(`/api/station/batches/${res.body.id}`))
      .send({ stitching_party_id: '', operator: OPERATOR });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ stitching_party_id: null, stitching_party_name: null });
    const upd = await db.execute({
      sql: `SELECT changes FROM audit_logs WHERE entity_type = 'label_batch' AND entity_id = ? AND action_type = 'LABEL_BATCH_UPDATE'`,
      args: [res.body.id],
    });
    expect(JSON.parse(upd.rows[0].changes).map(c => c.field)).toEqual(['stitching_party']);
  });

  test('field errors come back in grid order, with the mirrored messages', async () => {
    const cases = [
      [{ outbound_vendor_id: '' }, 'Vendor is required'],
      [{ article_id: null }, 'Article is required'],
      [{ pack_size: '' }, 'Pack Size is required'],
      [{ pack_size: '3.5' }, 'Pack Size must be a whole number'],
      [{ pack_size: '0' }, 'Pack Size must be at least 1'],
      [{ pack_size: 1000001 }, 'Pack Size cannot be more than 1000000'],
      [{ stitching_party_id: 'x' }, 'Stitching / Packing must be picked from the list'],
      [{ stitching_party_id: '0' }, 'Stitching / Packing must be picked from the list'],
      [{ label_count: '' }, 'Number of Barcodes is required'],
      [{ label_count: 2001 }, 'Number of Barcodes cannot be more than 2000'],
      [{ operator: '   ' }, 'Operator name is required'],
      [{ operator: 'x'.repeat(61) }, 'Operator name cannot be longer than 60 characters'],
      // Vendor is checked before Article
      [{ outbound_vendor_id: '', article_id: '' }, 'Vendor is required'],
      // Grid order: Vendor, Stitching / Packing, Article
      [{ outbound_vendor_id: '', stitching_party_id: 'x' }, 'Vendor is required'],
      [{ stitching_party_id: 'x', article_id: '' }, 'Stitching / Packing must be picked from the list'],
    ];
    for (const [overrides, message] of cases) {
      const res = await createDraft(overrides);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(message);
    }
  });

  test('the article must be one the vendor is mapped to, the vendor active, and a party active and tagged', async () => {
    const unmapped = await createDraft({ article_id: fx.unmappedId });
    expect(unmapped.status).toBe(400);
    expect(unmapped.body.message).toMatch(/is not mapped to/);

    const oldVendor = await createDraft({ outbound_vendor_id: fx.inactiveVendorId });
    expect(oldVendor.status).toBe(400);
    expect(oldVendor.body.message).toMatch(/is no longer active — pick another vendor/);

    const ghost = await createDraft({ stitching_party_id: 999999 });
    expect(ghost.status).toBe(400);
    expect(ghost.body.message).toBe('Stitching / Packing party not found');

    const oldParty = await createDraft({ stitching_party_id: fx.oldPartyId });
    expect(oldParty.body.message).toBe(`${fx.oldPartyName} is no longer active — pick another party`);

    const buyer = await createDraft({ stitching_party_id: fx.buyerId });
    expect(buyer.body.message).toBe(`${fx.buyerName} is not a Stitching or Packing party`);

    // A floor is no longer part of an entry: one sent is ignored.
    const withFloor = await createDraft({ floor_id: fx.inactiveFloorId });
    expect(withFloor.status).toBe(201);
    expect(withFloor.body).not.toHaveProperty('floor_id');
  });

  test('a draft can be edited, with a field-level audit diff', async () => {
    const { body: draft } = await createDraft();
    const res = await asStation(request(app).patch(`/api/station/batches/${draft.id}`))
      .send({ pack_size: 250, article_id: fx.silverId, operator: 'Suresh' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pack_size: 250, article_id: fx.silverId, variant: 'Silver', entered_by: OPERATOR });

    const { rows } = await db.execute({
      sql: `SELECT description, changes FROM audit_logs WHERE entity_type = 'label_batch' AND entity_id = ? AND action_type = 'LABEL_BATCH_UPDATE'`,
      args: [draft.id],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toMatch(/^Suresh edited label batch/);
    const fields = JSON.parse(rows[0].changes).map(c => c.field).sort();
    expect(fields).toEqual(['article', 'pack_size']);
  });

  test('a draft can be deleted (soft), and then no longer exists', async () => {
    const { body: draft } = await createDraft();
    const noOperator = await asStation(request(app).delete(`/api/station/batches/${draft.id}`)).send({});
    expect(noOperator.status).toBe(400);
    expect(noOperator.body.message).toBe('Operator name is required');

    const res = await asStation(request(app).delete(`/api/station/batches/${draft.id}`)).send({ operator: 'Suresh' });
    expect(res.status).toBe(200);
    const { rows } = await db.execute({ sql: 'SELECT deleted_at, deleted_by FROM label_batches WHERE id = ?', args: [draft.id] });
    expect(rows[0].deleted_at).toBeTruthy();
    expect(rows[0].deleted_by).toBe('Suresh');

    const list = await asStation(request(app).get('/api/station/batches'));
    expect(list.body.rows.map(r => r.id)).not.toContain(draft.id);
    expect((await asStation(request(app).delete(`/api/station/batches/${draft.id}`)).send({ operator: OPERATOR })).status).toBe(404);
    expect((await generate(draft.id)).status).toBe(404);
  });
});

describe('Barcode Station — Generate', () => {
  beforeEach(cleanStation);
  afterEach(() => jest.restoreAllMocks());

  test('one random 8-digit key per label, every one tied to the entry', async () => {
    const { body: draft } = await createDraft({ label_count: 180 });
    const res = await generate(draft.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: draft.id, is_generated: true, key_count: 180, generated_by: OPERATOR });
    expect(res.body.generated_at).toBeTruthy();

    const keys = await keysOf(draft.id);
    expect(keys).toHaveLength(180);
    expect(keys.every(k => k.batch_id === draft.id)).toBe(true);
    expect(keys.map(k => k.label_no)).toEqual(Array.from({ length: 180 }, (_, i) => i + 1));
    expect(keys.every(k => KEY_RE.test(String(k.label_key)))).toBe(true);
    expect(new Set(keys.map(k => k.label_key)).size).toBe(180);
    // Random, not a counter: 180 consecutive numbers would be a vanishing coincidence.
    const sorted = keys.map(k => k.label_key).sort((a, b) => a - b);
    expect(sorted[179] - sorted[0]).toBeGreaterThan(179);

    const stationUser = await barcodeStationUser();
    const { rows } = await db.execute({
      sql: `SELECT user_id, description FROM audit_logs WHERE entity_type = 'label_batch' AND entity_id = ? AND action_type = 'LABEL_BATCH_GENERATE'`,
      args: [draft.id],
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].user_id)).toBe(stationUser.id);
    expect(rows[0].description).toMatch(/^Ramesh generated 180 keys for label batch/);
  });

  test("a second batch's keys never collide with the first's", async () => {
    const a = (await createDraft({ label_count: 50 })).body;
    const b = (await createDraft({ label_count: 20 })).body;
    expect((await generate(a.id)).status).toBe(200);
    expect((await generate(b.id)).status).toBe(200);
    const keysA = new Set((await keysOf(a.id)).map(k => k.label_key));
    const keysB = (await keysOf(b.id)).map(k => k.label_key);
    expect(keysB).toHaveLength(20);
    expect(keysB.some(k => keysA.has(k))).toBe(false);
  });

  test('a key that is already taken is redrawn, never shared', async () => {
    const first = (await createDraft({ label_count: 1 })).body;
    await generate(first.id);
    const [taken] = await keysOf(first.id);

    // The next draw hands back the taken key first, then real randomness.
    const real = crypto.randomInt;
    let calls = 0;
    jest.spyOn(crypto, 'randomInt').mockImplementation((...args) => (calls++ === 0 ? taken.label_key : real(...args)));

    const second = (await createDraft({ label_count: 5 })).body;
    const res = await generate(second.id);
    expect(res.status).toBe(200);
    const keys = await keysOf(second.id);
    expect(keys).toHaveLength(5);
    expect(keys.map(k => k.label_key)).not.toContain(taken.label_key);
    expect((await keysOf(first.id))[0].label_key).toBe(taken.label_key);
  });

  test('a failure mid-Generate leaves the entry a draft with no keys', async () => {
    const draft = (await createDraft({ label_count: 10 })).body;
    jest.spyOn(crypto, 'randomInt').mockImplementation(() => { throw new Error('entropy ran out'); });
    const res = await generate(draft.id);
    expect(res.status).toBe(500);
    jest.restoreAllMocks();

    const { rows } = await db.execute({ sql: 'SELECT generated_at, generated_by FROM label_batches WHERE id = ?', args: [draft.id] });
    expect(rows[0].generated_at).toBeNull();
    expect(rows[0].generated_by).toBeNull();
    expect(await keysOf(draft.id)).toHaveLength(0);

    expect((await generate(draft.id)).status).toBe(200);
    expect(await keysOf(draft.id)).toHaveLength(10);
  });

  test('once generated, a batch is final: it cannot be generated again, edited or deleted', async () => {
    const draft = (await createDraft()).body;
    expect((await generate(draft.id)).status).toBe(200);

    const final = 'Keys have already been generated for this batch — it can no longer be changed';
    const again = await generate(draft.id);
    expect(again.status).toBe(409);
    expect(again.body.message).toBe(final);
    const edit = await asStation(request(app).patch(`/api/station/batches/${draft.id}`)).send({ pack_size: 1, operator: OPERATOR });
    expect(edit.status).toBe(409);
    const del = await asStation(request(app).delete(`/api/station/batches/${draft.id}`)).send({ operator: OPERATOR });
    expect(del.status).toBe(409);
    expect(del.body.message).toBe(final);

    const { rows } = await db.execute({ sql: 'SELECT deleted_at, pack_size FROM label_batches WHERE id = ?', args: [draft.id] });
    expect(rows[0]).toMatchObject({ deleted_at: null, pack_size: 300 });
    expect(await keysOf(draft.id)).toHaveLength(5);
  });

  test('the schema itself refuses to delete a generated batch (101)', async () => {
    const draft = (await createDraft()).body;
    expect((await generate(draft.id)).status).toBe(200);
    await expect(db.execute({ sql: `UPDATE label_batches SET deleted_at = datetime('now') WHERE id = ?`, args: [draft.id] }))
      .rejects.toThrow(/CHECK constraint failed/);
    const cols = (await db.execute('PRAGMA table_info(label_batches)')).rows.map(r => r.name);
    expect(cols).toContain('deleted_by');
    expect(cols).not.toContain('delete_reason');
  });

  test('two Generate clicks at once write one set of keys', async () => {
    const draft = (await createDraft({ label_count: 30 })).body;
    const results = await Promise.all([generate(draft.id), generate(draft.id), generate(draft.id)]);
    const statuses = results.map(r => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect(await keysOf(draft.id)).toHaveLength(30);
  });

  test('Generate re-checks the entry: a Stitching / Packing party retired since the draft blocks it', async () => {
    const draft = (await createDraft({ stitching_party_id: fx.packerId })).body;
    await db.execute({ sql: 'UPDATE stitching_parties SET is_active = 0 WHERE id = ?', args: [fx.packerId] });
    try {
      const res = await generate(draft.id);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/is no longer active — pick another party/);
      expect(await keysOf(draft.id)).toHaveLength(0);
    } finally {
      await db.execute({ sql: 'UPDATE stitching_parties SET is_active = 1 WHERE id = ?', args: [fx.packerId] });
    }
    const ok = await generate(draft.id);
    expect(ok.status).toBe(200);
    const { rows } = await db.execute({
      sql: `SELECT description FROM audit_logs WHERE entity_type = 'label_batch' AND entity_id = ? AND action_type = 'LABEL_BATCH_GENERATE'`,
      args: [draft.id],
    });
    expect(rows[0].description).toMatch(new RegExp(`\\(${fx.vendorName}, BS Packer `));
  });

  test('Generate needs an operator name', async () => {
    const draft = (await createDraft()).body;
    const res = await generate(draft.id, '');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Operator name is required');
  });
});

describe('Barcode Station — keys, lookup and list', () => {
  let batch;
  let draft;
  beforeAll(async () => {
    await cleanStation();
    batch = (await createDraft({ label_count: 60 })).body;
    await generate(batch.id);
    draft = (await createDraft({ label_count: 3 })).body;
  });

  test('an Admin sees every key of a batch, in label order, with the batch and sticker size', async () => {
    const res = await asAdmin(request(app).get(`/api/label-batches/${batch.id}/keys`));
    expect(res.status).toBe(200);
    expect(res.body.batch).toMatchObject({ id: batch.id, vendor_name: fx.vendorName, unit_metric: 'pcs' });
    expect(res.body.batch).not.toHaveProperty('floor_name');
    expect(res.body.keys).toHaveLength(60);
    expect(res.body.keys.map(k => k.label_no)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(res.body.label).toEqual({ width_mm: 152, height_mm: 51, per_page: 1, gap_mm: 0, margin_mm: 0 });
  });

  test('a slice of labels, for a reprint', async () => {
    const res = await asAdmin(request(app).get(`/api/label-batches/${batch.id}/keys`)).query({ from: 37, to: 40 });
    expect(res.status).toBe(200);
    expect(res.body.keys.map(k => k.label_no)).toEqual([37, 38, 39, 40]);
    for (const q of [{ from: 0 }, { to: 61 }, { from: 10, to: 5 }, { from: 'x' }]) {
      const bad = await asAdmin(request(app).get(`/api/label-batches/${batch.id}/keys`)).query(q);
      expect(bad.status).toBe(400);
      expect(bad.body.message).toBe('Labels must be a range within 1 to 60');
    }
    expect((await asAdmin(request(app).get(`/api/label-batches/${draft.id}/keys`))).status).toBe(409);
  });

  test('the station has no route that shows keys', async () => {
    const res = await asStation(request(app).get(`/api/station/batches/${batch.id}/keys`));
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('keys');
  });

  test('any key leads back to its entry and label number', async () => {
    const keys = await keysOf(batch.id);
    const k = keys[36];
    const res = await asStation(request(app).get(`/api/station/keys/${k.label_key}`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ label_key: k.label_key, label_no: 37 });
    expect(res.body.batch).toMatchObject({ id: batch.id, label_count: 60, vendor_name: fx.vendorName });

    const known = new Set(keys.map(x => x.label_key));
    let unknown = 10000000;
    while (known.has(unknown)) unknown++;
    const missing = await asStation(request(app).get(`/api/station/keys/${unknown}`));
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe(`No label has the key ${unknown}`);

    for (const bad of ['abc', '01234567', '1234567', '123456789']) {
      const res2 = await asStation(request(app).get(`/api/station/keys/${bad}`));
      expect(res2.status).toBe(400);
      expect(res2.body.message).toBe('Key must be 8 digits');
    }
  });

  test('the station list: the envelope, drafts first, and no keys anywhere in it', async () => {
    const res = await asStation(request(app).get('/api/station/batches')).query({ page: 1, page_size: 25 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, page: 1, page_size: 25 });
    expect(res.body.rows.map(r => r.id)).toEqual([draft.id, batch.id]);
    expect(res.body.rows[1]).toMatchObject({ key_count: 60, print_count: 0, is_generated: true });
    for (const row of res.body.rows) expect(row).not.toHaveProperty('key_preview');
    // Not one of the batch's keys appears anywhere in the response.
    const body = JSON.stringify(res.body);
    for (const k of await keysOf(batch.id)) expect(body).not.toContain(String(k.label_key));

    const one = await asStation(request(app).get('/api/station/batches')).query({ id: batch.id });
    expect(one.body.rows.map(r => r.id)).toEqual([batch.id]);
  });

  test("the Admin's list carries a key preview on generated rows", async () => {
    const res = await asAdmin(request(app).get('/api/label-batches')).query({ page: 1, page_size: 25 });
    expect(res.status).toBe(200);
    expect(res.body.rows.map(r => r.id)).toEqual([draft.id, batch.id]);
    const keys = await keysOf(batch.id);
    expect(res.body.rows[1].key_preview).toEqual(keys.slice(0, 3).map(k => k.label_key));
    expect(res.body.rows[0].key_preview).toEqual([]);
  });

  test('the date filter works on the IST day the keys were generated', async () => {
    const { rows } = await db.execute(`SELECT date('now', '+5 hours', '+30 minutes') AS d`);
    const today = rows[0].d;
    const res = await asStation(request(app).get('/api/station/batches')).query({ date_from: today, date_to: today });
    expect(res.body.rows.map(r => r.id)).toEqual([batch.id]);
    const bad = await asStation(request(app).get('/api/station/batches')).query({ date_from: '25-11-2026' });
    expect(bad.status).toBe(400);
  });
});

describe('Barcode Station — printing', () => {
  let batch;
  beforeAll(async () => {
    await cleanStation();
    batch = (await createDraft({ label_count: 12 })).body;
    await generate(batch.id);
  });

  test('the station prints any generated batch, every print is logged with the operator', async () => {
    const res = await stationPrint(batch.id, { operator: 'Ramesh' });
    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(12);
    expect(res.body.keys.map(k => k.label_no)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(res.body.keys.map(k => k.label_key)).toEqual((await keysOf(batch.id)).map(k => k.label_key));
    expect(res.body.label).toEqual({ width_mm: 152, height_mm: 51, per_page: 1, gap_mm: 0, margin_mm: 0 });
    expect(res.body.batch).toMatchObject({ id: batch.id, print_count: 1 });

    // A reprint of a range -- allowed any number of times, each one logged.
    const again = await stationPrint(batch.id, { operator: 'Suresh', from: 4, to: 6 });
    expect(again.status).toBe(200);
    expect(again.body.keys.map(k => k.label_no)).toEqual([4, 5, 6]);

    const stationUser = await barcodeStationUser();
    const logged = await printsOf(batch.id);
    expect(logged).toHaveLength(2);
    expect(logged.every(r => Number(r.user_id) === stationUser.id)).toBe(true);
    expect(logged[0].description).toMatch(/^Ramesh printed all 12 labels of label batch #\d+ /);
    expect(logged[1].description).toMatch(/^Suresh printed labels 4–6 of 12 of label batch #\d+ /);

    const list = await asStation(request(app).get('/api/station/batches')).query({ id: batch.id });
    expect(list.body.rows[0].print_count).toBe(2);
  });

  test('a print needs an operator, a generated batch and a valid range', async () => {
    const noOperator = await stationPrint(batch.id, {});
    expect(noOperator.status).toBe(400);
    expect(noOperator.body.message).toBe('Operator name is required');

    const draft = (await createDraft()).body;
    const notYet = await stationPrint(draft.id, { operator: OPERATOR });
    expect(notYet.status).toBe(409);
    expect(notYet.body.message).toBe('Generate the keys for this batch first');

    const badRange = await stationPrint(batch.id, { operator: OPERATOR, from: 5, to: 13 });
    expect(badRange.status).toBe(400);
    expect(badRange.body.message).toBe('Labels must be a range within 1 to 12');

    expect((await stationPrint(999999, { operator: OPERATOR })).status).toBe(404);
    // None of the refused attempts was logged as a print.
    expect(await printsOf(draft.id)).toHaveLength(0);
  });

  test("an Admin's print is logged under the Admin", async () => {
    const before = (await printsOf(batch.id)).length;
    const res = await asAdmin(request(app).post(`/api/label-batches/${batch.id}/print`)).send({ from: 1, to: 2 });
    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(2);
    const logged = await printsOf(batch.id);
    expect(logged).toHaveLength(before + 1);
    expect(Number(logged[logged.length - 1].user_id)).toBe(fx.adminId);
    expect(logged[logged.length - 1].description).toMatch(new RegExp(`^${fx.adminName} printed labels 1–2 of 12 `));
  });
});

describe('Barcode Station — the Admin router', () => {
  let batch;
  beforeAll(async () => {
    await cleanStation();
    batch = (await createDraft({ label_count: 3 })).body;
    await generate(batch.id);
  });

  test('only a portal Admin/Owner gets in: Employee 403, station token 401, nobody 401', async () => {
    const calls = [
      () => request(app).get('/api/label-batches'),
      () => request(app).get(`/api/label-batches/${batch.id}/keys`),
      () => request(app).post(`/api/label-batches/${batch.id}/print`),
    ];
    for (const call of calls) {
      expect((await asAdmin(call())).status).toBe(200);
      expect((await asEmployee(call())).status).toBe(403);
      expect((await asStation(call())).status).toBe(401);
      expect((await call()).status).toBe(401);
    }
  });

  test('a refused caller is never logged as having printed', async () => {
    const before = (await printsOf(batch.id)).length;
    await asEmployee(request(app).post(`/api/label-batches/${batch.id}/print`)).send({});
    await asStation(request(app).post(`/api/label-batches/${batch.id}/print`)).send({});
    expect(await printsOf(batch.id)).toHaveLength(before);
  });
});

describe('Barcode Station — print mode', () => {
  afterAll(() => setSettings({ print_mode: 'dialog' }));

  test("defaults to the print dialog, Admin switches it, the station reads it", async () => {
    const read = await asAdmin(request(app).get('/api/configurations/barcode-station'));
    expect(read.body.print_mode).toBe('dialog');
    expect((await asStation(request(app).get('/api/station/options'))).body.print_mode).toBe('dialog');

    const set = await setSettings({ print_mode: 'direct' });
    expect(set.status).toBe(200);
    expect(set.body.print_mode).toBe('direct');
    expect((await asStation(request(app).get('/api/station/options'))).body.print_mode).toBe('direct');

    const { rows } = await db.execute(`SELECT description, changes FROM audit_logs
                                         WHERE action_type = 'BARCODE_STATION_SETTINGS_UPDATE' ORDER BY id DESC LIMIT 1`);
    expect(rows[0].description).toMatch(/set printing to direct/);
    expect(JSON.parse(rows[0].changes)).toEqual([{ field: 'print_mode', old: 'dialog', new: 'direct' }]);
  });

  test('only dialog or direct, and only Admin/Owner may change it', async () => {
    const bad = await setSettings({ print_mode: 'fax' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('Print mode must be dialog or direct');
    expect((await setSettings({ print_mode: 'dialog' }, employeeToken)).status).toBe(403);
  });
});

describe('Barcode Station — guards elsewhere', () => {
  test('a catalog article a batch uses cannot be deleted', async () => {
    await cleanStation();
    const draft = (await createDraft({ article_id: fx.silverId })).body;
    expect(draft.id).toBeTruthy();
    // Take the vendor mapping away so only the batch still holds the article.
    await db.execute({ sql: `DELETE FROM outbound_vendor_articles WHERE vendor_id = ? AND variant = 'Silver'`, args: [fx.vendorId] });
    try {
      const res = await asAdmin(request(app).delete(`/api/packaging-raw-materials/${fx.silverId}`));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/1 Barcode Station label batch uses it/);
      const bulk = await asAdmin(request(app).post('/api/packaging-raw-materials/bulk-delete')).send({ ids: [fx.silverId] });
      expect(bulk.status).toBe(200);
      expect(bulk.body.deleted).toBe(0);
      expect(bulk.body.skipped[0].reason).toMatch(/label batch/);
    } finally {
      await db.execute({
        sql: `INSERT INTO outbound_vendor_articles (vendor_id, category, item_name, variant) VALUES (?, 'Packaging', ?, 'Silver')`,
        args: [fx.vendorId, fx.itemName],
      });
    }
  });

  test('the system users cannot be deleted or given a password', async () => {
    const stationUser = await barcodeStationUser();
    const del = await asAdmin(request(app).delete(`/api/users/${stationUser.id}`));
    expect(del.status).toBe(400);
    expect(del.body.message).toBe('barcode-station is a system account and cannot be deleted');
    const reset = await asAdmin(request(app).post(`/api/users/${stationUser.id}/reset-password`)).send({ newPassword: 'Whatever#Pass1' });
    expect(reset.status).toBe(400);
    expect(reset.body.message).toBe('barcode-station is a system account and cannot be given a password');
  });

  test('a token minted for an old PIN version is refused', async () => {
    const old = signStationToken(-1);
    const res = await request(app).get('/api/station/options').set('Authorization', `Bearer ${old}`);
    expect(res.body.code).toBe('PIN_CHANGED');
  });
});

describe('Floors master', () => {
  test('Admin adds, renames and deactivates a floor, names are unique ignoring case', async () => {
    const name = `BS Mezzanine ${uid()}`;
    const created = await asAdmin(request(app).post('/api/configurations/floors')).send({ name });
    expect(created.status).toBe(201);
    const dup = await asAdmin(request(app).post('/api/configurations/floors')).send({ name: name.toUpperCase() });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe('A floor with that name already exists');

    const renamed = await asAdmin(request(app).patch(`/api/configurations/floors/${created.body.id}`)).send({ name: `${name} East` });
    expect(renamed.status).toBe(200);
    const off = await asAdmin(request(app).delete(`/api/configurations/floors/${created.body.id}`));
    expect(off.body.is_active).toBe(0);

    const list = await asAdmin(request(app).get('/api/configurations/floors'));
    expect(list.body.find(f => f.id === created.body.id)).toMatchObject({ name: `${name} East`, is_active: 0 });
  });

  test('the seeded floors exist', async () => {
    const list = await asAdmin(request(app).get('/api/configurations/floors'));
    const names = list.body.map(f => f.name);
    expect(names).toEqual(expect.arrayContaining(['Ground Floor', '1st Floor', '2nd Floor']));
  });

  test('only Admin/Owner may change floors, anyone may read them', async () => {
    const emp = (req) => req.set('Authorization', `Bearer ${employeeToken}`);
    expect((await emp(request(app).post('/api/configurations/floors')).send({ name: `BS Nope ${uid()}` })).status).toBe(403);
    expect((await emp(request(app).patch(`/api/configurations/floors/${fx.floorId}`)).send({ name: 'x' })).status).toBe(403);
    expect((await emp(request(app).delete(`/api/configurations/floors/${fx.floorId}`))).status).toBe(403);
    expect((await emp(request(app).get('/api/configurations/floors'))).status).toBe(200);
  });
});
