const request = require('supertest');
const app = require('../app');
const { db, resetTable } = require('./helpers/db');

let token;
let adminUserId;
let activeCompanyId;
let inactiveCompanyId;
let uidCounter = 0;
const uid = () => `${Date.now()}-${uidCounter++}`;

const DEFAULT_ARTICLES = [{ category: 'Raw Material', item_name: 'Caps' }];

function createVendor(articles = DEFAULT_ARTICLES, overrides = {}) {
  return request(app)
    .post('/api/outbound-vendors')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: overrides.name || `Vendor ${uid()}`, articles });
}

function deactivateVendor(id) {
  return request(app).delete(`/api/outbound-vendors/${id}`).set('Authorization', `Bearer ${token}`);
}

// Turns a vendor's article record ({category, item_name, variant}) into a
// valid PO line payload, overridable per test.
function lineFor(article, overrides = {}) {
  return {
    category: article.category,
    item_name: article.item_name,
    variant: article.variant || null,
    qty: 1,
    rate: 10,
    received: 0,
    short: 0,
    ...overrides,
  };
}

function createPO(body) {
  return request(app).post('/api/outbound-pos').set('Authorization', `Bearer ${token}`).send(body);
}

function patchPO(id, body) {
  return request(app).patch(`/api/outbound-pos/${id}`).set('Authorization', `Bearer ${token}`).send(body);
}

function auditFor(entityType, entityId) {
  return request(app)
    .get('/api/audit-logs')
    .query({ entity_type: entityType, entity_id: entityId })
    .set('Authorization', `Bearer ${token}`);
}

// Convenience: create a vendor with one mapping, then a PO with one line
// against it. Returns { vendor, po, article }.
async function createVendorAndPO(poOverrides = {}) {
  const vendor = await createVendor();
  const article = vendor.body.articles[0];
  const po = await createPO({
    vendor_id: vendor.body.id,
    lines: [lineFor(article)],
    ...poOverrides,
  });
  return { vendor, po, article };
}

beforeAll(async () => {
  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = login.body.accessToken;
  adminUserId = login.body.user.id;

  const active = await request(app)
    .post('/api/configurations/companies')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: `Active Co ${uid()}` });
  activeCompanyId = active.body.id;

  const inactive = await request(app)
    .post('/api/configurations/companies')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: `Inactive Co ${uid()}` });
  inactiveCompanyId = inactive.body.id;
  await request(app)
    .delete(`/api/configurations/companies/${inactiveCompanyId}`)
    .set('Authorization', `Bearer ${token}`);
});

// Same FK-ordered reset as outboundVendors.test.js — outbound_pos must be
// cleared before outbound_vendors (no ON DELETE CASCADE on outbound_pos.vendor_id),
// and this exact order is kept identical across both test files regardless of
// which one Jest runs first within the same suite run. companies is
// intentionally never reset here: nothing in this file mutates the two
// fixture companies created above, so they don't need per-test isolation.
beforeEach(async () => {
  await resetTable('outbound_pos');
  await resetTable('outbound_po_lines');
  await resetTable('outbound_vendors');
  await resetTable('outbound_vendor_articles');
});

