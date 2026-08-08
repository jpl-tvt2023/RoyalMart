const request = require('supertest');
const app = require('../app');
const { db } = require('./helpers/db');

let token;
let adminId;
let uidCounter = 0;
const uid = () => `${Date.now()}-${uidCounter++}`;

const authed = (req) => req.set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = res.body.accessToken;
  const { rows } = await db.execute('SELECT id FROM users ORDER BY id LIMIT 1');
  adminId = rows[0].id;
});

async function createArticle(category, variant = '') {
  const item_name = `Item ${uid()}`;
  const taxonomy = await authed(request(app).post('/api/configurations/outbound-products')).send({
    category, item_name, unit_metric: 'pcs',
  });
  expect(taxonomy.status).toBe(201);
  const article = await authed(request(app).post('/api/packaging-raw-materials')).send({
    category, item_name, variant,
  });
  expect(article.status).toBe(201);
  return article.body;
}

async function createRawProduct() {
  const res = await authed(request(app).post('/api/raw-products')).send({ name: `Raw ${uid()}`, qty: 0 });
  expect(res.status).toBe(201);
  return res.body;
}

// Full chain: SKU with raw+packaging+barcode requirements, a vendor mapping so
// a marketplace PO line resolves to it, then one marketplace PO + line.
async function seedDemand({ packagingQty = 2, barcodeQty = 1, lineQty = 5, poDate = '2026-08-01', vendor } = {}) {
  const vendorName = vendor || `Vendor${uid().replace(/-/g, '')}`;
  const raw = await createRawProduct();
  const packaging = await createArticle('Packaging', '5 Ply');
  const barcode = await createArticle('Barcode');

  const sku = await authed(request(app).post('/api/products')).send({
    sku_code: `SKU-${uid()}`,
    requirements: [{ raw_product_id: raw.id, qty: 1 }],
    packaging_requirements: [{ packaging_raw_material_id: packaging.id, qty: packagingQty }],
    barcode_requirements: [{ packaging_raw_material_id: barcode.id, qty: barcodeQty }],
  });
  expect(sku.status).toBe(201);

  const itemCode = `CODE-${uid()}`;
  const mapping = await authed(request(app).post('/api/product-vendor-codes')).send({
    product_id: sku.body.id, vendor: vendorName, vendor_item_code: itemCode,
  });
  expect(mapping.status).toBe(201);

  const poId = `TESTPO-${uid()}`;
  await db.execute({
    sql: `INSERT INTO marketplace_pos (po_id, vendor, vendor_po_id, po_date, status, created_by)
          VALUES (?, ?, ?, ?, 'Open', ?)`,
    args: [poId, vendorName, `VPO-${uid()}`, poDate, adminId],
  });
  await db.execute({
    sql: `INSERT INTO marketplace_po_lines (po_id, line_no, item_code, qty) VALUES (?, 1, ?, ?)`,
    args: [poId, itemCode, lineQty],
  });

  return { poId, poDate, vendorName, sku, packaging, barcode, raw, itemCode };
}

async function cleanupPO(poId) {
  await db.execute({ sql: 'DELETE FROM marketplace_po_lines WHERE po_id = ?', args: [poId] });
  await db.execute({ sql: 'DELETE FROM marketplace_pos WHERE po_id = ?', args: [poId] });
}

