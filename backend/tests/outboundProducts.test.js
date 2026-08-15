const request = require('supertest');
const app = require('../app');
const { db } = require('./helpers/db');

let token;
let uidCounter = 0;
const uid = () => `${Date.now()}-${uidCounter++}`;

const authed = (req) => req.set('Authorization', `Bearer ${token}`);

function createProduct(overrides = {}) {
  return authed(request(app).post('/api/configurations/outbound-products')).send({
    category: `Cat ${uid()}`,
    item_name: `Item ${uid()}`,
    unit_metric: 'pcs',
    ...overrides,
  });
}

function createPackagingProduct(payload) {
  return authed(request(app).post('/api/packaging-raw-materials')).send(payload);
}

// Rows created here are keyed on a per-test uid, so tests do not collide and
// the migration-seeded taxonomy (Raw Material / Caps, Packaging / Corrugated…)
// stays intact for the other outbound test files.
async function cleanup(category) {
  await db.execute({ sql: 'DELETE FROM packaging_raw_materials WHERE category = ?', args: [category] });
  await db.execute({ sql: 'DELETE FROM outbound_products WHERE category = ?', args: [category] });
}

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = res.body.accessToken;
});

describe('Outbound Product List API', () => {
  describe('CRUD', () => {
    test('creates an entry and returns it with a zero usage count', async () => {
      const res = await createProduct({ unit_metric: 'roll' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ unit_metric: 'roll', is_active: 1, products_using: 0 });
      await cleanup(res.body.category);
    });

    test.each(['category', 'item_name', 'unit_metric'])('rejects a missing %s', async (field) => {
      const res = await createProduct({ [field]: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(new RegExp(`${field} is required`));
    });

    test('rejects a duplicate category + item name, case-insensitively', async () => {
      const category = `Cat ${uid()}`;
      const itemName = `Item ${uid()}`;
      const first = await createProduct({ category, item_name: itemName });
      expect(first.status).toBe(201);

      const second = await createProduct({
        category: category.toUpperCase(),
        item_name: itemName.toUpperCase(),
      });
      expect(second.status).toBe(409);
      expect(second.body.message).toMatch(/already in the Outbound Product List/);
      await cleanup(category);
    });

    test('lists active entries first, with usage counts', async () => {
      const active = await createProduct();
      const inactive = await createProduct();
      await authed(request(app).delete(`/api/configurations/outbound-products/${inactive.body.id}`));

      await createPackagingProduct({
        category: active.body.category, item_name: active.body.item_name, variant: '5 Ply',
      });

      const res = await authed(request(app).get('/api/configurations/outbound-products'));
      expect(res.status).toBe(200);
      const activeIdx = res.body.findIndex(r => r.id === active.body.id);
      const inactiveIdx = res.body.findIndex(r => r.id === inactive.body.id);
      expect(activeIdx).toBeGreaterThanOrEqual(0);
      expect(activeIdx).toBeLessThan(inactiveIdx);
      expect(res.body[activeIdx].products_using).toBe(1);
      expect(res.body[inactiveIdx]).toMatchObject({ is_active: 0, products_using: 0 });

      await cleanup(active.body.category);
      await cleanup(inactive.body.category);
    });

    test('deactivate is a soft delete and is reversible', async () => {
      const created = await createProduct();
      const del = await authed(request(app).delete(`/api/configurations/outbound-products/${created.body.id}`));
      expect(del.status).toBe(200);
      expect(del.body.is_active).toBe(0);

      const back = await authed(request(app).patch(`/api/configurations/outbound-products/${created.body.id}`))
        .send({ is_active: true });
      expect(back.status).toBe(200);
      expect(back.body.is_active).toBe(1);
      await cleanup(created.body.category);
    });
  });

  describe('PATCH — rename cascade and unit metric cascade', () => {
    test('allows a rename while nothing uses the entry', async () => {
      const created = await createProduct();
      const renamed = `Item ${uid()}`;
      const res = await authed(request(app).patch(`/api/configurations/outbound-products/${created.body.id}`))
        .send({ item_name: renamed });
      expect(res.status).toBe(200);
      expect(res.body.item_name).toBe(renamed);
      await cleanup(created.body.category);
    });

    test('a rename cascades into packaging products and their vendor mappings', async () => {
      const created = await createProduct();
      const pkg = await createPackagingProduct({
        category: created.body.category, item_name: created.body.item_name, variant: '',
      });
      const { rows: vendorRows } = await db.execute({
        sql: 'INSERT INTO outbound_vendors (name) VALUES (?) RETURNING id',
        args: [`Rename Cascade Vendor ${uid()}`],
      });
      await db.execute({
        sql: `INSERT INTO outbound_vendor_articles (vendor_id, category, item_name, variant)
              VALUES (?, ?, ?, '')`,
        args: [vendorRows[0].id, created.body.category, created.body.item_name],
      });

      const renamedItem = `Item ${uid()}`;
      const res = await authed(request(app).patch(`/api/configurations/outbound-products/${created.body.id}`))
        .send({ item_name: renamedItem });
      expect(res.status).toBe(200);
      expect(res.body.item_name).toBe(renamedItem);

      const { rows: pkgRows } = await db.execute({
        sql: 'SELECT category, item_name FROM packaging_raw_materials WHERE id = ?',
        args: [pkg.body.id],
      });
      expect(pkgRows[0]).toMatchObject({ category: created.body.category, item_name: renamedItem });

      const { rows: articleRows } = await db.execute({
        sql: 'SELECT category, item_name FROM outbound_vendor_articles WHERE vendor_id = ?',
        args: [vendorRows[0].id],
      });
      expect(articleRows[0]).toMatchObject({ category: created.body.category, item_name: renamedItem });

      await db.execute({ sql: 'DELETE FROM outbound_vendor_articles WHERE vendor_id = ?', args: [vendorRows[0].id] });
      await db.execute({ sql: 'DELETE FROM outbound_vendors WHERE id = ?', args: [vendorRows[0].id] });
      await cleanup(created.body.category);
    });

    test('a casing-only correction is not treated as a rename', async () => {
      const created = await createProduct({ item_name: `item ${uid()}` });
      await createPackagingProduct({
        category: created.body.category, item_name: created.body.item_name, variant: '',
      });

      const res = await authed(request(app).patch(`/api/configurations/outbound-products/${created.body.id}`))
        .send({ item_name: created.body.item_name.toUpperCase() });
      expect(res.status).toBe(200);
      await cleanup(created.body.category);
    });

    test('a unit metric change cascades into the packaging products using it', async () => {
      const created = await createProduct({ unit_metric: 'pcs' });
      const pkg = await createPackagingProduct({
        category: created.body.category, item_name: created.body.item_name, variant: '5 Ply',
      });
      expect(pkg.body.unit_metric).toBe('pcs');

      const res = await authed(request(app).patch(`/api/configurations/outbound-products/${created.body.id}`))
        .send({ unit_metric: 'kg' });
      expect(res.status).toBe(200);

      const { rows } = await db.execute({
        sql: 'SELECT unit_metric FROM packaging_raw_materials WHERE id = ?',
        args: [pkg.body.id],
      });
      expect(rows[0].unit_metric).toBe('kg');
      await cleanup(created.body.category);
    });

    test('a unit metric change leaves outbound PO lines untouched', async () => {
      const created = await createProduct({ unit_metric: 'pcs' });
      await createPackagingProduct({
        category: created.body.category, item_name: created.body.item_name, variant: '',
      });

      // Historical PO lines snapshot their unit metric (migration 057), so the
      // cascade must not rewrite them. The vendor and PO are created here rather
      // than reused, since the other outbound test files reset those tables.
      const { rows: vendorRows } = await db.execute({
        sql: 'INSERT INTO outbound_vendors (name) VALUES (?) RETURNING id',
        args: [`UM Cascade Vendor ${uid()}`],
      });
      const { rows: poRows } = await db.execute({
        sql: `INSERT INTO outbound_pos (vendor_id, status, created_by)
              VALUES (?, 'Open', (SELECT id FROM users ORDER BY id LIMIT 1)) RETURNING id`,
        args: [vendorRows[0].id],
      });
      const { rows: lineRows } = await db.execute({
        sql: `INSERT INTO outbound_po_lines (po_id, line_no, category, item_name, variant, qty, rate, unit_metric)
              VALUES (?, 1, ?, ?, '', 10, 5, 'pcs') RETURNING id`,
        args: [poRows[0].id, created.body.category, created.body.item_name],
      });

      const patched = await authed(request(app).patch(`/api/configurations/outbound-products/${created.body.id}`))
        .send({ unit_metric: 'kg' });
      expect(patched.status).toBe(200);

      const { rows } = await db.execute({
        sql: 'SELECT unit_metric FROM outbound_po_lines WHERE id = ?',
        args: [lineRows[0].id],
      });
      expect(rows[0].unit_metric).toBe('pcs');

      await db.execute({ sql: 'DELETE FROM outbound_po_lines WHERE po_id = ?', args: [poRows[0].id] });
      await db.execute({ sql: 'DELETE FROM outbound_pos WHERE id = ?', args: [poRows[0].id] });
      await db.execute({ sql: 'DELETE FROM outbound_vendors WHERE id = ?', args: [vendorRows[0].id] });
      await cleanup(created.body.category);
    });
  });
});

describe('Packaging products validate against the Outbound Product List', () => {
  test('rejects a category + item name that is not listed', async () => {
    const res = await createPackagingProduct({
      category: `Bogus ${uid()}`, item_name: 'Nothing', variant: '', unit_metric: 'pcs',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not in the Outbound Product List/);
  });

  test('rejects a listed item under the wrong category', async () => {
    const res = await createPackagingProduct({
      category: 'Packaging', item_name: 'Caps', variant: '', unit_metric: 'pcs',
    });
    expect(res.status).toBe(400);
  });

  test('rejects an entry that has been deactivated', async () => {
    const created = await createProduct();
    await authed(request(app).delete(`/api/configurations/outbound-products/${created.body.id}`));
    const res = await createPackagingProduct({
      category: created.body.category, item_name: created.body.item_name, variant: '',
    });
    expect(res.status).toBe(400);
    await cleanup(created.body.category);
  });

  test('canonicalises casing and takes the unit metric from the master, ignoring the one sent', async () => {
    const created = await createProduct({ unit_metric: 'meter' });
    const res = await createPackagingProduct({
      category: created.body.category.toUpperCase(),
      item_name: created.body.item_name.toUpperCase(),
      variant: '80',
      unit_metric: 'tonne',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      category: created.body.category,
      item_name: created.body.item_name,
      unit_metric: 'meter',
    });
    await cleanup(created.body.category);
  });

  test('update is validated too', async () => {
    const created = await createProduct();
    const pkg = await createPackagingProduct({
      category: created.body.category, item_name: created.body.item_name, variant: '',
    });
    const res = await authed(request(app).put(`/api/packaging-raw-materials/${pkg.body.id}`))
      .send({ category: `Bogus ${uid()}`, item_name: 'Nothing' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not in the Outbound Product List/);
    await cleanup(created.body.category);
  });

  test('bulk upload skips unlisted rows and derives the unit metric for the rest', async () => {
    const created = await createProduct({ unit_metric: 'roll' });
    const bogus = `Bogus ${uid()}`;
    const res = await authed(request(app).post('/api/packaging-raw-materials/bulk')).send({
      rows: [
        { category: created.body.category, item_name: created.body.item_name, variant: '60', unit_metric: 'ignored' },
        { category: bogus, item_name: 'Nothing', variant: '', unit_metric: 'pcs' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0]).toMatchObject({ row: 3 });
    expect(res.body.skipped[0].reason).toMatch(/not in the Outbound Product List/);

    const { rows } = await db.execute({
      sql: 'SELECT unit_metric FROM packaging_raw_materials WHERE category = ? AND variant = ?',
      args: [created.body.category, '60'],
    });
    expect(rows[0].unit_metric).toBe('roll');
    await cleanup(created.body.category);
  });
});
