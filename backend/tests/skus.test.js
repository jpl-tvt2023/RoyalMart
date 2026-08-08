const request = require('supertest');
const app = require('../app');
const { db } = require('./helpers/db');

let token;
let uidCounter = 0;
const uid = () => `${Date.now()}-${uidCounter++}`;

const authed = (req) => req.set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = res.body.accessToken;
});

// Creates an Outbound Product List entry + a packaging_raw_materials article
// under it, in the given category ('Packaging' or 'Barcode'). Mirrors the
// two-step setup in outboundProducts.test.js (taxonomy entry, then catalog
// article validated against it).
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
  return article.body; // { id, category, item_name, variant, unit_metric, ... }
}

async function createRawProduct() {
  const res = await authed(request(app).post('/api/raw-products')).send({ name: `Raw ${uid()}`, qty: 0 });
  expect(res.status).toBe(201);
  return res.body;
}

function skuPayload({ raw, packaging, barcode, overrides = {} }) {
  return {
    sku_code: `SKU-${uid()}`,
    description: 'Test SKU',
    category: null,
    requirements: raw ? [{ raw_product_id: raw.id, qty: 1 }] : [],
    packaging_requirements: packaging ? [{ packaging_raw_material_id: packaging.id, qty: 2 }] : [],
    barcode_requirements: barcode ? [{ packaging_raw_material_id: barcode.id, qty: 1 }] : [],
    ...overrides,
  };
}

