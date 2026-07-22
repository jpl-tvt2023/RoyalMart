const request = require('supertest');
const app = require('../app');
const { db, resetTable } = require('./helpers/db');

let token;
let uidCounter = 0;
const uid = () => `${Date.now()}-${uidCounter++}`;

const DEFAULT_ARTICLES = [{ category: 'Raw Material', item_name: 'Caps' }];

function createVendor(articles = DEFAULT_ARTICLES, overrides = {}) {
  return request(app)
    .post('/api/outbound-vendors')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: overrides.name || `Vendor ${uid()}`, articles });
}

function auditFor(entityType, entityId) {
  return request(app)
    .get('/api/audit-logs')
    .query({ entity_type: entityType, entity_id: entityId })
    .set('Authorization', `Bearer ${token}`);
}

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = res.body.accessToken;
});

// outbound_pos must be cleared before outbound_vendors: outbound_pos.vendor_id
// has no ON DELETE CASCADE, so a leftover PO row would make DELETE FROM
// outbound_vendors fail with a FK constraint error. outbound_po_lines and
// outbound_vendor_articles are already CASCADE-covered by their parents, but
// are reset explicitly anyway so this file doesn't depend on cleanup order
// from whichever outbound test file Jest happens to run first.
beforeEach(async () => {
  await resetTable('outbound_pos');
  await resetTable('outbound_po_lines');
  await resetTable('outbound_vendors');
  await resetTable('outbound_vendor_articles');
});

