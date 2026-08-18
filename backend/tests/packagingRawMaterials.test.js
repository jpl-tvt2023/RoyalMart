const request = require('supertest');
const app = require('../app');
const { db, resetTable } = require('./helpers/db');

let token;
let uidCounter = 0;
const uid = () => `${Date.now()}-${uidCounter++}`;

const authed = (req) => req.set('Authorization', `Bearer ${token}`);

function createVendor(articles, overrides = {}) {
  return authed(request(app).post('/api/outbound-vendors')).send({ name: overrides.name || `Vendor ${uid()}`, articles });
}

function createOutboundProduct(overrides = {}) {
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

async function findCatalogRow(category, itemName) {
  const res = await authed(request(app).get('/api/packaging-raw-materials'));
  return res.body.find(r => r.category === category && r.item_name === itemName);
}

// A fresh, guaranteed-unreferenced catalog row: its own Outbound Product List
// entry plus a matching packaging_raw_materials row, both under a unique
// category so cleanup can't touch the migration-seeded taxonomy shared by
// the other outbound test files.
async function createDisposableCatalogRow() {
  const product = await createOutboundProduct();
  const packaging = await createPackagingProduct({ category: product.body.category, item_name: product.body.item_name });
  return { category: product.body.category, item_name: product.body.item_name, id: packaging.body.id };
}

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

beforeEach(async () => {
  await resetTable('outbound_pos');
  await resetTable('outbound_po_lines');
  await resetTable('outbound_vendors');
  await resetTable('outbound_vendor_articles');
});

describe('Packaging Raw Materials API — referential integrity guard', () => {
  describe('DELETE /api/packaging-raw-materials/:id', () => {
    test('is blocked while a vendor still maps to the item', async () => {
      const row = await findCatalogRow('Raw Material', 'Caps');
      expect(row).toBeTruthy();
      const vendor = await createVendor([{ category: 'Raw Material', item_name: 'Caps' }]);
      expect(vendor.status).toBe(201);

      const res = await authed(request(app).delete(`/api/packaging-raw-materials/${row.id}`));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/still mapped to vendor/);
      expect(res.body.message).toContain(vendor.body.name);

      const stillThere = await findCatalogRow('Raw Material', 'Caps');
      expect(stillThere).toBeTruthy();
    });

    test('succeeds when no vendor maps to the item', async () => {
      const disposable = await createDisposableCatalogRow();
      const res = await authed(request(app).delete(`/api/packaging-raw-materials/${disposable.id}`));
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
      await cleanup(disposable.category);
    });
  });

  describe('POST /api/packaging-raw-materials/bulk-delete', () => {
    test('skips a referenced row and reports it, but deletes the unreferenced one', async () => {
      const referenced = await findCatalogRow('Raw Material', 'Caps');
      await createVendor([{ category: 'Raw Material', item_name: 'Caps' }]);
      const disposable = await createDisposableCatalogRow();

      const res = await authed(request(app).post('/api/packaging-raw-materials/bulk-delete'))
        .send({ ids: [referenced.id, disposable.id] });
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(1);
      expect(res.body.skipped).toHaveLength(1);
      expect(res.body.skipped[0]).toMatchObject({ id: referenced.id });
      expect(res.body.skipped[0].reason).toMatch(/still mapped to vendor/);

      expect(await findCatalogRow('Raw Material', 'Caps')).toBeTruthy();
      await cleanup(disposable.category);
    });
  });

  describe('PUT /api/packaging-raw-materials/:id', () => {
    test('cascades a rename (identity change) onto vendor mappings that still map to the old identity', async () => {
      const disposable = await createDisposableCatalogRow();
      const vendor = await createVendor([{ category: disposable.category, item_name: disposable.item_name }]);
      const target = await createOutboundProduct();

      const res = await authed(request(app).put(`/api/packaging-raw-materials/${disposable.id}`))
        .send({ category: target.body.category, item_name: target.body.item_name });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ category: target.body.category, item_name: target.body.item_name });

      const renamed = await findCatalogRow(target.body.category, target.body.item_name);
      expect(renamed.id).toBe(disposable.id);

      const vendors = await authed(request(app).get('/api/outbound-vendors'));
      const savedVendor = vendors.body.find(v => v.id === vendor.body.id);
      expect(savedVendor.articles).toContainEqual(
        expect.objectContaining({ category: target.body.category, item_name: target.body.item_name })
      );
      expect(savedVendor.articles.some(a => a.category === disposable.category && a.item_name === disposable.item_name)).toBe(false);

      await cleanup(disposable.category);
      await cleanup(target.body.category);
    });

    test('allows a same-identity edit even while a vendor still maps to the item', async () => {
      // unit_metric is always derived from the Outbound Product List master
      // (see create()'s comment) and ignored from the request body, so the
      // only meaningful no-op edit here is resubmitting the same category/item_name.
      const row = await findCatalogRow('Raw Material', 'Caps');
      await createVendor([{ category: 'Raw Material', item_name: 'Caps' }]);

      const res = await authed(request(app).put(`/api/packaging-raw-materials/${row.id}`))
        .send({ category: 'Raw Material', item_name: 'Caps' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ category: 'Raw Material', item_name: 'Caps', unit_metric: row.unit_metric });
    });

    test('allows a rename when no vendor maps to the item', async () => {
      const disposable = await createDisposableCatalogRow();
      const target = await createOutboundProduct();

      const res = await authed(request(app).put(`/api/packaging-raw-materials/${disposable.id}`))
        .send({ category: target.body.category, item_name: target.body.item_name });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ category: target.body.category, item_name: target.body.item_name });

      await cleanup(disposable.category);
      await cleanup(target.body.category);
    });
  });

  // Migration 064 let one (category, item_name) pair be listed under several
  // unit metrics, so the pair alone no longer determines the metric.
  describe('unit metric resolution against the Outbound Product List', () => {
    // Two Outbound Product entries sharing a pair but differing in metric.
    async function createAmbiguousPair() {
      const pcs = await createOutboundProduct({ unit_metric: 'pcs' });
      const { category, item_name: itemName } = pcs.body;
      const mtr = await createOutboundProduct({ category, item_name: itemName, unit_metric: 'mtr' });
      expect(mtr.status).toBe(201);
      return { category, itemName };
    }

    test('an unambiguous pair still ignores the submitted metric entirely', async () => {
      const product = await createOutboundProduct({ unit_metric: 'roll' });
      const { category, item_name: itemName } = product.body;

      const res = await createPackagingProduct({ category, item_name: itemName, unit_metric: 'nonsense' });
      expect(res.status).toBe(201);
      expect(res.body.unit_metric).toBe('roll');
      await cleanup(category);
    });

    test('an ambiguous pair is rejected when no metric is given', async () => {
      const { category, itemName } = await createAmbiguousPair();

      const res = await createPackagingProduct({ category, item_name: itemName });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/more than one unit metric/);
      await cleanup(category);
    });

    test('an ambiguous pair is rejected when the metric is not one of its options', async () => {
      const { category, itemName } = await createAmbiguousPair();

      const res = await createPackagingProduct({ category, item_name: itemName, unit_metric: 'roll' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/more than one unit metric/);
      await cleanup(category);
    });

    test('an ambiguous pair resolves to whichever metric was chosen', async () => {
      const { category, itemName } = await createAmbiguousPair();

      const res = await createPackagingProduct({ category, item_name: itemName, variant: 'A', unit_metric: 'mtr' });
      expect(res.status).toBe(201);
      expect(res.body.unit_metric).toBe('mtr');
      await cleanup(category);
    });
  });
});