describe('Outbound (packaging/barcode) procurement', () => {
  test('computes packaging + barcode demand from SKU requirements and marketplace PO lines', async () => {
    const { poId, poDate, sku, packaging, barcode } = await seedDemand({ packagingQty: 2, barcodeQty: 1, lineQty: 5 });

    const res = await authed(request(app).get('/api/procurement/outbound/requirements'))
      .query({ po_date_from: poDate, po_date_to: poDate });
    expect(res.status).toBe(200);

    expect(res.body.pos.some(p => p.po_id === poId && p.ordered === false)).toBe(true);

    const pkgArticle = res.body.articles.find(a => a.packaging_raw_material_id === packaging.id);
    expect(pkgArticle).toBeDefined();
    expect(pkgArticle.category).toBe('Packaging');
    expect(pkgArticle.quantities[poId]).toBe(10); // 5 (line qty) * 2 (requirement qty)
    expect(pkgArticle.total_required_qty).toBe(10);

    const bcArticle = res.body.articles.find(a => a.packaging_raw_material_id === barcode.id);
    expect(bcArticle).toBeDefined();
    expect(bcArticle.category).toBe('Barcode');
    expect(bcArticle.quantities[poId]).toBe(5); // 5 (line qty) * 1 (requirement qty)

    await cleanupPO(poId);
    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [sku.body.id] });
  });

  test('marking packaging-ordered is independent of raw-ordered status', async () => {
    const { poId, poDate, sku } = await seedDemand({ lineQty: 3 });

    const mark = await authed(request(app).post('/api/procurement/outbound/mark-ordered'))
      .send({ po_ids: [poId], po_date_from: poDate, po_date_to: poDate });
    expect(mark.status).toBe(201);
    expect(mark.body.po_count).toBe(1);
    const batchId = mark.body.batch_id;

    const { rows } = await db.execute({
      sql: `SELECT packaging_procurement_batch_id, packaging_ordered_at, procurement_batch_id, raw_ordered_at
            FROM marketplace_pos WHERE po_id = ?`,
      args: [poId],
    });
    expect(rows[0].packaging_procurement_batch_id).toBe(batchId);
    expect(rows[0].packaging_ordered_at).not.toBeNull();
    // Independence: raw-material ordering on the same PO must be untouched.
    expect(rows[0].procurement_batch_id).toBeNull();
    expect(rows[0].raw_ordered_at).toBeNull();

    const refetch = await authed(request(app).get('/api/procurement/outbound/requirements'))
      .query({ po_date_from: poDate, po_date_to: poDate });
    const po = refetch.body.pos.find(p => p.po_id === poId);
    expect(po.ordered).toBe(true);
    expect(refetch.body.po_count).toBe(0);

    const undo = await authed(request(app).delete(`/api/procurement/outbound/batches/${batchId}`));
    expect(undo.status).toBe(200);
    expect(undo.body.po_count).toBe(1);

    const { rows: after } = await db.execute({
      sql: 'SELECT packaging_procurement_batch_id, packaging_ordered_at FROM marketplace_pos WHERE po_id = ?',
      args: [poId],
    });
    expect(after[0].packaging_procurement_batch_id).toBeNull();
    expect(after[0].packaging_ordered_at).toBeNull();

    await cleanupPO(poId);
    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [sku.body.id] });
  });

  test('a raw-ordered PO can independently also be packaging-ordered', async () => {
    const { poId, poDate, sku } = await seedDemand({ lineQty: 2 });

    const rawMark = await authed(request(app).post('/api/procurement/mark-ordered'))
      .send({ po_ids: [poId], po_date_from: poDate, po_date_to: poDate });
    expect(rawMark.status).toBe(201);

    const pkgMark = await authed(request(app).post('/api/procurement/outbound/mark-ordered'))
      .send({ po_ids: [poId], po_date_from: poDate, po_date_to: poDate });
    expect(pkgMark.status).toBe(201);

    const { rows } = await db.execute({
      sql: `SELECT procurement_batch_id, packaging_procurement_batch_id FROM marketplace_pos WHERE po_id = ?`,
      args: [poId],
    });
    expect(rows[0].procurement_batch_id).not.toBeNull();
    expect(rows[0].packaging_procurement_batch_id).not.toBeNull();

    await cleanupPO(poId);
    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [sku.body.id] });
  });

  test('a line with no vendor mapping counts as unmapped', async () => {
    const poId = `TESTPO-${uid()}`;
    const poDate = '2026-08-02';
    const vendorName = `Vendor${uid().replace(/-/g, '')}`;
    await db.execute({
      sql: `INSERT INTO marketplace_pos (po_id, vendor, vendor_po_id, po_date, status, created_by)
            VALUES (?, ?, ?, ?, 'Open', ?)`,
      args: [poId, vendorName, `VPO-${uid()}`, poDate, adminId],
    });
    const itemCode = `UNMAPPED-${uid()}`;
    await db.execute({
      sql: `INSERT INTO marketplace_po_lines (po_id, line_no, item_code, qty) VALUES (?, 1, ?, 1)`,
      args: [poId, itemCode],
    });

    const res = await authed(request(app).get('/api/procurement/outbound/requirements'))
      .query({ po_date_from: poDate, po_date_to: poDate });
    expect(res.status).toBe(200);
    expect(res.body.unmapped_line_count).toBeGreaterThanOrEqual(1);
    expect(res.body.unmapped_samples.some(s => s.po_id === poId && s.item_code === itemCode)).toBe(true);

    await cleanupPO(poId);
  });
});