describe('Outbound Vendors API', () => {
  describe('POST /api/outbound-vendors — create', () => {
    test('creates a vendor with valid articles', async () => {
      const res = await createVendor();
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: expect.any(String), is_active: 1 });
      expect(res.body.articles).toHaveLength(1);
    });

    test('rejects empty/whitespace-only name', async () => {
      const res = await request(app)
        .post('/api/outbound-vendors')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '   ', articles: DEFAULT_ARTICLES });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/name is required/);
    });

    test('rejects a duplicate name, case-insensitively', async () => {
      const name = `Dup ${uid()}`;
      const first = await createVendor(DEFAULT_ARTICLES, { name });
      expect(first.status).toBe(201);
      const second = await createVendor(DEFAULT_ARTICLES, { name: name.toUpperCase() });
      expect(second.status).toBe(409);
      expect(second.body.message).toMatch(/already exists/);
    });

    test('rejects a missing/empty articles array', async () => {
      const res = await createVendor([]);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/At least one article mapping/);
    });

    test('rejects an invalid category', async () => {
      const res = await createVendor([{ category: 'Bogus', item_name: 'Caps' }]);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid category/);
    });

    test('rejects an item_name not in the fixed list for the category', async () => {
      const res = await createVendor([{ category: 'Raw Material', item_name: 'Umbrellas' }]);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not a valid item name/);
    });

    test('is case-sensitive on item_name (unlike the bulk endpoint)', async () => {
      const res = await createVendor([{ category: 'Raw Material', item_name: 'caps' }]);
      expect(res.status).toBe(400);
    });

    test('accepts Others category with arbitrary free-text item_name', async () => {
      const res = await createVendor([{ category: 'Others', item_name: 'Anything Goes' }]);
      expect(res.status).toBe(201);
      expect(res.body.articles[0]).toMatchObject({ category: 'Others', item_name: 'Anything Goes' });
    });
  });

  describe('GET /api/outbound-vendors — list', () => {
    test('returns vendors with articles, active first then by name', async () => {
      const a = await createVendor(DEFAULT_ARTICLES, { name: `Zzz ${uid()}` });
      const b = await createVendor(DEFAULT_ARTICLES, { name: `Aaa ${uid()}` });
      await request(app).delete(`/api/outbound-vendors/${a.body.id}`).set('Authorization', `Bearer ${token}`);

      const res = await request(app).get('/api/outbound-vendors').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const activeIdx = res.body.findIndex(v => v.id === b.body.id);
      const inactiveIdx = res.body.findIndex(v => v.id === a.body.id);
      expect(activeIdx).toBeGreaterThanOrEqual(0);
      expect(activeIdx).toBeLessThan(inactiveIdx);
      expect(res.body.find(v => v.id === b.body.id).articles).toHaveLength(1);
    });
  });

  describe('PATCH /api/outbound-vendors/:id — update', () => {
    test('404 for a non-existent vendor', async () => {
      const res = await request(app)
        .patch('/api/outbound-vendors/999999')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'X' });
      expect(res.status).toBe(404);
    });

    test('partial update: name-only leaves articles unchanged', async () => {
      const created = await createVendor();
      const res = await request(app)
        .patch(`/api/outbound-vendors/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Renamed ${uid()}` });
      expect(res.status).toBe(200);
      expect(res.body.articles).toHaveLength(1);
      expect(res.body.articles[0].item_name).toBe('Caps');
    });

    test('rejects an empty name', async () => {
      const created = await createVendor();
      const res = await request(app)
        .patch(`/api/outbound-vendors/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/name cannot be empty/);
    });

    test('coerces is_active to 1/0', async () => {
      const created = await createVendor();
      const off = await request(app)
        .patch(`/api/outbound-vendors/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ is_active: false });
      expect(off.body.is_active).toBe(0);
      const on = await request(app)
        .patch(`/api/outbound-vendors/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ is_active: true });
      expect(on.body.is_active).toBe(1);
    });

    test('rejects a duplicate name on rename', async () => {
      const nameA = `A ${uid()}`;
      await createVendor(DEFAULT_ARTICLES, { name: nameA });
      const vendorB = await createVendor();
      const res = await request(app)
        .patch(`/api/outbound-vendors/${vendorB.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: nameA.toUpperCase() });
      expect(res.status).toBe(409);
    });

    test('full article replace deletes old mappings and inserts new ones', async () => {
      const created = await createVendor([{ category: 'Raw Material', item_name: 'Caps' }]);
      const oldArticleId = created.body.articles[0].id;
      const res = await request(app)
        .patch(`/api/outbound-vendors/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ articles: [{ category: 'Packaging', item_name: 'One Ply' }] });
      expect(res.status).toBe(200);
      expect(res.body.articles).toHaveLength(1);
      expect(res.body.articles[0].category).toBe('Packaging');
      expect(res.body.articles[0].id).not.toBe(oldArticleId);
    });

    test('rejects invalid articles on update', async () => {
      const created = await createVendor();
      const res = await request(app)
        .patch(`/api/outbound-vendors/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ articles: [{ category: 'Raw Material', item_name: 'NotAThing' }] });
      expect(res.status).toBe(400);
    });

    test('reactivates a deactivated vendor via is_active: true', async () => {
      const created = await createVendor();
      await request(app).delete(`/api/outbound-vendors/${created.body.id}`).set('Authorization', `Bearer ${token}`);
      const res = await request(app)
        .patch(`/api/outbound-vendors/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ is_active: true });
      expect(res.body.is_active).toBe(1);
    });
  });

  describe('DELETE /api/outbound-vendors/:id — soft remove', () => {
    test('404 for a non-existent vendor', async () => {
      const res = await request(app).delete('/api/outbound-vendors/999999').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    test('deactivates without deleting the row', async () => {
      const created = await createVendor();
      const res = await request(app).delete(`/api/outbound-vendors/${created.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.is_active).toBe(0);
      const list = await request(app).get('/api/outbound-vendors').set('Authorization', `Bearer ${token}`);
      expect(list.body.some(v => v.id === created.body.id)).toBe(true);
    });
  });

  describe('POST /api/outbound-vendors/bulk — bulk upsert', () => {
    test('rejects a missing/non-array rows field', async () => {
      const res = await request(app).post('/api/outbound-vendors/bulk').set('Authorization', `Bearer ${token}`).send({});
      expect(res.status).toBe(400);
    });

    test('rejects an empty array', async () => {
      const res = await request(app).post('/api/outbound-vendors/bulk').set('Authorization', `Bearer ${token}`).send({ rows: [] });
      expect(res.status).toBe(400);
    });

    test('rejects more than 2000 rows', async () => {
      const rows = Array.from({ length: 2001 }, () => ({}));
      const res = await request(app).post('/api/outbound-vendors/bulk').set('Authorization', `Bearer ${token}`).send({ rows });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Too many rows/);
    });

    test('an unknown vendor_name auto-creates the vendor', async () => {
      const vendorName = `Bulk New ${uid()}`;
      const res = await request(app)
        .post('/api/outbound-vendors/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ rows: [{ vendor_name: vendorName, category: 'Raw Material', item_name: 'Caps' }] });
      expect(res.status).toBe(200);
      expect(res.body.inserted).toBe(1);
      expect(res.body.skipped).toHaveLength(0);
      const list = await request(app).get('/api/outbound-vendors').set('Authorization', `Bearer ${token}`);
      expect(list.body.some(v => v.name === vendorName)).toBe(true);
    });

    test('matches an existing vendor case-insensitively and updates it (not a duplicate)', async () => {
      const created = await createVendor([{ category: 'Raw Material', item_name: 'Caps' }]);
      const res = await request(app)
        .post('/api/outbound-vendors/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ rows: [{ vendor_name: created.body.name.toUpperCase(), category: 'Packaging', item_name: 'One Ply' }] });
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(1);
      expect(res.body.inserted).toBe(0);
      const list = await request(app).get('/api/outbound-vendors').set('Authorization', `Bearer ${token}`);
      expect(list.body.filter(v => v.name.toLowerCase() === created.body.name.toLowerCase())).toHaveLength(1);
    });

    test('canonicalizes category/item_name casing to the official form', async () => {
      const vendorName = `Bulk Canon ${uid()}`;
      const res = await request(app)
        .post('/api/outbound-vendors/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ rows: [{ vendor_name: vendorName, category: 'packaging', item_name: 'one ply' }] });
      expect(res.status).toBe(200);
      expect(res.body.inserted).toBe(1);
      const list = await request(app).get('/api/outbound-vendors').set('Authorization', `Bearer ${token}`);
      const v = list.body.find(v => v.name === vendorName);
      expect(v.articles[0]).toMatchObject({ category: 'Packaging', item_name: 'One Ply' });
    });

    test('skips a duplicate mapping without overwriting the existing row', async () => {
      const created = await createVendor([{ category: 'Raw Material', item_name: 'Caps' }]);
      const res = await request(app)
        .post('/api/outbound-vendors/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ rows: [{ vendor_name: created.body.name, category: 'Raw Material', item_name: 'Caps' }] });
      expect(res.status).toBe(200);
      expect(res.body.inserted).toBe(0);
      expect(res.body.updated).toBe(0);
      expect(res.body.skipped).toHaveLength(1);
      expect(res.body.skipped[0].reason).toMatch(/already exists/);
    });

    test('one bad row among good rows is skipped, not a blanket 400', async () => {
      const vendorName = `Bulk Mixed ${uid()}`;
      const res = await request(app)
        .post('/api/outbound-vendors/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({
          rows: [
            { vendor_name: vendorName, category: 'Raw Material', item_name: 'Caps' },
            { vendor_name: vendorName, category: 'Bogus Category', item_name: 'X' },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.inserted).toBe(1);
      expect(res.body.skipped).toHaveLength(1);
      expect(res.body.skipped[0].row).toBe(3); // array index 1 + 2 (assumes a header row)
    });

    test('writes an OUTBOUND_VENDOR_BULK_UPSERT audit row', async () => {
      // The bulk-upsert audit entry is written with entityId: null, and
      // GET /api/audit-logs requires a non-empty entity_id, so it can never be
      // retrieved through that endpoint (a real gap in the History UI, not
      // just a test limitation — see plan notes). Verify directly via db instead.
      const vendorName = `Bulk Audit ${uid()}`;
      await request(app)
        .post('/api/outbound-vendors/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ rows: [{ vendor_name: vendorName, category: 'Raw Material', item_name: 'Caps' }] });
      const { rows } = await db.execute(
        `SELECT * FROM audit_logs WHERE action_type = 'OUTBOUND_VENDOR_BULK_UPSERT' ORDER BY id DESC LIMIT 1`
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('Audit logging spot-checks', () => {
    test('create writes an OUTBOUND_VENDOR_CREATE entry', async () => {
      const created = await createVendor();
      const res = await auditFor('outbound_vendor', created.body.id);
      expect(res.status).toBe(200);
      expect(res.body.some(e => e.action_type === 'OUTBOUND_VENDOR_CREATE')).toBe(true);
    });

    test('update writes an OUTBOUND_VENDOR_UPDATE entry with a non-empty changes diff', async () => {
      const created = await createVendor();
      await request(app)
        .patch(`/api/outbound-vendors/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Changed ${uid()}` });
      const res = await auditFor('outbound_vendor', created.body.id);
      const entry = res.body.find(e => e.action_type === 'OUTBOUND_VENDOR_UPDATE');
      expect(entry).toBeTruthy();
      expect(entry.changes.length).toBeGreaterThan(0);
    });

    test('deactivate writes an OUTBOUND_VENDOR_DEACTIVATE entry', async () => {
      const created = await createVendor();
      await request(app).delete(`/api/outbound-vendors/${created.body.id}`).set('Authorization', `Bearer ${token}`);
      const res = await auditFor('outbound_vendor', created.body.id);
      expect(res.body.some(e => e.action_type === 'OUTBOUND_VENDOR_DEACTIVATE')).toBe(true);
    });
  });
});