describe('SKU packaging/barcode requirements', () => {
  test('rejects a SKU with raw requirements but no packaging requirements', async () => {
    const raw = await createRawProduct();
    const barcode = await createArticle('Barcode');
    const res = await authed(request(app).post('/api/products'))
      .send(skuPayload({ raw, barcode }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/packaging product/i);
  });

  test('rejects a SKU with no barcode requirements', async () => {
    const raw = await createRawProduct();
    const packaging = await createArticle('Packaging');
    const res = await authed(request(app).post('/api/products'))
      .send(skuPayload({ raw, packaging }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/barcode/i);
  });

  test('rejects a Barcode-category article used inside packaging_requirements', async () => {
    const raw = await createRawProduct();
    const barcode = await createArticle('Barcode');
    const res = await authed(request(app).post('/api/products'))
      .send(skuPayload({ raw, packaging: barcode, barcode }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/unknown packaging product/i);
  });

  test('rejects a Packaging-category article used inside barcode_requirements', async () => {
    const raw = await createRawProduct();
    const packaging = await createArticle('Packaging');
    const res = await authed(request(app).post('/api/products'))
      .send(skuPayload({ raw, packaging, barcode: packaging }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/unknown barcode/i);
  });

  test('creates a SKU with all three sections and round-trips them via GET', async () => {
    const raw = await createRawProduct();
    const packaging = await createArticle('Packaging', '5 Ply');
    const barcode = await createArticle('Barcode');
    const payload = skuPayload({ raw, packaging, barcode });

    const created = await authed(request(app).post('/api/products')).send(payload);
    expect(created.status).toBe(201);
    expect(created.body.sku_code).toBe(payload.sku_code);

    const list = await authed(request(app).get('/api/products'));
    expect(list.status).toBe(200);
    const sku = list.body.find(s => s.id === created.body.id);
    expect(sku).toBeDefined();
    expect(sku.requirements).toMatchObject([{ raw_product_id: raw.id, qty: 1 }]);
    expect(sku.packaging_requirements).toMatchObject([{
      packaging_raw_material_id: packaging.id, qty: 2, item_name: packaging.item_name, variant: '5 Ply', category: 'Packaging',
    }]);
    expect(sku.barcode_requirements).toMatchObject([{
      packaging_raw_material_id: barcode.id, qty: 1, item_name: barcode.item_name, category: 'Barcode',
    }]);

    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [created.body.id] });
  });

  test('editing an existing (legacy-shaped) SKU without packaging/barcode requirements is rejected', async () => {
    const raw = await createRawProduct();
    const packaging = await createArticle('Packaging');
    const barcode = await createArticle('Barcode');
    const created = await authed(request(app).post('/api/products')).send(skuPayload({ raw, packaging, barcode }));
    expect(created.status).toBe(201);

    // Simulate a legacy SKU by wiping its packaging/barcode rows directly.
    await db.execute({ sql: 'DELETE FROM product_packaging_requirements WHERE product_id = ?', args: [created.body.id] });
    await db.execute({ sql: 'DELETE FROM product_barcode_requirements WHERE product_id = ?', args: [created.body.id] });

    const update = await authed(request(app).put(`/api/products/${created.body.id}`)).send({
      sku_code: created.body.sku_code,
      requirements: [{ raw_product_id: raw.id, qty: 1 }],
      packaging_requirements: [],
      barcode_requirements: [],
    });
    expect(update.status).toBe(400);
    expect(update.body.message).toMatch(/packaging product/i);

    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [created.body.id] });
  });

  test('bulk upload resolves "Item|Variant:qty" cells and skips unknown articles', async () => {
    const raw = await createRawProduct();
    const packaging = await createArticle('Packaging', '5 Ply');
    const barcode = await createArticle('Barcode');
    const skuCode = `SKU-${uid()}`;

    const res = await authed(request(app).post('/api/products/bulk')).send({
      rows: [
        {
          sku_code: skuCode,
          requirements: `${raw.name}:3`,
          packaging_requirements: `${packaging.item_name}|${packaging.variant}:2`,
          barcode_requirements: `${barcode.item_name}:1`,
        },
        {
          sku_code: `SKU-${uid()}`,
          requirements: `${raw.name}:1`,
          packaging_requirements: `Totally Unknown Item|X:1`,
          barcode_requirements: `${barcode.item_name}:1`,
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].reason).toMatch(/unknown packaging product/i);

    const { rows: prodRows } = await db.execute({ sql: 'SELECT id FROM products WHERE sku_code = ?', args: [skuCode] });
    expect(prodRows).toHaveLength(1);
    const { rows: pkgRows } = await db.execute({
      sql: 'SELECT packaging_raw_material_id, qty FROM product_packaging_requirements WHERE product_id = ?',
      args: [prodRows[0].id],
    });
    expect(pkgRows).toMatchObject([{ packaging_raw_material_id: packaging.id, qty: 2 }]);

    await db.execute({ sql: 'DELETE FROM products WHERE sku_code = ?', args: [skuCode] });
  });
});

describe('hsn_code has been fully removed', () => {
  test('the products table no longer has an hsn_code column', async () => {
    const { rows } = await db.execute('PRAGMA table_info(products)');
    expect(rows.some(r => r.name === 'hsn_code')).toBe(false);
  });

  test('POST /api/products silently ignores a stray hsn_code in the body', async () => {
    const raw = await createRawProduct();
    const packaging = await createArticle('Packaging');
    const barcode = await createArticle('Barcode');
    const res = await authed(request(app).post('/api/products')).send(
      skuPayload({ raw, packaging, barcode, overrides: { hsn_code: '9999' } })
    );
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('hsn_code');

    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [res.body.id] });
  });

  test('GET /api/products rows never carry an hsn_code key', async () => {
    const raw = await createRawProduct();
    const packaging = await createArticle('Packaging');
    const barcode = await createArticle('Barcode');
    const created = await authed(request(app).post('/api/products')).send(skuPayload({ raw, packaging, barcode }));
    expect(created.status).toBe(201);

    const list = await authed(request(app).get('/api/products'));
    const sku = list.body.find(s => s.id === created.body.id);
    expect(sku).not.toHaveProperty('hsn_code');

    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [created.body.id] });
  });

  test('PUT /api/products/:id silently ignores a stray hsn_code in the body', async () => {
    const raw = await createRawProduct();
    const packaging = await createArticle('Packaging');
    const barcode = await createArticle('Barcode');
    const created = await authed(request(app).post('/api/products')).send(skuPayload({ raw, packaging, barcode }));
    expect(created.status).toBe(201);

    const updated = await authed(request(app).put(`/api/products/${created.body.id}`)).send(
      skuPayload({ raw, packaging, barcode, overrides: { sku_code: created.body.sku_code, hsn_code: '5555' } })
    );
    expect(updated.status).toBe(200);
    expect(updated.body).not.toHaveProperty('hsn_code');

    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [created.body.id] });
  });
});