describe('Outbound POs API', () => {
  describe('POST /api/outbound-pos — create', () => {
    test('creates a PO with a valid vendor and one valid line', async () => {
      const vendor = await createVendor();
      const res = await createPO({ vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0])] });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'Open' });
      expect(res.body.order_no).toMatch(/^\d{3,}$/);
    });

    test('rejects an unknown vendor_id', async () => {
      const res = await createPO({ vendor_id: 999999, lines: [lineFor(DEFAULT_ARTICLES[0])] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Vendor not found/);
    });

    test('rejects an inactive vendor', async () => {
      const vendor = await createVendor();
      await deactivateVendor(vendor.body.id);
      const res = await createPO({ vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0])] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/is inactive/);
    });

    test('accepts a valid, active company_id', async () => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        company_id: activeCompanyId,
        lines: [lineFor(vendor.body.articles[0])],
      });
      expect(res.status).toBe(201);
    });

    test('rejects an unknown company_id', async () => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        company_id: 999999,
        lines: [lineFor(vendor.body.articles[0])],
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Company not found/);
    });

    test('rejects an inactive company_id', async () => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        company_id: inactiveCompanyId,
        lines: [lineFor(vendor.body.articles[0])],
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Company is inactive/);
    });

    test('allows an omitted approved_by (optional at creation)', async () => {
      const vendor = await createVendor();
      const res = await createPO({ vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0])] });
      expect(res.status).toBe(201);
      const fetched = await request(app).get(`/api/outbound-pos/${res.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(fetched.body.approved_by).toBeNull();
    });

    test('rejects an approved_by that does not resolve to a real user', async () => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        approved_by: 999999,
        lines: [lineFor(vendor.body.articles[0])],
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/user not found/);
    });

    test('rejects an empty lines array', async () => {
      const vendor = await createVendor();
      const res = await createPO({ vendor_id: vendor.body.id, lines: [] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/At least one line item is required/);
    });

    test('rejects a line tuple not in the vendor\'s article mappings', async () => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        lines: [lineFor({ category: 'Packaging', item_name: 'One Ply' })],
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/is not in the vendor's article mappings/);
    });

    test.each([
      ['qty', 0, /qty must be a whole number/],
      ['qty', 1.5, /qty must be a whole number/],
      ['rate', -1, /rate must be a number/],
      ['received', -1, /received must be a whole number/],
      ['short', -1, /short must be a whole number/],
    ])('rejects an invalid line field: %s=%p', async (field, value, expectedMessage) => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        lines: [lineFor(vendor.body.articles[0], { [field]: value })],
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(expectedMessage);
    });

    test('ignores a client-supplied status and always derives it server-side', async () => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        status: 'Closed',
        lines: [lineFor(vendor.body.articles[0])],
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('Open');
    });

    test.each([
      ['all lines fresh', { received: 0, short: 0 }, 'Open'],
      ['a line partially received', { received: 0, short: 1, qty: 3 }, 'Partially Received'],
      ['every line fully accounted for', { received: 2, short: 1, qty: 3 }, 'Closed'],
    ])('derives status correctly when %s', async (_label, overrides, expectedStatus) => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        lines: [lineFor(vendor.body.articles[0], overrides)],
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe(expectedStatus);
    });
  });

  describe('GET /api/outbound-pos — list', () => {
    test('default view excludes Deleted POs', async () => {
      const { po: keep } = await createVendorAndPO();
      const { po: deleted } = await createVendorAndPO();
      await request(app).delete(`/api/outbound-pos/${deleted.body.id}`).set('Authorization', `Bearer ${token}`);

      const res = await request(app).get('/api/outbound-pos').set('Authorization', `Bearer ${token}`);
      const ids = res.body.rows.map(r => r.id);
      expect(ids).toContain(keep.body.id);
      expect(ids).not.toContain(deleted.body.id);
    });

    test('status=Deleted returns only Deleted POs', async () => {
      const { po: kept } = await createVendorAndPO();
      const { po: deleted } = await createVendorAndPO();
      await request(app).delete(`/api/outbound-pos/${deleted.body.id}`).set('Authorization', `Bearer ${token}`);

      const res = await request(app).get('/api/outbound-pos').query({ status: 'Deleted' }).set('Authorization', `Bearer ${token}`);
      const ids = res.body.rows.map(r => r.id);
      expect(ids).toContain(deleted.body.id);
      expect(ids).not.toContain(kept.body.id);
    });

    test('order_no filter strips leading zeros and matches by id', async () => {
      const { po } = await createVendorAndPO();
      const res = await request(app)
        .get('/api/outbound-pos')
        .query({ order_no: `0${po.body.order_no}` }) // extra leading zero on top of the padded order_no
        .set('Authorization', `Bearer ${token}`);
      expect(res.body.rows.map(r => r.id)).toEqual([po.body.id]);
    });

    test('a non-numeric order_no returns zero rows, not a 400', async () => {
      await createVendorAndPO();
      const res = await request(app).get('/api/outbound-pos').query({ order_no: 'abc' }).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(0);
    });

    test('vendor_id filter narrows to that vendor\'s POs', async () => {
      const { vendor: v1, po: po1 } = await createVendorAndPO();
      await createVendorAndPO();
      const res = await request(app).get('/api/outbound-pos').query({ vendor_id: v1.body.id }).set('Authorization', `Bearer ${token}`);
      expect(res.body.rows.map(r => r.id)).toEqual([po1.body.id]);
    });

    test('an invalid page_size falls back to 25', async () => {
      await createVendorAndPO();
      const res = await request(app).get('/api/outbound-pos').query({ page: 1, page_size: 999 }).set('Authorization', `Bearer ${token}`);
      expect(res.body.page_size).toBe(25);
    });

    test('omitting page and page_size returns everything unpaginated', async () => {
      await createVendorAndPO();
      await createVendorAndPO();
      const res = await request(app).get('/api/outbound-pos').set('Authorization', `Bearer ${token}`);
      expect(res.body.rows.length).toBe(res.body.total);
      expect(res.body.total).toBeGreaterThanOrEqual(2);
    });
  });

  describe('GET /api/outbound-pos/:id — getOne', () => {
    test('returns the full PO with order_no and lines', async () => {
      const { po } = await createVendorAndPO();
      const res = await request(app).get(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.order_no).toBe(po.body.order_no);
      expect(res.body.lines).toHaveLength(1);
    });

    test('404 for an unknown id', async () => {
      const res = await request(app).get('/api/outbound-pos/999999').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/outbound-pos/:id — update', () => {
    test('404 for an unknown id', async () => {
      const res = await patchPO(999999, { po_date: '2026-01-01' });
      expect(res.status).toBe(404);
    });

    test('mandatory-approver gate: an edit that omits approved_by 400s while it is still unset', async () => {
      const { po } = await createVendorAndPO(); // no approved_by set
      const blocked = await patchPO(po.body.id, { po_date: '2026-01-05' });
      expect(blocked.status).toBe(400);
      expect(blocked.body.message).toMatch(/Approved By is required/);

      const approved = await patchPO(po.body.id, { po_date: '2026-01-05', approved_by: adminUserId });
      expect(approved.status).toBe(200);
      expect(approved.body.po_date).toBe('2026-01-05');
    });

    test('once approved, a later edit that omits approved_by from the body still succeeds', async () => {
      const { po } = await createVendorAndPO({ approved_by: adminUserId });
      const res = await patchPO(po.body.id, { po_date: '2026-02-02' });
      expect(res.status).toBe(200);
      expect(res.body.approved_by).toBe(adminUserId);
    });

    test('explicitly clearing approved_by on an already-approved PO is rejected', async () => {
      const { po } = await createVendorAndPO({ approved_by: adminUserId });
      const res = await patchPO(po.body.id, { approved_by: '' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Approved By is required/);
    });

    test('a full lines replace re-derives status from the new lines', async () => {
      const { po, article } = await createVendorAndPO({ approved_by: adminUserId });
      const res = await patchPO(po.body.id, {
        lines: [lineFor(article, { qty: 2, received: 2 })],
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Closed');
    });

    test('ignores a client-supplied status on update the same way create does', async () => {
      const { po } = await createVendorAndPO({ approved_by: adminUserId });
      const res = await patchPO(po.body.id, { status: 'Closed' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Open'); // unchanged: no `lines` in the body, so status isn't recomputed
    });

    test('a company_id in the body is validated for existence but NOT for is_active (looser than create)', async () => {
      // Documents an asymmetry found while reading the controller: create()
      // checks both existence and is_active for company_id, update() only
      // checks existence. This locks in current behavior rather than assuming
      // it — flag to the team if this asymmetry isn't intentional.
      const { po } = await createVendorAndPO({ approved_by: adminUserId });
      const res = await patchPO(po.body.id, { company_id: inactiveCompanyId });
      expect(res.status).toBe(200);
      expect(res.body.company_id).toBe(inactiveCompanyId);
    });

    test('vendor_id in the body is silently ignored (server-side vendor lock)', async () => {
      const { po, vendor: originalVendor } = await createVendorAndPO({ approved_by: adminUserId });
      const otherVendor = await createVendor();
      const res = await patchPO(po.body.id, { vendor_id: otherVendor.body.id });
      expect(res.status).toBe(200);
      expect(res.body.vendor_id).toBe(originalVendor.body.id);
    });

    test('blocked entirely once status is Deleted', async () => {
      const { po } = await createVendorAndPO({ approved_by: adminUserId });
      await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      const res = await patchPO(po.body.id, { po_date: '2026-03-03' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/PO is deleted; restore it first/);
    });
  });

  describe('Update grandfathering (regression) — protects existing lines from vendor config edits', () => {
    test('a pre-existing line survives its mapping being removed from the vendor, but a new tuple is still rejected', async () => {
      const vendor = await createVendor([{ category: 'Raw Material', item_name: 'Caps' }]);
      const articleA = vendor.body.articles[0];
      const po = await createPO({
        vendor_id: vendor.body.id,
        approved_by: adminUserId,
        lines: [lineFor(articleA)],
      });
      expect(po.status).toBe(201);

      // Replace the vendor's articles so mapping A no longer exists.
      const vendorUpdate = await request(app)
        .patch(`/api/outbound-vendors/${vendor.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ articles: [{ category: 'Packaging', item_name: 'Corrugated' }] });
      expect(vendorUpdate.status).toBe(200);

      // Resubmitting the PO's existing line A unchanged must still succeed.
      const resubmit = await patchPO(po.body.id, { lines: [lineFor(articleA)] });
      expect(resubmit.status).toBe(200);
      expect(resubmit.body.lines[0]).toMatchObject({ category: 'Raw Material', item_name: 'Caps' });

      // Adding a brand-new tuple that was never mapped for this vendor is still rejected.
      const addNew = await patchPO(po.body.id, {
        lines: [lineFor(articleA), lineFor({ category: 'Others', item_name: 'Never Mapped' })],
      });
      expect(addNew.status).toBe(400);
      expect(addNew.body.message).toMatch(/is not in the vendor's article mappings/);
    });
  });

  describe('DELETE /api/outbound-pos/:id — soft delete', () => {
    test('404 for an unknown id', async () => {
      const res = await request(app).delete('/api/outbound-pos/999999').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    test('soft-deletes: status becomes Deleted, row still fetchable', async () => {
      const { po } = await createVendorAndPO();
      const res = await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Deleted');
      const fetched = await request(app).get(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.status).toBe('Deleted');
    });

    test('deleting an already-deleted PO is rejected', async () => {
      const { po } = await createVendorAndPO();
      await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      const res = await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/PO is already deleted/);
    });
  });

  describe('POST /api/outbound-pos/:id/restore', () => {
    test('404 for an unknown id', async () => {
      const res = await request(app).post('/api/outbound-pos/999999/restore').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    test('rejects restoring a PO that is not deleted', async () => {
      const { po } = await createVendorAndPO();
      const res = await request(app).post(`/api/outbound-pos/${po.body.id}/restore`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/PO is not deleted/);
    });

    test('restoring a fully-received PO re-derives Closed, not a blind reset to Open', async () => {
      const vendor = await createVendor();
      const closedPo = await createPO({
        vendor_id: vendor.body.id,
        lines: [lineFor(vendor.body.articles[0], { qty: 2, received: 2 })],
      });
      expect(closedPo.body.status).toBe('Closed');
      await request(app).delete(`/api/outbound-pos/${closedPo.body.id}`).set('Authorization', `Bearer ${token}`);

      const res = await request(app).post(`/api/outbound-pos/${closedPo.body.id}/restore`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Closed');
    });

    test('restoring a PO whose lines are all untouched re-derives Open', async () => {
      const { po } = await createVendorAndPO();
      await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      const res = await request(app).post(`/api/outbound-pos/${po.body.id}/restore`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Open');
    });
  });

  describe('Audit logging spot-checks', () => {
    test('create writes an OUTBOUND_PO_CREATE entry', async () => {
      const { po } = await createVendorAndPO();
      const res = await auditFor('outbound_po', po.body.id);
      expect(res.body.some(e => e.action_type === 'OUTBOUND_PO_CREATE')).toBe(true);
    });

    test('update writes an OUTBOUND_PO_UPDATE entry with a non-empty changes diff', async () => {
      const { po } = await createVendorAndPO({ approved_by: adminUserId });
      await patchPO(po.body.id, { po_date: '2026-04-04' });
      const res = await auditFor('outbound_po', po.body.id);
      const entry = res.body.find(e => e.action_type === 'OUTBOUND_PO_UPDATE');
      expect(entry).toBeTruthy();
      expect(entry.changes.length).toBeGreaterThan(0);
    });

    test('delete writes an OUTBOUND_PO_DELETE entry', async () => {
      const { po } = await createVendorAndPO();
      await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      const res = await auditFor('outbound_po', po.body.id);
      expect(res.body.some(e => e.action_type === 'OUTBOUND_PO_DELETE')).toBe(true);
    });

    test('restore writes an OUTBOUND_PO_RESTORE entry', async () => {
      const { po } = await createVendorAndPO();
      await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      await request(app).post(`/api/outbound-pos/${po.body.id}/restore`).set('Authorization', `Bearer ${token}`);
      const res = await auditFor('outbound_po', po.body.id);
      expect(res.body.some(e => e.action_type === 'OUTBOUND_PO_RESTORE')).toBe(true);
    });
  });
});
